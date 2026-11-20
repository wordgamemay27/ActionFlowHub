-- ============================================================================
-- MIGRATION: 014_audit_hardening_fixes.sql
-- DESCRIZIONE:
--   Correzioni di sicurezza e integrità contabile post-audit indipendente:
--   1. Kill Switch fail-closed in `core.get_payout_kill_switch`,
--      `request_payout_atomic`, `approve_payout_atomic`, `complete_payout_atomic`.
--   2. Blocco sovra-approvazioni concorrenti: `approve_payout_atomic` e
--      `complete_payout_atomic` sottraggono i payout `APPROVED` in corso
--      dalla capacità netta del singolo asset + lock per asset.
--   3. Doppia approvazione defense-in-depth in `complete_payout_atomic`
--      (`first_approved_by <> second_approved_by`, entrambi NOT NULL).
--   4. Recupero automatico dei debiti da storno (`core.recover_user_clawback_debt`)
--      invocato in `execute_batch_settlement` e `release_settled_to_withdrawable_for_user`.
--   5. Riferimento swap/tx obbligatorio, univoco e validato FX in
--      `core.record_treasury_conversion`.
--   6. Coda persistente PostgreSQL `core.settlement_jobs` per `SettlementWorker`.
--   7. Finestra di deduplicazione server-side in `request_payout_atomic` anche
--      se il client rigenera una nuova `idempotency_key`.
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-013.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. CODA PERSISTENTE SETTLEMENT WORKER & VINCOLO UNIVOCITÀ CONVERSIONI
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.settlement_jobs (
    batch_id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    period_start_ms BIGINT NOT NULL,
    period_end_ms BIGINT NOT NULL,
    expected_gross_usd NUMERIC(14, 2) NOT NULL DEFAULT 0,
    actual_net_received_usd NUMERIC(14, 2) NOT NULL DEFAULT 0,
    haircut_ratio NUMERIC(6, 4) NOT NULL DEFAULT 1.0,
    onchain_tx_hash TEXT NOT NULL,
    received_asset TEXT NOT NULL DEFAULT 'USDT',
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_jobs_status_created
    ON core.settlement_jobs (status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_conversions_ext_tx_ref_unique
    ON core.treasury_conversions (external_tx_ref)
    WHERE external_tx_ref IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. KILL SWITCH GLOBALE FAIL-CLOSED
-- ----------------------------------------------------------------------------
INSERT INTO core.system_controls (control_key, is_enabled, reason, updated_by, metadata)
VALUES ('PAYOUT_KILL_SWITCH', TRUE, 'Blocco preventivo fail-closed in modalita MANUAL_EXTERNAL fino a validazione staging', 'system', '{}'::jsonb)
ON CONFLICT (control_key) DO NOTHING;

CREATE OR REPLACE FUNCTION core.get_payout_kill_switch()
RETURNS JSONB AS $$
DECLARE
    v_row core.system_controls%ROWTYPE;
BEGIN
    SELECT * INTO v_row
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_KILL_SWITCH';

    IF NOT FOUND THEN
        -- Fail-closed: se la riga di controllo manca, i pagamenti restano bloccati
        RETURN jsonb_build_object(
            'is_enabled', true,
            'reason', 'KILL_SWITCH_CONTROL_ROW_MISSING_FAIL_CLOSED'
        );
    END IF;

    RETURN jsonb_build_object(
        'is_enabled', v_row.is_enabled,
        'reason', v_row.reason,
        'updated_by', v_row.updated_by,
        'updated_at', v_row.updated_at
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. RECUPERO AUTOMATICO DEBITI DA STORNO (CLAWBACK DEBT AUTO-RECOVERY)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.recover_user_clawback_debt(
    p_user_id BIGINT,
    p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user core.users%ROWTYPE;
    v_debt BIGINT := 0;
    v_settled_bal BIGINT := 0;
    v_withdrawable_bal BIGINT := 0;
    v_from_settled BIGINT := 0;
    v_from_withdrawable BIGINT := 0;
    v_recovered BIGINT := 0;
    v_tx_id UUID;
    v_ref TEXT := COALESCE(NULLIF(trim(COALESCE(p_reference_id, '')), ''), 'debt_rec_' || p_user_id || '_' || gen_random_uuid()::text);
BEGIN
    SELECT * INTO v_user
      FROM core.users
     WHERE user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
    END IF;

    v_debt := GREATEST(0, COALESCE(v_user.clawback_debt_points, 0));
    IF v_debt = 0 THEN
        RETURN jsonb_build_object('ok', true, 'recovered_points', 0, 'remaining_debt_points', 0);
    END IF;

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('SYSTEM:CLAWBACK_RECOVERY', 'SYSTEM_EQUITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('SYSTEM:CLAWBACK_RECOVERY', 0)
    ON CONFLICT (account_id) DO NOTHING;

    SELECT COALESCE(balance, 0) INTO v_settled_bal
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':SETTLED'
     FOR UPDATE;

    SELECT COALESCE(balance, 0) INTO v_withdrawable_bal
      FROM core.balances
     WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'
     FOR UPDATE;

    PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:CLAWBACK_RECOVERY' FOR UPDATE;

    v_from_settled := LEAST(GREATEST(0, COALESCE(v_settled_bal, 0)), v_debt);
    v_debt := v_debt - v_from_settled;

    v_from_withdrawable := LEAST(GREATEST(0, COALESCE(v_withdrawable_bal, 0)), v_debt);
    v_debt := v_debt - v_from_withdrawable;

    v_recovered := v_from_settled + v_from_withdrawable;

    IF v_recovered > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('DEBT_AUTO_RECOVERY', v_ref, 'Recupero automatico debito clawback utente ' || p_user_id)
        RETURNING tx_id INTO v_tx_id;

        IF v_from_settled > 0 THEN
            INSERT INTO core.ledger_entries (tx_id, account_id, amount)
            VALUES
                (v_tx_id, 'USER_' || p_user_id || ':SETTLED', -v_from_settled),
                (v_tx_id, 'SYSTEM:CLAWBACK_RECOVERY', v_from_settled);

            UPDATE core.balances
               SET balance = balance - v_from_settled, updated_at = NOW()
             WHERE account_id = 'USER_' || p_user_id || ':SETTLED';
        END IF;

        IF v_from_withdrawable > 0 THEN
            INSERT INTO core.ledger_entries (tx_id, account_id, amount)
            VALUES
                (v_tx_id, 'USER_' || p_user_id || ':WITHDRAWABLE', -v_from_withdrawable),
                (v_tx_id, 'SYSTEM:CLAWBACK_RECOVERY', v_from_withdrawable);

            UPDATE core.balances
               SET balance = balance - v_from_withdrawable, updated_at = NOW()
             WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE';
        END IF;

        UPDATE core.balances
           SET balance = balance + v_recovered, updated_at = NOW()
         WHERE account_id = 'SYSTEM:CLAWBACK_RECOVERY';

        UPDATE core.users
           SET clawback_debt_points = GREATEST(0, clawback_debt_points - v_recovered),
               updated_at = NOW()
         WHERE user_id = p_user_id;

        INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
        VALUES (
            'CLAWBACK_DEBT_AUTO_RECOVERED',
            'system',
            p_user_id::text,
            jsonb_build_object(
                'reference_id', v_ref,
                'recovered_from_settled', v_from_settled,
                'recovered_from_withdrawable', v_from_withdrawable,
                'total_recovered', v_recovered,
                'remaining_debt_points', v_debt
            )
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'recovered_points', v_recovered,
        'remaining_debt_points', v_debt
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. REGISTRAZIONE CONVERSIONE TESORERIA CON RIFERIMENTO OBBLIGATORIO & CHECK FX
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.record_treasury_conversion(
    p_conversion_id TEXT,
    p_from_asset TEXT,
    p_to_asset TEXT,
    p_amount_usd NUMERIC,
    p_fx_rate NUMERIC DEFAULT 1.0,
    p_external_tx_ref TEXT DEFAULT NULL,
    p_recorded_by TEXT DEFAULT 'owner',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_clean_id TEXT := trim(COALESCE(p_conversion_id, ''));
    v_from TEXT := upper(trim(COALESCE(p_from_asset, '')));
    v_to TEXT := upper(trim(COALESCE(p_to_asset, '')));
    v_usd NUMERIC(14, 2) := ROUND(COALESCE(p_amount_usd, 0)::numeric, 2);
    v_points BIGINT := FLOOR(v_usd * 100);
    v_clean_ref TEXT := trim(COALESCE(p_external_tx_ref, ''));
    v_fx_rate NUMERIC := COALESCE(p_fx_rate, 1.0);
    v_snapshot_rate NUMERIC;
    v_volatile_asset TEXT;
    v_from_vault core.treasury_vault%ROWTYPE;
    v_to_vault core.treasury_vault%ROWTYPE;
    v_from_net_pts BIGINT := 0;
    v_from_approved_pts BIGINT := 0;
BEGIN
    IF length(v_clean_id) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONVERSION_ID');
    END IF;
    IF v_from = '' OR v_to = '' OR v_from = v_to THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONVERSION_ASSETS');
    END IF;
    IF v_from NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET')
       OR v_to NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_TREASURY_ASSET');
    END IF;
    IF v_usd <= 0 OR v_points <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONVERSION_AMOUNT');
    END IF;
    IF length(v_clean_ref) < 8 OR v_clean_ref ~* '^(sim_|fake_|mock_|test_|demo_)' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONVERSION_EXTERNAL_TX_REF_REQUIRED');
    END IF;
    IF v_fx_rate <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONVERSION_FX_RATE');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('treasury_conv_' || v_clean_id));
    PERFORM pg_advisory_xact_lock(hashtext('treasury_conv_ref_' || v_clean_ref));

    IF EXISTS (SELECT 1 FROM core.treasury_conversions WHERE conversion_id = v_clean_id) THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'conversion_id', v_clean_id);
    END IF;

    IF EXISTS (SELECT 1 FROM core.treasury_conversions WHERE external_tx_ref = v_clean_ref) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONVERSION_TX_REF_ALREADY_USED');
    END IF;

    -- Verifica coerenza FX snapshot quando uno degli asset e' volatile
    IF v_to IN ('TON', 'SOL', 'PI') OR v_from IN ('TON', 'SOL', 'PI') THEN
        v_volatile_asset := CASE WHEN v_to IN ('TON', 'SOL', 'PI') THEN v_to ELSE v_from END;
        SELECT usd_per_unit INTO v_snapshot_rate
          FROM core.fx_price_snapshots
         WHERE asset = v_volatile_asset
           AND is_valid = TRUE
           AND expires_at > NOW()
         ORDER BY fetched_at DESC, snapshot_id DESC
         LIMIT 1;

        IF v_snapshot_rate IS NOT NULL AND v_snapshot_rate > 0 AND v_fx_rate <> 1.0 THEN
            IF ABS(v_fx_rate - v_snapshot_rate) / v_snapshot_rate > 0.20 THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'CONVERSION_FX_DEVIATION_EXCEEDED',
                    'asset', v_volatile_asset,
                    'provided_rate', v_fx_rate,
                    'snapshot_rate', v_snapshot_rate
                );
            END IF;
        END IF;
    END IF;

    IF v_from < v_to THEN
        SELECT * INTO v_from_vault FROM core.treasury_vault WHERE asset = v_from FOR UPDATE;
        SELECT * INTO v_to_vault FROM core.treasury_vault WHERE asset = v_to FOR UPDATE;
    ELSE
        SELECT * INTO v_to_vault FROM core.treasury_vault WHERE asset = v_to FOR UPDATE;
        SELECT * INTO v_from_vault FROM core.treasury_vault WHERE asset = v_from FOR UPDATE;
    END IF;

    IF v_from_vault.asset IS NULL OR v_to_vault.asset IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TREASURY_ASSET_ROW_MISSING');
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_from_approved_pts
      FROM core.payout_requests
     WHERE crypto_asset = v_from
       AND status = 'APPROVED';

    v_from_net_pts := FLOOR(
        GREATEST(0, v_from_vault.points_equivalent_capacity - v_from_vault.disbursed_points)
        * (1 - v_from_vault.reserved_buffer_percent)
    )::BIGINT - v_from_approved_pts;

    IF v_from_net_pts < v_points THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'SOURCE_ASSET_NET_CAPACITY_INSUFFICIENT',
            'from_asset', v_from,
            'available_net_points', GREATEST(0, v_from_net_pts),
            'requested_points', v_points
        );
    END IF;

    UPDATE core.treasury_vault
       SET actual_cash_on_chain = GREATEST(0, actual_cash_on_chain - v_usd),
           points_equivalent_capacity = GREATEST(disbursed_points, points_equivalent_capacity - v_points),
           updated_at = NOW()
     WHERE asset = v_from;

    UPDATE core.treasury_vault
       SET actual_cash_on_chain = actual_cash_on_chain + v_usd,
           points_equivalent_capacity = points_equivalent_capacity + v_points,
           updated_at = NOW()
     WHERE asset = v_to;

    INSERT INTO core.treasury_conversions (
        conversion_id, from_asset, to_asset, amount_usd, points_moved,
        fx_rate_used, external_tx_ref, recorded_by, note
    ) VALUES (
        v_clean_id, v_from, v_to, v_usd, v_points,
        GREATEST(0.00000001, v_fx_rate),
        v_clean_ref,
        COALESCE(NULLIF(trim(p_recorded_by), ''), 'owner'),
        p_note
    );

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'TREASURY_CONVERSION',
        COALESCE(NULLIF(trim(p_recorded_by), ''), 'owner'),
        v_clean_id,
        jsonb_build_object(
            'from_asset', v_from,
            'to_asset', v_to,
            'amount_usd', v_usd,
            'points_moved', v_points,
            'fx_rate_used', v_fx_rate,
            'external_tx_ref', v_clean_ref
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'conversion_id', v_clean_id,
        'from_asset', v_from,
        'to_asset', v_to,
        'amount_usd', v_usd,
        'points_moved', v_points,
        'external_tx_ref', v_clean_ref
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 5. BATCH SETTLEMENT CON RECUPERO AUTOMATICO DEBITI DA STORNO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.execute_batch_settlement(
    p_batch_id TEXT,
    p_partner_id TEXT,
    p_period_start BIGINT,
    p_period_end BIGINT,
    p_expected_gross_usd NUMERIC,
    p_actual_net_usd NUMERIC,
    p_haircut_ratio NUMERIC,
    p_onchain_tx_hash TEXT,
    p_received_asset TEXT DEFAULT 'USDT'
) RETURNS JSONB AS $$
DECLARE
    v_clean_batch TEXT := trim(COALESCE(p_batch_id, ''));
    v_clean_partner TEXT := trim(COALESCE(p_partner_id, ''));
    v_actual_net NUMERIC := GREATEST(0, COALESCE(p_actual_net_usd, 0));
    v_clean_tx TEXT := trim(COALESCE(p_onchain_tx_hash, ''));
    v_received_asset TEXT := upper(trim(COALESCE(NULLIF(p_received_asset, ''), 'USDT')));
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

    IF v_received_asset NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET') THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_SETTLEMENT_ASSET', 'asset', v_received_asset);
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
            'received_asset', v_received_asset,
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
        VALUES (v_received_asset, v_actual_net, v_points_capacity, 0.15)
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

            -- Compensazione automatica eventuale debito da storno sui punti SETTLED
            IF v_user_settled > 0 THEN
                PERFORM core.recover_user_clawback_debt(v_event.user_id, 'settle_' || v_event.event_id);
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
        VALUES ('SETTLEMENT', v_clean_batch, 'Liquidazione Tesoreria (' || v_received_asset || ') Batch ' || v_clean_partner)
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
        total_points_settled, unallocated_points, received_asset
    ) VALUES (
        v_clean_batch, v_clean_partner, p_period_start, p_period_end,
        GREATEST(0, COALESCE(p_expected_gross_usd, 0)), v_actual_net, v_ratio, v_effective_ratio,
        NULLIF(v_clean_tx, ''), v_settled_count, v_revoked_zero_count,
        v_total_points_settled, v_remaining_capacity, v_received_asset
    );

    RETURN jsonb_build_object(
        'success', true,
        'idempotent', false,
        'batch_id', v_clean_batch,
        'partner_id', v_clean_partner,
        'received_asset', v_received_asset,
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
-- 6. PAYOUT ATOMICI HARDENED: KILL SWITCH FAIL-CLOSED, DEDUPLICAZIONE E
--    PROTEZIONE CONCORRENZA SU APPROVAZIONI MULTIPLE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.request_payout_atomic(
    p_request_id TEXT,
    p_user_id BIGINT,
    p_points BIGINT,
    p_crypto_asset TEXT,
    p_payout_channel TEXT,
    p_wallet_address TEXT,
    p_idempotency_key TEXT,
    p_max_fx_age_seconds INTEGER DEFAULT 600
) RETURNS JSONB AS $$
DECLARE
    v_existing core.payout_requests%ROWTYPE;
    v_user core.users%ROWTYPE;
    v_withdrawable BIGINT;
    v_tx_id UUID;
    v_usd NUMERIC(14, 2);
    v_asset_amount NUMERIC(18, 6);
    v_ton NUMERIC(18, 6) := 0;
    v_upper_asset TEXT := upper(trim(COALESCE(p_crypto_asset, 'TON')));
    v_upper_channel TEXT := upper(trim(COALESCE(p_payout_channel, 'CRYPTO_DIRECT')));
    v_clean_wallet TEXT := trim(COALESCE(p_wallet_address, ''));
    v_fx core.fx_price_snapshots%ROWTYPE;
    v_fx_snapshot_id BIGINT := NULL;
    v_fx_usd_per_asset NUMERIC(18, 8) := 1.00000000;
    v_fx_source TEXT := 'USD_PARITY';
    v_fx_quoted_at TIMESTAMPTZ := NOW();
    v_max_age INTEGER := GREATEST(30, LEAST(3600, COALESCE(p_max_fx_age_seconds, 600)));
    v_kill_switch BOOLEAN := TRUE;
    v_limits JSONB := '{}'::jsonb;
    v_max_single BIGINT := 10000;
    v_max_user_daily BIGINT := 20000;
    v_max_global_daily BIGINT := 100000;
    v_max_asset_daily BIGINT := 75000;
    v_dual_threshold BIGINT := 5000;
    v_user_daily_used BIGINT := 0;
    v_global_daily_used BIGINT := 0;
    v_asset_daily_used BIGINT := 0;
BEGIN
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_IDEMPOTENCY_KEY');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('payout_req_' || p_idempotency_key));
    PERFORM pg_advisory_xact_lock(hashtext('payout_user_limit_' || COALESCE(p_user_id::text, '0')));
    PERFORM pg_advisory_xact_lock(hashtext('payout_global_limit'));

    SELECT * INTO v_existing
      FROM core.payout_requests
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'payout', row_to_json(v_existing));
    END IF;

    -- Deduplicazione server-side su finestra 15s contro doppio click anche con chiavi client diverse
    SELECT * INTO v_existing
      FROM core.payout_requests
     WHERE user_id = p_user_id
       AND points = p_points
       AND crypto_asset = v_upper_asset
       AND wallet_address = v_clean_wallet
       AND status = 'PENDING'
       AND created_at >= NOW() - INTERVAL '15 seconds'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'deduplication', 'ACTIVE_WINDOW_15S', 'payout', row_to_json(v_existing));
    END IF;

    -- Kill switch globale (fail-closed se riga assente)
    SELECT is_enabled INTO v_kill_switch
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_KILL_SWITCH';
    IF NOT FOUND OR COALESCE(v_kill_switch, TRUE) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_KILL_SWITCH_ACTIVE');
    END IF;

    IF p_points IS NULL OR p_points < 500 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'MINIMUM_500_PT_REQUIRED');
    END IF;

    IF length(v_clean_wallet) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_WALLET_ADDRESS');
    END IF;

    IF v_upper_asset NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_PAYEER', 'CASH_AIRTM', 'CASH_VOLET') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNSUPPORTED_PAYOUT_ASSET', 'asset', v_upper_asset);
    END IF;

    IF (v_upper_asset LIKE 'CASH_%' AND v_upper_channel <> 'CASH_LOCAL')
       OR (v_upper_asset NOT LIKE 'CASH_%' AND v_upper_channel <> 'CRYPTO_DIRECT') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_CHANNEL_ASSET_MISMATCH');
    END IF;

    SELECT metadata INTO v_limits
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_FINANCIAL_LIMITS';
    IF v_limits IS NOT NULL THEN
        v_max_single := COALESCE((v_limits->>'max_single_payout_points')::bigint, 10000);
        v_max_user_daily := COALESCE((v_limits->>'max_user_daily_points')::bigint, 20000);
        v_max_global_daily := COALESCE((v_limits->>'max_global_daily_points')::bigint, 100000);
        v_dual_threshold := COALESCE((v_limits->>'dual_approval_threshold_points')::bigint, 5000);
        v_max_asset_daily := COALESCE((v_limits->'per_asset_daily_points'->>v_upper_asset)::bigint, v_max_global_daily);
    END IF;

    IF p_points > v_max_single THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SINGLE_PAYOUT_LIMIT_EXCEEDED', 'max_points', v_max_single);
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_user_daily_used
      FROM core.payout_requests
     WHERE user_id = p_user_id
       AND status IN ('PENDING', 'APPROVED', 'COMPLETED')
       AND created_at >= NOW() - INTERVAL '24 hours';
    IF (v_user_daily_used + p_points) > v_max_user_daily THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_DAILY_PAYOUT_LIMIT_EXCEEDED', 'max_daily_points', v_max_user_daily);
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_asset_daily_used
      FROM core.payout_requests
     WHERE crypto_asset = v_upper_asset
       AND status IN ('PENDING', 'APPROVED', 'COMPLETED')
       AND created_at >= NOW() - INTERVAL '24 hours';
    IF (v_asset_daily_used + p_points) > v_max_asset_daily THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ASSET_DAILY_PAYOUT_LIMIT_EXCEEDED', 'asset', v_upper_asset, 'max_daily_points', v_max_asset_daily);
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_global_daily_used
      FROM core.payout_requests
     WHERE status IN ('PENDING', 'APPROVED', 'COMPLETED')
       AND created_at >= NOW() - INTERVAL '24 hours';
    IF (v_global_daily_used + p_points) > v_max_global_daily THEN
        RETURN jsonb_build_object('ok', false, 'error', 'GLOBAL_DAILY_PAYOUT_LIMIT_EXCEEDED', 'max_daily_points', v_max_global_daily);
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
            RETURN jsonb_build_object('ok', false, 'error', 'FX_PRICE_UNAVAILABLE_PAYOUT_BLOCKED', 'asset', v_upper_asset);
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

    -- Prova eventuale recupero automatico prima di bloccare su debito residuo
    PERFORM core.recover_user_clawback_debt(p_user_id, 'pre_req_' || p_request_id);

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_BLOCKED');
    END IF;
    IF COALESCE(v_user.clawback_debt_points, 0) > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_CLAWBACK_DEBT_PENDING', 'debt_points', v_user.clawback_debt_points);
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
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_WITHDRAWABLE_BALANCE', 'withdrawable_points', COALESCE(v_withdrawable, 0));
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
        fx_snapshot_id, fx_usd_per_asset, fx_source, fx_quoted_at, asset_amount,
        requires_dual_approval
    ) VALUES (
        p_request_id, p_user_id, p_idempotency_key, p_points, v_usd, v_ton,
        v_upper_asset, v_upper_channel, v_clean_wallet, 'PENDING', 'PENDING_ADMIN_DISBURSEMENT',
        v_fx_snapshot_id, v_fx_usd_per_asset, v_fx_source, v_fx_quoted_at, v_asset_amount,
        (p_points >= v_dual_threshold)
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_existing));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION core.approve_payout_atomic(
    p_request_id TEXT,
    p_admin_actor TEXT DEFAULT 'admin',
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_kill_switch BOOLEAN := TRUE;
    v_actor TEXT := COALESCE(NULLIF(trim(p_admin_actor), ''), 'admin');
    v_vault core.treasury_vault%ROWTYPE;
    v_asset_net_pts BIGINT := 0;
    v_approved_reserved_pts BIGINT := 0;
    v_effective_net_pts BIGINT := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || COALESCE(p_request_id, '')));

    SELECT is_enabled INTO v_kill_switch
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_KILL_SWITCH';
    IF NOT FOUND OR COALESCE(v_kill_switch, TRUE) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_KILL_SWITCH_ACTIVE');
    END IF;

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

    -- Lock esclusivo sul vault dell'asset per serializzare approvazioni concorrenti
    PERFORM pg_advisory_xact_lock(hashtext('treasury_vault_' || v_payout.crypto_asset));

    SELECT * INTO v_vault
      FROM core.treasury_vault
     WHERE asset = v_payout.crypto_asset
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TREASURY_ASSET_VAULT_MISSING', 'asset', v_payout.crypto_asset);
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_approved_reserved_pts
      FROM core.payout_requests
     WHERE crypto_asset = v_payout.crypto_asset
       AND status = 'APPROVED'
       AND request_id <> p_request_id;

    v_asset_net_pts := FLOOR(
        GREATEST(0, v_vault.points_equivalent_capacity - v_vault.disbursed_points)
        * (1 - v_vault.reserved_buffer_percent)
    )::BIGINT;

    v_effective_net_pts := GREATEST(0, v_asset_net_pts - v_approved_reserved_pts);

    IF v_effective_net_pts < v_payout.points THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TREASURY_VAULT_ASSET_INSUFFICIENT',
            'asset', v_payout.crypto_asset,
            'remaining_asset_net_points', v_effective_net_pts,
            'approved_pending_points', v_approved_reserved_pts,
            'requested_points', v_payout.points
        );
    END IF;

    IF v_payout.requires_dual_approval THEN
        IF v_payout.first_approved_by IS NULL THEN
            UPDATE core.payout_requests
               SET first_approved_by = v_actor,
                   first_approved_at = NOW(),
                   payout_status = 'AWAITING_SECOND_APPROVAL',
                   note = COALESCE(p_note, note, 'Prima approvazione registrata; richiesta seconda firma admin distinta'),
                   updated_at = NOW()
             WHERE request_id = p_request_id
             RETURNING * INTO v_payout;

            INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
            VALUES ('PAYOUT_FIRST_APPROVAL', v_actor, p_request_id, jsonb_build_object('points', v_payout.points, 'asset', v_payout.crypto_asset));

            RETURN jsonb_build_object(
                'ok', true,
                'idempotent', false,
                'requires_second_approval', true,
                'payout', row_to_json(v_payout)
            );
        END IF;

        IF v_payout.first_approved_by = v_actor THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'DUAL_APPROVAL_DISTINCT_ADMIN_REQUIRED',
                'first_approved_by', v_payout.first_approved_by
            );
        END IF;

        UPDATE core.payout_requests
           SET status = 'APPROVED',
               payout_status = 'APPROVED_READY_FOR_DISBURSEMENT',
               approved_by = v_payout.first_approved_by || ' + ' || v_actor,
               second_approved_by = v_actor,
               second_approved_at = NOW(),
               approved_at = NOW(),
               note = COALESCE(p_note, note, 'Doppia approvazione completata'),
               updated_at = NOW()
         WHERE request_id = p_request_id
         RETURNING * INTO v_payout;

        INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
        VALUES ('PAYOUT_DUAL_APPROVED', v_actor, p_request_id, jsonb_build_object('first_admin', v_payout.first_approved_by, 'second_admin', v_actor));

        RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
    END IF;

    UPDATE core.payout_requests
       SET status = 'APPROVED',
           payout_status = 'APPROVED_READY_FOR_DISBURSEMENT',
           approved_by = v_actor,
           approved_at = NOW(),
           note = COALESCE(p_note, note, 'Approvato dall''amministratore per erogazione verificabile'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES ('PAYOUT_APPROVED', v_actor, p_request_id, jsonb_build_object('points', v_payout.points, 'asset', v_payout.crypto_asset));

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
    v_kill_switch BOOLEAN := TRUE;
    v_reserved_bal BIGINT;
    v_vault core.treasury_vault%ROWTYPE;
    v_asset_net_pts BIGINT := 0;
    v_other_approved_pts BIGINT := 0;
    v_effective_net_pts BIGINT := 0;
    v_tx_id UUID;
BEGIN
    IF length(v_clean_hash) < 8
       OR v_clean_hash ~* '^(sim_|fake_|mock_|test_|demo_|tx_confirmed_|tx_onchain_)' THEN
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

    SELECT is_enabled INTO v_kill_switch
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_KILL_SWITCH';
    IF NOT FOUND OR COALESCE(v_kill_switch, TRUE) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_KILL_SWITCH_ACTIVE');
    END IF;

    IF v_payout.status NOT IN ('PENDING', 'APPROVED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE_TRANSITION_' || v_payout.status);
    END IF;

    IF v_payout.requires_dual_approval THEN
        IF v_payout.status <> 'APPROVED'
           OR v_payout.first_approved_by IS NULL
           OR v_payout.second_approved_by IS NULL
           OR v_payout.first_approved_by = v_payout.second_approved_by THEN
            RETURN jsonb_build_object('ok', false, 'error', 'DUAL_APPROVAL_REQUIRED_BEFORE_COMPLETE');
        END IF;
    END IF;

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

    PERFORM pg_advisory_xact_lock(hashtext('treasury_vault_' || v_payout.crypto_asset));

    SELECT * INTO v_vault
      FROM core.treasury_vault
     WHERE asset = v_payout.crypto_asset
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TREASURY_ASSET_VAULT_MISSING', 'asset', v_payout.crypto_asset);
    END IF;

    SELECT COALESCE(SUM(points), 0)::BIGINT INTO v_other_approved_pts
      FROM core.payout_requests
     WHERE crypto_asset = v_payout.crypto_asset
       AND status = 'APPROVED'
       AND request_id <> p_request_id;

    v_asset_net_pts := FLOOR(
        GREATEST(0, v_vault.points_equivalent_capacity - v_vault.disbursed_points)
        * (1 - v_vault.reserved_buffer_percent)
    )::BIGINT;

    v_effective_net_pts := GREATEST(0, v_asset_net_pts - v_other_approved_pts);

    IF v_effective_net_pts < v_payout.points THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TREASURY_VAULT_ASSET_INSUFFICIENT',
            'asset', v_payout.crypto_asset,
            'remaining_asset_net_points', v_effective_net_pts,
            'approved_pending_points', v_other_approved_pts,
            'requested_points', v_payout.points
        );
    END IF;

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('SYSTEM:PAID', 'SYSTEM_LIABILITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('SYSTEM:PAID', 0)
    ON CONFLICT (account_id) DO NOTHING;

    PERFORM 1 FROM core.balances WHERE account_id = 'SYSTEM:PAID' FOR UPDATE;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('PAYOUT_COMPLETE', p_request_id, 'Chiusura prelievo verificato ' || v_payout.crypto_asset || ' tx=' || v_clean_hash)
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

    UPDATE core.treasury_vault
       SET disbursed_usd = disbursed_usd + v_payout.amount_usd,
           disbursed_points = disbursed_points + v_payout.points,
           updated_at = NOW()
     WHERE asset = v_payout.crypto_asset;

    INSERT INTO core.processed_tx_hashes (tx_hash)
    VALUES ('payout:' || v_clean_hash)
    ON CONFLICT DO NOTHING;

    UPDATE core.payout_requests
       SET status = 'COMPLETED',
           payout_status = 'COMPLETED_ONCHAIN',
           tx_hash = v_clean_hash,
           note = COALESCE(p_note, note, 'Erogazione verificata e saldata'),
           completed_at = NOW(),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 7. RILASCIO SETTLED -> WITHDRAWABLE CON RECUPERO AUTOMATICO DEBITI
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

    -- Estingue automaticamente eventuali debiti da storno prima di rilasciare fondi
    PERFORM core.recover_user_clawback_debt(p_user_id, COALESCE(v_clean_ref, 'rel_' || p_user_id));

    SELECT * INTO v_user FROM core.users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;
    IF v_user.is_blocked THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_BLOCKED');
    END IF;
    IF COALESCE(v_user.clawback_debt_points, 0) > 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'USER_HAS_UNSETTLED_CLAWBACK_DEBT',
            'remaining_debt_points', v_user.clawback_debt_points
        );
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

    PERFORM 1 FROM core.treasury_vault ORDER BY asset ASC FOR UPDATE;

    SELECT COALESCE(
        SUM(FLOOR(GREATEST(0, points_equivalent_capacity - disbursed_points) * (1 - reserved_buffer_percent))),
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

COMMIT;
