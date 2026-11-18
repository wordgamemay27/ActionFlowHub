-- ============================================================================
-- MIGRATION: 002_daily_reset_timezone.sql
-- DESCRIZIONE: Profilo d'ingresso persistente (lingua, mercato, categorie,
--             durata) + RESET GIORNALIERO atomico nel fuso orario dell'utente.
--
-- Regole applicate:
--  - La scaletta 600/800/1000/1200 riparte ogni giorno locale dell'utente.
--  - Il reset e' applicato dentro la stessa transazione che blocca la riga
--    utente (FOR UPDATE): due riscatti concorrenti non possono applicare
--    due reset, e il giorno di reset viene riancorato quando il fuso cambia,
--    cosi' spostarsi di fuso non concede bonus giornalieri extra.
--  - L'orologio usato per il timer dei 10 minuti e per il confine di giornata
--    e' quello del SERVER: il timestamp dichiarato dal client non puo'
--    abbreviare il blocco ne' innescaree reset anticipati.
-- ============================================================================

BEGIN;

-- 1. COLONNE DEL PROFILO D'INGRESSO E DEL RESET
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS last_reset_date DATE;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'it';
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS market_country TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS session_minutes INT NOT NULL DEFAULT 20
  CHECK (session_minutes IN (10, 20, 30));
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS selected_categories TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS session_started_at BIGINT NOT NULL DEFAULT 0;

