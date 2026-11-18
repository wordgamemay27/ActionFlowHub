-- ============================================================================
-- MIGRATION: 009_unified_auto_session_and_interactions.sql
-- DESCRIZIONE:
--   1. Sostituisce concettualmente le vecchie sessioni a durata 10/20/30 minuti
--      con un'unica sessione automatizzata persistente (`core.auto_sessions`),
--      preservando integralmente tutti i dati storici delle migrazioni 001-008.
--   2. Introduce `core.session_interactions` con `interaction_id` e `click_id`
--      univoci, collegati a sessione, utente, fornitore (`core.provider_reputation`)
--      e collegamento nullable 1:1 a `core.reward_events`.
--   3. Disattiva in modo sicuro (`fail-closed`) i crediti automatici basati sul
--      timer 600s / +30 PT in `core.claim_block_atomic`, senza alterare lo storico.
--   4. Impone la riconciliazione obbligatoria clic/interazione -> postback S2S ->
--      PENDING (non incassato) -> settlement reale su incasso verificato
--      (`execute_batch_settlement`) -> `SETTLED` -> `WITHDRAWABLE` (protetto da
--      solvibilità tesoreria in `core.treasury_vault`).
--   5. Elimina il tasso fisso `0.002 TON/PT` introducendo `core.fx_price_snapshots`
--      con blocco automatico dei pagamenti se il prezzo aggiornato non è disponibile.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. ADEGUAMENTO NON DISTRUTTIVO DI `core.users` E `core.idempotency_keys`
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_con RECORD;
BEGIN
    -- Rimuove eventuali vincoli CHECK su `session_minutes IN (10, 20, 30)`
    -- preservando i valori storici già salvati nelle righe esistenti.
    FOR v_con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'core.users'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%session_minutes%'
    LOOP
        EXECUTE format('ALTER TABLE core.users DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;

    -- Allarga il vincolo CHECK su `core.idempotency_keys.operation`
    FOR v_con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'core.idempotency_keys'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%operation%'
    LOOP
        EXECUTE format('ALTER TABLE core.idempotency_keys DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;
END $$;

ALTER TABLE core.users ALTER COLUMN session_minutes DROP NOT NULL;
ALTER TABLE core.users ALTER COLUMN session_minutes SET DEFAULT NULL;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'UNIFIED_AUTO';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_session_mode_check') THEN
        ALTER TABLE core.users
            ADD CONSTRAINT users_session_mode_check
            CHECK (session_mode IN ('UNIFIED_AUTO', 'LEGACY_TIMED'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_operation_check_v2') THEN
        ALTER TABLE core.idempotency_keys
            ADD CONSTRAINT idempotency_keys_operation_check_v2
            CHECK (operation IN (
                'CLAIM_BLOCK',
                'WITHDRAWAL_REQUEST',
                'PARTNER_CONVERSION',
                'REWARD_RECORD',
                'AUTO_SESSION_START',
                'INTERACTION_REGISTER',
                'INTERACTION_POSTBACK',
                'SETTLE_WITHDRAWABLE'
            ));
    END IF;
END $$;

-- Disattiva per nuove azioni il partner sintetico `internal_relay` usato dai blocchi 600s
-- (la riga resta intatta per integrità referenziale storica)
UPDATE core.partner_exposure
   SET status = 'REVOKED',
       updated_at = NOW()
 WHERE partner_id = 'internal_relay'
   AND status <> 'REVOKED';

-- ----------------------------------------------------------------------------
-- 2. SESSIONE AUTOMATIZZATA UNICA (`core.auto_sessions`)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.auto_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(trim(session_id)) >= 8),
    user_id BIGINT NOT NULL REFERENCES core.users(user_id) ON DELETE RESTRICT,
    session_mode TEXT NOT NULL DEFAULT 'UNIFIED_AUTO' CHECK (session_mode IN ('UNIFIED_AUTO')),
    selected_categories TEXT[] NOT NULL DEFAULT '{}',
    language TEXT NOT NULL DEFAULT 'it',
    market_country TEXT NOT NULL DEFAULT 'OTHER',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
    interactions_total INT NOT NULL DEFAULT 0 CHECK (interactions_total >= 0),
    interactions_pending INT NOT NULL DEFAULT 0 CHECK (interactions_pending >= 0),
    interactions_settled INT NOT NULL DEFAULT 0 CHECK (interactions_settled >= 0),
    interactions_revoked INT NOT NULL DEFAULT 0 CHECK (interactions_revoked >= 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    end_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT auto_sessions_session_user_unique UNIQUE (session_id, user_id)
);

-- Un solo ciclo automatico ACTIVE per utente alla volta
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_sessions_one_active_per_user
    ON core.auto_sessions(user_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_auto_sessions_user_started
    ON core.auto_sessions(user_id, started_at DESC);

-- ----------------------------------------------------------------------------
-- 3. INTERAZIONI AUTONOME TRACCIATE (`core.session_interactions`)
--    Ogni singola inserzione/video/musica/micro-drama/gioco ha:
--      - interaction_id univoco
--      - click_id univoco
--      - collegamento forte a sessione + utente + fornitore
--      - collegamento nullable 1:1 a core.reward_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.session_interactions (
    interaction_id TEXT PRIMARY KEY CHECK (length(trim(interaction_id)) >= 8),
    click_id TEXT NOT NULL UNIQUE CHECK (length(trim(click_id)) >= 8),
    session_id TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES core.users(user_id) ON DELETE RESTRICT,
    provider_id VARCHAR(64) NOT NULL REFERENCES core.provider_reputation(provider_id) ON DELETE RESTRICT,
    activity_category TEXT NOT NULL CHECK (activity_category IN (
        'VIDEO', 'ADS', 'MUSIC', 'MICRO_DRAMA', 'GAME', 'SURVEY',
        'SHOPPING', 'AI_TASK', 'UX_QA', 'RECEIPT', 'TELEGRAM', 'AIRDROP', 'DEPIN', 'OTHER'
    )),
    task_id TEXT NOT NULL CHECK (length(trim(task_id)) >= 1),
    tracking_url TEXT,
    status TEXT NOT NULL DEFAULT 'CLICK_REGISTERED' CHECK (status IN (
        'CLICK_REGISTERED',
        'POSTBACK_CONFIRMED_PENDING',
        'SETTLED',
        'REVOKED',
        'EXPIRED',
        'REJECTED'
    )),
    reward_event_id TEXT NULL UNIQUE REFERENCES core.reward_events(event_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    provider_status_at_click VARCHAR(24) NOT NULL CHECK (provider_status_at_click IN ('ACTIVE', 'WARNING')),
    provider_reputation_at_click NUMERIC(5, 2) NOT NULL,
    expected_gross_usd NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (expected_gross_usd >= 0),
    confirmed_gross_usd NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (confirmed_gross_usd >= 0),
    user_pending_points BIGINT NOT NULL DEFAULT 0 CHECK (user_pending_points >= 0),
    user_settled_points BIGINT NOT NULL DEFAULT 0 CHECK (user_settled_points >= 0),
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    postback_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_session_interactions_session_user
        FOREIGN KEY (session_id, user_id)
        REFERENCES core.auto_sessions(session_id, user_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_session_interactions_session_created
    ON core.session_interactions(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_interactions_user_status
    ON core.session_interactions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_interactions_provider_status
    ON core.session_interactions(provider_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_interactions_reward_event
    ON core.session_interactions(reward_event_id)
    WHERE reward_event_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. COLLEGAMENTO NULLABLE SU `core.reward_events` E STATI PIPELINE RICAVI
--    Distingue chiaramente:
--      - POSTBACK_UNCOLLECTED      : postback iniziale non verificato sull'incasso
--      - CONFIRMED_UNSETTLED       : conversione confermata dal partner, NON incassata
--      - CASH_COLLECTED_SETTLED    : denaro reale incassato in tesoreria (batch settlement)
--      - WITHDRAWABLE_RELEASED     : fondi resi prelevabili
--      - REVOKED                   : conversione stornata / revocata
-- ----------------------------------------------------------------------------
ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS interaction_id TEXT NULL REFERENCES core.session_interactions(interaction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS click_id TEXT NULL;

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS session_id TEXT NULL REFERENCES core.auto_sessions(session_id) ON DELETE RESTRICT;

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS gross_usd NUMERIC(14, 4) NULL CHECK (gross_usd IS NULL OR gross_usd >= 0);

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS revenue_state TEXT NOT NULL DEFAULT 'POSTBACK_UNCOLLECTED';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_events_revenue_state_check') THEN
        ALTER TABLE core.reward_events
            ADD CONSTRAINT reward_events_revenue_state_check
            CHECK (revenue_state IN (
                'POSTBACK_UNCOLLECTED',
                'CONFIRMED_UNSETTLED',
                'CASH_COLLECTED_SETTLED',
                'WITHDRAWABLE_RELEASED',
                'REVOKED'
            ));
    END IF;
END $$;

-- Allinea solo i metadati di stato pipeline delle righe storiche già chiuse
-- senza modificare saldi o importi.
UPDATE core.reward_events
   SET revenue_state = CASE
       WHEN status = 'SETTLED' THEN 'CASH_COLLECTED_SETTLED'
       WHEN status = 'REVOKED' THEN 'REVOKED'
       ELSE revenue_state
   END
 WHERE status IN ('SETTLED', 'REVOKED')
   AND revenue_state = 'POSTBACK_UNCOLLECTED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_events_interaction_unique
    ON core.reward_events(interaction_id)
    WHERE interaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reward_events_click_id
    ON core.reward_events(click_id)
    WHERE click_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reward_events_revenue_state
    ON core.reward_events(partner_id, revenue_state, status, created_at);

-- ----------------------------------------------------------------------------
-- 5. ORACLE VERIFICABILE DEI PREZZI ASSET (`core.fx_price_snapshots`)
--    Elimina il tasso fisso `0.002 TON/PT` e impone una quotazione fresca e
--    verificabile su `core.payout_requests`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fx_price_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    asset TEXT NOT NULL CHECK (asset IN ('TON', 'SOL', 'USDT', 'USDC', 'PI')),
    quote_currency TEXT NOT NULL DEFAULT 'USD' CHECK (quote_currency = 'USD'),
    usd_per_unit NUMERIC(18, 8) NOT NULL CHECK (usd_per_unit > 0),
    source TEXT NOT NULL CHECK (length(trim(source)) >= 2),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    is_valid BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fx_price_snapshots_window_check CHECK (expires_at > fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_fx_price_snapshots_lookup
    ON core.fx_price_snapshots(asset, is_valid, fetched_at DESC, expires_at DESC);

DO $$
DECLARE
    v_con RECORD;
BEGIN
    -- Consente `amount_ton = 0` per payout non denominati in TON (es. CASH_PAYEER, USDT, SOL)
    -- mantenendo intatti i record storici esistenti.
    FOR v_con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'core.payout_requests'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%amount_ton%'
    LOOP
        EXECUTE format('ALTER TABLE core.payout_requests DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_requests_amount_ton_non_negative') THEN
        ALTER TABLE core.payout_requests
            ADD CONSTRAINT payout_requests_amount_ton_non_negative
            CHECK (amount_ton >= 0);
    END IF;
END $$;

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS fx_snapshot_id BIGINT NULL REFERENCES core.fx_price_snapshots(snapshot_id) ON DELETE RESTRICT;

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS fx_usd_per_asset NUMERIC(18, 8) NULL CHECK (fx_usd_per_asset IS NULL OR fx_usd_per_asset > 0);

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS fx_source TEXT NULL;

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS fx_quoted_at TIMESTAMPTZ NULL;

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS asset_amount NUMERIC(18, 8) NULL CHECK (asset_amount IS NULL OR asset_amount > 0);

-- ----------------------------------------------------------------------------
-- 6. AGGIORNAMENTO FUNZIONI SESSIONE & DISATTIVAZIONE SICURA TIMER 600s (+30 PT)
-- ----------------------------------------------------------------------------

-- 6a. Profilo ingresso: elimina il vincolo 10/20/30 mantenendo compatibilità di firma
CREATE OR REPLACE FUNCTION core.upsert_entry_profile(
    p_user_id BIGINT,
    p_timezone TEXT,
    p_language TEXT,
    p_market_country TEXT,
    p_session_minutes INT,
    p_selected_categories TEXT[],
    p_now_ms BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_tz TEXT := 'UTC';
    v_now_ms BIGINT := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
    v_stored_tz TEXT;
    v_lang TEXT := 'it';
    v_market TEXT := 'OTHER';
    v_categories TEXT[] := '{}';
BEGIN
    IF p_timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        v_tz := p_timezone;
    END IF;
    IF p_language IS NOT NULL AND length(p_language) BETWEEN 2 AND 5 THEN
        v_lang := p_language;
    END IF;
    IF p_market_country IS NOT NULL AND length(p_market_country) BETWEEN 2 AND 8 THEN
        v_market := upper(p_market_country);
    END IF;
    IF p_selected_categories IS NOT NULL THEN
        v_categories := p_selected_categories;
    END IF;

    SELECT timezone INTO v_stored_tz FROM core.users WHERE user_id = p_user_id FOR UPDATE;

    INSERT INTO core.users (
        user_id, username, tier_zone, ppp_multiplier, timezone, last_reset_date,
        language, market_country, session_minutes, session_mode, selected_categories
    ) VALUES (
        p_user_id, 'User', 'ZONE_C', 0.20, v_tz,
        (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
        v_lang, v_market, NULL, 'UNIFIED_AUTO', v_categories
    )
    ON CONFLICT (user_id) DO UPDATE
    SET language = EXCLUDED.language,
        market_country = EXCLUDED.market_country,
        session_mode = 'UNIFIED_AUTO',
        selected_categories = EXCLUDED.selected_categories,
        updated_at = NOW();

    IF v_stored_tz IS NOT NULL AND v_stored_tz <> v_tz THEN
        UPDATE core.users
           SET timezone = v_tz,
               last_reset_date = (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'session_mode', 'UNIFIED_AUTO',
        'timezone', v_tz,
        'language', v_lang,
        'market_country', v_market,
        'selected_categories', to_jsonb(v_categories)
    );
END;
$$ LANGUAGE plpgsql;

-- 6b. Avvio sessione legacy mantenuto compatibile solo per metadati (nessun credito)
CREATE OR REPLACE FUNCTION core.start_session(
    p_user_id BIGINT,
    p_session_minutes INT DEFAULT NULL,
    p_now_ms BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_now_ms BIGINT := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
BEGIN
    PERFORM 1 FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    UPDATE core.users
       SET session_mode = 'UNIFIED_AUTO',
           session_started_at = v_now_ms,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'session_mode', 'UNIFIED_AUTO',
        'session_started_at', v_now_ms,
        'time_based_rewards_enabled', false
    );
END;
$$ LANGUAGE plpgsql;

-- 6c. DISATTIVAZIONE SICURA DI `core.claim_block_atomic`
--     Preserva firma e dati storici in `idempotency_keys`, `reward_events`,
--     `ledger_transactions` e `balances`, ma impedisce qualsiasi nuovo accredito
--     automatico basato sul trascorrere di 600 secondi.
CREATE OR REPLACE FUNCTION core.claim_block_atomic(
    p_user_id BIGINT,
    p_idempotency_key TEXT,
    p_partner_id TEXT,
    p_client_now_ms BIGINT,
    p_timezone TEXT DEFAULT NULL,
    p_now_ms BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_existing_status TEXT;
BEGIN
    SELECT status
      INTO v_existing_status
      FROM core.idempotency_keys
     WHERE idempotency_key = p_idempotency_key;

    RETURN jsonb_build_object(
        'success', false,
        'disabled', true,
        'added_pending_points', 0,
        'historical_preserved', (v_existing_status = 'COMPLETED'),
        'error', 'TIME_BASED_BLOCK_REWARDS_DISABLED',
        'message', 'I crediti automatici a tempo (600s / +30 PT) sono disattivati. Ogni ricompensa richiede una singola interazione tracciata e confermata dal fornitore.'
    );
END;
$$ LANGUAGE plpgsql;

-- 6d. DISATTIVAZIONE SICURA DI `core.verify_user_reward` (004)
--     Previene accrediti single-entry fuori partita doppia su WITHDRAWABLE.
CREATE OR REPLACE FUNCTION core.verify_user_reward(
    p_reward_id TEXT
) RETURNS JSONB AS $$
BEGIN
    RETURN jsonb_build_object(
        'success', false,
        'disabled', true,
        'reward_id', p_reward_id,
        'error', 'DEPRECATED_SINGLE_ENTRY_REWARD_DISABLED'
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 7. FUNZIONI ATOMICHE PER SESSIONE AUTOMATIZZATA UNICA E INTERAZIONI
-- ----------------------------------------------------------------------------

-- 7a. Avvia o riprende la sessione automatizzata unica per l'utente
CREATE OR REPLACE FUNCTION core.start_auto_session(
    p_session_id TEXT,
    p_user_id BIGINT,
    p_selected_categories TEXT[] DEFAULT '{}',
    p_language TEXT DEFAULT 'it',
    p_market_country TEXT DEFAULT 'OTHER',
    p_timezone TEXT DEFAULT 'UTC',
    p_force_new BOOLEAN DEFAULT FALSE,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
    v_existing core.auto_sessions%ROWTYPE;
    v_tz TEXT := 'UTC';
    v_lang TEXT := 'it';
    v_market TEXT := 'OTHER';
    v_cats TEXT[] := COALESCE(p_selected_categories, '{}');
    v_clean_sess_id TEXT := trim(COALESCE(p_session_id, ''));
BEGIN
    IF length(v_clean_sess_id) < 8 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_SESSION_ID');
    END IF;

    IF p_timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        v_tz := p_timezone;
    END IF;
    IF p_language IS NOT NULL AND length(trim(p_language)) BETWEEN 2 AND 5 THEN
        v_lang := lower(trim(p_language));
    END IF;
    IF p_market_country IS NOT NULL AND length(trim(p_market_country)) BETWEEN 2 AND 8 THEN
        v_market := upper(trim(p_market_country));
    END IF;

    PERFORM core.ensure_user_accounts(p_user_id, 'User', 'ZONE_C', 0.20, v_tz);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    -- Idempotenza se lo stesso session_id è già stato creato
    SELECT * INTO v_existing
      FROM core.auto_sessions
     WHERE session_id = v_clean_sess_id
     FOR UPDATE;
    IF FOUND THEN
        IF v_existing.user_id <> p_user_id THEN
            RETURN jsonb_build_object('success', false, 'error', 'SESSION_OWNERSHIP_CONFLICT');
        END IF;
        RETURN jsonb_build_object(
            'success', true,
            'idempotent', true,
            'session', row_to_json(v_existing)
        );
    END IF;

    -- Controlla eventuale altra sessione ACTIVE per lo stesso utente
    SELECT * INTO v_existing
      FROM core.auto_sessions
     WHERE user_id = p_user_id
       AND status = 'ACTIVE'
     FOR UPDATE;

    IF FOUND THEN
        IF NOT COALESCE(p_force_new, FALSE) THEN
            UPDATE core.auto_sessions
               SET selected_categories = CASE WHEN cardinality(v_cats) > 0 THEN v_cats ELSE selected_categories END,
                   language = v_lang,
                   market_country = v_market,
                   timezone = v_tz,
                   last_activity_at = NOW(),
                   updated_at = NOW()
             WHERE session_id = v_existing.session_id
             RETURNING * INTO v_existing;

            RETURN jsonb_build_object(
                'success', true,
                'resumed', true,
                'session', row_to_json(v_existing)
            );
        END IF;

        UPDATE core.auto_sessions
           SET status = 'COMPLETED',
               ended_at = NOW(),
               end_reason = 'REPLACED_BY_NEW_SESSION',
               updated_at = NOW()
         WHERE session_id = v_existing.session_id;
    END IF;

    INSERT INTO core.auto_sessions (
        session_id, user_id, session_mode, selected_categories,
        language, market_country, timezone, status, metadata
    ) VALUES (
        v_clean_sess_id, p_user_id, 'UNIFIED_AUTO', v_cats,
        v_lang, v_market, v_tz, 'ACTIVE', COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_existing;

    UPDATE core.users
       SET session_mode = 'UNIFIED_AUTO',
           selected_categories = v_cats,
           language = v_lang,
           market_country = v_market,
           session_started_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'resumed', false,
        'session', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

-- 7b. Chiusura/pausa esplicita della sessione automatizzata
CREATE OR REPLACE FUNCTION core.close_auto_session(
    p_session_id TEXT,
    p_user_id BIGINT,
    p_target_status TEXT DEFAULT 'COMPLETED',
    p_reason TEXT DEFAULT 'USER_STOPPED'
) RETURNS JSONB AS $$
DECLARE
    v_session core.auto_sessions%ROWTYPE;
    v_target TEXT := upper(trim(COALESCE(p_target_status, 'COMPLETED')));
BEGIN
    IF v_target NOT IN ('PAUSED', 'COMPLETED', 'CANCELLED', 'EXPIRED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_TARGET_SESSION_STATUS');
    END IF;

    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = trim(COALESCE(p_session_id, ''))
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'SESSION_NOT_FOUND');
    END IF;

    IF v_session.user_id <> p_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'SESSION_OWNERSHIP_CONFLICT');
    END IF;

    IF v_session.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'session', row_to_json(v_session));
    END IF;

    UPDATE core.auto_sessions
       SET status = v_target,
           ended_at = CASE WHEN v_target IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN NOW() ELSE NULL END,
           end_reason = COALESCE(NULLIF(trim(p_reason), ''), end_reason),
           updated_at = NOW()
     WHERE session_id = v_session.session_id
     RETURNING * INTO v_session;

    RETURN jsonb_build_object('success', true, 'idempotent', false, 'session', row_to_json(v_session));
END;
$$ LANGUAGE plpgsql;

-- 7c. Registrazione autonoma di una singola interazione / click
--     NOTA: NON genera MAI punti nè movimenti nel ledger.
CREATE OR REPLACE FUNCTION core.register_session_interaction(
    p_interaction_id TEXT,
    p_click_id TEXT,
    p_session_id TEXT,
    p_user_id BIGINT,
    p_provider_id TEXT,
    p_activity_category TEXT,
    p_task_id TEXT,
    p_tracking_url TEXT DEFAULT NULL,
    p_expected_gross_usd NUMERIC DEFAULT 0,
    p_ttl_hours INT DEFAULT 24,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_clean_int TEXT := trim(COALESCE(p_interaction_id, ''));
    v_clean_click TEXT := trim(COALESCE(p_click_id, ''));
    v_clean_sess TEXT := trim(COALESCE(p_session_id, ''));
    v_clean_prov TEXT := trim(COALESCE(p_provider_id, ''));
    v_clean_cat TEXT := upper(trim(COALESCE(p_activity_category, 'OTHER')));
    v_clean_task TEXT := trim(COALESCE(p_task_id, ''));
    v_user core.users%ROWTYPE;
    v_session core.auto_sessions%ROWTYPE;
    v_provider core.provider_reputation%ROWTYPE;
    v_exposure_status TEXT;
    v_existing core.session_interactions%ROWTYPE;
    v_ttl INT := GREATEST(1, LEAST(168, COALESCE(p_ttl_hours, 24)));
BEGIN
    IF length(v_clean_int) < 8 OR length(v_clean_click) < 8 OR length(v_clean_sess) < 8 OR length(v_clean_prov) = 0 OR length(v_clean_task) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_INTERACTION_IDENTIFIERS');
    END IF;

    IF v_clean_cat NOT IN (
        'VIDEO', 'ADS', 'MUSIC', 'MICRO_DRAMA', 'GAME', 'SURVEY',
        'SHOPPING', 'AI_TASK', 'UX_QA', 'RECEIPT', 'TELEGRAM', 'AIRDROP', 'DEPIN', 'OTHER'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_ACTIVITY_CATEGORY');
    END IF;

    -- Serializzazione anti-race deadlock-free su interaction_id e click_id
    IF hashtext('reg_int_' || v_clean_int) <= hashtext('reg_clk_' || v_clean_click) THEN
        PERFORM pg_advisory_xact_lock(hashtext('reg_int_' || v_clean_int));
        PERFORM pg_advisory_xact_lock(hashtext('reg_clk_' || v_clean_click));
    ELSE
        PERFORM pg_advisory_xact_lock(hashtext('reg_clk_' || v_clean_click));
        PERFORM pg_advisory_xact_lock(hashtext('reg_int_' || v_clean_int));
    END IF;

    -- Idempotenza stretta su interaction_id o click_id (senza rischi di TOO_MANY_ROWS)
    SELECT * INTO v_existing
      FROM core.session_interactions
     WHERE interaction_id = v_clean_int OR click_id = v_clean_click
     ORDER BY (interaction_id = v_clean_int) DESC
     LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
        IF v_existing.interaction_id = v_clean_int
           AND v_existing.click_id = v_clean_click
           AND v_existing.session_id = v_clean_sess
           AND v_existing.user_id = p_user_id
           AND v_existing.provider_id = v_clean_prov THEN
            RETURN jsonb_build_object(
                'success', true,
                'idempotent', true,
                'added_points', 0,
                'interaction', row_to_json(v_existing)
            );
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_OR_CLICK_ID_CONFLICT');
    END IF;

    -- Verifica utente e stato blocco
    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    -- Verifica sessione automatizzata attiva e di proprietà dell'utente
    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = v_clean_sess
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTO_SESSION_NOT_FOUND');
    END IF;
    IF v_session.user_id <> p_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTO_SESSION_OWNERSHIP_MISMATCH');
    END IF;
    IF v_session.status <> 'ACTIVE' THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTO_SESSION_NOT_ACTIVE_' || v_session.status);
    END IF;

    -- Controllo stato e reputazione del fornitore (FAIL-CLOSED su QUARANTINE / BANNED / sconosciuto)
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
            'provider_status', v_provider.status,
            'quarantine_reason', v_provider.quarantine_reason
        );
    END IF;

    -- Controllo stato e cap esposizione partner se configurato
    SELECT status INTO v_exposure_status
      FROM core.partner_exposure
     WHERE partner_id = v_clean_prov
       AND (max_exposure_limit IS NULL OR pending_points_exposure < max_exposure_limit)
     FOR SHARE;
    IF FOUND AND v_exposure_status <> 'ACTIVE' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'PARTNER_EXPOSURE_SUSPENDED',
            'partner_status', v_exposure_status
        );
    ELSIF NOT FOUND AND EXISTS (SELECT 1 FROM core.partner_exposure WHERE partner_id = v_clean_prov) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'PARTNER_EXPOSURE_CAP_REACHED'
        );
    END IF;

    INSERT INTO core.session_interactions (
        interaction_id, click_id, session_id, user_id, provider_id,
        activity_category, task_id, tracking_url, status,
        provider_status_at_click, provider_reputation_at_click,
        expected_gross_usd, expires_at, payload_json
    ) VALUES (
        v_clean_int, v_clean_click, v_clean_sess, p_user_id, v_clean_prov,
        v_clean_cat, v_clean_task, NULLIF(trim(COALESCE(p_tracking_url, '')), ''), 'CLICK_REGISTERED',
        v_provider.status, v_provider.reputation_score,
        GREATEST(0, COALESCE(p_expected_gross_usd, 0)),
        NOW() + make_interval(hours => v_ttl),
        COALESCE(p_payload_json, '{}'::jsonb)
    )
    RETURNING * INTO v_existing;

    UPDATE core.auto_sessions
       SET interactions_total = interactions_total + 1,
           last_activity_at = NOW(),
           updated_at = NOW()
     WHERE session_id = v_clean_sess;

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'added_points', 0,
        'interaction', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

-- 7c-bis. Chiusura non remunerata (EXPIRED / REJECTED) di una singola interazione
CREATE OR REPLACE FUNCTION core.expire_or_reject_interaction(
    p_interaction_id TEXT,
    p_target_status TEXT DEFAULT 'EXPIRED',
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_interaction core.session_interactions%ROWTYPE;
    v_target TEXT := upper(trim(COALESCE(p_target_status, 'EXPIRED')));
BEGIN
    IF v_target NOT IN ('EXPIRED', 'REJECTED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_TARGET_INTERACTION_STATUS');
    END IF;

    SELECT * INTO v_interaction
      FROM core.session_interactions
     WHERE interaction_id = trim(COALESCE(p_interaction_id, ''))
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'INTERACTION_NOT_FOUND');
    END IF;

    IF v_interaction.status IN ('EXPIRED', 'REJECTED') THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'interaction', row_to_json(v_interaction));
    END IF;

    IF v_interaction.status <> 'CLICK_REGISTERED' OR v_interaction.reward_event_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'CANNOT_EXPIRE_REWARDED_INTERACTION_' || v_interaction.status);
    END IF;

    UPDATE core.session_interactions
       SET status = v_target,
           payload_json = payload_json || jsonb_build_object('closed_reason', COALESCE(NULLIF(trim(p_reason), ''), v_target)),
           updated_at = NOW()
     WHERE interaction_id = v_interaction.interaction_id
     RETURNING * INTO v_interaction;

    RETURN jsonb_build_object('success', true, 'idempotent', false, 'interaction', row_to_json(v_interaction));
END;
$$ LANGUAGE plpgsql;

-- 7d. Riconciliazione atomica S2S di una singola interazione confermata dal fornitore
--     Registra la ricompensa ESCLUSIVAMENTE come PENDING (`CONFIRMED_UNSETTLED`),
--     applicando il tetto 30% utente (100 PT = $1.00 USD) e la doppia scrittura.
--     NON considera MAI il webhook come prova automatica dell'incasso reale.
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
    v_clean_event TEXT := trim(COALESCE(p_event_id, ''));
    v_clean_click TEXT := NULLIF(trim(COALESCE(p_click_id, '')), '');
    v_clean_int TEXT := NULLIF(trim(COALESCE(p_interaction_id, '')), '');
    v_clean_prov TEXT := trim(COALESCE(p_provider_id, ''));
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

    -- Serializza postback concorrenti sullo stesso event_id
    PERFORM pg_advisory_xact_lock(hashtext('reward_evt_' || v_clean_event));

    -- Idempotenza sul singolo event_id del fornitore con controllo coerenza anti-replay
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

    -- Lock utente e verifica conti contabili
    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    -- Ricerca e lock dell'interazione autentica (lookup univoco senza TOO_MANY_ROWS)
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

    -- Lock sessione automatizzata collegata
    PERFORM 1
      FROM core.auto_sessions
     WHERE session_id = v_interaction.session_id
     FOR UPDATE;

    -- Verifica stato e reputazione fornitore
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

    -- Regola 30% utente con troncamento per difetto (FLOOR <= 30%)
    v_user_pending := FLOOR(v_raw_points * 0.30)::BIGINT;

    -- Esposizione e cap credito partner
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

    -- Assicura esistenza conti utente PENDING e sistema UNEARNED_REVENUE
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

    -- Registra evento ricompensa collegato 1:1 all'interazione (stato PENDING / CONFIRMED_UNSETTLED)
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

-- 7e. Hardening di `core.record_pending_reward` (firma 5 argomenti preservata):
--     impedisce accrediti privi di `click_id` / `interaction_id` autenticati.
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

    RETURN core.confirm_interaction_postback(
        p_event_id,
        v_click_id,
        v_interaction_id,
        p_partner_id,
        p_user_id,
        v_gross_usd,
        p_payload_json
    );
END;
$$ LANGUAGE plpgsql;

-- 7f. Hardening di `core.partner_confirm_reward`:
--     Un webhook di conferma NON sposta fondi in SETTLED o PLATFORM_REVENUE
--     senza incasso reale (solo `execute_batch_settlement` liquida su cassa reale).
--     Supporta invece la revoca atomica (`REVOKED`) con storno da PENDING e aggiornamento
--     dell'interazione/sessione collegata.
CREATE OR REPLACE FUNCTION core.partner_confirm_reward(
    p_event_id TEXT,
    p_status TEXT DEFAULT 'VERIFIED' -- 'VERIFIED' | 'REVOKED'
) RETURNS JSONB AS $$
DECLARE
    v_event core.reward_events%ROWTYPE;
    v_pending_alloc BIGINT;
    v_user_pending_bal BIGINT;
    v_release_amount BIGINT;
    v_tx_id UUID;
BEGIN
    SELECT * INTO v_event FROM core.reward_events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
    END IF;

    IF v_event.status IN ('SETTLED', 'REVOKED') THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'action', v_event.status);
    END IF;

    v_pending_alloc := COALESCE(v_event.user_pending_points, GREATEST(0, FLOOR(v_event.raw_points * 0.30)));

    IF upper(trim(COALESCE(p_status, 'VERIFIED'))) = 'REVOKED' THEN
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

    -- p_status = 'VERIFIED':
    -- Conferma la conversione lato partner MA NON sposta fondi in SETTLED senza incasso reale.
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

-- 7g. Aggiornamento `core.execute_batch_settlement`:
--     - Richiede tx hash verificabile quando `actual_net_usd > 0`
--     - Aggiorna `reward_events.revenue_state = 'CASH_COLLECTED_SETTLED'`
--     - Propaga `SETTLED` su `core.session_interactions` e `core.auto_sessions`
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
    v_clean_tx TEXT := trim(COALESCE(p_onchain_tx_hash, ''));
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
    IF v_actual_net > 0 AND (
        length(v_clean_tx) < 8
        OR v_clean_tx ~* '^(sim_|fake_|mock_|test_|tx_confirmed_|tx_onchain_)'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'REAL_VERIFIABLE_SETTLEMENT_TX_REQUIRED');
    END IF;

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

    IF v_actual_net > 0 THEN
        INSERT INTO core.treasury_vault (asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent)
        VALUES ('USDT', v_actual_net, v_points_capacity, 0.15)
        ON CONFLICT (asset) DO UPDATE
        SET actual_cash_on_chain = core.treasury_vault.actual_cash_on_chain + EXCLUDED.actual_cash_on_chain,
            points_equivalent_capacity = core.treasury_vault.points_equivalent_capacity + EXCLUDED.points_equivalent_capacity,
            updated_at = NOW();
    END IF;

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

    FOR v_event IN
        SELECT event_id, user_id, raw_points, user_pending_points, interaction_id, session_id
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

        IF v_gross_settled > 0 THEN
            UPDATE core.reward_events
               SET status = 'SETTLED',
                   revenue_state = 'CASH_COLLECTED_SETTLED',
                   batch_id = p_batch_id,
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
        ELSE
            UPDATE core.reward_events
               SET status = 'REVOKED',
                   revenue_state = 'REVOKED',
                   batch_id = p_batch_id,
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
        END IF;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_pending_alloc),
               updated_at = NOW()
         WHERE partner_id = p_partner_id;

        v_settled_count := v_settled_count + 1;
        v_total_points_settled := v_total_points_settled + v_user_settled;
    END LOOP;

    IF v_points_capacity > 0 THEN
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:TREASURY_CASH' FOR UPDATE;
        PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:UNEARNED_REVENUE' FOR UPDATE;

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
        'onchain_tx_hash', v_clean_tx
    );
END;
$$ LANGUAGE plpgsql;

-- 7h. Hardening `core.settle_to_withdrawable`:
--     - Idempotenza su `p_reference_id`
--     - Controllo `is_blocked`
--     - Verifica solvibilità `core.treasury_vault` prima di rendere i punti prelevabili
CREATE OR REPLACE FUNCTION core.settle_to_withdrawable(
    p_user_id BIGINT,
    p_points BIGINT,
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
BEGIN
    IF v_clean_ref IS NOT NULL AND EXISTS (
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

    v_points_to_move := LEAST(v_user_settled_balance, GREATEST(0, p_points));
    IF v_points_to_move <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_POINTS_AMOUNT');
    END IF;

    -- Verifica solvibilità reale in tesoreria (al netto della riserva 15%)
    SELECT COALESCE(FLOOR(SUM(points_equivalent_capacity * (1 - reserved_buffer_percent))), 0)::BIGINT
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
        COALESCE(v_clean_ref, 'settle_' || p_user_id || '_' || floor(extract(epoch from now()) * 1000)::text),
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

-- ----------------------------------------------------------------------------
-- 8. CONVERSIONE VERIFICABILE FX + BLOCCO PAYOUT SE PREZZO NON DISPONIBILE
-- ----------------------------------------------------------------------------

-- 8a. Registra uno snapshot di cambio verificato con scadenza TTL
CREATE OR REPLACE FUNCTION core.record_fx_price_snapshot(
    p_asset TEXT,
    p_usd_per_unit NUMERIC,
    p_source TEXT,
    p_ttl_seconds INT DEFAULT 600,
    p_payload_json JSONB DEFAULT '{}'::jsonb
) RETURNS BIGINT AS $$
DECLARE
    v_asset TEXT := upper(trim(COALESCE(p_asset, '')));
    v_ttl INT := GREATEST(30, LEAST(3600, COALESCE(p_ttl_seconds, 600)));
    v_snapshot_id BIGINT;
BEGIN
    IF v_asset NOT IN ('TON', 'SOL', 'USDT', 'USDC', 'PI') THEN
        RAISE EXCEPTION 'UNSUPPORTED_FX_ASSET: %', v_asset;
    END IF;
    IF p_usd_per_unit IS NULL OR p_usd_per_unit <= 0 THEN
        RAISE EXCEPTION 'INVALID_FX_PRICE: %', p_usd_per_unit;
    END IF;
    IF length(trim(COALESCE(p_source, ''))) < 2 THEN
        RAISE EXCEPTION 'FX_SOURCE_REQUIRED';
    END IF;

    INSERT INTO core.fx_price_snapshots (
        asset, quote_currency, usd_per_unit, source, payload_json, fetched_at, expires_at, is_valid
    ) VALUES (
        v_asset, 'USD', p_usd_per_unit, trim(p_source), COALESCE(p_payload_json, '{}'::jsonb),
        NOW(), NOW() + make_interval(secs => v_ttl), TRUE
    )
    RETURNING snapshot_id INTO v_snapshot_id;

    RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql;

-- 8b. Richiesta prelievo atomica con cambio TON/SOL/PI dinamico e fail-closed
--     Elimina definitivamente il tasso fisso `0.002 TON/PT`.
DROP FUNCTION IF EXISTS core.request_payout_atomic(TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT);
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

    -- Scala economica invariata: 100 PT = $1.00 USD
    v_usd := ROUND((p_points * 0.01)::numeric, 2);

    -- Conversione dinamica e verificabile per asset volatili (blocco fail-closed se assente/scaduto)
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
        v_upper_asset, p_payout_channel, trim(p_wallet_address), 'PENDING', 'PENDING_ADMIN_DISBURSEMENT',
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

-- ----------------------------------------------------------------------------
-- 9. VISTA CONTABILE DI AUDIT: DISTINZIONE 4 STADI DELLA PIPELINE RICAVI
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_user_revenue_pipeline AS
SELECT
    u.user_id,
    u.username,
    u.is_blocked,
    u.session_mode,
    COALESCE(b_pend.balance, 0) AS pending_uncollected_points,
    COALESCE(b_sett.balance, 0) AS settled_accrued_points,
    COALESCE(b_with.balance, 0) AS withdrawable_points,
    COALESCE(b_resv.balance, 0) AS reserved_payout_points,
    COALESCE(pr_paid.paid_points, 0) AS paid_completed_points,
    COALESCE(ev_stats.confirmed_unsettled_events, 0) AS confirmed_unsettled_events,
    COALESCE(ev_stats.cash_collected_events, 0) AS cash_collected_events,
    COALESCE(ev_stats.revoked_events, 0) AS revoked_events
FROM core.users u
LEFT JOIN core.balances b_pend ON b_pend.account_id = 'USER_' || u.user_id || ':PENDING'
LEFT JOIN core.balances b_sett ON b_sett.account_id = 'USER_' || u.user_id || ':SETTLED'
LEFT JOIN core.balances b_with ON b_with.account_id = 'USER_' || u.user_id || ':WITHDRAWABLE'
LEFT JOIN core.balances b_resv ON b_resv.account_id = 'USER_' || u.user_id || ':RESERVED'
LEFT JOIN (
    SELECT user_id, COALESCE(SUM(points), 0) AS paid_points
      FROM core.payout_requests
     WHERE status = 'COMPLETED'
     GROUP BY user_id
) pr_paid ON pr_paid.user_id = u.user_id
LEFT JOIN (
    SELECT user_id,
           COUNT(*) FILTER (WHERE status = 'PENDING' AND revenue_state = 'CONFIRMED_UNSETTLED') AS confirmed_unsettled_events,
           COUNT(*) FILTER (WHERE status = 'SETTLED') AS cash_collected_events,
           COUNT(*) FILTER (WHERE status = 'REVOKED') AS revoked_events
      FROM core.reward_events
     GROUP BY user_id
) ev_stats ON ev_stats.user_id = u.user_id;

COMMIT;
