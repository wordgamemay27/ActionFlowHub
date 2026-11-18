-- ============================================================================
-- MIGRATION: 010_reconciliation_settlement_and_payout_hardening.sql
-- DESCRIZIONE:
--   Completa e blinda il motore contabile di ActionFlow Hub dopo la 009:
--   1. Anti-replay strutturale:
--      - `core.settlement_batches` con `onchain_tx_hash` univoco
--      - `core.webhook_replay_guard` per nonce / replay S2S
--      - Indici univoci su `core.payout_requests(tx_hash)` e sui
--        `reference_type, reference_id` deterministici in `core.ledger_transactions`.
--   2. Vincoli DB sul tetto del 30% utente (`reward_events`, `session_interactions`).
--   3. Tracciamento esborsi reali in `core.treasury_vault` (`disbursed_usd`,
--      `disbursed_points`) per solvibilità netta reale prima di rilasci e payout.
--   4. Funzioni definitive richieste:
--      - `core.record_verified_interaction_postback` (+ wrapper `confirm_interaction_postback`)
--      - `core.record_pending_reward`
--      - `core.partner_confirm_reward`
--      - `core.set_partner_exposure_policy` & `core.sync_provider_exposure_status`
--      - `core.execute_batch_settlement`
--      - `core.release_settled_to_withdrawable_for_user` (+ wrapper `settle_to_withdrawable`)
--      - `core.request_payout_atomic`, `core.approve_payout_atomic`,
--        `core.complete_payout_atomic`, `core.reject_payout_atomic`
--      - `core.audit_ledger_integrity` & `core.v_treasury_solvency`
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. TABELLE E VINCOLI ANTI-REPLAY, TESORERIA E TETTO 30%
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.settlement_batches (
    batch_id TEXT PRIMARY KEY CHECK (length(trim(batch_id)) >= 3),
    partner_id TEXT NOT NULL,
    period_start_ms BIGINT NOT NULL,
    period_end_ms BIGINT NOT NULL,
    expected_gross_usd NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (expected_gross_usd >= 0),
    actual_net_usd NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (actual_net_usd >= 0),
    requested_haircut_ratio NUMERIC(8, 6) NOT NULL DEFAULT 1.0 CHECK (requested_haircut_ratio >= 0 AND requested_haircut_ratio <= 1),
    effective_ratio NUMERIC(8, 6) NOT NULL DEFAULT 0 CHECK (effective_ratio >= 0 AND effective_ratio <= 1),
    onchain_tx_hash TEXT NULL,
    settled_users_count INT NOT NULL DEFAULT 0 CHECK (settled_users_count >= 0),
    revoked_zero_cash_count INT NOT NULL DEFAULT 0 CHECK (revoked_zero_cash_count >= 0),
    total_points_settled BIGINT NOT NULL DEFAULT 0 CHECK (total_points_settled >= 0),
    unallocated_points BIGINT NOT NULL DEFAULT 0 CHECK (unallocated_points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_batches_tx_hash_unique
    ON core.settlement_batches(onchain_tx_hash)
    WHERE onchain_tx_hash IS NOT NULL AND length(trim(onchain_tx_hash)) > 0;

CREATE INDEX IF NOT EXISTS idx_settlement_batches_partner_created
    ON core.settlement_batches(partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS core.webhook_replay_guard (
    guard_key TEXT PRIMARY KEY CHECK (length(trim(guard_key)) >= 8),
    provider_id VARCHAR(64) NOT NULL,
    event_id TEXT,
    click_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);

CREATE INDEX IF NOT EXISTS idx_webhook_replay_guard_expires
    ON core.webhook_replay_guard(expires_at);

ALTER TABLE core.treasury_vault
    ADD COLUMN IF NOT EXISTS disbursed_usd NUMERIC(18, 6) NOT NULL DEFAULT 0.000000 CHECK (disbursed_usd >= 0);

ALTER TABLE core.treasury_vault
    ADD COLUMN IF NOT EXISTS disbursed_points BIGINT NOT NULL DEFAULT 0 CHECK (disbursed_points >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_tx_hash_unique
    ON core.payout_requests(tx_hash)
    WHERE tx_hash IS NOT NULL AND status = 'COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx_deterministic_ref
    ON core.ledger_transactions(reference_type, reference_id)
    WHERE reference_id IS NOT NULL
      AND left(reference_id, 7) <> 'manual_'
      AND reference_type IN (
        'PARTNER_PENDING',
        'REWARD_REVOKE',
        'BATCH_SETTLEMENT_USER',
        'SETTLEMENT',
        'WITHDRAW_REQUEST',
        'PAYOUT_COMPLETE',
        'PAYOUT_REJECT_REFUND',
        'SETTLE_TO_WITHDRAWABLE'
    );

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_events_user_pending_cap_30pct') THEN
        ALTER TABLE core.reward_events
            ADD CONSTRAINT reward_events_user_pending_cap_30pct
            CHECK (user_pending_points IS NULL OR user_pending_points <= FLOOR(raw_points * 0.30)) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_interactions_settled_lte_pending') THEN
        ALTER TABLE core.session_interactions
            ADD CONSTRAINT session_interactions_settled_lte_pending
            CHECK (user_settled_points <= user_pending_points);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_interactions_pending_cap_30pct') THEN
        ALTER TABLE core.session_interactions
            ADD CONSTRAINT session_interactions_pending_cap_30pct
            CHECK (user_pending_points <= FLOOR(confirmed_gross_usd * 100 * 0.30));
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. GESTIONE ESPOSIZIONE PARTNER E SINCRONIZZAZIONE REPUTAZIONE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.set_partner_exposure_policy(
    p_partner_id TEXT,
    p_parent_broker TEXT DEFAULT NULL,
    p_max_exposure_limit BIGINT DEFAULT 500000,
    p_status TEXT DEFAULT 'ACTIVE'
) RETURNS JSONB AS $$
DECLARE
    v_clean_partner TEXT := trim(COALESCE(p_partner_id, ''));
    v_clean_status TEXT := upper(trim(COALESCE(p_status, 'ACTIVE')));
    v_row core.partner_exposure%ROWTYPE;
BEGIN
    IF length(v_clean_partner) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'PARTNER_ID_REQUIRED');
    END IF;
    IF v_clean_status NOT IN ('ACTIVE', 'PAUSED', 'REVOKED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_EXPOSURE_STATUS');
    END IF;
    IF p_max_exposure_limit IS NOT NULL AND p_max_exposure_limit < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_MAX_EXPOSURE_LIMIT');
    END IF;

    INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, status)
    VALUES (
        v_clean_partner,
        COALESCE(NULLIF(trim(p_parent_broker), ''), v_clean_partner),
        p_max_exposure_limit,
        v_clean_status
    )
    ON CONFLICT (partner_id) DO UPDATE
    SET parent_broker = COALESCE(NULLIF(trim(p_parent_broker), ''), core.partner_exposure.parent_broker),
        max_exposure_limit = COALESCE(p_max_exposure_limit, core.partner_exposure.max_exposure_limit),
        status = v_clean_status,
        updated_at = NOW()
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('success', true, 'exposure', row_to_json(v_row));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.sync_provider_exposure_status(
    p_provider_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_clean_prov TEXT := trim(COALESCE(p_provider_id, ''));
    v_rep core.provider_reputation%ROWTYPE;
    v_target_exp TEXT;
BEGIN
    SELECT * INTO v_rep
      FROM core.provider_reputation
     WHERE provider_id = v_clean_prov
     FOR SHARE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PROVIDER_NOT_REGISTERED');
    END IF;

    v_target_exp := CASE
        WHEN v_rep.status = 'BANNED' THEN 'REVOKED'
        WHEN v_rep.status = 'QUARANTINE' THEN 'PAUSED'
        ELSE 'ACTIVE'
    END;

    INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, status)
    VALUES (v_clean_prov, v_clean_prov, 500000, v_target_exp)
    ON CONFLICT (partner_id) DO UPDATE
    SET status = v_target_exp,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'success', true,
        'provider_id', v_clean_prov,
        'reputation_status', v_rep.status,
        'exposure_status', v_target_exp
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. POSTBACK S2S VERIFICATO E RICONCILIATO (`record_verified_interaction_postback`)
--    - Anti-replay su `event_id` (con verifica coerenza payload) e `p_webhook_nonce`
--    - Ownership stretta utente + sessione + provider + click/interaction
--    - Blocco fail-closed su provider QUARANTINE / BANNED / non censiti / cap superato
--    - Tetto max 30% utente, solo bucket PENDING (`CONFIRMED_UNSETTLED`)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.record_verified_interaction_postback(
    p_event_id TEXT,
    p_click_id TEXT,
    p_interaction_id TEXT,
    p_provider_id TEXT,
    p_user_id BIGINT,
    p_confirmed_gross_usd NUMERIC,
    p_webhook_nonce TEXT DEFAULT NULL,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_clean_event TEXT := trim(COALESCE(p_event_id, ''));
    v_clean_click TEXT := NULLIF(trim(COALESCE(p_click_id, '')), '');
    v_clean_int TEXT := NULLIF(trim(COALESCE(p_interaction_id, '')), '');
    v_clean_prov TEXT := trim(COALESCE(p_provider_id, ''));
    v_clean_nonce TEXT := NULLIF(trim(COALESCE(p_webhook_nonce, '')), '');
    v_user core.users%ROWTYPE;
    v_existing_event core.reward_events%ROWTYPE;
    v_interaction core.session_interactions%ROWTYPE;
    v_provider core.provider_reputation%ROWTYPE;
    v_curr_exposure BIGINT;
    v_max_exposure BIGINT;
    v_exp_status TEXT;
    v_raw_points BIGINT;
    v_user_pending BIGINT;
    v_tx_id UUID;
    v_inserted_nonce TEXT;
BEGIN
    IF length(v_clean_event) < 3 THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_ID_REQUIRED');
    END IF;
    IF v_clean_click IS NULL AND v_clean_int IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_OR_CLICK_ID_REQUIRED');
    END IF;
    IF length(v_clean_prov) = 0 OR p_user_id IS NULL OR p_user_id <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_PROVIDER_OR_USER');
    END IF;
    IF p_confirmed_gross_usd IS NULL OR p_confirmed_gross_usd <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_PAYOUT_AMOUNT');
    END IF;

    v_raw_points := FLOOR(p_confirmed_gross_usd * 100)::BIGINT;
    IF v_raw_points <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'PAYOUT_BELOW_ONE_POINT');
    END IF;

    -- Anti-replay opzionale su nonce/firma S2S se fornito dal backend
    IF v_clean_nonce IS NOT NULL THEN
        IF length(v_clean_nonce) < 8 THEN
            RETURN jsonb_build_object('success', false, 'error', 'INVALID_WEBHOOK_NONCE');
        END IF;
        INSERT INTO core.webhook_replay_guard (guard_key, provider_id, event_id, click_id)
        VALUES (v_clean_prov || ':' || v_clean_nonce, v_clean_prov, v_clean_event, v_clean_click)
        ON CONFLICT (guard_key) DO NOTHING
        RETURNING guard_key INTO v_inserted_nonce;

        IF v_inserted_nonce IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'WEBHOOK_NONCE_REPLAYED');
        END IF;
    END IF;

    -- Serializza richieste concorrenti sullo stesso event_id
    PERFORM pg_advisory_xact_lock(hashtext('reward_evt_' || v_clean_event));

    SELECT * INTO v_existing_event
      FROM core.reward_events
     WHERE event_id = v_clean_event
     FOR UPDATE;
    IF FOUND THEN
        IF v_existing_event.partner_id <> v_clean_prov
           OR v_existing_event.user_id <> p_user_id
           OR (v_clean_int IS NOT NULL AND v_existing_event.interaction_id IS DISTINCT FROM v_clean_int)
           OR (v_clean_click IS NOT NULL AND v_existing_event.click_id IS DISTINCT FROM v_clean_click) THEN
            RETURN jsonb_build_object('success', false, 'error', 'EVENT_ID_REPLAY_CONFLICT');
        END IF;
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'added_pending_points', 0,
            'event_id', v_clean_event,
            'revenue_state', v_existing_event.revenue_state
        );
    END IF;

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    IF v_clean_int IS NOT NULL THEN
        SELECT * INTO v_interaction
          FROM core.session_interactions
         WHERE interaction_id = v_clean_int
         FOR UPDATE;
    ELSE
        SELECT * INTO v_interaction
          FROM core.session_interactions
         WHERE click_id = v_clean_click
         FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_NOT_FOUND');
    END IF;

    IF v_clean_int IS NOT NULL AND v_interaction.interaction_id <> v_clean_int THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_CLICK_MISMATCH');
    END IF;
    IF v_clean_click IS NOT NULL AND v_interaction.click_id <> v_clean_click THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_CLICK_MISMATCH');
    END IF;
    IF v_interaction.user_id <> p_user_id OR v_interaction.provider_id <> v_clean_prov THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_OWNERSHIP_MISMATCH');
    END IF;
    IF v_interaction.reward_event_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_ALREADY_REWARDED');
    END IF;
    IF v_interaction.status <> 'CLICK_REGISTERED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_INTERACTION_STATUS_' || v_interaction.status);
    END IF;
    IF NOW() > v_interaction.expires_at THEN
        UPDATE core.session_interactions
           SET status = 'EXPIRED',
               updated_at = NOW()
         WHERE interaction_id = v_interaction.interaction_id;
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_EXPIRED');
    END IF;

    PERFORM 1
      FROM core.auto_sessions
     WHERE session_id = v_interaction.session_id
     FOR UPDATE;

    SELECT * INTO v_provider
      FROM core.provider_reputation
     WHERE provider_id = v_clean_prov
     FOR SHARE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PROVIDER_NOT_REGISTERED');
    END IF;
    IF v_provider.status NOT IN ('ACTIVE', 'WARNING') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'PROVIDER_BLOCKED_BY_REPUTATION',
            'provider_status', v_provider.status
        );
    END IF;

    v_user_pending := FLOOR(v_raw_points * 0.30)::BIGINT;

    INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, status)
    VALUES (v_clean_prov, v_clean_prov, 500000, 'ACTIVE')
    ON CONFLICT (partner_id) DO NOTHING;

    SELECT pending_points_exposure, max_exposure_limit, status
      INTO v_curr_exposure, v_max_exposure, v_exp_status
      FROM core.partner_exposure
     WHERE partner_id = v_clean_prov
     FOR UPDATE;

    IF v_exp_status <> 'ACTIVE' THEN
        RETURN jsonb_build_object('success', false, 'error', 'PARTNER_EXPOSURE_SUSPENDED');
    END IF;
    IF v_max_exposure IS NOT NULL AND (v_curr_exposure + v_user_pending) > v_max_exposure THEN
        RETURN jsonb_build_object('success', false, 'error', 'PARTNER_EXPOSURE_CAP_EXCEEDED');
    END IF;

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES
        ('USER_' || p_user_id || ':PENDING', 'USER_PENDING', p_user_id),
        ('SYSTEM:UNEARNED_REVENUE', 'SYSTEM_LIABILITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES
        ('USER_' || p_user_id || ':PENDING', 0),
        ('SYSTEM:UNEARNED_REVENUE', 0)
    ON CONFLICT (account_id) DO NOTHING;

    PERFORM 1 FROM core.balances WHERE account_id = 'USER_' || p_user_id || ':PENDING' FOR UPDATE;
    PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:UNEARNED_REVENUE' FOR UPDATE;

    INSERT INTO core.reward_events (
        event_id, partner_id, user_id, raw_points, user_pending_points,
        status, source, interaction_id, click_id, session_id,
        gross_usd, revenue_state, payload_json
    ) VALUES (
        v_clean_event, v_clean_prov, p_user_id, v_raw_points, v_user_pending,
        'PENDING', 'S2S_POSTBACK', v_interaction.interaction_id, v_interaction.click_id, v_interaction.session_id,
        ROUND(p_confirmed_gross_usd::numeric, 4), 'CONFIRMED_UNSETTLED', COALESCE(p_payload_json, '{}'::jsonb)
    );

    IF v_user_pending > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES (
            'PARTNER_PENDING',
            v_clean_event,
            'Pending 30% confermato da ' || v_clean_prov || ' (interazione ' || v_interaction.interaction_id || ', in attesa incasso reale)'
        )
        RETURNING tx_id INTO v_tx_id;

        INSERT INTO core.ledger_entries (tx_id, account_id, amount)
        VALUES
            (v_tx_id, 'USER_' || p_user_id || ':PENDING', v_user_pending),
            (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_user_pending);

        UPDATE core.balances
           SET balance = balance + v_user_pending, updated_at = NOW()
         WHERE account_id = 'USER_' || p_user_id || ':PENDING';

        UPDATE core.balances
           SET balance = balance - v_user_pending, updated_at = NOW()
         WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

        UPDATE core.partner_exposure
           SET pending_points_exposure = pending_points_exposure + v_user_pending,
               updated_at = NOW()
         WHERE partner_id = v_clean_prov;
    END IF;

    UPDATE core.session_interactions
       SET status = 'POSTBACK_CONFIRMED_PENDING',
           reward_event_id = v_clean_event,
           confirmed_gross_usd = ROUND(p_confirmed_gross_usd::numeric, 4),
           user_pending_points = v_user_pending,
           postback_at = NOW(),
           updated_at = NOW()
     WHERE interaction_id = v_interaction.interaction_id;

    UPDATE core.auto_sessions
       SET interactions_pending = interactions_pending + 1,
           last_activity_at = NOW(),
           updated_at = NOW()
     WHERE session_id = v_interaction.session_id;

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'event_id', v_clean_event,
        'interaction_id', v_interaction.interaction_id,
        'click_id', v_interaction.click_id,
        'session_id', v_interaction.session_id,
        'raw_points', v_raw_points,
        'added_pending_points', v_user_pending,
        'revenue_state', 'CONFIRMED_UNSETTLED',
        'cash_collected', false
    );
