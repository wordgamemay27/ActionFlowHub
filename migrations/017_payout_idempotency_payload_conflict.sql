-- ============================================================================
-- MIGRATION: 017_payout_idempotency_payload_conflict.sql
-- DESCRIZIONE:
--   1. Aggiunge `request_payload_hash` su `core.payout_requests` + indice univoco
--      esplicito su `idempotency_key` per garantire idempotenza server-side reale.
--   2. Aggiorna `core.request_payout_atomic` per calcolare l'hash SHA-256 canonico
--      del payload `(user_id|points|asset|channel|wallet_address)`:
--      - stesso `idempotency_key` + stesso payload => ritorna richiesta esistente (idempotent: true)
--      - stesso `idempotency_key` + payload o utente diverso => rifiuta con
--        `IDEMPOTENCY_KEY_PAYLOAD_CONFLICT` (HTTP 409 Conflict).
--   3. Usa `sha256()` nativa PostgreSQL senza richiedere estensioni esterne.
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-016.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS request_payload_hash TEXT;

UPDATE core.payout_requests
   SET request_payload_hash = encode(
       sha256(
           convert_to(
               user_id::text || '|' ||
               COALESCE(points::text, '0') || '|' ||
               upper(trim(COALESCE(crypto_asset, 'TON'))) || '|' ||
               upper(trim(COALESCE(payout_channel, 'CRYPTO_DIRECT'))) || '|' ||
               trim(COALESCE(wallet_address, '')),
               'UTF8'
           )
       ),
       'hex'
   )
 WHERE request_payload_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_requests_idempotency_unique
    ON core.payout_requests (idempotency_key);

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
    v_clean_idem TEXT := trim(COALESCE(p_idempotency_key, ''));
    v_payload_hash TEXT;
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
    IF length(v_clean_idem) < 4 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_IDEMPOTENCY_KEY');
    END IF;

    v_payload_hash := encode(
        sha256(
            convert_to(
                COALESCE(p_user_id::text, '0') || '|' ||
                COALESCE(p_points::text, '0') || '|' ||
                v_upper_asset || '|' ||
                v_upper_channel || '|' ||
                v_clean_wallet,
                'UTF8'
            )
        ),
        'hex'
    );

    PERFORM pg_advisory_xact_lock(hashtext('payout_req_' || v_clean_idem));
    PERFORM pg_advisory_xact_lock(hashtext('payout_user_limit_' || COALESCE(p_user_id::text, '0')));
    PERFORM pg_advisory_xact_lock(hashtext('payout_global_limit'));

    SELECT * INTO v_existing
      FROM core.payout_requests
     WHERE idempotency_key = v_clean_idem
     FOR UPDATE;
    IF FOUND THEN
        IF v_existing.user_id <> p_user_id
           OR (v_existing.request_payload_hash IS NOT NULL AND v_existing.request_payload_hash <> v_payload_hash) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
                'request_id', v_existing.request_id
            );
        END IF;
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
        RETURN jsonb_build_object(
            'ok', true,
            'idempotent', true,
            'deduplication', 'ACTIVE_WINDOW_15S',
            'payout', row_to_json(v_existing)
        );
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
        request_id, user_id, idempotency_key, request_payload_hash, points, amount_usd, amount_ton,
        crypto_asset, payout_channel, wallet_address, status, payout_status,
        fx_snapshot_id, fx_usd_per_asset, fx_source, fx_quoted_at, asset_amount,
        requires_dual_approval
    ) VALUES (
        p_request_id, p_user_id, v_clean_idem, v_payload_hash, p_points, v_usd, v_ton,
        v_upper_asset, v_upper_channel, v_clean_wallet, 'PENDING', 'PENDING_ADMIN_DISBURSEMENT',
        v_fx_snapshot_id, v_fx_usd_per_asset, v_fx_source, v_fx_quoted_at, v_asset_amount,
        (p_points >= v_dual_threshold)
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_existing));
END;
$$ LANGUAGE plpgsql;

COMMIT;
