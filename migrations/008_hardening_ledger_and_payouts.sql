-- ============================================================================
-- MIGRATION: 008_hardening_ledger_and_payouts.sql
-- DESCRIZIONE:
--   1. Tabella core.schema_migrations per migrazioni controllate e idempotenti.
--   2. Vincoli non-negativi sicuri per tutti i 4 bucket utente + conti cassa/pagamenti.
--   3. Correzione idempotenza e partita doppia in core.record_pending_reward (30% utente).
--   4. Risoluzione incoerenza PENDING -> SETTLED -> WITHDRAWABLE senza residui bloccati.
--   5. Tabella persistente core.payout_requests e ciclo atomico prelievi:
--      request_payout_atomic -> approve_payout_atomic -> complete_payout_atomic / reject_payout_atomic.
-- Nota: Compatibile con dati già presenti; non altera retroattivamente righe ledger esistenti.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. TRACCIAMENTO MIGRAZIONI APPLICATE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. VINCOLI DI INTEGRITÀ NON-NEGATIVITÀ (COMPATIBILI CON PARTITA DOPPIA)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative') THEN
        ALTER TABLE core.balances DROP CONSTRAINT balance_non_negative;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative_users') THEN
        ALTER TABLE core.balances
            ADD CONSTRAINT balance_non_negative_users
            CHECK (LEFT(account_id, 5) <> 'USER_' OR balance >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative_system_assets') THEN
        ALTER TABLE core.balances
            ADD CONSTRAINT balance_non_negative_system_assets
            CHECK (
                account_id NOT IN ('SYSTEM:TREASURY_CASH', 'SYSTEM:PLATFORM_REVENUE', 'SYSTEM:PAID')
                OR balance >= 0
            );
    END IF;
END $$;

-- Assicura esistenza conti di sistema principali
INSERT INTO core.accounts (account_id, account_type, user_id) VALUES
    ('SYSTEM:UNEARNED_REVENUE', 'SYSTEM_LIABILITY', NULL),
    ('SYSTEM:ACCRUED_LIABILITIES', 'SYSTEM_LIABILITY', NULL),
    ('SYSTEM:TREASURY_CASH', 'SYSTEM_ASSET', NULL),
    ('SYSTEM:PLATFORM_MARGIN', 'SYSTEM_EQUITY', NULL),
    ('SYSTEM:PLATFORM_REVENUE', 'SYSTEM_EQUITY', NULL),
    ('SYSTEM:PAID', 'SYSTEM_LIABILITY', NULL)
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO core.balances (account_id, balance) VALUES
    ('SYSTEM:UNEARNED_REVENUE', 0),
    ('SYSTEM:ACCRUED_LIABILITIES', 0),
    ('SYSTEM:TREASURY_CASH', 0),
    ('SYSTEM:PLATFORM_MARGIN', 0),
    ('SYSTEM:PLATFORM_REVENUE', 0),
    ('SYSTEM:PAID', 0)
ON CONFLICT (account_id) DO NOTHING;

-- Assicura colonne mancanti su core.users riferite da funzioni storiche (001/004)
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS session_started_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS ton_balance NUMERIC(18, 6) NOT NULL DEFAULT 0;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS gram_balance BIGINT NOT NULL DEFAULT 0;

-- Colonna per tracciare la quota utente già allocata in PENDING senza riscrivere righe storiche
ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS user_pending_points BIGINT;

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reward_events_partner_status_created
    ON core.reward_events (partner_id, status, created_at);

-- ----------------------------------------------------------------------------
-- 3. RECORD PENDING REWARD — IDEMPOTENZA RIGIDA + PARTITA DOPPIA + 30% UTENTE
--    Scala: 100 PT = $1.00 USD | Ripartizione: 70% piattaforma / 30% utente
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.record_pending_reward(
    p_event_id TEXT,
    p_partner_id TEXT,
    p_user_id BIGINT,
    p_raw_points BIGINT,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
    v_inserted_event_id TEXT;
    v_user_pending BIGINT;
    v_tx_id UUID;
    v_curr_exposure BIGINT;
    v_max_exposure BIGINT;
BEGIN
    IF p_event_id IS NULL OR length(trim(p_event_id)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_ID_REQUIRED');
    END IF;

    IF p_raw_points IS NULL OR p_raw_points <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_RAW_POINTS');
    END IF;

    -- Assicura esistenza account utente e 4 bucket
    PERFORM core.ensure_user_accounts(p_user_id, 'User', 'ZONE_C', 0.20, NULL);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    -- Quota utente max 30% del lordo riconosciuto dal partner (FLOOR evita arrotondamenti > 30%)
    v_user_pending := FLOOR(p_raw_points * 0.30);

    -- Inserimento strettamente idempotente
    INSERT INTO core.reward_events (
        event_id, partner_id, user_id, raw_points, user_pending_points, status, payload_json
    )
    VALUES (
        p_event_id, p_partner_id, p_user_id, p_raw_points, v_user_pending, 'PENDING', COALESCE(p_payload_json, '{}'::jsonb)
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id INTO v_inserted_event_id;

    -- Se già esistente, NON toccare saldi o esposizione
    IF v_inserted_event_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'added_pending_points', 0,
            'event_id', p_event_id
        );
    END IF;

    -- Assicura riga esposizione partner se nuovo partner
    INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, status)
    VALUES (p_partner_id, p_partner_id, 500000, 'ACTIVE')
    ON CONFLICT (partner_id) DO NOTHING;

    SELECT pending_points_exposure, max_exposure_limit
      INTO v_curr_exposure, v_max_exposure
      FROM core.partner_exposure
     WHERE partner_id = p_partner_id
     FOR UPDATE;

    IF v_max_exposure IS NOT NULL AND (v_curr_exposure + v_user_pending) > v_max_exposure THEN
        RAISE EXCEPTION 'PARTNER_EXPOSURE_CAP_EXCEEDED';
    END IF;

    IF v_user_pending > 0 THEN
        -- Double-Entry: +v_user_pending su USER_*:PENDING, -v_user_pending su SYSTEM:UNEARNED_REVENUE
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('PARTNER_PENDING', p_event_id, 'Accredito Pending 30% da partner ' || p_partner_id)
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
         WHERE partner_id = p_partner_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'added_pending_points', v_user_pending,
        'raw_points', p_raw_points,
        'event_id', p_event_id
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. PARTNER CONFIRM REWARD — SBLOCCO PULITO PENDING -> SETTLED + 70% PLATFORM
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.partner_confirm_reward(
    p_event_id TEXT,
    p_status TEXT DEFAULT 'VERIFIED' -- 'VERIFIED' | 'REVOKED'
) RETURNS JSONB AS $$
DECLARE
    v_event core.reward_events%ROWTYPE;
    v_pending_alloc BIGINT;
    v_user_pending_bal BIGINT;
    v_release_amount BIGINT;
    v_platform_revenue_points BIGINT;
    v_tx_id UUID;
BEGIN
    SELECT * INTO v_event FROM core.reward_events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
    END IF;

    IF v_event.status IN ('SETTLED', 'REVOKED') THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'action', v_event.status);
    END IF;

    v_pending_alloc := COALESCE(v_event.user_pending_points, GREATEST(0, ROUND(v_event.raw_points * 0.30)));

    SELECT balance INTO v_user_pending_bal
      FROM core.balances
     WHERE account_id = 'USER_' || v_event.user_id || ':PENDING'
     FOR UPDATE;

    v_release_amount := LEAST(COALESCE(v_user_pending_bal, 0), v_pending_alloc);

    IF p_status = 'REVOKED' THEN
        IF v_release_amount > 0 THEN
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

        UPDATE core.reward_events SET status = 'REVOKED', updated_at = NOW() WHERE event_id = p_event_id;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
               updated_at = NOW()
         WHERE partner_id = v_event.partner_id;

        RETURN jsonb_build_object('success', true, 'action', 'REVOKED', 'revoked_points', v_release_amount);
    END IF;

    v_platform_revenue_points := GREATEST(0, v_event.raw_points - v_pending_alloc);

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('USER_' || v_event.user_id || ':SETTLED', 'USER_SETTLED', v_event.user_id)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('USER_' || v_event.user_id || ':SETTLED', 0)
    ON CONFLICT (account_id) DO NOTHING;

    PERFORM 1 FROM core.balances WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED' FOR UPDATE;

    IF v_release_amount > 0 OR v_platform_revenue_points > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('REWARD_VERIFY', p_event_id, 'Conferma S2S Ricompensa ' || p_event_id)
        RETURNING tx_id INTO v_tx_id;

        IF v_release_amount > 0 THEN
            INSERT INTO core.ledger_entries (tx_id, account_id, amount)
            VALUES
                (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_release_amount),
                (v_tx_id, 'USER_' || v_event.user_id || ':SETTLED', v_release_amount);

            UPDATE core.balances SET balance = balance - v_release_amount, updated_at = NOW()
             WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

            UPDATE core.balances SET balance = balance + v_release_amount, updated_at = NOW()
             WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED';
        END IF;

        IF v_platform_revenue_points > 0 THEN
            INSERT INTO core.ledger_entries (tx_id, account_id, amount)
            VALUES
                (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_platform_revenue_points),
                (v_tx_id, 'SYSTEM:PLATFORM_REVENUE', v_platform_revenue_points);

            UPDATE core.balances SET balance = balance - v_platform_revenue_points, updated_at = NOW()
             WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

            UPDATE core.balances SET balance = balance + v_platform_revenue_points, updated_at = NOW()
             WHERE account_id = 'SYSTEM:PLATFORM_REVENUE';
        END IF;
    END IF;

    UPDATE core.reward_events SET status = 'SETTLED', updated_at = NOW() WHERE event_id = p_event_id;

    UPDATE core.partner_exposure
       SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
           updated_at = NOW()
     WHERE partner_id = v_event.partner_id;

    RETURN jsonb_build_object(
        'success', true,
        'action', 'SETTLED',
        'user_settled_points', v_release_amount,
        'platform_revenue_points', v_platform_revenue_points
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 5. EXECUTE BATCH SETTLEMENT — LIQUIDAZIONE BATCH CON HAIRCUT SENZA RESIDUI
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
    v_actual_net NUMERIC := GREATEST(0, COALESCE(p_actual_net_usd, 0));
    v_points_capacity BIGINT := FLOOR(v_actual_net * 100);
    v_remaining_capacity BIGINT := FLOOR(v_actual_net * 100);
    v_total_raw_points BIGINT := 0;
    v_settled_count INT := 0;
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
    -- Idempotenza sul batch
    IF EXISTS (
        SELECT 1 FROM core.ledger_transactions
         WHERE reference_type = 'SETTLEMENT' AND reference_id = p_batch_id
    ) THEN
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'batch_id', p_batch_id,
            'partner_id', p_partner_id,
            'settled_users_count', 0,
            'total_points_settled', 0
        );
    END IF;

    -- Aggiorna cassa reale di tesoreria USDT
    IF v_actual_net > 0 THEN
        INSERT INTO core.treasury_vault (asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent)
        VALUES ('USDT', v_actual_net, v_points_capacity, 0.15)
        ON CONFLICT (asset) DO UPDATE
        SET actual_cash_on_chain = core.treasury_vault.actual_cash_on_chain + EXCLUDED.actual_cash_on_chain,
            points_equivalent_capacity = core.treasury_vault.points_equivalent_capacity + EXCLUDED.points_equivalent_capacity,
            updated_at = NOW();
    END IF;

    -- Calcola il totale lordo degli eventi PENDING nel periodo e limita il ratio ai ricavi effettivamente incassati
    SELECT COALESCE(SUM(raw_points), 0) INTO v_total_raw_points
      FROM core.reward_events
     WHERE partner_id = p_partner_id
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

    -- Itera sugli eventi PENDING del partner nel periodo con lock FOR UPDATE
    FOR v_event IN
        SELECT event_id, user_id, raw_points, user_pending_points
          FROM core.reward_events
         WHERE partner_id = p_partner_id
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

        -- Cap rigoroso sulla cassa effettivamente incassata (user + platform <= v_remaining_capacity)
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

        IF v_pending_alloc > 0 OR v_platform_rev > 0 THEN
            INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
            VALUES ('BATCH_SETTLEMENT_USER', v_event.event_id, 'Liquidazione Evento ' || v_event.event_id || ' Batch ' || p_batch_id)
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

        UPDATE core.reward_events
           SET status = 'SETTLED',
               batch_id = p_batch_id,
               updated_at = NOW()
         WHERE event_id = v_event.event_id;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
               updated_at = NOW()
         WHERE partner_id = p_partner_id;

        v_settled_count := v_settled_count + 1;
        v_total_points_settled := v_total_points_settled + v_user_settled;
    END LOOP;

    IF v_points_capacity > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('SETTLEMENT', p_batch_id, 'Liquidazione Tesoreria Batch ' || p_partner_id || ' ratio ' || v_effective_ratio)
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

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'batch_id', p_batch_id,
        'partner_id', p_partner_id,
        'settled_users_count', v_settled_count,
        'total_points_settled', v_total_points_settled,
        'haircut_ratio', v_effective_ratio,
        'onchain_tx_hash', p_onchain_tx_hash
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. TABELLA PERSISTENTE RICHIESTE PRELIEVO + FUNZIONI ATOMICHE (FASE 4)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.payout_requests (
    request_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES core.users(user_id),
    idempotency_key TEXT UNIQUE NOT NULL,
    points BIGINT NOT NULL CHECK (points >= 500),
    amount_usd NUMERIC(14, 2) NOT NULL CHECK (amount_usd > 0),
    amount_ton NUMERIC(18, 6) NOT NULL CHECK (amount_ton > 0),
    crypto_asset TEXT NOT NULL,
    payout_channel TEXT NOT NULL CHECK (payout_channel IN ('CASH_LOCAL', 'CRYPTO_DIRECT')),
    wallet_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED')),
    payout_status TEXT NOT NULL DEFAULT 'PENDING_ADMIN_DISBURSEMENT',
    tx_hash TEXT,
    note TEXT,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_user_created
    ON core.payout_requests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_requests_status_created
    ON core.payout_requests (status, created_at DESC);

-- 6a. RICHIESTA PRELIEVO ATOMICA: WITHDRAWABLE -> RESERVED
CREATE OR REPLACE FUNCTION core.request_payout_atomic(
    p_request_id TEXT,
    p_user_id BIGINT,
    p_points BIGINT,
    p_crypto_asset TEXT,
    p_payout_channel TEXT,
    p_wallet_address TEXT,
    p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
    v_existing core.payout_requests%ROWTYPE;
    v_user core.users%ROWTYPE;
    v_withdrawable BIGINT;
    v_tx_id UUID;
    v_usd NUMERIC(14, 2);
    v_ton NUMERIC(18, 6);
BEGIN
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_KEY_REQUIRED');
    END IF;

    -- Serializza richieste concorrenti con identica idempotency_key prima della SELECT
    PERFORM pg_advisory_xact_lock(hashtext('payout_req_' || p_idempotency_key));

    -- Idempotenza: se la stessa richiesta è già stata registrata, restituiscila senza doppio addebito
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

    -- Assicura conti utente e blocca la riga utente
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

    -- Scala 100 PT = $1.00 USD | 1 PT = 0.002 TON
    v_usd := ROUND((p_points * 0.01)::numeric, 2);
    v_ton := ROUND((p_points * 0.002)::numeric, 6);

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('WITHDRAW_REQUEST', p_request_id, 'Riserva prelievo ' || p_crypto_asset || ' utente ' || p_user_id)
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
        crypto_asset, payout_channel, wallet_address, status, payout_status
    ) VALUES (
        p_request_id, p_user_id, p_idempotency_key, p_points, v_usd, v_ton,
        UPPER(p_crypto_asset), p_payout_channel, trim(p_wallet_address), 'PENDING', 'PENDING_ADMIN_DISBURSEMENT'
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'payout', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

-- 6b. APPROVAZIONE AMMINISTRATIVA: PENDING -> APPROVED
CREATE OR REPLACE FUNCTION core.approve_payout_atomic(
    p_request_id TEXT,
    p_admin_actor TEXT DEFAULT 'admin',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
BEGIN
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
           note = COALESCE(p_note, note, 'Approvato dall''amministratore per erogazione manuale'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

-- 6c. COMPLETAMENTO PRELIEVO VERIFICATO: RESERVED -> SYSTEM:PAID (richiede hash/ricevuta reale)
CREATE OR REPLACE FUNCTION core.complete_payout_atomic(
    p_request_id TEXT,
    p_tx_hash TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_clean_hash TEXT := trim(COALESCE(p_tx_hash, ''));
    v_reserved_bal BIGINT;
    v_tx_id UUID;
BEGIN
    IF length(v_clean_hash) < 8
       OR v_clean_hash ~* '^(sim_|fake_|mock_|test_|tx_confirmed_|tx_onchain_)' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REAL_VERIFIABLE_TX_HASH_REQUIRED');
    END IF;

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.status = 'COMPLETED' THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'payout', row_to_json(v_payout));
    END IF;

    IF v_payout.status NOT IN ('PENDING', 'APPROVED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE_TRANSITION_' || v_payout.status);
    END IF;

    SELECT balance INTO v_reserved_bal
      FROM core.balances
     WHERE account_id = 'USER_' || v_payout.user_id || ':RESERVED'
     FOR UPDATE;

    IF COALESCE(v_reserved_bal, 0) < v_payout.points THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_RESERVED_BALANCE');
    END IF;

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

-- 6d. RIFIUTO / RIMBORSO ATOMICO: RESERVED -> WITHDRAWABLE
CREATE OR REPLACE FUNCTION core.reject_payout_atomic(
    p_request_id TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_reserved_bal BIGINT;
    v_tx_id UUID;
BEGIN
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
-- 7. ESTENSIONE CLAIM_BLOCK_ATOMIC: registra anche reward_event PENDING (100 raw / 30 user)
--    cosi il ciclo PENDING -> SETTLED -> WITHDRAWABLE è completo anche per i blocchi 10m
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.claim_block_atomic(
    p_user_id BIGINT,
    p_idempotency_key TEXT,
    p_partner_id TEXT,
    p_client_now_ms BIGINT,
    p_timezone TEXT DEFAULT NULL,
    p_now_ms BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
    v_ten_min_ms BIGINT := 600000;
    v_points_to_add BIGINT := 30;
    v_tx_id UUID;
    v_curr_exposure BIGINT;
    v_max_exposure BIGINT;
    v_existing_status TEXT;
    v_existing_resp JSONB;
    v_now_ms BIGINT := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
    v_tz TEXT := 'UTC';
    v_today DATE;
    v_block INT := 1;
    v_reset_applied BOOLEAN := FALSE;
BEGIN
    SELECT status, response_payload INTO v_existing_status, v_existing_resp
      FROM core.idempotency_keys
     WHERE idempotency_key = p_idempotency_key FOR UPDATE;

    IF v_existing_status = 'COMPLETED' THEN
        RETURN v_existing_resp;
    ELSIF v_existing_status = 'PROCESSING' THEN
        RETURN jsonb_build_object('success', false, 'error', 'CONCURRENT_REQUEST_IN_PROGRESS');
    END IF;

    PERFORM core.ensure_user_accounts(p_user_id, 'User', 'ZONE_C', 0.20, p_timezone);

    INSERT INTO core.idempotency_keys (idempotency_key, user_id, operation, status)
    VALUES (p_idempotency_key, p_user_id, 'CLAIM_BLOCK', 'PROCESSING')
    ON CONFLICT (idempotency_key) DO NOTHING;

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    IF v_user.is_blocked THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    IF v_user.last_claim_time > 0 AND (v_now_ms - v_user.last_claim_time) < v_ten_min_ms THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BLOCK_NOT_EXPIRED',
            'remaining_seconds', CEIL((v_ten_min_ms - (v_now_ms - v_user.last_claim_time)) / 1000)
        );
    END IF;

    v_tz := 'UTC';
    IF v_user.timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_user.timezone) THEN
        v_tz := v_user.timezone;
    END IF;

    IF p_timezone IS NOT NULL
       AND p_timezone <> v_tz
       AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        v_tz := p_timezone;
        UPDATE core.users
           SET timezone = v_tz,
               last_reset_date = (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
               updated_at = NOW()
         WHERE user_id = p_user_id;
        v_user.timezone := v_tz;
        v_user.last_reset_date := (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date;
    END IF;

    v_today := (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date;
    IF v_user.last_reset_date IS NULL OR v_today > v_user.last_reset_date THEN
        v_block := 1;
        v_reset_applied := TRUE;
        UPDATE core.users
           SET current_block = 1,
               last_reset_date = v_today,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    ELSE
        v_block := v_user.current_block;
    END IF;

    INSERT INTO core.partner_exposure (partner_id, parent_broker, max_exposure_limit, status)
    VALUES (p_partner_id, p_partner_id, 1000000, 'ACTIVE')
    ON CONFLICT (partner_id) DO NOTHING;

    SELECT pending_points_exposure, max_exposure_limit INTO v_curr_exposure, v_max_exposure
      FROM core.partner_exposure WHERE partner_id = p_partner_id FOR UPDATE;

    IF v_max_exposure IS NOT NULL AND (v_curr_exposure + v_points_to_add) > v_max_exposure THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'PARTNER_EXPOSURE_CAP_EXCEEDED');
    END IF;

    v_points_to_add := 30;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('CLAIM_BLOCK', p_idempotency_key, 'Accredito Blocco Pendente ' || v_block)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || p_user_id || ':PENDING', v_points_to_add),
        (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_points_to_add);

    UPDATE core.balances SET balance = balance + v_points_to_add, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':PENDING';

    UPDATE core.balances SET balance = balance - v_points_to_add, updated_at = NOW()
     WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

    INSERT INTO core.reward_events (
        event_id, partner_id, user_id, raw_points, user_pending_points, status, source, payload_json
    ) VALUES (
        'claim_' || p_idempotency_key,
        p_partner_id,
        p_user_id,
        100,
        v_points_to_add,
        'PENDING',
        'SESSION_BLOCK',
        jsonb_build_object('block', v_block, 'local_date', v_today)
    )
    ON CONFLICT (event_id) DO NOTHING;

    UPDATE core.users
       SET last_claim_time = v_now_ms,
           current_block = LEAST(4, v_block + 1),
           updated_at = NOW()
     WHERE user_id = p_user_id;

    UPDATE core.partner_exposure
       SET pending_points_exposure = pending_points_exposure + v_points_to_add,
           updated_at = NOW()
     WHERE partner_id = p_partner_id;

    v_existing_resp := jsonb_build_object(
        'success', true,
        'added_pending_points', v_points_to_add,
        'next_block', LEAST(4, v_block + 1),
        'last_claim_time', v_now_ms,
        'reset_applied', v_reset_applied,
        'timezone', v_tz,
        'local_date', v_today
    );

    UPDATE core.idempotency_keys
       SET status = 'COMPLETED',
           response_payload = v_existing_resp,
           completed_at = NOW()
     WHERE idempotency_key = p_idempotency_key;

    RETURN v_existing_resp;
END;
$$ LANGUAGE plpgsql;

COMMIT;
