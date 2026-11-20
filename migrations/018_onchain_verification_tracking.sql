-- ============================================================================
-- MIGRATION: 018_onchain_verification_tracking.sql
-- DESCRIZIONE:
--   1. Tabella persistente `core.payout_onchain_verifications` per memorizzare
--      le prove on-chain/gateway verificate prima del passaggio a `COMPLETED`.
--   2. Colonne di tracciamento verifica su `core.payout_requests`:
--      `onchain_verified`, `onchain_network`, `onchain_confirmations`,
--      `onchain_verified_at`, `onchain_observed_amount`.
--   3. Controllo DB-level fail-closed in `core.complete_payout_atomic`:
--      nessun payout passa a `COMPLETED` senza record verificato in
--      `core.payout_onchain_verifications` (salvo disattivazione esplicita solo
--      in ambiente di test controllato).
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-017.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.payout_onchain_verifications (
    verification_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    network TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    expected_amount_asset NUMERIC(18, 6) NOT NULL DEFAULT 0,
    observed_amount_asset NUMERIC(18, 6),
    confirmations INTEGER,
    commitment_level TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_by TEXT NOT NULL DEFAULT 'onchain_verifier',
    raw_proof_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_payout_onchain_verifications_tx
    ON core.payout_onchain_verifications (tx_hash);

ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS onchain_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS onchain_network TEXT,
    ADD COLUMN IF NOT EXISTS onchain_confirmations INTEGER,
    ADD COLUMN IF NOT EXISTS onchain_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS onchain_observed_amount NUMERIC(18, 6);

INSERT INTO core.system_controls (control_key, is_enabled, reason, updated_by, metadata)
VALUES (
    'PAYOUT_ONCHAIN_PROOF_REQUIRED',
    TRUE,
    'Richiede registrazione prova on-chain/gateway verificata prima di COMPLETED',
    'system',
    '{"enforce_sql_proof_table": true}'::jsonb
)
ON CONFLICT (control_key) DO NOTHING;

CREATE OR REPLACE FUNCTION core.record_payout_onchain_verification(
    p_request_id TEXT,
    p_asset TEXT,
    p_network TEXT,
    p_tx_hash TEXT,
    p_destination_address TEXT,
    p_expected_amount_asset NUMERIC DEFAULT 0,
    p_observed_amount_asset NUMERIC DEFAULT NULL,
    p_confirmations INTEGER DEFAULT NULL,
    p_commitment_level TEXT DEFAULT NULL,
    p_verified BOOLEAN DEFAULT TRUE,
    p_verified_by TEXT DEFAULT 'onchain_verifier',
    p_raw_proof JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_clean_req TEXT := trim(COALESCE(p_request_id, ''));
    v_clean_hash TEXT := trim(COALESCE(p_tx_hash, ''));
    v_clean_asset TEXT := upper(trim(COALESCE(p_asset, 'TON')));
    v_clean_net TEXT := upper(trim(COALESCE(p_network, v_clean_asset)));
    v_ver_id TEXT;
    v_row core.payout_onchain_verifications%ROWTYPE;
BEGIN
    IF length(v_clean_req) = 0 OR length(v_clean_hash) < 8 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_VERIFICATION_INPUT');
    END IF;
    IF v_clean_hash ~* '^(sim_|fake_|mock_|test_|demo_|tx_confirmed_|tx_onchain_)' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REAL_VERIFIABLE_TX_HASH_REQUIRED');
    END IF;

    v_ver_id := 'ver_' || substr(encode(sha256(convert_to(v_clean_req || ':' || v_clean_hash, 'UTF8')), 'hex'), 1, 24);

    INSERT INTO core.payout_onchain_verifications (
        verification_id, request_id, asset, network, tx_hash, destination_address,
        expected_amount_asset, observed_amount_asset, confirmations, commitment_level,
        verified, verified_by, raw_proof_json, verified_at
    ) VALUES (
        v_ver_id, v_clean_req, v_clean_asset, v_clean_net, v_clean_hash, trim(COALESCE(p_destination_address, '')),
        COALESCE(p_expected_amount_asset, 0), p_observed_amount_asset, p_confirmations, p_commitment_level,
        COALESCE(p_verified, FALSE), COALESCE(NULLIF(trim(p_verified_by), ''), 'onchain_verifier'),
        COALESCE(p_raw_proof, '{}'::jsonb), NOW()
    )
    ON CONFLICT (request_id, tx_hash) DO UPDATE
        SET network = EXCLUDED.network,
            observed_amount_asset = COALESCE(EXCLUDED.observed_amount_asset, core.payout_onchain_verifications.observed_amount_asset),
            confirmations = COALESCE(EXCLUDED.confirmations, core.payout_onchain_verifications.confirmations),
            commitment_level = COALESCE(EXCLUDED.commitment_level, core.payout_onchain_verifications.commitment_level),
            verified = EXCLUDED.verified,
            verified_by = EXCLUDED.verified_by,
            raw_proof_json = EXCLUDED.raw_proof_json,
            verified_at = NOW()
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('ok', true, 'verification', row_to_json(v_row));
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
    v_proof_required BOOLEAN := TRUE;
    v_proof core.payout_onchain_verifications%ROWTYPE;
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

    -- Verifica prova on-chain/gateway registrata prima di chiudere il payout
    SELECT is_enabled INTO v_proof_required
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_ONCHAIN_PROOF_REQUIRED';
    IF NOT FOUND THEN
        v_proof_required := TRUE;
    END IF;

    SELECT * INTO v_proof
      FROM core.payout_onchain_verifications
     WHERE request_id = p_request_id
       AND tx_hash = v_clean_hash
       AND verified = TRUE
     ORDER BY verified_at DESC
     LIMIT 1;

    IF v_proof_required AND NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED');
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
           onchain_verified = COALESCE(v_proof.verified, TRUE),
           onchain_network = COALESCE(v_proof.network, v_payout.crypto_asset),
           onchain_confirmations = v_proof.confirmations,
           onchain_verified_at = COALESCE(v_proof.verified_at, NOW()),
           onchain_observed_amount = v_proof.observed_amount_asset,
           note = COALESCE(p_note, note, 'Erogazione verificata e saldata'),
           completed_at = NOW(),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

COMMIT;
