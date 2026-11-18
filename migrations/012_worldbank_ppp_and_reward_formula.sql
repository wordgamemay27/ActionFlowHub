-- ============================================================================
-- MIGRATION: 012_worldbank_ppp_and_reward_formula.sql
-- STATO: PREPARATA INCREMENTALE — NON ESEGUIRE SU NEON SENZA AUTORIZZAZIONE
-- DESCRIZIONE:
--   1. Tabella `core.country_economic_profiles` con i dati ufficiali Banca
--      Mondiale WDI Private Consumption PPP (`PA.NUS.PRVT.PP`) e tasso di cambio
--      ufficiale (`PA.NUS.FCRF`):
--        - Stati Uniti (`US`): coefficiente base `1.0000`
--        - Europa (UE / SEE / UK / CH): coefficiente base `1.0000`
--        - Africa, Cina, India, America Latina & Altri Paesi:
--            coefficiente = LEAST(1.0000, GREATEST(0.0100, ROUND(ppp / fx, 4)))
--   2. Funzioni `core.get_country_ppp_coefficient` e
--      `core.upsert_country_economic_profile` per aggiornamento periodico
--      senza alterare la scala contabile (100 PT = $1.00 USD) ne' i saldi esistenti.
--   3. Adeguamento non distruttivo di `core.users.ppp_multiplier` (NUMERIC(6,4)),
--      `core.reward_events` e `core.session_interactions` (`ppp_coefficient`,
--      `platform_margin_points`).
--   4. Aggiornamento di `core.upsert_entry_profile`, `core.start_auto_session`,
--      `core.record_verified_interaction_postback` e `core.execute_batch_settlement`
--      con la formula:
--        Utente = FLOOR(raw_points * 0.30 * ppp_coefficient) (max 30%)
--        Margine Piattaforma = raw_points - user_pending_points (>= 70%)
--   5. Estensione non distruttiva della vista `core.v_prioritized_providers`
--      con `total_clicks` e `completion_rate` reale (criterio #5).
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. PROFILI ECONOMICI BANCA MONDIALE (PA.NUS.PRVT.PP / PA.NUS.FCRF)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.country_economic_profiles (
    country_code TEXT PRIMARY KEY,
    region_group TEXT NOT NULL,
    tier_zone TEXT NOT NULL CHECK (tier_zone IN ('ZONE_A', 'ZONE_B', 'ZONE_C')),
    wb_ppp_private_consumption NUMERIC(18, 6) NOT NULL,
    wb_official_fx_rate NUMERIC(18, 6) NOT NULL CHECK (wb_official_fx_rate > 0),
    wb_price_level_index NUMERIC(8, 4) NOT NULL,
    ppp_coefficient NUMERIC(6, 4) NOT NULL CHECK (ppp_coefficient > 0 AND ppp_coefficient <= 1.0000),
    indicator_year INT NOT NULL DEFAULT 2025,
    source TEXT NOT NULL DEFAULT 'WORLD_BANK_WDI_PA.NUS.PRVT.PP',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO core.country_economic_profiles (
    country_code, region_group, tier_zone,
    wb_ppp_private_consumption, wb_official_fx_rate,
    wb_price_level_index, ppp_coefficient, indicator_year, source
) VALUES
    ('US', 'US', 'ZONE_A', 1.000000, 1.000000, 1.0000, 1.0000, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_BASE_1'),
    ('DE', 'EUROPE', 'ZONE_A', 0.718883, 0.884969, 0.8123, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('IT', 'EUROPE', 'ZONE_A', 0.644824, 0.884969, 0.7286, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('FR', 'EUROPE', 'ZONE_A', 0.732501, 0.884969, 0.8277, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('ES', 'EUROPE', 'ZONE_B', 0.607856, 0.884969, 0.6869, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('PT', 'EUROPE', 'ZONE_B', 0.574713, 0.884969, 0.6494, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('PL', 'EUROPE', 'ZONE_B', 2.063158, 3.760542, 0.5486, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('NL', 'EUROPE', 'ZONE_A', 0.767344, 0.884969, 0.8671, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('BE', 'EUROPE', 'ZONE_A', 0.771758, 0.884969, 0.8721, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('AT', 'EUROPE', 'ZONE_A', 0.750352, 0.884969, 0.8479, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('CH', 'EUROPE', 'ZONE_A', 1.065544, 0.831356, 1.2817, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('SE', 'EUROPE', 'ZONE_A', 8.889005, 9.820706, 0.9051, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('GB', 'EUROPE', 'ZONE_A', 0.701529, 0.759474, 0.9237, 1.0000, 2025, 'WORLD_BANK_WDI_EUROPE_BASE_1'),
    ('CA', 'OTHER', 'ZONE_A', 1.260483, 1.398106, 0.9016, 0.9016, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('AU', 'ASIA_PACIFIC', 'ZONE_A', 1.464593, 1.551998, 0.9437, 0.9437, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('JP', 'ASIA_PACIFIC', 'ZONE_A', 103.336580, 149.657927, 0.6905, 0.6905, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('KR', 'ASIA_PACIFIC', 'ZONE_A', 880.125358, 1422.440833, 0.6187, 0.6187, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('SG', 'ASIA_PACIFIC', 'ZONE_A', 1.023815, 1.307450, 0.7831, 0.7831, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('AE', 'MENA', 'ZONE_A', 2.526987, 3.672500, 0.6881, 0.6881, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('CN', 'CHINA', 'ZONE_B', 3.459558, 7.189847, 0.4812, 0.4812, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('IN', 'INDIA', 'ZONE_C', 19.838916, 87.158448, 0.2276, 0.2276, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('BR', 'LATAM', 'ZONE_B', 2.581490, 5.587286, 0.4620, 0.4620, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('MX', 'LATAM', 'ZONE_B', 11.308778, 19.237508, 0.5879, 0.5879, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('CL', 'LATAM', 'ZONE_B', 486.878432, 951.329454, 0.5118, 0.5118, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('CO', 'LATAM', 'ZONE_B', 1665.592955, 4053.135833, 0.4109, 0.4109, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('AR', 'LATAM', 'ZONE_B', 42.986240, 1240.851250, 0.0346, 0.0346, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_2021_VS_2025FX'),
    ('NG', 'AFRICA', 'ZONE_C', 318.059578, 1518.380948, 0.2095, 0.2095, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('KE', 'AFRICA', 'ZONE_C', 44.984382, 129.302572, 0.3479, 0.3479, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('ZA', 'AFRICA', 'ZONE_C', 7.739959, 17.888749, 0.4327, 0.4327, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('EG', 'AFRICA', 'ZONE_C', 7.721843, 49.227756, 0.1569, 0.1569, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('MA', 'AFRICA', 'ZONE_C', 3.959649, 9.350277, 0.4235, 0.4235, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('TR', 'MENA', 'ZONE_B', 17.744381, 39.454813, 0.4497, 0.4497, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('SA', 'MENA', 'ZONE_B', 1.870735, 3.750000, 0.4989, 0.4989, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('ID', 'ASIA_PACIFIC', 'ZONE_C', 5065.968994, 16477.865180, 0.3074, 0.3074, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('PH', 'ASIA_PACIFIC', 'ZONE_C', 20.533546, 57.505097, 0.3571, 0.3571, 2025, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP'),
    ('OTHER', 'OTHER', 'ZONE_C', 0.307800, 1.000000, 0.3078, 0.3078, 2025, 'WORLD_BANK_WDI_ZONE_C_MEAN')
ON CONFLICT (country_code) DO UPDATE
SET region_group = EXCLUDED.region_group,
    tier_zone = EXCLUDED.tier_zone,
    wb_ppp_private_consumption = EXCLUDED.wb_ppp_private_consumption,
    wb_official_fx_rate = EXCLUDED.wb_official_fx_rate,
    wb_price_level_index = EXCLUDED.wb_price_level_index,
    ppp_coefficient = EXCLUDED.ppp_coefficient,
    indicator_year = EXCLUDED.indicator_year,
    source = EXCLUDED.source,
    updated_at = NOW();

-- Funzione lookup coefficiente PPP per Paese (US = 1.0000, Europa = 1.0000)
CREATE OR REPLACE FUNCTION core.get_country_ppp_coefficient(
    p_country TEXT
) RETURNS NUMERIC(6, 4) AS $$
DECLARE
    v_code TEXT := upper(trim(COALESCE(p_country, 'OTHER')));
    v_coef NUMERIC(6, 4);
BEGIN
    IF v_code = 'UK' THEN
        v_code := 'GB';
    END IF;

    IF v_code = 'US' OR v_code IN (
        'IT', 'DE', 'FR', 'ES', 'PT', 'PL', 'NL', 'BE', 'AT', 'CH', 'SE', 'GB',
        'NO', 'DK', 'FI', 'IE', 'LU', 'GR', 'CZ', 'RO', 'HU', 'SK', 'BG', 'HR',
        'SI', 'LT', 'LV', 'EE', 'CY', 'MT'
    ) THEN
        RETURN 1.0000;
    END IF;

    SELECT ppp_coefficient
      INTO v_coef
      FROM core.country_economic_profiles
     WHERE country_code = v_code;

    IF FOUND AND v_coef IS NOT NULL THEN
        RETURN LEAST(1.0000, GREATEST(0.0100, v_coef));
    END IF;

    SELECT ppp_coefficient
      INTO v_coef
      FROM core.country_economic_profiles
     WHERE country_code = 'OTHER';

    RETURN LEAST(1.0000, GREATEST(0.0100, COALESCE(v_coef, 0.3078)));
END;
$$ LANGUAGE plpgsql STABLE;

-- Upsert atomico per aggiornamento periodico da World Bank WDI API v2
CREATE OR REPLACE FUNCTION core.upsert_country_economic_profile(
    p_country_code TEXT,
    p_region_group TEXT,
    p_tier_zone TEXT,
    p_wb_ppp NUMERIC,
    p_wb_fx NUMERIC,
    p_wb_pli NUMERIC,
    p_ppp_coefficient NUMERIC,
    p_indicator_year INT DEFAULT 2025,
    p_source TEXT DEFAULT 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_LIVE'
) RETURNS VOID AS $$
DECLARE
    v_code TEXT := upper(trim(COALESCE(p_country_code, '')));
    v_region TEXT := upper(trim(COALESCE(p_region_group, 'OTHER')));
    v_zone TEXT := upper(trim(COALESCE(p_tier_zone, core.resolve_country_tier_zone(v_code))));
    v_effective_coef NUMERIC(6, 4);
BEGIN
    IF length(v_code) < 2 THEN
        RETURN;
    END IF;
    IF v_code = 'UK' THEN
        v_code := 'GB';
    END IF;
    IF v_zone NOT IN ('ZONE_A', 'ZONE_B', 'ZONE_C') THEN
        v_zone := core.resolve_country_tier_zone(v_code);
    END IF;

    v_effective_coef := CASE
        WHEN v_region IN ('US', 'EUROPE') THEN 1.0000
        ELSE LEAST(1.0000, GREATEST(0.0100, ROUND(COALESCE(p_ppp_coefficient, 0.3078)::numeric, 4)))
    END;

    INSERT INTO core.country_economic_profiles (
        country_code, region_group, tier_zone,
        wb_ppp_private_consumption, wb_official_fx_rate,
        wb_price_level_index, ppp_coefficient, indicator_year, source, updated_at
    ) VALUES (
        v_code, v_region, v_zone,
        GREATEST(0.000001, COALESCE(p_wb_ppp, 1.0)),
        GREATEST(0.000001, COALESCE(p_wb_fx, 1.0)),
        GREATEST(0.0001, ROUND(COALESCE(p_wb_pli, v_effective_coef)::numeric, 4)),
        v_effective_coef,
        COALESCE(p_indicator_year, 2025),
        COALESCE(NULLIF(trim(p_source), ''), 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_LIVE'),
        NOW()
    )
    ON CONFLICT (country_code) DO UPDATE
    SET region_group = EXCLUDED.region_group,
        tier_zone = EXCLUDED.tier_zone,
        wb_ppp_private_consumption = EXCLUDED.wb_ppp_private_consumption,
        wb_official_fx_rate = EXCLUDED.wb_official_fx_rate,
        wb_price_level_index = EXCLUDED.wb_price_level_index,
        ppp_coefficient = EXCLUDED.ppp_coefficient,
        indicator_year = EXCLUDED.indicator_year,
        source = EXCLUDED.source,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 2. ADEGUAMENTO NON DISTRUTTIVO COLONNE PPP E TRACCIABILITA' MARGINI
-- ----------------------------------------------------------------------------
ALTER TABLE core.users
    ALTER COLUMN ppp_multiplier TYPE NUMERIC(6, 4);

ALTER TABLE core.users
    ALTER COLUMN ppp_multiplier SET DEFAULT 0.3078;

UPDATE core.users
   SET ppp_multiplier = core.get_country_ppp_coefficient(market_country),
       updated_at = NOW()
 WHERE market_country IS NOT NULL
   AND upper(trim(market_country)) <> 'OTHER'
   AND ppp_multiplier IS DISTINCT FROM core.get_country_ppp_coefficient(market_country);

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS ppp_coefficient NUMERIC(6, 4) NOT NULL DEFAULT 1.0000;

ALTER TABLE core.reward_events
    ADD COLUMN IF NOT EXISTS platform_margin_points BIGINT NOT NULL DEFAULT 0;

ALTER TABLE core.session_interactions
    ADD COLUMN IF NOT EXISTS ppp_coefficient NUMERIC(6, 4) NOT NULL DEFAULT 1.0000;

ALTER TABLE core.session_interactions
    ADD COLUMN IF NOT EXISTS platform_margin_points BIGINT NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- 3. ONBOARDING & SESSIONE AUTOMATICA CON PERSISTENZA COEFFICIENTE PPP
-- ----------------------------------------------------------------------------
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
    v_effective_ppp NUMERIC(6, 4) := 0.3078;
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
        v_effective_ppp := core.get_country_ppp_coefficient(v_effective_market);

        INSERT INTO core.users (
            user_id, username, tier_zone, ppp_multiplier, timezone, last_reset_date,
            language, market_country, market_country_locked_at, session_minutes, session_mode, selected_categories
        ) VALUES (
            p_user_id, 'User', v_effective_zone, v_effective_ppp, v_tz,
            (to_timestamp(v_now_ms / 1000.0) AT TIME ZONE v_tz)::date,
            v_lang, v_effective_market,
            CASE WHEN v_effective_market <> 'OTHER' THEN NOW() ELSE NULL END,
            NULL, 'UNIFIED_AUTO', v_categories
        );
    ELSE
        IF v_existing.market_country IS NOT NULL AND upper(trim(v_existing.market_country)) <> 'OTHER' THEN
            v_effective_market := upper(trim(v_existing.market_country));
            v_country_locked := TRUE;
        ELSE
            v_effective_market := v_req_market;
        END IF;
        v_effective_zone := core.resolve_country_tier_zone(v_effective_market);
        v_effective_ppp := core.get_country_ppp_coefficient(v_effective_market);

        UPDATE core.users
           SET language = v_lang,
               market_country = v_effective_market,
               tier_zone = v_effective_zone,
               ppp_multiplier = v_effective_ppp,
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
        'ppp_coefficient', v_effective_ppp,
        'country_locked', v_country_locked,
        'selected_categories', to_jsonb(v_categories)
    );
END;
$$ LANGUAGE plpgsql;

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
    v_effective_ppp NUMERIC(6, 4) := 0.3078;
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

    PERFORM core.ensure_user_accounts(
        p_user_id,
        'User',
        core.resolve_country_tier_zone(v_req_market),
        core.get_country_ppp_coefficient(v_req_market),
        v_tz
    );

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
    v_effective_ppp := core.get_country_ppp_coefficient(v_effective_market);

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
            'ppp_coefficient', v_effective_ppp,
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
                'ppp_coefficient', v_effective_ppp,
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
           ppp_multiplier = v_effective_ppp,
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
        'ppp_coefficient', v_effective_ppp,
        'session', row_to_json(v_existing)
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. POSTBACK VERIFICATO S2S & BATCH SETTLEMENT CON COEFFICIENTE PPP REALE
--    Formula immutabile:
--      v_user_pending = FLOOR(v_raw_points * 0.30 * v_ppp_coef) (<= 30% di raw)
--      v_platform_margin = v_raw_points - v_user_pending (>= 70% di raw)
--    Il tasso contabile dei punti (100 PT = $1.00 USD) rimane identico.
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
        SELECT event_id, user_id, raw_points, user_pending_points,
               COALESCE(ppp_coefficient, 1.0000) AS ppp_coefficient,
               interaction_id, session_id
          FROM core.reward_events
         WHERE partner_id = v_clean_partner
           AND status = 'PENDING'
           AND created_at >= v_start_ts
           AND created_at <= v_end_ts
         ORDER BY created_at ASC, event_id ASC
         FOR UPDATE
    LOOP
        v_pending_alloc := COALESCE(
            v_event.user_pending_points,
            GREATEST(0, FLOOR(v_event.raw_points * 0.30 * COALESCE(v_event.ppp_coefficient, 1.0000)))
        );

        SELECT balance INTO v_pending_bal
          FROM core.balances
         WHERE account_id = 'USER_' || v_event.user_id || ':PENDING'
         FOR UPDATE;

        v_pending_alloc := LEAST(COALESCE(v_pending_bal, 0), v_pending_alloc);

        v_gross_settled := LEAST(v_remaining_capacity, GREATEST(0, FLOOR(v_event.raw_points * v_effective_ratio)));
        v_user_settled := LEAST(
            v_pending_alloc,
            GREATEST(0, FLOOR(v_gross_settled * 0.30 * COALESCE(v_event.ppp_coefficient, 1.0000)))
        );
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
-- 5. VISTA FORNITORI PRIORITIZZATI CON TASSO DI COMPLETAMENTO REALE (CRITERIO #5)
--    Mantiene intatto l'ordine e tipo delle colonne 011, aggiungendo
--    `total_clicks` e `completion_rate` in coda per CREATE OR REPLACE VIEW.
-- ----------------------------------------------------------------------------
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
    COALESCE(pe.max_exposure_limit, 500000) AS max_exposure_limit,
    COALESCE(si.total_clicks, 0)::BIGINT AS total_clicks,
    CASE
        WHEN COALESCE(si.total_clicks, 0) > 0
            THEN LEAST(1.0000, GREATEST(0.0000, ROUND(COALESCE(si.confirmed_events, pr.total_confirmed_events, 0)::numeric / si.total_clicks::numeric, 4)))
        ELSE LEAST(1.0000, GREATEST(0.0000, ROUND(COALESCE(pr.ema_haircut_ratio, 1.0)::numeric, 4)))
    END::NUMERIC(6, 4) AS completion_rate
FROM core.provider_reputation pr
LEFT JOIN core.partner_exposure pe
       ON pe.partner_id = pr.provider_id
LEFT JOIN (
    SELECT
        provider_id,
        COUNT(*)::BIGINT AS total_clicks,
        COUNT(*) FILTER (WHERE status IN ('POSTBACK_CONFIRMED_PENDING', 'SETTLED'))::BIGINT AS confirmed_events
    FROM core.session_interactions
    GROUP BY provider_id
) si ON si.provider_id = pr.provider_id
WHERE pr.status IN ('ACTIVE', 'WARNING')
  AND COALESCE(pe.status, 'ACTIVE') = 'ACTIVE'
ORDER BY
    CASE
        WHEN COALESCE(si.total_clicks, 0) > 0
            THEN LEAST(1.0000, COALESCE(si.confirmed_events, pr.total_confirmed_events, 0)::numeric / si.total_clicks::numeric)
        ELSE LEAST(1.0000, COALESCE(pr.ema_haircut_ratio, 1.0)::numeric)
    END DESC,
    CASE WHEN pr.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
    pr.reputation_score DESC,
    pr.ema_haircut_ratio DESC,
    pr.total_confirmed_events DESC;

COMMIT;
