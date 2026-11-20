-- ============================================================================
-- MIGRATION: 011_geo_country_lock_and_provider_ranking.sql
-- STATO: PREPARATA INCREMENTALE — NON ESEGUIRE SU NEON SENZA AUTORIZZAZIONE
-- DESCRIZIONE:
--   1. Associa in modo deterministico `market_country` -> `tier_zone`
--      (`ZONE_A`, `ZONE_B`, `ZONE_C`) tramite `core.resolve_country_tier_zone`
--      senza alterare o inventare i moltiplicatori PPP non recuperati (`ZONE_A`/`ZONE_B`).
--   2. Protegge `core.users.market_country` e `tier_zone` da manipolazioni
--      opportunistiche dopo l'impostazione iniziale (country lock su onboarding),
--      mantenendo intatti tutti i saldi e i record storici.
--   3. Espone la vista `core.v_prioritized_providers` su `core.provider_reputation`
--      per escludere automaticamente `QUARANTINE`/`BANNED` e ordinare `ACTIVE` > `WARNING`.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- 1. Colonna audit lock geografico (non distruttiva su righe esistenti)
ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS market_country_locked_at TIMESTAMPTZ NULL;

-- 2. Funzione deterministica Paese -> Zona economica (`ZONE_A` / `ZONE_B` / `ZONE_C`)
CREATE OR REPLACE FUNCTION core.resolve_country_tier_zone(
    p_country TEXT
) RETURNS TEXT AS $$
DECLARE
    v_code TEXT := upper(trim(COALESCE(p_country, 'OTHER')));
BEGIN
    IF v_code = 'UK' THEN
        v_code := 'GB';
    END IF;

    IF v_code IN (
        'US', 'GB', 'CA', 'DE', 'FR', 'IT', 'NL', 'BE', 'AT', 'CH',
        'SE', 'NO', 'DK', 'FI', 'IE', 'LU', 'AU', 'NZ', 'JP', 'KR', 'SG', 'AE'
    ) THEN
        RETURN 'ZONE_A';
    ELSIF v_code IN (
        'ES', 'PT', 'PL', 'CZ', 'GR', 'RO', 'HU',
        'BR', 'MX', 'AR', 'CL', 'CO', 'TR', 'SA', 'CN', 'RU', 'TH', 'MY'
    ) THEN
        RETURN 'ZONE_B';
    END IF;

    RETURN 'ZONE_C';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Riallinea `tier_zone` sulle righe esistenti con Paese gia' valorizzato
-- senza alterare `ppp_multiplier` ne' i saldi contabili storici.
UPDATE core.users
   SET tier_zone = core.resolve_country_tier_zone(market_country),
       market_country_locked_at = COALESCE(market_country_locked_at, updated_at),
       updated_at = NOW()
 WHERE market_country IS NOT NULL
   AND upper(trim(market_country)) <> 'OTHER'
   AND tier_zone IS DISTINCT FROM core.resolve_country_tier_zone(market_country);

-- 3. Profilo d'ingresso con blocco anti-manipolazione di `market_country`
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
    v_existing core.users%ROWTYPE;
    v_lang TEXT := 'it';
    v_req_market TEXT := 'OTHER';
    v_effective_market TEXT := 'OTHER';
    v_effective_zone TEXT := 'ZONE_C';
    v_categories TEXT[] := '{}';
    v_country_locked BOOLEAN := FALSE;
