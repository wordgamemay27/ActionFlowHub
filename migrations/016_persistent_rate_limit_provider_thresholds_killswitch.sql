-- ============================================================================
-- MIGRATION: 016_persistent_rate_limit_provider_thresholds_killswitch.sql
-- DESCRIZIONE:
--   1. Rate limiting persistente e atomico su PostgreSQL per fornitore/endpoint
--      (default configurabile 10 req/min, override per-provider, multi-istanza).
--   2. Protezione proporzionata fornitori con contatori separati:
--      - TECHNICAL_ERROR -> incrementa solo technical_error_count (mai quarantena)
--      - Anomalie sospette (SUSPICIOUS_BEHAVIOR, REPLAY_ATTEMPT, UNAUTHORIZED_URL,
--        FRAUDULENT_ACTIVITY) -> 1-2 solo log, 3 -> WARNING, 5 -> QUARANTINE
--      - BANNED rimane esclusivamente manuale lato admin
--      - Soglie configurabili su core.system_controls ('PROVIDER_PROTECTION_THRESHOLDS')
--      - Funzione admin `core.admin_review_provider_anomalies` per revisione/ripristino
--   3. Estensione vista `core.v_treasury_vault_status` per esporre anche i payout
--      APPROVED impegnati per asset e la quota netta disponibile residua.
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-015.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. RATE LIMITING PERSISTENTE & CONFIGURABILE PER FORNITORE (POSTGRESQL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.provider_rate_limits (
    provider_id TEXT PRIMARY KEY,
    requests_per_minute INTEGER NOT NULL DEFAULT 10 CHECK (requests_per_minute >= 1 AND requests_per_minute <= 10000),
    updated_by TEXT NOT NULL DEFAULT 'system',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.provider_rate_limit_windows (
    provider_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    window_bucket BIGINT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider_id, endpoint, window_bucket)
);

CREATE INDEX IF NOT EXISTS idx_provider_rl_windows_bucket
    ON core.provider_rate_limit_windows (window_bucket);

CREATE OR REPLACE FUNCTION core.set_provider_rate_limit(
    p_provider_id TEXT,
    p_requests_per_minute INTEGER,
    p_actor TEXT DEFAULT 'admin'
) RETURNS JSONB AS $$
DECLARE
    v_prov TEXT := lower(trim(COALESCE(p_provider_id, '')));
    v_rpm INTEGER := COALESCE(p_requests_per_minute, 10);
    v_actor TEXT := COALESCE(NULLIF(trim(p_actor), ''), 'admin');
    v_row core.provider_rate_limits%ROWTYPE;
BEGIN
    IF length(v_prov) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_ID_REQUIRED');
    END IF;
    IF v_rpm < 1 OR v_rpm > 10000 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_RPM_RANGE_1_TO_10000');
    END IF;

    INSERT INTO core.provider_rate_limits (provider_id, requests_per_minute, updated_by, updated_at)
    VALUES (v_prov, v_rpm, v_actor, NOW())
    ON CONFLICT (provider_id) DO UPDATE
        SET requests_per_minute = EXCLUDED.requests_per_minute,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
    RETURNING * INTO v_row;

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'PROVIDER_RATE_LIMIT_UPDATED',
        v_actor,
        v_prov,
        jsonb_build_object('requests_per_minute', v_rpm)
    );

    RETURN jsonb_build_object('ok', true, 'config', row_to_json(v_row));
END;
$$ LANGUAGE plpgsql;

