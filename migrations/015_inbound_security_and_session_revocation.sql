-- ============================================================================
-- MIGRATION: 015_inbound_security_and_session_revocation.sql
-- DESCRIZIONE:
--   1. Tabella di audit `core.inbound_security_logs` e funzione
--      `core.log_inbound_security_event` con classificazione proporzionata
--      (TECHNICAL_ERROR, SUSPICIOUS_BEHAVIOR, REPLAY_ATTEMPT, INVALID_SIGNATURE,
--       UNAUTHORIZED_URL) senza penalizzare i fornitori per errori tecnici.
--   2. Supporto stato `REVOKED` su `core.auto_sessions` e funzione atomica
--      `core.revoke_auto_session`: la revoca blocca subito sia nuove interazioni
--      sia nuovi accrediti postback su sessioni revocate/cancellate/scadute.
--   3. Aggiornamento non distruttivo di `core.record_verified_interaction_postback`
--      per verificare `v_session.status NOT IN ('CANCELLED', 'REVOKED', 'EXPIRED')`.
--   4. Allineamento fail-closed di `cpx` (bandito da policy dirette) e blocco
--      idempotente di separazione privilegi DB (`actionflow_app`, `actionflow_auditor`).
--
-- NOTA: Migrazione incrementale non distruttiva; NON eseguire su Neon senza
--       autorizzazione esplicita. Preserva 001-014.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. LOG SICUREZZA INBOUND & CLASSIFICAZIONE PROPORZIONATA ANOMALIE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.inbound_security_logs (
    log_id BIGSERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL,
    provider_id TEXT,
    user_id BIGINT,
    anomaly_category TEXT NOT NULL CHECK (anomaly_category IN (
        'TECHNICAL_ERROR',
        'SUSPICIOUS_BEHAVIOR',
        'REPLAY_ATTEMPT',
        'INVALID_SIGNATURE',
        'UNAUTHORIZED_URL'
    )),
    error_code TEXT NOT NULL,
    source_ip TEXT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_security_logs_created
    ON core.inbound_security_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_security_logs_cat_prov
    ON core.inbound_security_logs (anomaly_category, provider_id, created_at DESC);

CREATE OR REPLACE FUNCTION core.log_inbound_security_event(
    p_endpoint TEXT,
    p_provider_id TEXT,
    p_user_id BIGINT,
    p_anomaly_category TEXT,
    p_error_code TEXT,
    p_source_ip TEXT DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb
) RETURNS BIGINT AS $$
DECLARE
    v_cat TEXT := upper(trim(COALESCE(p_anomaly_category, 'TECHNICAL_ERROR')));
    v_prov TEXT := NULLIF(lower(trim(COALESCE(p_provider_id, ''))), '');
    v_log_id BIGINT;
BEGIN
    IF v_cat NOT IN (
        'TECHNICAL_ERROR',
        'SUSPICIOUS_BEHAVIOR',
        'REPLAY_ATTEMPT',
        'INVALID_SIGNATURE',
        'UNAUTHORIZED_URL'
    ) THEN
        v_cat := 'TECHNICAL_ERROR';
    END IF;

    INSERT INTO core.inbound_security_logs (
        endpoint, provider_id, user_id, anomaly_category, error_code, source_ip, details_json
    ) VALUES (
        COALESCE(NULLIF(trim(p_endpoint), ''), 'unknown'),
        v_prov,
        p_user_id,
        v_cat,
        COALESCE(NULLIF(trim(p_error_code), ''), 'UNKNOWN_ERROR'),
        NULLIF(trim(COALESCE(p_source_ip, '')), ''),
        COALESCE(p_details, '{}'::jsonb)
    )
    RETURNING log_id INTO v_log_id;

    -- Gestione proporzionata: gli errori tecnici (TECHNICAL_ERROR) non penalizzano
    -- la reputazione fornitore; replay/URL non autorizzati/anomalie sospette su
    -- provider registrati vengono registrati nell'audit provider senza ban cieco
    -- su singola firma falsificabile da terzi.
    IF v_prov IS NOT NULL
       AND v_cat IN ('REPLAY_ATTEMPT', 'UNAUTHORIZED_URL', 'SUSPICIOUS_BEHAVIOR')
       AND EXISTS (SELECT 1 FROM core.provider_reputation WHERE provider_id = v_prov) THEN
        INSERT INTO core.provider_audit_log (provider_id, action, details)
        VALUES (
            v_prov,
            'INBOUND_' || v_cat,
            jsonb_build_object(
                'log_id', v_log_id,
                'endpoint', p_endpoint,
                'error_code', p_error_code,
                'details', COALESCE(p_details, '{}'::jsonb)
            )
        );
    END IF;

    RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 2. REVOCA ATOMICA SESSIONI AUTOMATICHE & BLOCCO POSTBACK NON AUTORIZZATI
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_con RECORD;
BEGIN
    FOR v_con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'core.auto_sessions'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%status%'
           AND pg_get_constraintdef(oid) NOT ILIKE '%REVOKED%'
    LOOP
        EXECUTE format('ALTER TABLE core.auto_sessions DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auto_sessions_status_check_v2') THEN
        ALTER TABLE core.auto_sessions
            ADD CONSTRAINT auto_sessions_status_check_v2
            CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REVOKED'));
    END IF;
END $$;

ALTER TABLE core.auto_sessions
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revoked_by TEXT;

CREATE OR REPLACE FUNCTION core.revoke_auto_session(
    p_session_id TEXT,
    p_reason TEXT DEFAULT 'ADMIN_REVOKED',
    p_actor TEXT DEFAULT 'admin'
) RETURNS JSONB AS $$
DECLARE
    v_session core.auto_sessions%ROWTYPE;
    v_clean_id TEXT := trim(COALESCE(p_session_id, ''));
    v_actor TEXT := COALESCE(NULLIF(trim(p_actor), ''), 'admin');
    v_reason TEXT := COALESCE(NULLIF(trim(p_reason), ''), 'ADMIN_REVOKED');
BEGIN
    IF length(v_clean_id) < 8 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_SESSION_ID');
    END IF;

    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = v_clean_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SESSION_NOT_FOUND');
    END IF;

    IF v_session.status = 'REVOKED' THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'session', row_to_json(v_session));
    END IF;

    UPDATE core.auto_sessions
       SET status = 'REVOKED',
           revoked_at = NOW(),
           revoked_by = v_actor,
           ended_at = COALESCE(ended_at, NOW()),
           end_reason = v_reason,
           updated_at = NOW()
     WHERE session_id = v_clean_id
     RETURNING * INTO v_session;

    -- Chiude eventuali interazioni ancora aperte senza accredito per impedirne la riapertura
    UPDATE core.session_interactions
       SET status = 'REJECTED',
           payload_json = payload_json || jsonb_build_object('closed_reason', 'SESSION_REVOKED', 'revoked_by', v_actor),
           updated_at = NOW()
     WHERE session_id = v_clean_id
       AND status = 'CLICK_REGISTERED'
       AND reward_event_id IS NULL;

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'AUTO_SESSION_REVOKED',
        v_actor,
        v_clean_id,
        jsonb_build_object('user_id', v_session.user_id, 'reason', v_reason)
    );

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'session', row_to_json(v_session));
END;
$$ LANGUAGE plpgsql;