BEGIN
    IF p_timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        v_tz := p_timezone;
    END IF;
    IF p_language IS NOT NULL AND length(trim(p_language)) BETWEEN 2 AND 5 THEN
        v_lang := lower(trim(p_language));
    END IF;
    IF p_market_country IS NOT NULL AND length(trim(p_market_country)) BETWEEN 2 AND 8 THEN
        v_req_market := upper(trim(p_market_country));
        IF v_req_market = 'UK' THEN
            v_req_market := 'GB';
        END IF;
    END IF;
    IF p_selected_categories IS NOT NULL THEN
        v_categories := p_selected_categories;
    END IF;

    SELECT * INTO v_existing FROM core.users WHERE user_id = p_user_id FOR UPDATE;

    IF NOT FOUND THEN
        v_effective_market := v_req_market;
        v_effective_zone := core.resolve_country_tier_zone(v_effective_market);

        INSERT INTO core.users (
            user_id, username, tier_zone, ppp_multiplier, timezone, last_reset_date,
            language, market_country, market_country_locked_at, session_minutes, session_mode, selected_categories
        ) VALUES (
            p_user_id, 'User', v_effective_zone, 0.20, v_tz,
            (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
            v_lang, v_effective_market,
            CASE WHEN v_effective_market <> 'OTHER' THEN NOW() ELSE NULL END,
            NULL, 'UNIFIED_AUTO', v_categories
        );
    ELSE
        -- Anti-arbitraggio geografico: una volta fissato un Paese valido (diverso da OTHER),
        -- le chiamate successive dal client non possono sovrascriverlo arbitrariamente.
        IF v_existing.market_country IS NOT NULL AND upper(trim(v_existing.market_country)) <> 'OTHER' THEN
            v_effective_market := upper(trim(v_existing.market_country));
            v_effective_zone := core.resolve_country_tier_zone(v_effective_market);
            v_country_locked := TRUE;
        ELSE
            v_effective_market := v_req_market;
            v_effective_zone := core.resolve_country_tier_zone(v_effective_market);
        END IF;

        UPDATE core.users
           SET language = v_lang,
               market_country = v_effective_market,
               tier_zone = v_effective_zone,
               market_country_locked_at = COALESCE(
                   market_country_locked_at,
                   CASE WHEN v_effective_market <> 'OTHER' THEN NOW() ELSE NULL END
               ),
               timezone = v_tz,
               last_reset_date = CASE
                   WHEN timezone IS DISTINCT FROM v_tz
                       THEN (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date
                   ELSE last_reset_date
               END,
               session_mode = 'UNIFIED_AUTO',
               selected_categories = v_categories,
               updated_at = NOW()
         WHERE user_id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'session_mode', 'UNIFIED_AUTO',
        'timezone', v_tz,
        'language', v_lang,
        'market_country', v_effective_market,
        'tier_zone', v_effective_zone,
        'country_locked', v_country_locked,
        'selected_categories', to_jsonb(v_categories)
    );
END;
$$ LANGUAGE plpgsql;

-- 4. Aggiornamento non distruttivo `core.start_auto_session` con rispetto country lock
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
    v_req_market TEXT := 'OTHER';
    v_effective_market TEXT := 'OTHER';
    v_effective_zone TEXT := 'ZONE_C';
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
        v_req_market := upper(trim(p_market_country));
        IF v_req_market = 'UK' THEN
            v_req_market := 'GB';
        END IF;
    END IF;

    PERFORM core.ensure_user_accounts(p_user_id, 'User', core.resolve_country_tier_zone(v_req_market), 0.20, v_tz);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;

    IF v_user.market_country IS NOT NULL AND upper(trim(v_user.market_country)) <> 'OTHER' THEN
        v_effective_market := upper(trim(v_user.market_country));
    ELSE
        v_effective_market := v_req_market;
    END IF;
    v_effective_zone := core.resolve_country_tier_zone(v_effective_market);

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
            'market_country', v_effective_market,
            'tier_zone', v_effective_zone,
            'session', row_to_json(v_existing)
        );
    END IF;

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
                   market_country = v_effective_market,
                   timezone = v_tz,
                   last_activity_at = NOW(),
                   updated_at = NOW()
             WHERE session_id = v_existing.session_id
             RETURNING * INTO v_existing;

            RETURN jsonb_build_object(
                'success', true,
                'resumed', true,
                'market_country', v_effective_market,
                'tier_zone', v_effective_zone,
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
        v_lang, v_effective_market, v_tz, 'ACTIVE', COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING * INTO v_existing;

    UPDATE core.users
       SET session_mode = 'UNIFIED_AUTO',
           selected_categories = v_cats,
           language = v_lang,
           market_country = v_effective_market,
           tier_zone = v_effective_zone,
           market_country_locked_at = COALESCE(
               market_country_locked_at,
               CASE WHEN v_effective_market <> 'OTHER' THEN NOW() ELSE NULL END
           ),
           session_started_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
           updated_at = NOW()
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'resumed', false,
        'market_country', v_effective_market,
        'tier_zone', v_effective_zone,
        'session', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

-- 5. Vista prioritizzazione fornitori attivi per reputazione & storico
ALTER TABLE core.provider_reputation
    ADD COLUMN IF NOT EXISTS strikes_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_confirmed_events INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE VIEW core.v_prioritized_providers AS
SELECT
    pr.provider_id,
    pr.provider_name,
    pr.category,
    pr.status,
    pr.reputation_score,
    pr.ema_haircut_ratio,
    pr.strikes_count,
    pr.total_confirmed_events,
    COALESCE(pe.status, 'ACTIVE') AS exposure_status,
    COALESCE(pe.pending_points_exposure, 0) AS pending_points_exposure,
    COALESCE(pe.max_exposure_limit, 500000) AS max_exposure_limit
FROM core.provider_reputation pr
LEFT JOIN core.partner_exposure pe
       ON pe.partner_id = pr.provider_id
WHERE pr.status IN ('ACTIVE', 'WARNING')
  AND COALESCE(pe.status, 'ACTIVE') = 'ACTIVE'
ORDER BY
    CASE WHEN pr.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
    pr.reputation_score DESC,
    pr.ema_haircut_ratio DESC,
    pr.total_confirmed_events DESC;

COMMIT;