-- Raffinamento atomico esatto della N-esima vs (N+1)-esima richiesta su consume_provider_rate_limit
CREATE OR REPLACE FUNCTION core.consume_provider_rate_limit(
    p_provider_id TEXT,
    p_endpoint TEXT DEFAULT 'default',
    p_default_rpm INTEGER DEFAULT 10
) RETURNS JSONB AS $$
DECLARE
    v_prov TEXT := COALESCE(NULLIF(lower(trim(COALESCE(p_provider_id, ''))), ''), 'unknown');
    v_ep TEXT := COALESCE(NULLIF(lower(trim(COALESCE(p_endpoint, ''))), ''), 'default');
    v_bucket BIGINT := FLOOR(EXTRACT(EPOCH FROM NOW()) / 60)::BIGINT;
    v_limit INTEGER := GREATEST(1, COALESCE(p_default_rpm, 10));
    v_configured INTEGER;
    v_prev_count INTEGER := 0;
    v_new_count INTEGER := 0;
BEGIN
    SELECT requests_per_minute INTO v_configured
      FROM core.provider_rate_limits
     WHERE provider_id = v_prov;
    IF FOUND AND v_configured IS NOT NULL THEN
        v_limit := v_configured;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('prov_rl_' || v_prov || '_' || v_ep || '_' || v_bucket::text));

    SELECT request_count INTO v_prev_count
      FROM core.provider_rate_limit_windows
     WHERE provider_id = v_prov
       AND endpoint = v_ep
       AND window_bucket = v_bucket
     FOR UPDATE;

    IF NOT FOUND THEN
        v_prev_count := 0;
    END IF;

    IF v_prev_count >= v_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'limit', v_limit,
            'current_count', v_prev_count,
            'remaining', 0,
            'window_bucket', v_bucket,
            'mode', 'POSTGRES_PERSISTENT'
        );
    END IF;

    v_new_count := v_prev_count + 1;

    INSERT INTO core.provider_rate_limit_windows (provider_id, endpoint, window_bucket, request_count, updated_at)
    VALUES (v_prov, v_ep, v_bucket, v_new_count, NOW())
    ON CONFLICT (provider_id, endpoint, window_bucket) DO UPDATE
        SET request_count = v_new_count,
            updated_at = NOW();

    -- Pulizia opportunistica finestre obsolete (>10 minuti fa)
    DELETE FROM core.provider_rate_limit_windows
     WHERE provider_id = v_prov
       AND endpoint = v_ep
       AND window_bucket < (v_bucket - 10);

    RETURN jsonb_build_object(
        'allowed', true,
        'limit', v_limit,
        'current_count', v_new_count,
        'remaining', GREATEST(0, v_limit - v_new_count),
        'window_bucket', v_bucket,
        'mode', 'POSTGRES_PERSISTENT'
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 2. CONTATORI PROPORZIONATI & SOGLIE CONFIGURABILI PROTEZIONE FORNITORI
-- ----------------------------------------------------------------------------
ALTER TABLE core.provider_reputation
    ADD COLUMN IF NOT EXISTS consecutive_suspicious_anomalies INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS technical_error_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_anomaly_at TIMESTAMPTZ;

INSERT INTO core.system_controls (control_key, is_enabled, reason, updated_by, metadata)
VALUES (
    'PROVIDER_PROTECTION_THRESHOLDS',
    TRUE,
    'Soglie proporzionate escalation anomalie fornitori (3=WARNING, 5=QUARANTINE, BAN solo admin)',
    'system',
    '{"warning_threshold": 3, "quarantine_threshold": 5, "ban_admin_only": true}'::jsonb
)
ON CONFLICT (control_key) DO NOTHING;

DO $$
DECLARE
    v_con RECORD;
BEGIN
    FOR v_con IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'core.inbound_security_logs'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%anomaly_category%'
    LOOP
        EXECUTE format('ALTER TABLE core.inbound_security_logs DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbound_security_logs_category_check_v2') THEN
        ALTER TABLE core.inbound_security_logs
            ADD CONSTRAINT inbound_security_logs_category_check_v2
            CHECK (anomaly_category IN (
                'TECHNICAL_ERROR',
                'SUSPICIOUS_BEHAVIOR',
                'REPLAY_ATTEMPT',
                'INVALID_SIGNATURE',
                'UNAUTHORIZED_URL',
                'FRAUDULENT_ACTIVITY'
            ));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION core.update_provider_protection_thresholds(
    p_warning_threshold INTEGER,
    p_quarantine_threshold INTEGER,
    p_actor TEXT DEFAULT 'admin'
) RETURNS JSONB AS $$
DECLARE
    v_warn INTEGER := COALESCE(p_warning_threshold, 3);
    v_quar INTEGER := COALESCE(p_quarantine_threshold, 5);
    v_actor TEXT := COALESCE(NULLIF(trim(p_actor), ''), 'admin');
BEGIN
    IF v_warn < 2 OR v_quar <= v_warn OR v_quar > 100 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_PROVIDER_THRESHOLDS');
    END IF;

    INSERT INTO core.system_controls (control_key, is_enabled, reason, updated_by, metadata, updated_at)
    VALUES (
        'PROVIDER_PROTECTION_THRESHOLDS',
        TRUE,
        'Aggiornamento soglie protezione fornitori',
        v_actor,
        jsonb_build_object(
            'warning_threshold', v_warn,
            'quarantine_threshold', v_quar,
            'ban_admin_only', true
        ),
        NOW()
    )
    ON CONFLICT (control_key) DO UPDATE
        SET metadata = EXCLUDED.metadata,
            updated_by = EXCLUDED.updated_by,
            reason = EXCLUDED.reason,
            updated_at = NOW();

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'PROVIDER_PROTECTION_THRESHOLDS_UPDATED',
        v_actor,
        'PROVIDER_PROTECTION_THRESHOLDS',
        jsonb_build_object('warning_threshold', v_warn, 'quarantine_threshold', v_quar)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'warning_threshold', v_warn,
        'quarantine_threshold', v_quar,
        'ban_admin_only', true
    );