END;
$$ LANGUAGE plpgsql;

-- Wrapper compatibile con il nome introdotto nella 009
CREATE OR REPLACE FUNCTION core.confirm_interaction_postback(
    p_event_id TEXT,
    p_click_id TEXT,
    p_interaction_id TEXT,
    p_provider_id TEXT,
    p_user_id BIGINT,
    p_confirmed_gross_usd NUMERIC,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_nonce TEXT := NULLIF(trim(COALESCE(p_payload_json->>'webhook_nonce', p_payload_json->>'nonce', '')), '');
BEGIN
    RETURN core.record_verified_interaction_postback(
        p_event_id,
        p_click_id,
        p_interaction_id,
        p_provider_id,
        p_user_id,
        p_confirmed_gross_usd,
        v_nonce,
        p_payload_json
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.record_pending_reward(
    p_event_id TEXT,
    p_partner_id TEXT,
    p_user_id BIGINT,
    p_raw_points BIGINT,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_click_id TEXT := NULLIF(trim(COALESCE(p_payload_json->>'click_id', p_payload_json->>'clickId', '')), '');
    v_interaction_id TEXT := NULLIF(trim(COALESCE(p_payload_json->>'interaction_id', p_payload_json->>'interactionId', '')), '');
    v_nonce TEXT := NULLIF(trim(COALESCE(p_payload_json->>'webhook_nonce', p_payload_json->>'nonce', '')), '');
    v_gross_usd NUMERIC;
BEGIN
    IF p_raw_points IS NULL OR p_raw_points <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_RAW_POINTS');
    END IF;

    IF v_click_id IS NULL AND v_interaction_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'AUTHENTIC_INTERACTION_OR_CLICK_REQUIRED',
            'message', 'Nessun accredito consentito senza click_id/interaction_id registrato e riconciliato.'
        );
    END IF;

    v_gross_usd := (p_raw_points::numeric / 100.0);

    RETURN core.record_verified_interaction_postback(
        p_event_id,
        v_click_id,
        v_interaction_id,
        p_partner_id,
        p_user_id,
        v_gross_usd,
        v_nonce,
        p_payload_json
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. CONFERMA / REVOCA PARTNER (`partner_confirm_reward`)
--    - 'VERIFIED': mai SETTLED o PLATFORM_REVENUE senza incasso reale
--    - 'REVOKED' su PENDING: storno atomico double-entry + esposizione + interazione
--    - 'REVOKED' su già SETTLED: blocca silenzio ambiguo (richiede rettifica dedicata)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.partner_confirm_reward(
    p_event_id TEXT,
    p_status TEXT DEFAULT 'VERIFIED' -- 'VERIFIED' | 'REVOKED'
) RETURNS JSONB AS $$
DECLARE
    v_event core.reward_events%ROWTYPE;
    v_target TEXT := upper(trim(COALESCE(p_status, 'VERIFIED')));
    v_pending_alloc BIGINT;
    v_user_pending_bal BIGINT;
    v_release_amount BIGINT;
    v_tx_id UUID;
BEGIN
    IF v_target NOT IN ('VERIFIED', 'REVOKED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_CONFIRM_STATUS');
    END IF;

    SELECT * INTO v_event FROM core.reward_events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
    END IF;

    IF v_event.status = 'REVOKED' THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'action', 'REVOKED');
    END IF;

    IF v_event.status = 'SETTLED' THEN
        IF v_target = 'REVOKED' THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'EVENT_ALREADY_SETTLED_REQUIRES_ADMIN_ADJUSTMENT'
            );
        END IF;
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'action', 'SETTLED');
    END IF;

    v_pending_alloc := COALESCE(v_event.user_pending_points, GREATEST(0, FLOOR(v_event.raw_points * 0.30)));

    IF v_target = 'REVOKED' THEN
        SELECT balance INTO v_user_pending_bal
          FROM core.balances
         WHERE account_id = 'USER_' || v_event.user_id || ':PENDING'
         FOR UPDATE;

        v_release_amount := LEAST(COALESCE(v_user_pending_bal, 0), v_pending_alloc);

        IF v_release_amount > 0 THEN
            PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:UNEARNED_REVENUE' FOR UPDATE;

            INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
            VALUES ('REWARD_REVOKE', p_event_id, 'Revoca Evento Ricompensa ' || p_event_id)
            RETURNING tx_id INTO v_tx_id;

            INSERT INTO core.ledger_entries (tx_id, account_id, amount)
            VALUES
                (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_release_amount),
                (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', v_release_amount);

            UPDATE core.balances SET balance = balance - v_release_amount, updated_at = NOW()
             WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

            UPDATE core.balances SET balance = balance + v_release_amount, updated_at = NOW()
             WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';
        END IF;

        UPDATE core.reward_events
           SET status = 'REVOKED',
               revenue_state = 'REVOKED',
               updated_at = NOW()
         WHERE event_id = p_event_id;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
               updated_at = NOW()
         WHERE partner_id = v_event.partner_id;

        IF v_event.interaction_id IS NOT NULL THEN
            UPDATE core.session_interactions
               SET status = 'REVOKED',
                   revoked_at = NOW(),
                   updated_at = NOW()
             WHERE interaction_id = v_event.interaction_id;

            IF v_event.session_id IS NOT NULL THEN
                UPDATE core.auto_sessions
                   SET interactions_pending = GREATEST(0, interactions_pending - 1),
                       interactions_revoked = interactions_revoked + 1,
                       updated_at = NOW()
                 WHERE session_id = v_event.session_id;
            END IF;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'action', 'REVOKED',
            'revoked_points', COALESCE(v_release_amount, 0)
        );
    END IF;

    UPDATE core.reward_events
       SET revenue_state = 'CONFIRMED_UNSETTLED',
           updated_at = NOW()
     WHERE event_id = p_event_id;

    RETURN jsonb_build_object(
        'success', true,
        'action', 'CONFIRMED_AWAITING_REAL_SETTLEMENT',
        'event_id', p_event_id,
        'user_pending_points', v_pending_alloc,
        'cash_collected', false
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 5. LIQUIDAZIONE BATCH SU INCASSO REALE (`execute_batch_settlement`)
--    - Anti-replay su `batch_id` E `onchain_tx_hash` (`settlement_batches` + `processed_tx_hashes`)
--    - Cap rigoroso sulla cassa reale ricevuta
--    - Eventi con incasso 0 vengono chiusi `REVOKED` (mai `CASH_COLLECTED_SETTLED`)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.execute_batch_settlement(
    p_batch_id TEXT,
    p_partner_id TEXT,
    p_period_start BIGINT,
    p_period_end BIGINT,
    p_expected_gross_usd NUMERIC,
    p_actual_net_usd NUMERIC,
    p_haircut_ratio NUMERIC,
    p_onchain_tx_hash TEXT
) RETURNS JSONB AS $$
DECLARE
    v_clean_batch TEXT := trim(COALESCE(p_batch_id, ''));
    v_clean_partner TEXT := trim(COALESCE(p_partner_id, ''));
    v_actual_net NUMERIC := GREATEST(0, COALESCE(p_actual_net_usd, 0));
    v_clean_tx TEXT := trim(COALESCE(p_onchain_tx_hash, ''));
    v_points_capacity BIGINT := FLOOR(v_actual_net * 100);
    v_remaining_capacity BIGINT := FLOOR(v_actual_net * 100);
    v_total_raw_points BIGINT := 0;
    v_settled_count INT := 0;
    v_revoked_zero_count INT := 0;
    v_total_points_settled BIGINT := 0;
    v_tx_id UUID;
    v_event RECORD;
    v_pending_alloc BIGINT;
    v_pending_bal BIGINT;
    v_gross_settled BIGINT;
    v_user_settled BIGINT;
    v_haircut_release BIGINT;
    v_platform_rev BIGINT;
    v_ratio NUMERIC := LEAST(1.0, GREATEST(0, COALESCE(p_haircut_ratio, 1.0)));
    v_effective_ratio NUMERIC := 0;
    v_start_ts TIMESTAMPTZ := to_timestamp(p_period_start / 1000.0);
    v_end_ts TIMESTAMPTZ := to_timestamp(p_period_end / 1000.0);
BEGIN
    IF length(v_clean_batch) < 3 OR length(v_clean_partner) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_BATCH_OR_PARTNER_ID');
    END IF;

    IF v_actual_net > 0 AND (
        length(v_clean_tx) < 8
        OR v_clean_tx ~* '^(sim_|fake_|mock_|test_|tx_confirmed_|tx_onchain_)'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'REAL_VERIFIABLE_SETTLEMENT_TX_REQUIRED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('settlement_batch_' || v_clean_batch));
    IF length(v_clean_tx) > 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext('settlement_tx_' || v_clean_tx));
    END IF;

    IF EXISTS (SELECT 1 FROM core.settlement_batches WHERE batch_id = v_clean_batch)
       OR EXISTS (
           SELECT 1 FROM core.ledger_transactions
            WHERE reference_type = 'SETTLEMENT' AND reference_id = v_clean_batch
       ) THEN
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'batch_id', v_clean_batch,
            'partner_id', v_clean_partner,
            'settled_users_count', 0,
            'total_points_settled', 0
        );
    END IF;

    -- Anti-replay on-chain: impedisce di riutilizzare lo stesso tx_hash su un altro batch
    IF v_actual_net > 0 THEN
        IF EXISTS (SELECT 1 FROM core.settlement_batches WHERE onchain_tx_hash = v_clean_tx)
           OR EXISTS (SELECT 1 FROM core.payout_requests WHERE tx_hash = v_clean_tx AND status = 'COMPLETED')
           OR EXISTS (SELECT 1 FROM core.processed_tx_hashes WHERE tx_hash = 'settlement:' || v_clean_tx) THEN
            RETURN jsonb_build_object('success', false, 'error', 'SETTLEMENT_TX_HASH_ALREADY_USED');
        END IF;

        INSERT INTO core.processed_tx_hashes (tx_hash)
        VALUES ('settlement:' || v_clean_tx)
        ON CONFLICT DO NOTHING;

        INSERT INTO core.treasury_vault (asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent)
        VALUES ('USDT', v_actual_net, v_points_capacity, 0.15)
        ON CONFLICT (asset) DO UPDATE
        SET actual_cash_on_chain = core.treasury_vault.actual_cash_on_chain + EXCLUDED.actual_cash_on_chain,
            points_equivalent_capacity = core.treasury_vault.points_equivalent_capacity + EXCLUDED.points_equivalent_capacity,
            updated_at = NOW();
    END IF;

    SELECT COALESCE(SUM(raw_points), 0) INTO v_total_raw_points
      FROM core.reward_events
     WHERE partner_id = v_clean_partner
       AND status = 'PENDING'
       AND created_at >= v_start_ts
       AND created_at <= v_end_ts;

    IF v_points_capacity <= 0 THEN
        v_effective_ratio := 0;
    ELSIF v_total_raw_points > 0 THEN
        v_effective_ratio := LEAST(v_ratio, LEAST(1.0, v_points_capacity::numeric / v_total_raw_points::numeric));
    ELSE
        v_effective_ratio := v_ratio;
    END IF;

    FOR v_event IN
        SELECT event_id, user_id, raw_points, user_pending_points, interaction_id, session_id
          FROM core.reward_events
         WHERE partner_id = v_clean_partner
           AND status = 'PENDING'
           AND created_at >= v_start_ts
           AND created_at <= v_end_ts
         ORDER BY created_at ASC, event_id ASC
         FOR UPDATE
    LOOP
        v_pending_alloc := COALESCE(v_event.user_pending_points, GREATEST(0, FLOOR(v_event.raw_points * 0.30)));

        SELECT balance INTO v_pending_bal
          FROM core.balances
         WHERE account_id = 'USER_' || v_event.user_id || ':PENDING'
         FOR UPDATE;

        v_pending_alloc := LEAST(COALESCE(v_pending_bal, 0), v_pending_alloc);

        v_gross_settled := LEAST(v_remaining_capacity, GREATEST(0, FLOOR(v_event.raw_points * v_effective_ratio)));
        v_user_settled := LEAST(v_pending_alloc, GREATEST(0, FLOOR(v_gross_settled * 0.30)));
        v_platform_rev := GREATEST(0, v_gross_settled - v_user_settled);
        v_haircut_release := v_pending_alloc - v_user_settled;
        v_remaining_capacity := GREATEST(0, v_remaining_capacity - v_gross_settled);

        INSERT INTO core.accounts (account_id, account_type, user_id)
        VALUES ('USER_' || v_event.user_id || ':SETTLED', 'USER_SETTLED', v_event.user_id)
        ON CONFLICT (account_id) DO NOTHING;

        INSERT INTO core.balances (account_id, balance)
        VALUES ('USER_' || v_event.user_id || ':SETTLED', 0)
        ON CONFLICT (account_id) DO NOTHING;

        PERFORM 1 FROM core.balances WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED' FOR UPDATE;
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:UNEARNED_REVENUE' FOR UPDATE;
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:PLATFORM_REVENUE' FOR UPDATE;

        IF v_pending_alloc > 0 OR v_platform_rev > 0 THEN
            INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
            VALUES ('BATCH_SETTLEMENT_USER', v_event.event_id, 'Liquidazione Evento ' || v_event.event_id || ' Batch ' || v_clean_batch)
            RETURNING tx_id INTO v_tx_id;

            IF v_user_settled > 0 THEN
                INSERT INTO core.ledger_entries (tx_id, account_id, amount)
                VALUES
                    (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_user_settled),
                    (v_tx_id, 'USER_' || v_event.user_id || ':SETTLED', v_user_settled);

                UPDATE core.balances SET balance = balance - v_user_settled, updated_at = NOW()
                 WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

                UPDATE core.balances SET balance = balance + v_user_settled, updated_at = NOW()
                 WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED';
            END IF;

            IF v_haircut_release > 0 THEN
                INSERT INTO core.ledger_entries (tx_id, account_id, amount)
                VALUES
                    (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_haircut_release),
                    (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', v_haircut_release);

                UPDATE core.balances SET balance = balance - v_haircut_release, updated_at = NOW()
                 WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

                UPDATE core.balances SET balance = balance + v_haircut_release, updated_at = NOW()
                 WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';
            END IF;

            IF v_platform_rev > 0 THEN
                INSERT INTO core.ledger_entries (tx_id, account_id, amount)
                VALUES
                    (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_platform_rev),
                    (v_tx_id, 'SYSTEM:PLATFORM_REVENUE', v_platform_rev);

                UPDATE core.balances SET balance = balance - v_platform_rev, updated_at = NOW()
                 WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

                UPDATE core.balances SET balance = balance + v_platform_rev, updated_at = NOW()
                 WHERE account_id = 'SYSTEM:PLATFORM_REVENUE';
            END IF;
        END IF;

        IF v_gross_settled > 0 THEN
            UPDATE core.reward_events
               SET status = 'SETTLED',
                   revenue_state = 'CASH_COLLECTED_SETTLED',
                   batch_id = v_clean_batch,
                   updated_at = NOW()
             WHERE event_id = v_event.event_id;

            IF v_event.interaction_id IS NOT NULL THEN
                UPDATE core.session_interactions
                   SET status = 'SETTLED',
                       user_settled_points = v_user_settled,
                       settled_at = NOW(),
                       updated_at = NOW()
                 WHERE interaction_id = v_event.interaction_id;

                IF v_event.session_id IS NOT NULL THEN
                    UPDATE core.auto_sessions
                       SET interactions_pending = GREATEST(0, interactions_pending - 1),
                           interactions_settled = interactions_settled + 1,
                           updated_at = NOW()
                     WHERE session_id = v_event.session_id;
                END IF;
            END IF;

            v_settled_count := v_settled_count + 1;
            v_total_points_settled := v_total_points_settled + v_user_settled;
        ELSE
            UPDATE core.reward_events
               SET status = 'REVOKED',
                   revenue_state = 'REVOKED',
                   batch_id = v_clean_batch,
                   updated_at = NOW()
             WHERE event_id = v_event.event_id;

            IF v_event.interaction_id IS NOT NULL THEN
                UPDATE core.session_interactions
                   SET status = 'REVOKED',
                       user_settled_points = 0,
                       revoked_at = NOW(),
                       updated_at = NOW()
                 WHERE interaction_id = v_event.interaction_id;

                IF v_event.session_id IS NOT NULL THEN
                    UPDATE core.auto_sessions
                       SET interactions_pending = GREATEST(0, interactions_pending - 1),
                           interactions_revoked = interactions_revoked + 1,
                           updated_at = NOW()
                     WHERE session_id = v_event.session_id;
                END IF;
            END IF;

            v_revoked_zero_count := v_revoked_zero_count + 1;
        END IF;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
               updated_at = NOW()
         WHERE partner_id = v_clean_partner;
    END LOOP;

    IF v_points_capacity > 0 THEN
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:TREASURY_CASH' FOR UPDATE;
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:UNEARNED_REVENUE' FOR UPDATE;

        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('SETTLEMENT', v_clean_batch, 'Liquidazione Tesoreria Batch ' || v_clean_partner || ' ratio ' || v_effective_ratio)
        RETURNING tx_id INTO v_tx_id;

        INSERT INTO core.ledger_entries (tx_id, account_id, amount)
        VALUES
            (v_tx_id, 'SYSTEM:TREASURY_CASH', v_points_capacity),
            (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_points_capacity);

        UPDATE core.balances SET balance = balance + v_points_capacity, updated_at = NOW()
         WHERE account_id = 'SYSTEM:TREASURY_CASH';

        UPDATE core.balances SET balance = balance - v_points_capacity, updated_at = NOW()
         WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';
    END IF;

    INSERT INTO core.settlement_batches (
        batch_id, partner_id, period_start_ms, period_end_ms,
        expected_gross_usd, actual_net_usd, requested_haircut_ratio, effective_ratio,
        onchain_tx_hash, settled_users_count, revoked_zero_cash_count,
        total_points_settled, unallocated_points
    ) VALUES (
        v_clean_batch, v_clean_partner, p_period_start, p_period_end,
        GREATEST(0, COALESCE(p_expected_gross_usd, 0)), v_actual_net, v_ratio, v_effective_ratio,
        NULLIF(v_clean_tx, ''), v_settled_count, v_revoked_zero_count,
        v_total_points_settled, v_remaining_capacity
    );

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'batch_id', v_clean_batch,
        'partner_id', v_clean_partner,
        'settled_users_count', v_settled_count,
        'revoked_zero_cash_count', v_revoked_zero_count,
        'total_points_settled', v_total_points_settled,
        'unallocated_points', v_remaining_capacity,
        'haircut_ratio', v_effective_ratio,
        'onchain_tx_hash', NULLIF(v_clean_tx, '')
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. RILASCIO SETTLED -> WITHDRAWABLE PER UTENTE CON SOLVIBILITÀ NETTA
--    `core.release_settled_to_withdrawable_for_user` + wrapper `settle_to_withdrawable`
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.release_settled_to_withdrawable_for_user(
    p_user_id BIGINT,
    p_points BIGINT DEFAULT NULL,
    p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
    v_clean_ref TEXT := NULLIF(trim(COALESCE(p_reference_id, '')), '');
    v_user_settled_balance BIGINT := 0;
    v_points_to_move BIGINT;
    v_vault_available_points BIGINT := 0;
    v_total_liabilities BIGINT := 0;
    v_tx_id UUID;
    v_ev RECORD;
    v_remaining_release BIGINT;
    v_ev_share BIGINT;
BEGIN
    IF v_clean_ref IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('release_with_' || v_clean_ref));
        IF EXISTS (
            SELECT 1 FROM core.ledger_transactions
             WHERE reference_type = 'SETTLE_TO_WITHDRAWABLE' AND reference_id = v_clean_ref
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent', true,
                'user_id', p_user_id,
                'moved_points', 0,
                'new_withdrawable_balance', COALESCE(
                    (SELECT balance FROM core.balances WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'),
                    0
                )
            );
        END IF;
    END IF;

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('USER_' || p_user_id || ':WITHDRAWABLE', 'USER_WITHDRAWABLE', p_user_id)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('USER_' || p_user_id || ':WITHDRAWABLE', 0)
    ON CONFLICT (account_id) DO NOTHING;

    SELECT balance INTO v_user_settled_balance
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':SETTLED'
     FOR UPDATE;

    IF v_user_settled_balance IS NULL OR v_user_settled_balance <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'NO_SETTLED_FUNDS');
    END IF;

    PERFORM 1
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'
     FOR UPDATE;

    IF p_points IS NULL THEN
        v_points_to_move := v_user_settled_balance;
    ELSE
        v_points_to_move := LEAST(v_user_settled_balance, GREATEST(0, p_points));
    END IF;

    IF v_points_to_move <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_POINTS_AMOUNT');
    END IF;

    -- Lock delle righe tesoreria e verifica capacità netta residua (al netto di esborsi già pagati e riserva 15%)
    PERFORM 1 FROM core.treasury_vault FOR UPDATE;

    SELECT COALESCE(
        FLOOR(SUM(GREATEST(0, points_equivalent_capacity - disbursed_points) * (1 - reserved_buffer_percent))),
        0
    )::BIGINT
      INTO v_vault_available_points
      FROM core.treasury_vault;

    SELECT COALESCE(SUM(b.balance), 0)::BIGINT
      INTO v_total_liabilities
      FROM core.balances b
      JOIN core.accounts a ON a.account_id = b.account_id
     WHERE a.account_type IN ('USER_WITHDRAWABLE', 'USER_RESERVED');

    IF (v_total_liabilities + v_points_to_move) > v_vault_available_points THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'TREASURY_SOLVENCY_INSUFFICIENT_FOR_WITHDRAWABLE',
            'vault_available_points', v_vault_available_points,
            'current_withdrawable_liabilities', v_total_liabilities,
            'requested_points', v_points_to_move
        );
    END IF;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES (
        'SETTLE_TO_WITHDRAWABLE',
        COALESCE(v_clean_ref, 'release_' || p_user_id || '_' || gen_random_uuid()::text),
        'Transito SETTLED -> WITHDRAWABLE per utente ' || p_user_id
    )
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || p_user_id || ':SETTLED', -v_points_to_move),
        (v_tx_id, 'USER_' || p_user_id || ':WITHDRAWABLE', v_points_to_move);

    UPDATE core.balances
       SET balance = balance - v_points_to_move, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':SETTLED';

    UPDATE core.balances
       SET balance = balance + v_points_to_move, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE';

    -- Aggiorna stato pipeline FIFO sugli eventi SETTLED dell'utente
    v_remaining_release := v_points_to_move;
    FOR v_ev IN
        SELECT re.event_id,
               COALESCE(si.user_settled_points, re.user_pending_points, FLOOR(re.raw_points * 0.30))::BIGINT AS settled_pts
          FROM core.reward_events re
          LEFT JOIN core.session_interactions si ON si.interaction_id = re.interaction_id
         WHERE re.user_id = p_user_id
           AND re.status = 'SETTLED'
           AND re.revenue_state = 'CASH_COLLECTED_SETTLED'
         ORDER BY re.created_at ASC, re.event_id ASC
         FOR UPDATE OF re
    LOOP
        EXIT WHEN v_remaining_release <= 0;
        v_ev_share := GREATEST(0, COALESCE(v_ev.settled_pts, 0));
        IF v_ev_share <= v_remaining_release THEN
            UPDATE core.reward_events
               SET revenue_state = 'WITHDRAWABLE_RELEASED',
                   updated_at = NOW()
             WHERE event_id = v_ev.event_id;
            v_remaining_release := v_remaining_release - v_ev_share;
        ELSE
            EXIT;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'user_id', p_user_id,
        'moved_points', v_points_to_move,
        'new_withdrawable_balance', (
            SELECT balance FROM core.balances WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'
        )
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.settle_to_withdrawable(
    p_user_id BIGINT,
    p_points BIGINT,
    p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    RETURN core.release_settled_to_withdrawable_for_user(p_user_id, p_points, p_reference_id);
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 7. CICLO PRELIEVI BLINDATO:
--    - `request_payout_atomic` (coerenza canale/asset + FX snapshot obbligatorio)
--    - `approve_payout_atomic`
--    - `complete_payout_atomic` (anti-replay tx_hash + check cassa + aggiornamento vault)
--    - `reject_payout_atomic` (advisory lock + rimborso atomico)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.request_payout_atomic(
    p_request_id TEXT,
    p_user_id BIGINT,
    p_points BIGINT,
    p_crypto_asset TEXT,
    p_payout_channel TEXT,
    p_wallet_address TEXT,
    p_idempotency_key TEXT,
    p_max_quote_age_seconds INT DEFAULT 600
) RETURNS JSONB AS $$
DECLARE
    v_existing core.payout_requests%ROWTYPE;
    v_user core.users%ROWTYPE;
    v_withdrawable BIGINT;
    v_tx_id UUID;
    v_usd NUMERIC(14, 2);
    v_ton NUMERIC(18, 6) := 0;
    v_asset_amount NUMERIC(18, 8);
    v_upper_asset TEXT := upper(trim(COALESCE(p_crypto_asset, '')));
    v_upper_channel TEXT := upper(trim(COALESCE(p_payout_channel, '')));
    v_fx core.fx_price_snapshots%ROWTYPE;
    v_fx_snapshot_id BIGINT := NULL;
    v_fx_usd_per_asset NUMERIC(18, 8) := NULL;
    v_fx_source TEXT := NULL;
    v_fx_quoted_at TIMESTAMPTZ := NULL;
    v_max_age INT := GREATEST(30, LEAST(3600, COALESCE(p_max_quote_age_seconds, 600)));
BEGIN
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_KEY_REQUIRED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('payout_req_' || p_idempotency_key));

    SELECT * INTO v_existing
      FROM core.payout_requests
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'ok', true,
            'idempotent', true,
            'payout', row_to_json(v_existing)
        );
    END IF;

    IF p_points IS NULL OR p_points < 500 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'MINIMUM_500_PT_REQUIRED');
    END IF;

    IF p_wallet_address IS NULL OR length(trim(p_wallet_address)) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WALLET_ADDRESS');
    END IF;

    IF v_upper_asset NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_PAYEER', 'CASH_AIRTM', 'CASH_VOLET') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_PAYOUT_ASSET', 'asset', v_upper_asset);
    END IF;

    IF (v_upper_asset LIKE 'CASH_%' AND v_upper_channel <> 'CASH_LOCAL')
       OR (v_upper_asset NOT LIKE 'CASH_%' AND v_upper_channel <> 'CRYPTO_DIRECT') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_CHANNEL_ASSET_MISMATCH');
    END IF;

    v_usd := ROUND((p_points * 0.01)::numeric, 2);

    IF v_upper_asset IN ('TON', 'SOL', 'PI') THEN
        SELECT * INTO v_fx
          FROM core.fx_price_snapshots
         WHERE asset = v_upper_asset
           AND is_valid = TRUE
           AND expires_at > NOW()
           AND fetched_at >= NOW() - make_interval(secs => v_max_age)
         ORDER BY fetched_at DESC, snapshot_id DESC
         LIMIT 1;

        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'FX_PRICE_UNAVAILABLE_PAYOUT_BLOCKED',
                'asset', v_upper_asset
            );
        END IF;

        v_asset_amount := ROUND((v_usd / v_fx.usd_per_unit)::numeric, 6);
        IF v_asset_amount <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONVERTED_ASSET_AMOUNT');
        END IF;

        v_ton := CASE WHEN v_upper_asset = 'TON' THEN v_asset_amount ELSE 0 END;
        v_fx_snapshot_id := v_fx.snapshot_id;
        v_fx_usd_per_asset := v_fx.usd_per_unit;
        v_fx_source := v_fx.source;
        v_fx_quoted_at := v_fx.fetched_at;
    ELSE
        v_asset_amount := v_usd;
        v_ton := 0;
        v_fx_usd_per_asset := 1.00000000;
        v_fx_source := 'USD_PARITY';
        v_fx_quoted_at := NOW();
    END IF;

    PERFORM core.ensure_user_accounts(p_user_id, 'User', 'ZONE_C', 0.20, NULL);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_BLOCKED');
    END IF;

    SELECT balance INTO v_withdrawable
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'
     FOR UPDATE;

    PERFORM 1
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':RESERVED'
     FOR UPDATE;

    IF COALESCE(v_withdrawable, 0) < p_points THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
            'withdrawable_points', COALESCE(v_withdrawable, 0)
        );
    END IF;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('WITHDRAW_REQUEST', p_request_id, 'Riserva prelievo ' || v_upper_asset || ' utente ' || p_user_id)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || p_user_id || ':WITHDRAWABLE', -p_points),
        (v_tx_id, 'USER_' || p_user_id || ':RESERVED', p_points);

    UPDATE core.balances
       SET balance = balance - p_points, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE';

    UPDATE core.balances
       SET balance = balance + p_points, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':RESERVED';

    INSERT INTO core.payout_requests (
        request_id, user_id, idempotency_key, points, amount_usd, amount_ton,
        crypto_asset, payout_channel, wallet_address, status, payout_status,
        fx_snapshot_id, fx_usd_per_asset, fx_source, fx_quoted_at, asset_amount
    ) VALUES (
        p_request_id, p_user_id, p_idempotency_key, p_points, v_usd, v_ton,
        v_upper_asset, v_upper_channel, trim(p_wallet_address), 'PENDING', 'PENDING_ADMIN_DISBURSEMENT',
        v_fx_snapshot_id, v_fx_usd_per_asset, v_fx_source, v_fx_quoted_at, v_asset_amount
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'payout', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.approve_payout_atomic(
    p_request_id TEXT,
    p_admin_actor TEXT DEFAULT 'admin',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || COALESCE(p_request_id, '')));

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.status = 'APPROVED' THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'payout', row_to_json(v_payout));
    END IF;

    IF v_payout.status <> 'PENDING' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE_TRANSITION_' || v_payout.status);
    END IF;

    UPDATE core.payout_requests
       SET status = 'APPROVED',
           payout_status = 'APPROVED_READY_FOR_DISBURSEMENT',
           approved_by = COALESCE(NULLIF(trim(p_admin_actor), ''), 'admin'),
           approved_at = NOW(),
           note = COALESCE(p_note, note, 'Approvato dall''amministratore per erogazione verificabile'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.complete_payout_atomic(
    p_request_id TEXT,
    p_tx_hash TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_clean_hash TEXT := trim(COALESCE(p_tx_hash, ''));
    v_reserved_bal BIGINT;
    v_remaining_vault_pts BIGINT := 0;
    v_target_vault_asset TEXT;
    v_tx_id UUID;
BEGIN
    IF length(v_clean_hash) < 8
       OR v_clean_hash ~* '^(sim_|fake_|mock_|test_|tx_confirmed_|tx_onchain_)' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REAL_VERIFIABLE_TX_HASH_REQUIRED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || COALESCE(p_request_id, '')));
    PERFORM pg_advisory_xact_lock(hashtext('payout_tx_' || v_clean_hash));

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.status = 'COMPLETED' THEN
        IF v_payout.tx_hash IS DISTINCT FROM v_clean_hash THEN
            RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_TX_HASH_CONFLICT');
        END IF;
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'payout', row_to_json(v_payout));
    END IF;

    IF v_payout.status NOT IN ('PENDING', 'APPROVED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE_TRANSITION_' || v_payout.status);
    END IF;

    -- Anti-replay: lo stesso tx_hash non può chiudere più payout o sovrapporsi a batch di incasso
    IF EXISTS (SELECT 1 FROM core.payout_requests WHERE tx_hash = v_clean_hash AND request_id <> p_request_id)
       OR EXISTS (SELECT 1 FROM core.settlement_batches WHERE onchain_tx_hash = v_clean_hash)
       OR EXISTS (SELECT 1 FROM core.processed_tx_hashes WHERE tx_hash = 'payout:' || v_clean_hash) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_TX_HASH_ALREADY_USED');
    END IF;

    SELECT balance INTO v_reserved_bal
      FROM core.balances
     WHERE account_id = 'USER_' || v_payout.user_id || ':RESERVED'
     FOR UPDATE;

    IF COALESCE(v_reserved_bal, 0) < v_payout.points THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_RESERVED_BALANCE');
    END IF;

    PERFORM 1 FROM core.treasury_vault FOR UPDATE;

    SELECT COALESCE(SUM(GREATEST(0, points_equivalent_capacity - disbursed_points)), 0)::BIGINT
      INTO v_remaining_vault_pts
      FROM core.treasury_vault;

    IF v_remaining_vault_pts < v_payout.points THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TREASURY_VAULT_CASH_INSUFFICIENT',
            'remaining_vault_points', v_remaining_vault_pts,
            'requested_points', v_payout.points
        );
    END IF;

    SELECT asset INTO v_target_vault_asset
      FROM core.treasury_vault
     ORDER BY (asset = v_payout.crypto_asset) DESC,
              (points_equivalent_capacity - disbursed_points) DESC
     LIMIT 1;

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('SYSTEM:PAID', 'SYSTEM_LIABILITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('SYSTEM:PAID', 0)
    ON CONFLICT (account_id) DO NOTHING;

    PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:PAID' FOR UPDATE;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('PAYOUT_COMPLETE', p_request_id, 'Chiusura prelievo verificato tx=' || v_clean_hash)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || v_payout.user_id || ':RESERVED', -v_payout.points),
        (v_tx_id, 'SYSTEM:PAID', v_payout.points);

    UPDATE core.balances
       SET balance = balance - v_payout.points, updated_at = NOW()
     WHERE account_id = 'USER_' || v_payout.user_id || ':RESERVED';

    UPDATE core.balances
       SET balance = balance + v_payout.points, updated_at = NOW()
     WHERE account_id = 'SYSTEM:PAID';

    IF v_target_vault_asset IS NOT NULL THEN
        UPDATE core.treasury_vault
           SET disbursed_usd = disbursed_usd + v_payout.amount_usd,
               disbursed_points = disbursed_points + v_payout.points,
               updated_at = NOW()
         WHERE asset = v_target_vault_asset;
    END IF;

    INSERT INTO core.processed_tx_hashes (tx_hash)
    VALUES ('payout:' || v_clean_hash)
    ON CONFLICT DO NOTHING;

    UPDATE core.payout_requests
       SET status = 'COMPLETED',
           payout_status = 'COMPLETED_VERIFIED',
           tx_hash = v_clean_hash,
           completed_at = NOW(),
           note = COALESCE(p_note, note, 'Pagamento verificato e chiuso contabilmente'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.reject_payout_atomic(
    p_request_id TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_reserved_bal BIGINT;
    v_tx_id UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || COALESCE(p_request_id, '')));

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.status = 'REJECTED' THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'payout', row_to_json(v_payout));
    END IF;

    IF v_payout.status NOT IN ('PENDING', 'APPROVED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CANNOT_REJECT_STATUS_' || v_payout.status);
    END IF;

    SELECT balance INTO v_reserved_bal
      FROM core.balances
     WHERE account_id = 'USER_' || v_payout.user_id || ':RESERVED'
     FOR UPDATE;

    IF COALESCE(v_reserved_bal, 0) < v_payout.points THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_RESERVED_BALANCE');
    END IF;

    PERFORM 1
      FROM core.balances
     WHERE account_id = 'USER_' || v_payout.user_id || ':WITHDRAWABLE'
     FOR UPDATE;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('PAYOUT_REJECT_REFUND', p_request_id, 'Rimborso prelievo rifiutato ' || p_request_id)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || v_payout.user_id || ':RESERVED', -v_payout.points),
        (v_tx_id, 'USER_' || v_payout.user_id || ':WITHDRAWABLE', v_payout.points);

    UPDATE core.balances
       SET balance = balance - v_payout.points, updated_at = NOW()
     WHERE account_id = 'USER_' || v_payout.user_id || ':RESERVED';

    UPDATE core.balances
       SET balance = balance + v_payout.points, updated_at = NOW()
     WHERE account_id = 'USER_' || v_payout.user_id || ':WITHDRAWABLE';

    UPDATE core.payout_requests
       SET status = 'REJECTED',
           payout_status = 'REJECTED_REFUNDED',
           rejected_at = NOW(),
           note = COALESCE(p_note, 'Prelievo rifiutato e punti restituiti in WITHDRAWABLE'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 8. AUDIT CONTABILE AUTOMATICO & VISTA SOLVIBILITÀ TESORERIA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_treasury_solvency AS
SELECT
    COALESCE(SUM(actual_cash_on_chain), 0)::NUMERIC(18, 6) AS total_cash_collected_usd,
    COALESCE(SUM(disbursed_usd), 0)::NUMERIC(18, 6) AS total_cash_disbursed_usd,
    COALESCE(SUM(GREATEST(0, points_equivalent_capacity - disbursed_points)), 0)::BIGINT AS remaining_gross_points_capacity,
    COALESCE(FLOOR(SUM(GREATEST(0, points_equivalent_capacity - disbursed_points) * (1 - reserved_buffer_percent))), 0)::BIGINT AS net_withdrawable_capacity_points,
    COALESCE((
        SELECT SUM(b.balance)
          FROM core.balances b
          JOIN core.accounts a ON a.account_id = b.account_id
         WHERE a.account_type IN ('USER_WITHDRAWABLE', 'USER_RESERVED')
    ), 0)::BIGINT AS total_user_withdrawable_and_reserved_points,
    COALESCE((
        SELECT SUM(b.balance)
          FROM core.balances b
          JOIN core.accounts a ON a.account_id = b.account_id
         WHERE a.account_type = 'USER_PENDING'
    ), 0)::BIGINT AS total_user_pending_points,
    COALESCE((
        SELECT SUM(b.balance)
          FROM core.balances b
          JOIN core.accounts a ON a.account_id = b.account_id
         WHERE a.account_type = 'USER_SETTLED'
    ), 0)::BIGINT AS total_user_settled_points
FROM core.treasury_vault;

CREATE OR REPLACE FUNCTION core.audit_ledger_integrity()
RETURNS JSONB AS $$
DECLARE
    v_zero_sum_violations BIGINT;
    v_negative_user_balances BIGINT;
    v_balance_drift_count BIGINT;
    v_cap_30pct_violations BIGINT;
    v_solvency RECORD;
BEGIN
    SELECT COUNT(*) INTO v_zero_sum_violations
      FROM (
          SELECT tx_id
            FROM core.ledger_entries
           GROUP BY tx_id
          HAVING SUM(amount) <> 0
      ) t;

    SELECT COUNT(*) INTO v_negative_user_balances
      FROM core.balances
     WHERE LEFT(account_id, 5) = 'USER_'
       AND balance < 0;

    SELECT COUNT(*) INTO v_balance_drift_count
      FROM core.balances b
      LEFT JOIN (
          SELECT account_id, SUM(amount)::BIGINT AS ledger_sum
            FROM core.ledger_entries
           GROUP BY account_id
      ) le ON le.account_id = b.account_id
     WHERE b.balance <> COALESCE(le.ledger_sum, 0);

    SELECT COUNT(*) INTO v_cap_30pct_violations
      FROM core.reward_events
     WHERE user_pending_points IS NOT NULL
       AND user_pending_points > FLOOR(raw_points * 0.30);

    SELECT * INTO v_solvency FROM core.v_treasury_solvency;

    RETURN jsonb_build_object(
        'ok', (
            v_zero_sum_violations = 0
            AND v_negative_user_balances = 0
            AND v_balance_drift_count = 0
            AND v_cap_30pct_violations = 0
            AND v_solvency.net_withdrawable_capacity_points >= v_solvency.total_user_withdrawable_and_reserved_points
        ),
        'zero_sum_violations', v_zero_sum_violations,
        'negative_user_balances', v_negative_user_balances,
        'balance_drift_count', v_balance_drift_count,
        'cap_30pct_violations', v_cap_30pct_violations,
        'solvency', row_to_json(v_solvency)
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 9. PERSISTENZA STRIKE ANTI-ABUSO IN POSTGRESQL (ZERO JSON / ZERO RAM)
-- ----------------------------------------------------------------------------
ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS strike_count INTEGER NOT NULL DEFAULT 0 CHECK (strike_count >= 0);

ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS strike_last_reason TEXT;

ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS strike_updated_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION core.get_user_strikes(
    p_user_id BIGINT
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
BEGIN
    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'user_id', p_user_id,
            'count', 0,
            'is_blocked', false,
            'last_reason', NULL,
            'updated_at', NULL
        );
    END IF;

    RETURN jsonb_build_object(
        'user_id', v_user.user_id,
        'count', v_user.strike_count,
        'is_blocked', v_user.is_blocked,
        'last_reason', v_user.strike_last_reason,
        'updated_at', v_user.strike_updated_at
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.record_user_strike(
    p_user_id BIGINT,
    p_reason TEXT,
    p_increment BOOLEAN DEFAULT TRUE
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
BEGIN
    PERFORM core.ensure_user_accounts(p_user_id, 'User', 'ZONE_C', 0.20, NULL);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;

    IF p_increment THEN
        UPDATE core.users
           SET strike_count = LEAST(3, strike_count + 1),
               is_blocked = CASE WHEN strike_count + 1 >= 3 THEN TRUE ELSE is_blocked END,
               strike_last_reason = NULLIF(trim(COALESCE(p_reason, '')), ''),
               strike_updated_at = NOW(),
               updated_at = NOW()
         WHERE user_id = p_user_id
         RETURNING * INTO v_user;
    END IF;

    RETURN jsonb_build_object(
        'user_id', v_user.user_id,
        'count', v_user.strike_count,
        'is_blocked', v_user.is_blocked,
        'last_reason', v_user.strike_last_reason,
        'updated_at', v_user.strike_updated_at
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 10. SEED IDEMPOTENTE PROVIDER VERIFICATI E BLOCCO DEFINITIVO `internal_relay`
-- ----------------------------------------------------------------------------
INSERT INTO core.provider_reputation (
    provider_id, provider_name, category, status, reputation_score, ema_haircut_ratio, failover_chain
) VALUES
    ('reelshort', 'ReelShort Direct Video', 'MICRO_DRAMA', 'ACTIVE', 98.50, 0.9850, ARRAY['dramabox', 'shorttv']),
    ('dramabox', 'DramaBox Official', 'MICRO_DRAMA', 'ACTIVE', 97.50, 0.9750, ARRAY['shorttv', 'kalostv']),
    ('shorttv', 'ShortTV Ufficiale', 'MICRO_DRAMA', 'ACTIVE', 96.80, 0.9680, ARRAY['kalostv', 'reelshort']),
    ('kalostv', 'Kalos TV Direct', 'MICRO_DRAMA', 'ACTIVE', 95.20, 0.9520, ARRAY['reelshort', 'dramabox']),
    ('plarium', 'Plarium Direct Studio', 'GAME', 'ACTIVE', 96.00, 0.9600, ARRAY['wargaming', 'gaijin']),
    ('wargaming', 'Wargaming Affiliate Direct', 'GAME', 'ACTIVE', 95.50, 0.9550, ARRAY['gaijin', 'plarium']),
    ('gaijin', 'Gaijin Entertainment Direct', 'GAME', 'ACTIVE', 94.80, 0.9480, ARRAY['plarium', 'wargaming']),
    ('submithub', 'SubmitHub Music Direct', 'MUSIC', 'ACTIVE', 95.00, 0.9500, ARRAY['fountain']),
    ('fountain', 'Fountain.fm Bitcoin Direct', 'MUSIC', 'ACTIVE', 96.00, 0.9600, ARRAY['submithub']),
    ('cpx', 'CPX Research Survey Direct', 'SURVEY', 'ACTIVE', 94.50, 0.9450, ARRAY['prolific']),
    ('prolific', 'Prolific UX Research Direct', 'UX_QA', 'ACTIVE', 98.00, 0.9800, ARRAY['cpx']),
    ('outlier', 'Outlier AI Task Direct', 'AI_TASK', 'ACTIVE', 96.00, 0.9600, ARRAY['prolific']),
    ('premise', 'Premise Receipt & Audit Direct', 'RECEIPT', 'ACTIVE', 95.00, 0.9500, ARRAY['prolific']),
    ('mysterium', 'Mysterium DePIN Node Direct', 'DEPIN', 'ACTIVE', 95.00, 0.9500, ARRAY['honeygain']),
    ('honeygain', 'Honeygain DePIN Direct', 'DEPIN', 'ACTIVE', 94.00, 0.9400, ARRAY['mysterium']),
    ('video_stream', 'ActionFlow Video Partner Pool', 'VIDEO', 'ACTIVE', 95.00, 0.9500, ARRAY['reelshort', 'dramabox']),
    ('ads_network', 'ActionFlow Verified Ads Partner', 'ADS', 'ACTIVE', 95.00, 0.9500, ARRAY['video_stream']),
    ('music_player', 'ActionFlow Music Partner Pool', 'MUSIC', 'ACTIVE', 95.00, 0.9500, ARRAY['fountain', 'submithub']),
    ('ton_onchain_partner', 'TON On-Chain Settlement Partner', 'TELEGRAM', 'ACTIVE', 100.00, 1.0000, ARRAY[]::TEXT[]),
    ('sol_onchain_partner', 'Solana On-Chain Settlement Partner', 'TELEGRAM', 'ACTIVE', 100.00, 1.0000, ARRAY[]::TEXT[])
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, pending_points_exposure, status)
SELECT provider_id, 'DIRECT_HOUSE', 500000, 0, 'ACTIVE'
  FROM core.provider_reputation
 WHERE provider_id <> 'internal_relay'
   AND status IN ('ACTIVE', 'WARNING')
ON CONFLICT (partner_id) DO NOTHING;

INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, pending_points_exposure, status)
VALUES ('internal_relay', 'INTERNAL_LEGACY', 0, 0, 'REVOKED')
ON CONFLICT (partner_id) DO UPDATE
   SET status = 'REVOKED',
       max_exposure_limit = 0,
       updated_at = NOW();

COMMIT;