-- Aggiorna `core.record_verified_interaction_postback` mantenendo firma e
-- formula PPP invariante (30% * PPP / >=70% piattaforma), aggiungendo il controllo
-- esplicito sullo stato autorizzativo della sessione automatizzata.
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
    v_session core.auto_sessions%ROWTYPE;
    v_provider core.provider_reputation%ROWTYPE;
    v_curr_exposure BIGINT;
    v_max_exposure BIGINT;
    v_exp_status TEXT;
    v_raw_points BIGINT;
    v_ppp_coef NUMERIC(6, 4);
    v_user_pending BIGINT;
    v_platform_margin BIGINT;
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
            'platform_margin_points', v_existing_event.platform_margin_points,
            'ppp_coefficient', v_existing_event.ppp_coefficient,
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

    -- Lock e verifica stato autorizzativo della sessione automatica collegata:
    -- una sessione revocata/cancellata/scaduta impedisce nuovi accrediti.
    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = v_interaction.session_id
     FOR UPDATE;
    IF NOT FOUND OR v_session.status IN ('CANCELLED', 'REVOKED', 'EXPIRED') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'AUTO_SESSION_REVOKED_OR_EXPIRED',
            'session_status', COALESCE(v_session.status, 'MISSING')
        );
    END IF;

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

    v_ppp_coef := core.get_country_ppp_coefficient(v_user.market_country);
    v_user_pending := FLOOR(v_raw_points * 0.30 * v_ppp_coef)::BIGINT;
    v_platform_margin := GREATEST(0, v_raw_points - v_user_pending);

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
        ppp_coefficient, platform_margin_points,
        status, source, interaction_id, click_id, session_id,
        gross_usd, revenue_state, payload_json
    ) VALUES (
        v_clean_event, v_clean_prov, p_user_id, v_raw_points, v_user_pending,
        v_ppp_coef, v_platform_margin,
        'PENDING', 'S2S_POSTBACK', v_interaction.interaction_id, v_interaction.click_id, v_interaction.session_id,
        ROUND(p_confirmed_gross_usd::numeric, 4), 'CONFIRMED_UNSETTLED', COALESCE(p_payload_json, '{}'::jsonb)
    );

    IF v_user_pending > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES (
            'PARTNER_PENDING',
            v_clean_event,
            'Pending 30% * PPP(' || v_ppp_coef || ') confermato da ' || v_clean_prov || ' (interazione ' || v_interaction.interaction_id || ')'
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
           ppp_coefficient = v_ppp_coef,
           platform_margin_points = v_platform_margin,
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
        'ppp_coefficient', v_ppp_coef,
        'added_pending_points', v_user_pending,
        'platform_margin_points', v_platform_margin,
        'revenue_state', 'CONFIRMED_UNSETTLED',
        'cash_collected', false
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. ALLINEAMENTO PROVIDER BANDITO `cpx` SU REPUTATION & EXPOSURE
-- ----------------------------------------------------------------------------
UPDATE core.provider_reputation
   SET status = 'BANNED',
       quarantine_reason = 'BANNED_BY_DIRECT_PROVIDER_POLICY',
       updated_at = NOW()
 WHERE provider_id = 'cpx'
   AND status <> 'BANNED';

UPDATE core.partner_exposure
   SET status = 'REVOKED',
       updated_at = NOW()
 WHERE partner_id = 'cpx'
   AND status <> 'REVOKED';

-- ----------------------------------------------------------------------------
-- 4. MODELLO SEPARAZIONE PRIVILEGI DB (MINIMO PRIVILEGIO OPERATIVO vs AUDIT)
--    Protetto da handler insufficient_privilege per compatibilita' Neon branch.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_auditor') THEN
        CREATE ROLE actionflow_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    GRANT USAGE ON SCHEMA core TO actionflow_auditor;
    GRANT SELECT ON core.ledger_transactions, core.ledger_entries, core.balances,
                    core.payout_requests, core.settlement_batches,
                    core.treasury_vault, core.treasury_conversions,
                    core.security_audit_logs, core.inbound_security_logs,
                    core.v_treasury_solvency, core.v_treasury_vault_status
                 TO actionflow_auditor;
EXCEPTION
    WHEN insufficient_privilege THEN
        NULL;
END $$;

COMMIT;