END;
$$ LANGUAGE plpgsql;

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
    v_thresh_meta JSONB := '{}'::jsonb;
    v_warn_thresh INTEGER := 3;
    v_quar_thresh INTEGER := 5;
    v_prov_row core.provider_reputation%ROWTYPE;
    v_next_suspicious INTEGER := 0;
    v_next_status TEXT;
BEGIN
    IF v_cat NOT IN (
        'TECHNICAL_ERROR',
        'SUSPICIOUS_BEHAVIOR',
        'REPLAY_ATTEMPT',
        'INVALID_SIGNATURE',
        'UNAUTHORIZED_URL',
        'FRAUDULENT_ACTIVITY'
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

    IF v_prov IS NOT NULL THEN
        SELECT * INTO v_prov_row
          FROM core.provider_reputation
         WHERE provider_id = v_prov
         FOR UPDATE;

        IF FOUND THEN
            -- Errori tecnici: solo incremento tecnico separato, MAI warning/quarantine
            IF v_cat = 'TECHNICAL_ERROR' THEN
                UPDATE core.provider_reputation
                   SET technical_error_count = COALESCE(technical_error_count, 0) + 1,
                       last_anomaly_at = NOW(),
                       updated_at = NOW()
                 WHERE provider_id = v_prov;

            -- Firme invalide: registrate in inbound_security_logs senza auto-ban da spoof esterno
            ELSIF v_cat = 'INVALID_SIGNATURE' THEN
                INSERT INTO core.provider_audit_log (provider_id, action, details)
                VALUES (
                    v_prov,
                    'INBOUND_INVALID_SIGNATURE',
                    jsonb_build_object(
                        'log_id', v_log_id,
                        'endpoint', p_endpoint,
                        'error_code', p_error_code
                    )
                );

            -- Anomalie sospette/ripetute: 1-2 log, 3 -> WARNING, 5 -> QUARANTINE, BAN solo admin
            ELSIF v_cat IN ('SUSPICIOUS_BEHAVIOR', 'REPLAY_ATTEMPT', 'UNAUTHORIZED_URL', 'FRAUDULENT_ACTIVITY') THEN
                SELECT metadata INTO v_thresh_meta
                  FROM core.system_controls
                 WHERE control_key = 'PROVIDER_PROTECTION_THRESHOLDS';
                IF v_thresh_meta IS NOT NULL THEN
                    v_warn_thresh := GREATEST(2, COALESCE((v_thresh_meta->>'warning_threshold')::integer, 3));
                    v_quar_thresh := GREATEST(v_warn_thresh + 1, COALESCE((v_thresh_meta->>'quarantine_threshold')::integer, 5));
                END IF;

                v_next_suspicious := COALESCE(v_prov_row.consecutive_suspicious_anomalies, 0) + 1;
                v_next_status := v_prov_row.status;

                IF v_prov_row.status <> 'BANNED' THEN
                    IF v_next_suspicious >= v_quar_thresh THEN
                        v_next_status := 'QUARANTINE';
                    ELSIF v_next_suspicious >= v_warn_thresh AND v_prov_row.status = 'ACTIVE' THEN
                        v_next_status := 'WARNING';
                    END IF;
                END IF;

                UPDATE core.provider_reputation
                   SET consecutive_suspicious_anomalies = v_next_suspicious,
                       status = v_next_status,
                       quarantine_reason = CASE
                           WHEN v_next_status = 'QUARANTINE' AND v_prov_row.status <> 'QUARANTINE'
                           THEN 'ANOMALY_THRESHOLD_' || v_next_suspicious || '_REACHED (' || v_cat || ': ' || COALESCE(p_error_code, 'UNKNOWN') || ')'
                           WHEN v_next_status = 'WARNING' AND v_prov_row.status = 'ACTIVE'
                           THEN 'ANOMALY_WARNING_' || v_next_suspicious || ' (' || v_cat || ')'
                           ELSE quarantine_reason
                       END,
                       last_anomaly_at = NOW(),
                       updated_at = NOW()
                 WHERE provider_id = v_prov;

                INSERT INTO core.provider_audit_log (provider_id, action, details)
                VALUES (
                    v_prov,
                    'INBOUND_' || v_cat,
                    jsonb_build_object(
                        'log_id', v_log_id,
                        'endpoint', p_endpoint,
                        'error_code', p_error_code,
                        'consecutive_suspicious_anomalies', v_next_suspicious,
                        'status_after', v_next_status,
                        'warning_threshold', v_warn_thresh,
                        'quarantine_threshold', v_quar_thresh,
                        'details', COALESCE(p_details, '{}'::jsonb)
                    )
                );

                IF v_next_status IS DISTINCT FROM v_prov_row.status THEN
                    PERFORM core.sync_provider_exposure_status(v_prov);
                    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
                    VALUES (
                        CASE WHEN v_next_status = 'QUARANTINE' THEN 'PROVIDER_QUARANTINED_BY_ANOMALY_THRESHOLD' ELSE 'PROVIDER_WARNING_BY_ANOMALY_THRESHOLD' END,
                        'system_protection',
                        v_prov,
                        jsonb_build_object(
                            'previous_status', v_prov_row.status,
                            'new_status', v_next_status,
                            'consecutive_suspicious_anomalies', v_next_suspicious,
                            'category', v_cat,
                            'error_code', p_error_code
                        )
                    );
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.admin_review_provider_anomalies(
    p_provider_id TEXT,
    p_new_status TEXT DEFAULT 'ACTIVE',
    p_reason TEXT DEFAULT 'ADMIN_QUARANTINE_LIFTED',
    p_actor TEXT DEFAULT 'admin'
) RETURNS JSONB AS $$
DECLARE
    v_prov TEXT := lower(trim(COALESCE(p_provider_id, '')));
    v_status TEXT := upper(trim(COALESCE(p_new_status, 'ACTIVE')));
    v_actor TEXT := COALESCE(NULLIF(trim(p_actor), ''), 'admin');
    v_reason TEXT := COALESCE(NULLIF(trim(p_reason), ''), 'ADMIN_QUARANTINE_LIFTED');
    v_row core.provider_reputation%ROWTYPE;
BEGIN
    IF length(v_prov) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_ID_REQUIRED');
    END IF;
    IF v_status NOT IN ('ACTIVE', 'WARNING', 'QUARANTINE', 'BANNED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_PROVIDER_STATUS');
    END IF;

    SELECT * INTO v_row
      FROM core.provider_reputation
     WHERE provider_id = v_prov
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_NOT_FOUND');
    END IF;

    UPDATE core.provider_reputation
       SET status = v_status,
           consecutive_suspicious_anomalies = CASE WHEN v_status IN ('ACTIVE', 'WARNING') THEN 0 ELSE consecutive_suspicious_anomalies END,
           quarantine_reason = CASE WHEN v_status = 'ACTIVE' THEN NULL ELSE v_reason END,
           updated_at = NOW()
     WHERE provider_id = v_prov
     RETURNING * INTO v_row;

    PERFORM core.sync_provider_exposure_status(v_prov);

    INSERT INTO core.provider_audit_log (provider_id, action, details)
    VALUES (
        v_prov,
        'ADMIN_ANOMALY_REVIEW',
        jsonb_build_object('new_status', v_status, 'reason', v_reason, 'actor', v_actor, 'anomalies_reset', (v_status IN ('ACTIVE', 'WARNING')))
    );

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'PROVIDER_ADMIN_REVIEW',
        v_actor,
        v_prov,
        jsonb_build_object('new_status', v_status, 'reason', v_reason)
    );

    RETURN jsonb_build_object('ok', true, 'provider', row_to_json(v_row));
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. ESTENSIONE VISTA TESORERIA PER-ASSET (IMPEGNI APPROVED + RISERVA 15%)
--    Preserva tutte le 9 colonne originali di 013 e aggiunge colonne di audit.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_treasury_vault_status AS
SELECT
    tv.asset,
    tv.actual_cash_on_chain::NUMERIC(18, 6) AS actual_cash_on_chain,
    tv.disbursed_usd::NUMERIC(18, 6) AS disbursed_usd,
    tv.points_equivalent_capacity::BIGINT AS points_equivalent_capacity,
    tv.disbursed_points::BIGINT AS disbursed_points,
    tv.reserved_buffer_percent::NUMERIC(4, 2) AS reserved_buffer_percent,
    GREATEST(0, tv.points_equivalent_capacity - tv.disbursed_points)::BIGINT AS gross_remaining_points,
    FLOOR(
        GREATEST(0, tv.points_equivalent_capacity - tv.disbursed_points) * (1 - tv.reserved_buffer_percent)
    )::BIGINT AS net_withdrawable_points,
    tv.updated_at,
    COALESCE((
        SELECT SUM(pr.points)
          FROM core.payout_requests pr
         WHERE pr.crypto_asset = tv.asset
           AND pr.status = 'APPROVED'
    ), 0)::BIGINT AS approved_pending_points,
    GREATEST(
        0,
        FLOOR(
            GREATEST(0, tv.points_equivalent_capacity - tv.disbursed_points) * (1 - tv.reserved_buffer_percent)
        )::BIGINT - COALESCE((
            SELECT SUM(pr.points)
              FROM core.payout_requests pr
             WHERE pr.crypto_asset = tv.asset
               AND pr.status = 'APPROVED'
        ), 0)::BIGINT
    )::BIGINT AS available_after_approved_points,
    GREATEST(
        0,
        GREATEST(0, tv.points_equivalent_capacity - tv.disbursed_points) - FLOOR(
            GREATEST(0, tv.points_equivalent_capacity - tv.disbursed_points) * (1 - tv.reserved_buffer_percent)
        )
    )::BIGINT AS reserved_15pct_points
FROM core.treasury_vault tv
ORDER BY tv.asset ASC;

COMMIT;