-- 2. ENSURE USER ACCOUNTS con fuso orario (NULL = mantieni quello memorizzato)
DROP FUNCTION IF EXISTS core.ensure_user_accounts(BIGINT, TEXT, TEXT, NUMERIC);
CREATE OR REPLACE FUNCTION core.ensure_user_accounts(
    p_user_id BIGINT,
    p_username TEXT,
    p_tier_zone TEXT,
    p_ppp NUMERIC,
    p_timezone TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_tz TEXT := 'UTC';
    v_now_ms BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
    v_stored_tz TEXT;
BEGIN
    -- Fuso valido? (pg_timezone_names e' la lista ufficiale del server: niente injection)
    IF p_timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        v_tz := p_timezone;
    END IF;

    SELECT timezone INTO v_stored_tz FROM core.users WHERE user_id = p_user_id;

    INSERT INTO core.users (user_id, username, tier_zone, ppp_multiplier, timezone)
    VALUES (p_user_id, p_username, p_tier_zone, p_ppp, v_tz)
    ON CONFLICT (user_id) DO UPDATE
    SET username = EXCLUDED.username,
        updated_at = NOW();

    -- Cambio di fuso: si riancora il giorno di reset al giorno locale del nuovo
    -- fuso. La scaletta NON riparte: cambiare fuso non regala un bonus extra.
    IF v_stored_tz IS NOT NULL AND v_stored_tz <> v_tz THEN
        UPDATE core.users
           SET timezone = v_tz,
               last_reset_date = (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    ELSIF v_stored_tz IS NULL THEN
        UPDATE core.users
           SET timezone = v_tz,
               last_reset_date = (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    END IF;

    -- Inizializza i 4 bucket contabili
    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES
        ('USER_' || p_user_id || ':PENDING', 'USER_PENDING', p_user_id),
        ('USER_' || p_user_id || ':SETTLED', 'USER_SETTLED', p_user_id),
        ('USER_' || p_user_id || ':WITHDRAWABLE', 'USER_WITHDRAWABLE', p_user_id),
        ('USER_' || p_user_id || ':RESERVED', 'USER_RESERVED', p_user_id)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES
        ('USER_' || p_user_id || ':PENDING', 0),
        ('USER_' || p_user_id || ':SETTLED', 0),
        ('USER_' || p_user_id || ':WITHDRAWABLE', 0),
        ('USER_' || p_user_id || ':RESERVED', 0)
    ON CONFLICT (account_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- 3. PROFILO D'INGRESSO (lingua, mercato, categorie, durata, fuso)
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
    v_minutes INT := 20;
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
    IF p_session_minutes IN (10, 20, 30) THEN
        v_minutes := p_session_minutes;
    END IF;
    IF p_selected_categories IS NOT NULL THEN
        v_categories := p_selected_categories;
    END IF;

    SELECT timezone INTO v_stored_tz FROM core.users WHERE user_id = p_user_id FOR UPDATE;

    INSERT INTO core.users (
        user_id, username, tier_zone, ppp_multiplier, timezone, last_reset_date,
        language, market_country, session_minutes, selected_categories
    ) VALUES (
        p_user_id, 'User', 'ZONE_C', 0.20, v_tz,
        (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
        v_lang, v_market, v_minutes, v_categories
    )
    ON CONFLICT (user_id) DO UPDATE
    SET language = EXCLUDED.language,
        market_country = EXCLUDED.market_country,
        session_minutes = EXCLUDED.session_minutes,
        selected_categories = EXCLUDED.selected_categories,
        updated_at = NOW();

    -- Cambio di fuso -> riancoraggio del giorno di reset (nessun bonus extra)
    IF v_stored_tz IS NOT NULL AND v_stored_tz <> v_tz THEN
        UPDATE core.users
           SET timezone = v_tz,
               last_reset_date = (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'timezone', v_tz,
        'language', v_lang,
        'market_country', v_market,
        'session_minutes', v_minutes,
        'selected_categories', to_jsonb(v_categories)
    );
END;
$$ LANGUAGE plpgsql;

-- 4. AVVIO SESSIONE (finestra temporale definita dal server)
CREATE OR REPLACE FUNCTION core.start_session(
    p_user_id BIGINT,
    p_session_minutes INT DEFAULT NULL,
    p_now_ms BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_now_ms BIGINT := COALESCE(p_now_ms, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
    v_minutes INT := 20;
BEGIN
    SELECT session_minutes INTO v_minutes FROM core.users WHERE user_id = p_user_id FOR UPDATE;

    IF p_session_minutes IN (10, 20, 30) THEN
        v_minutes := p_session_minutes;
    END IF;
    IF v_minutes IS NULL THEN
        v_minutes := 20;
    END IF;

    UPDATE core.users
       SET session_minutes = v_minutes,
           session_started_at = v_now_ms,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'session_minutes', v_minutes,
        'session_started_at', v_now_ms,
        'session_ends_at', v_now_ms + (v_minutes * 60000)
    );
END;
$$ LANGUAGE plpgsql;

-- 5. RISCATTO ATOMICO con reset giornaliero nel fuso dell'utente
DROP FUNCTION IF EXISTS core.claim_block_atomic(BIGINT, TEXT, TEXT, BIGINT);
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
    -- 1. Verifica Idempotenza
    SELECT status, response_payload INTO v_existing_status, v_existing_resp
      FROM core.idempotency_keys
     WHERE idempotency_key = p_idempotency_key FOR UPDATE;

    IF v_existing_status = 'COMPLETED' THEN
        RETURN v_existing_resp;
    ELSIF v_existing_status = 'PROCESSING' THEN
        RETURN jsonb_build_object('success', false, 'error', 'CONCURRENT_REQUEST_IN_PROGRESS');
    END IF;

    INSERT INTO core.idempotency_keys (idempotency_key, user_id, operation, status)
    VALUES (p_idempotency_key, p_user_id, 'CLAIM_BLOCK', 'PROCESSING')
    ON CONFLICT (idempotency_key) DO NOTHING;

    -- 2. Lock Utente
    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    IF v_user.is_blocked THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    -- 3. Verifica timer 10 minuti (orologio del SERVER, non quello del client)
    IF v_user.last_claim_time > 0 AND (v_now_ms - v_user.last_claim_time) < v_ten_min_ms THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'BLOCK_NOT_EXPIRED',
            'remaining_seconds', CEIL((v_ten_min_ms - (v_now_ms - v_user.last_claim_time)) / 1000)
        );
    END IF;

    -- 4. Fuso orario: si usa quello MEMORIZZATO (server-side).
    --    Se il client ne dichiara un altro, il profilo viene riallineato e il
    --    giorno di reset riancorato: spostarsi di fuso non concede bonus extra.
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

    -- 5. Reset giornaliero: scatta quando il giorno locale dell'utente avanza.
    --    La riga utente e' gia' bloccata (FOR UPDATE): il reset e' atomico.
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

    -- 6. Verifica Limite Esposizione Partner
    SELECT pending_points_exposure, max_exposure_limit INTO v_curr_exposure, v_max_exposure
      FROM core.partner_exposure WHERE partner_id = p_partner_id FOR UPDATE;

    IF v_max_exposure IS NOT NULL AND (v_curr_exposure + 1200) > v_max_exposure THEN
        UPDATE core.idempotency_keys SET status = 'FAILED' WHERE idempotency_key = p_idempotency_key;
        RETURN jsonb_build_object('success', false, 'error', 'PARTNER_EXPOSURE_CAP_EXCEEDED');
    END IF;

    -- 7. Regola Unica 30% Per Azione (1,00 USDT compito = 0,30 USDT / 30 PT utente, nessuna scaletta)
    v_points_to_add := 30;

    -- 8. Registra Double-Entry Transaction: (+Debito Utente Pending, -Credito Sistema Unearned)
    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('CLAIM_BLOCK', p_idempotency_key, 'Accredito Blocco Pendente ' || v_block)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || p_user_id || ':PENDING', v_points_to_add),
        (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_points_to_add);

    -- 9. Aggiorna Saldi Proiettati
    UPDATE core.balances SET balance = balance + v_points_to_add, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':PENDING';

    UPDATE core.balances SET balance = balance - v_points_to_add, updated_at = NOW()
     WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

    -- 10. Aggiorna Stato Utente e Avanzamento Blocco
    UPDATE core.users
       SET last_claim_time = v_now_ms,
           current_block = LEAST(4, v_block + 1),
           updated_at = NOW()
     WHERE user_id = p_user_id;

    -- 11. Incrementa Esposizione Partner
    UPDATE core.partner_exposure
       SET pending_points_exposure = pending_points_exposure + v_points_to_add,
           updated_at = NOW()
     WHERE partner_id = p_partner_id;

    -- Risposta Finale Idempotente
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

-- 6. RECORD PENDING REWARD (da postback partner S2S)
CREATE OR REPLACE FUNCTION core.record_pending_reward(
    p_event_id TEXT,
    p_partner_id TEXT,
    p_user_id BIGINT,
    p_raw_points BIGINT,
    p_payload_json JSONB
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
BEGIN
    -- Verifica utente
    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    -- Idempotenza su event_id
    INSERT INTO core.reward_events (event_id, partner_id, user_id, raw_points, status, payload_json)
    VALUES (p_event_id, p_partner_id, p_user_id, p_raw_points, 'PENDING', p_payload_json)
    ON CONFLICT (event_id) DO NOTHING;

    -- Accredita punti in PENDING (solo bucket pending, mai withdrawable)
    UPDATE core.balances SET balance = balance + p_raw_points, updated_at = NOW()
     WHERE account_id = 'USER_' || p_user_id || ':PENDING';

    -- Incrementa esposizione partner
    UPDATE core.partner_exposure
       SET pending_points_exposure = pending_points_exposure + p_raw_points,
           updated_at = NOW()
     WHERE partner_id = p_partner_id;

    RETURN jsonb_build_object(
        'success', true,
        'added_pending_points', p_raw_points,
        'event_id', p_event_id
    );
END;
$$ LANGUAGE plpgsql;

COMMIT;
