-- ============================================================================
-- MIGRATION: 020_payout_dispatch_claims_and_double_spend_guard.sql
-- DESCRIZIONE (Allineamento commit Kilo 090f479 — Protezione Double-Spend):
--   1. Colonne persistenti di stato trasmissione su `core.payout_requests`
--      (`active_dispatch_attempt_id`, `dispatch_state`, `dispatch_claimed_by`,
--      `dispatch_claimed_at`, `dispatch_last_tx_hash`, `dispatch_seqno`,
--      `dispatch_uncertainty_reason`, `dispatch_attempt_count`).
--   2. Tabella `core.payout_dispatch_attempts` con indice univoco parziale
--      su tentativi attivi/incerti/confermati per impedire qualsiasi reinvio o
--      race condition tra worker concorrenti.
--   3. Tabella append-only `core.payout_dispatch_audit` con trigger immutabile
--      per il tracciamento di tutte le transizioni di trasmissione.
--   4. Funzioni atomiche PostgreSQL:
--      - `core.claim_payout_for_dispatch` (claim atomico pre-trasmissione)
--      - `core.update_payout_dispatch_state` (macchina a stati rigorosa con
--        divieto di reinvio su stato UNCERTAIN_TIMEOUT / CONFIRMED_ONCHAIN)
--      - `core.get_uncertain_payout_dispatches` (riconciliazione RPC post-crash/timeout)
--      - Aggiornamento `core.complete_payout_atomic` per chiudere anche lo stato
--        di dispatch e i relativi tentativi/audit.
--   5. Registrazione migrazione `020` in `core.schema_migrations`.
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-019 e NON
-- modifica regole commerciali (30/70, PPP, 100 PT = 1 USD, riserva 15%, 500 PT,
-- 8 asset/canali, MANUAL_EXTERNAL).
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

INSERT INTO core.schema_migrations (filename, migration_id, source_reference, description)
VALUES (
    '020_payout_dispatch_claims_and_double_spend_guard.sql',
    '020',
    'KILO_090F479_ALIGNED',
    'Protezione persistente double-spend payout: claim atomico pre-invio, stato trasmissione, divieto reinvio su esito incerto, riconciliazione RPC e audit transizioni'
)
ON CONFLICT (filename) DO UPDATE
SET migration_id = EXCLUDED.migration_id,
    source_reference = EXCLUDED.source_reference,
    description = EXCLUDED.description;

-- ----------------------------------------------------------------------------
-- 1. STATO PERSISTENTE DI TRASMISSIONE SU `core.payout_requests`
-- ----------------------------------------------------------------------------
ALTER TABLE core.payout_requests
    ADD COLUMN IF NOT EXISTS active_dispatch_attempt_id TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'UNCLAIMED',
    ADD COLUMN IF NOT EXISTS dispatch_claimed_by TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dispatch_last_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_seqno BIGINT,
    ADD COLUMN IF NOT EXISTS dispatch_uncertainty_reason TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_attempt_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payout_requests_dispatch_state') THEN
        ALTER TABLE core.payout_requests
            ADD CONSTRAINT chk_payout_requests_dispatch_state
            CHECK (dispatch_state IN (
                'UNCLAIMED',
                'CLAIMED',
                'BROADCASTING',
                'UNCERTAIN_TIMEOUT',
                'CONFIRMED_ONCHAIN',
                'FAILED_SAFE_RETRYABLE',
                'COMPLETED'
            ));
    END IF;
END $$;

UPDATE core.payout_requests
   SET dispatch_state = 'COMPLETED',
       dispatch_last_tx_hash = COALESCE(dispatch_last_tx_hash, tx_hash)
 WHERE status = 'COMPLETED'
   AND dispatch_state = 'UNCLAIMED';

-- ----------------------------------------------------------------------------
-- 2. TABELLA TENTATIVI DI INVIO & INDICE ANTI-DOUBLE-SPEND CONCORRENTE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.payout_dispatch_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES core.payout_requests(request_id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    expected_amount_asset NUMERIC(18, 8) NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN (
        'CLAIMED',
        'BROADCASTING',
        'SUBMITTED_UNCERTAIN',
        'CONFIRMED',
        'FAILED_BEFORE_SEND',
        'COMPLETED',
        'RECONCILED_CONFIRMED',
        'RECONCILED_NOT_SENT'
    )),
    tx_hash TEXT,
    chain_seqno BIGINT,
    error_code TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    broadcast_started_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payout_dispatch_attempts_req
    ON core.payout_dispatch_attempts (request_id, claimed_at DESC);

-- Garantisce a livello DB che una richiesta non possa avere piu' di un tentativo
-- attivo, incerto, confermato o completato nello stesso momento.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_dispatch_one_blocking_attempt
    ON core.payout_dispatch_attempts (request_id)
    WHERE status IN (
        'CLAIMED',
        'BROADCASTING',
        'SUBMITTED_UNCERTAIN',
        'CONFIRMED',
        'COMPLETED',
        'RECONCILED_CONFIRMED'
    );

-- ----------------------------------------------------------------------------
-- 3. AUDIT APPEND-ONLY DELLE TRANSIZIONI DI TRASMISSIONE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.payout_dispatch_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    tx_hash TEXT,
    reason TEXT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_dispatch_audit_req
    ON core.payout_dispatch_audit (request_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_payout_dispatch_audit_immutable ON core.payout_dispatch_audit;
CREATE TRIGGER trg_payout_dispatch_audit_immutable
    BEFORE UPDATE OR DELETE ON core.payout_dispatch_audit
    FOR EACH ROW EXECUTE FUNCTION core.prevent_audit_log_mutation();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_app') THEN
        GRANT SELECT, INSERT, UPDATE ON core.payout_dispatch_attempts TO actionflow_app;
        GRANT SELECT, INSERT ON core.payout_dispatch_audit TO actionflow_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO actionflow_app;
        REVOKE UPDATE, DELETE, TRUNCATE ON core.payout_dispatch_audit FROM actionflow_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_auditor') THEN
        GRANT SELECT ON core.payout_dispatch_attempts, core.payout_dispatch_audit TO actionflow_auditor;
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 4. CLAIM ATOMICO PRE-TRASMISSIONE (`core.claim_payout_for_dispatch`)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.claim_payout_for_dispatch(
    p_request_id TEXT,
    p_worker_id TEXT,
    p_attempt_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_clean_req TEXT := trim(COALESCE(p_request_id, ''));
    v_worker TEXT := COALESCE(NULLIF(trim(p_worker_id), ''), 'payout_worker');
    v_attempt_id TEXT := COALESCE(NULLIF(trim(COALESCE(p_attempt_id, '')), ''), 'att_' || gen_random_uuid()::text);
    v_kill_switch BOOLEAN := TRUE;
    v_payout core.payout_requests%ROWTYPE;
    v_prev_state TEXT;
BEGIN
    IF length(v_clean_req) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_REQUEST_ID');
    END IF;

    SELECT is_enabled INTO v_kill_switch
      FROM core.system_controls
     WHERE control_key = 'PAYOUT_KILL_SWITCH';
    IF NOT FOUND OR COALESCE(v_kill_switch, TRUE) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_KILL_SWITCH_ACTIVE');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || v_clean_req));

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = v_clean_req
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.status = 'COMPLETED' OR v_payout.dispatch_state = 'COMPLETED' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_ALREADY_COMPLETED',
            'tx_hash', v_payout.tx_hash
        );
    END IF;

    IF v_payout.status <> 'APPROVED' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_NOT_APPROVED_FOR_DISPATCH',
            'status', v_payout.status
        );
    END IF;

    IF v_payout.requires_dual_approval THEN
        IF v_payout.first_approved_by IS NULL
           OR v_payout.second_approved_by IS NULL
           OR v_payout.first_approved_by = v_payout.second_approved_by THEN
            RETURN jsonb_build_object('ok', false, 'error', 'DUAL_APPROVAL_REQUIRED_BEFORE_DISPATCH');
        END IF;
    END IF;

    -- Protezione anti-double-spend: blocca ogni retry concorrente o reinvio con esito incerto
    IF v_payout.dispatch_state IN ('CLAIMED', 'BROADCASTING') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_ALREADY_CLAIMED_BY_WORKER',
            'active_attempt_id', v_payout.active_dispatch_attempt_id,
            'dispatch_state', v_payout.dispatch_state,
            'claimed_by', v_payout.dispatch_claimed_by
        );
    END IF;

    IF v_payout.dispatch_state IN ('UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME',
            'active_attempt_id', v_payout.active_dispatch_attempt_id,
            'dispatch_state', v_payout.dispatch_state,
            'tx_hash', v_payout.dispatch_last_tx_hash,
            'uncertainty_reason', v_payout.dispatch_uncertainty_reason
        );
    END IF;

    IF EXISTS (
        SELECT 1
          FROM core.payout_dispatch_attempts
         WHERE request_id = v_clean_req
           AND status IN (
               'CLAIMED',
               'BROADCASTING',
               'SUBMITTED_UNCERTAIN',
               'CONFIRMED',
               'COMPLETED',
               'RECONCILED_CONFIRMED'
           )
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_BLOCKING_DISPATCH_ATTEMPT_EXISTS'
        );
    END IF;

    v_prev_state := v_payout.dispatch_state;

    INSERT INTO core.payout_dispatch_attempts (
        attempt_id, request_id, worker_id, asset, destination_address,
        expected_amount_asset, status, claimed_at, updated_at
    ) VALUES (
        v_attempt_id,
        v_clean_req,
        v_worker,
        upper(trim(COALESCE(v_payout.crypto_asset, 'TON'))),
        trim(COALESCE(v_payout.wallet_address, '')),
        COALESCE(v_payout.asset_amount, v_payout.amount_ton, v_payout.amount_usd, 0),
        'CLAIMED',
        NOW(),
        NOW()
    );

    UPDATE core.payout_requests
       SET active_dispatch_attempt_id = v_attempt_id,
           dispatch_state = 'CLAIMED',
           dispatch_claimed_by = v_worker,
           dispatch_claimed_at = NOW(),
           dispatch_uncertainty_reason = NULL,
           dispatch_attempt_count = COALESCE(dispatch_attempt_count, 0) + 1,
           updated_at = NOW()
     WHERE request_id = v_clean_req
     RETURNING * INTO v_payout;

    INSERT INTO core.payout_dispatch_audit (
        attempt_id, request_id, from_state, to_state, actor, reason, details_json
    ) VALUES (
        v_attempt_id,
        v_clean_req,
        v_prev_state,
        'CLAIMED',
        v_worker,
        'ATOMIC_PRE_BROADCAST_CLAIM',
        jsonb_build_object(
            'asset', v_payout.crypto_asset,
            'attempt_count', v_payout.dispatch_attempt_count
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'attempt_id', v_attempt_id,
        'request_id', v_clean_req,
        'payout', row_to_json(v_payout)
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 5. TRANSIZIONI PERSISTENTI DI TRASMISSIONE (`core.update_payout_dispatch_state`)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.update_payout_dispatch_state(
    p_request_id TEXT,
    p_attempt_id TEXT,
    p_next_state TEXT,
    p_actor TEXT DEFAULT 'worker',
    p_tx_hash TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_chain_seqno BIGINT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
    v_clean_req TEXT := trim(COALESCE(p_request_id, ''));
    v_clean_att TEXT := trim(COALESCE(p_attempt_id, ''));
    v_next TEXT := upper(trim(COALESCE(p_next_state, '')));
    v_actor TEXT := COALESCE(NULLIF(trim(p_actor), ''), 'worker');
    v_clean_tx TEXT := NULLIF(trim(COALESCE(p_tx_hash, '')), '');
    v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
    v_payout core.payout_requests%ROWTYPE;
    v_attempt core.payout_dispatch_attempts%ROWTYPE;
    v_prev_state TEXT;
    v_att_status TEXT;
BEGIN
    IF length(v_clean_req) = 0 OR length(v_clean_att) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DISPATCH_TRANSITION_INPUT');
    END IF;

    IF v_next NOT IN (
        'BROADCASTING',
        'UNCERTAIN_TIMEOUT',
        'CONFIRMED_ONCHAIN',
        'FAILED_SAFE_RETRYABLE',
        'COMPLETED'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DISPATCH_TARGET_STATE');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || v_clean_req));

    SELECT * INTO v_payout
      FROM core.payout_requests
     WHERE request_id = v_clean_req
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_NOT_FOUND');
    END IF;

    IF v_payout.dispatch_state = 'COMPLETED' OR v_payout.status = 'COMPLETED' THEN
        IF v_next = 'COMPLETED' THEN
            RETURN jsonb_build_object('ok', true, 'idempotent', true, 'dispatch_state', 'COMPLETED');
        END IF;
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ALREADY_COMPLETED');
    END IF;

    IF v_payout.active_dispatch_attempt_id IS DISTINCT FROM v_clean_att THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'DISPATCH_ATTEMPT_MISMATCH',
            'active_attempt_id', v_payout.active_dispatch_attempt_id,
            'provided_attempt_id', v_clean_att
        );
    END IF;

    SELECT * INTO v_attempt
      FROM core.payout_dispatch_attempts
     WHERE attempt_id = v_clean_att
       AND request_id = v_clean_req
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DISPATCH_ATTEMPT_NOT_FOUND');
    END IF;

    v_prev_state := v_payout.dispatch_state;

    -- Verifica transizioni ammesse: dopo BROADCASTING un timeout/errore rete va sempre
    -- in UNCERTAIN_TIMEOUT e MAI in FAILED_SAFE_RETRYABLE senza riconciliazione esplicita.
    IF v_prev_state = 'CLAIMED' AND v_next NOT IN ('BROADCASTING', 'FAILED_SAFE_RETRYABLE', 'UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ILLEGAL_DISPATCH_TRANSITION');
    ELSIF v_prev_state = 'BROADCASTING' AND v_next NOT IN ('UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN', 'FAILED_SAFE_RETRYABLE') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ILLEGAL_DISPATCH_TRANSITION');
    ELSIF v_prev_state = 'BROADCASTING' AND v_next = 'FAILED_SAFE_RETRYABLE' AND COALESCE(v_reason, '') NOT LIKE 'PRE_BROADCAST_CONFIRMED:%' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CANNOT_MARK_RETRYABLE_AFTER_BROADCAST_WITHOUT_RECONCILIATION');
    ELSIF v_prev_state = 'UNCERTAIN_TIMEOUT' AND v_next NOT IN ('CONFIRMED_ONCHAIN', 'FAILED_SAFE_RETRYABLE', 'COMPLETED') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ILLEGAL_DISPATCH_TRANSITION_FROM_UNCERTAIN');
    ELSIF v_prev_state = 'UNCERTAIN_TIMEOUT' AND v_next = 'FAILED_SAFE_RETRYABLE' AND COALESCE(v_reason, '') NOT LIKE 'RECONCILED_NOT_SENT:%' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'RECONCILED_NOT_SENT_PROOF_REQUIRED_TO_UNLOCK');
    ELSIF v_prev_state = 'CONFIRMED_ONCHAIN' AND v_next <> 'COMPLETED' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONFIRMED_PAYOUT_CAN_ONLY_COMPLETE');
    END IF;

    v_att_status := CASE v_next
        WHEN 'BROADCASTING' THEN 'BROADCASTING'
        WHEN 'UNCERTAIN_TIMEOUT' THEN 'SUBMITTED_UNCERTAIN'
        WHEN 'CONFIRMED_ONCHAIN' THEN 'CONFIRMED'
        WHEN 'COMPLETED' THEN 'COMPLETED'
        WHEN 'FAILED_SAFE_RETRYABLE' THEN CASE
            WHEN v_prev_state = 'UNCERTAIN_TIMEOUT' THEN 'RECONCILED_NOT_SENT'
            ELSE 'FAILED_BEFORE_SEND'
        END
    END;

    UPDATE core.payout_dispatch_attempts
       SET status = v_att_status,
           tx_hash = COALESCE(v_clean_tx, tx_hash),
           chain_seqno = COALESCE(p_chain_seqno, chain_seqno),
           error_code = CASE WHEN v_next IN ('UNCERTAIN_TIMEOUT', 'FAILED_SAFE_RETRYABLE') THEN COALESCE(v_reason, error_code) ELSE error_code END,
           metadata_json = metadata_json || COALESCE(p_metadata, '{}'::jsonb),
           broadcast_started_at = CASE WHEN v_next = 'BROADCASTING' THEN COALESCE(broadcast_started_at, NOW()) ELSE broadcast_started_at END,
           completed_at = CASE WHEN v_next IN ('COMPLETED', 'FAILED_SAFE_RETRYABLE') THEN NOW() ELSE completed_at END,
           updated_at = NOW()
     WHERE attempt_id = v_clean_att;

    UPDATE core.payout_requests
       SET dispatch_state = v_next,
           dispatch_last_tx_hash = COALESCE(v_clean_tx, dispatch_last_tx_hash),
           dispatch_seqno = COALESCE(p_chain_seqno, dispatch_seqno),
           dispatch_uncertainty_reason = CASE
               WHEN v_next = 'UNCERTAIN_TIMEOUT' THEN COALESCE(v_reason, 'UNCERTAIN_BROADCAST_OUTCOME')
               WHEN v_next IN ('CONFIRMED_ONCHAIN', 'COMPLETED', 'FAILED_SAFE_RETRYABLE') THEN NULL
               ELSE dispatch_uncertainty_reason
           END,
           updated_at = NOW()
     WHERE request_id = v_clean_req
     RETURNING * INTO v_payout;

    INSERT INTO core.payout_dispatch_audit (
        attempt_id, request_id, from_state, to_state, actor, tx_hash, reason, details_json
    ) VALUES (
        v_clean_att,
        v_clean_req,
        v_prev_state,
        v_next,
        v_actor,
        v_clean_tx,
        v_reason,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('chain_seqno', p_chain_seqno)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'attempt_id', v_clean_att,
        'from_state', v_prev_state,
        'dispatch_state', v_next,
        'tx_hash', v_payout.dispatch_last_tx_hash
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. QUERY RICONCILIAZIONE PAYOUT INCERTI / INTERROTTI DOPO CRASH O TIMEOUT
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.get_uncertain_payout_dispatches(
    p_limit INTEGER DEFAULT 50,
    p_stale_seconds INTEGER DEFAULT 90
) RETURNS JSONB AS $$
DECLARE
    v_safe_limit INTEGER := GREATEST(1, LEAST(200, COALESCE(p_limit, 50)));
    v_stale_secs INTEGER := GREATEST(15, LEAST(86400, COALESCE(p_stale_seconds, 90)));
    v_rows JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
      INTO v_rows
      FROM (
          SELECT pr.request_id,
                 pr.user_id,
                 UPPER(COALESCE(pr.crypto_asset, 'TON')) AS crypto_asset,
                 pr.wallet_address,
                 COALESCE(pr.asset_amount, pr.amount_ton, pr.amount_usd)::float8 AS asset_amount,
                 pr.amount_usd::float8 AS amount_usd,
                 pr.dispatch_state,
                 pr.active_dispatch_attempt_id AS attempt_id,
                 pr.dispatch_claimed_by AS worker_id,
                 pr.dispatch_claimed_at,
                 pr.dispatch_last_tx_hash AS tx_hash,
                 pr.dispatch_seqno AS chain_seqno,
                 pr.dispatch_uncertainty_reason AS uncertainty_reason,
                 pa.metadata_json AS attempt_metadata,
                 pa.claimed_at,
                 pa.broadcast_started_at
            FROM core.payout_requests pr
            LEFT JOIN core.payout_dispatch_attempts pa
              ON pa.attempt_id = pr.active_dispatch_attempt_id
           WHERE pr.status = 'APPROVED'
             AND (
                 pr.dispatch_state IN ('UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN')
                 OR (
                     pr.dispatch_state IN ('CLAIMED', 'BROADCASTING')
                     AND COALESCE(pr.dispatch_claimed_at, pr.updated_at) <= NOW() - make_interval(secs => v_stale_secs)
                 )
             )
           ORDER BY pr.updated_at ASC
           LIMIT v_safe_limit
      ) t;

    RETURN jsonb_build_object('ok', true, 'items', v_rows);
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 7. CHIUSURA ATOMICA COMPLETAMENTO + FINALIZZAZIONE STATO DISPATCH
-- ----------------------------------------------------------------------------
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
    v_expected_proof_amount NUMERIC := 0;
    v_reserved_bal BIGINT;
    v_vault core.treasury_vault%ROWTYPE;
    v_asset_net_pts BIGINT := 0;
    v_other_approved_pts BIGINT := 0;
    v_effective_net_pts BIGINT := 0;
    v_tx_id UUID;
    v_prev_dispatch_state TEXT;
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

    IF v_proof_required THEN
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED');
        END IF;
        IF upper(trim(COALESCE(v_proof.asset, ''))) <> upper(trim(COALESCE(v_payout.crypto_asset, ''))) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ONCHAIN_PROOF_ASSET_MISMATCH');
        END IF;
        IF length(trim(COALESCE(v_proof.destination_address, ''))) > 0
           AND lower(trim(v_proof.destination_address)) <> lower(trim(COALESCE(v_payout.wallet_address, ''))) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ONCHAIN_PROOF_DESTINATION_MISMATCH');
        END IF;
        v_expected_proof_amount := COALESCE(v_payout.asset_amount, v_payout.amount_usd, 0);
        IF v_proof.observed_amount_asset IS NOT NULL
           AND v_expected_proof_amount > 0
           AND v_proof.observed_amount_asset < ROUND((v_expected_proof_amount * 0.98)::numeric, 6) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'ONCHAIN_PROOF_AMOUNT_BELOW_EXPECTED',
                'expected_min', ROUND((v_expected_proof_amount * 0.98)::numeric, 6),
                'observed', v_proof.observed_amount_asset
            );
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM core.payout_requests WHERE tx_hash = v_clean_hash AND request_id <> p_request_id)
       OR EXISTS (SELECT 1 FROM core.settlement_batches WHERE onchain_tx_hash = v_clean_hash)
       OR EXISTS (SELECT 1 FROM core.treasury_conversions WHERE external_tx_ref = v_clean_hash)
       OR EXISTS (SELECT 1 FROM core.processed_tx_hashes WHERE tx_hash = 'payout:' || v_clean_hash) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_TX_HASH_ALREADY_USED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('user_ledger_' || v_payout.user_id::text));
    PERFORM 1 FROM core.users WHERE user_id = v_payout.user_id FOR UPDATE;

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

    v_prev_dispatch_state := COALESCE(v_payout.dispatch_state, 'UNCLAIMED');

    IF v_payout.active_dispatch_attempt_id IS NOT NULL THEN
        UPDATE core.payout_dispatch_attempts
           SET status = CASE
                   WHEN status = 'SUBMITTED_UNCERTAIN' THEN 'RECONCILED_CONFIRMED'
                   ELSE 'COMPLETED'
               END,
               tx_hash = COALESCE(tx_hash, v_clean_hash),
               completed_at = COALESCE(completed_at, NOW()),
               updated_at = NOW()
         WHERE attempt_id = v_payout.active_dispatch_attempt_id
           AND request_id = p_request_id;
    END IF;

    UPDATE core.payout_requests
       SET status = 'COMPLETED',
           payout_status = 'COMPLETED_ONCHAIN',
           tx_hash = v_clean_hash,
           dispatch_state = 'COMPLETED',
           dispatch_last_tx_hash = v_clean_hash,
           dispatch_uncertainty_reason = NULL,
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

    INSERT INTO core.payout_dispatch_audit (
        attempt_id, request_id, from_state, to_state, actor, tx_hash, reason, details_json
    ) VALUES (
        COALESCE(v_payout.active_dispatch_attempt_id, 'direct_complete'),
        p_request_id,
        v_prev_dispatch_state,
        'COMPLETED',
        COALESCE(v_proof.verified_by, 'complete_payout_atomic'),
        v_clean_hash,
        'PAYOUT_COMPLETED_WITH_VERIFIED_PROOF',
        jsonb_build_object('asset', v_payout.crypto_asset, 'observed_amount', v_proof.observed_amount_asset)
    );

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 8. HARDENING `core.reject_payout_atomic`: DIVIETO RIFIUTO CON DISPATCH ATTIVO/INCERTO
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reject_payout_atomic(
    p_request_id TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_payout core.payout_requests%ROWTYPE;
    v_reserved_bal BIGINT;
    v_tx_id UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('payout_id_' || COALESCE(p_request_id, '')));

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

    IF COALESCE(v_payout.dispatch_state, 'UNCLAIMED') IN ('CLAIMED', 'BROADCASTING', 'UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN')
       OR EXISTS (
           SELECT 1
             FROM core.payout_dispatch_attempts
            WHERE request_id = p_request_id
              AND status IN ('CLAIMED', 'BROADCASTING', 'SUBMITTED_UNCERTAIN', 'CONFIRMED', 'COMPLETED', 'RECONCILED_CONFIRMED')
       ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PAYOUT_CANNOT_BE_REJECTED_WHILE_DISPATCH_ACTIVE_OR_UNCERTAIN',
            'dispatch_state', v_payout.dispatch_state,
            'active_attempt_id', v_payout.active_dispatch_attempt_id
        );
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('user_ledger_' || v_payout.user_id::text));
    PERFORM 1 FROM core.users WHERE user_id = v_payout.user_id FOR UPDATE;

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
           note = COALESCE(p_note, note, 'Richiesta rifiutata: punti riaccreditati'),
           updated_at = NOW()
     WHERE request_id = p_request_id
     RETURNING * INTO v_payout;

    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'payout', row_to_json(v_payout));
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 9. PRIVILEGI FUNZIONI 020 PER `actionflow_app` E ISOLAMENTO `actionflow_auditor`
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_app') THEN
        GRANT EXECUTE ON FUNCTION
            core.claim_payout_for_dispatch(TEXT, TEXT, TEXT),
            core.update_payout_dispatch_state(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, JSONB),
            core.get_uncertain_payout_dispatches(INTEGER, INTEGER),
            core.complete_payout_atomic(TEXT, TEXT, TEXT),
            core.reject_payout_atomic(TEXT, TEXT)
        TO actionflow_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_auditor') THEN
        REVOKE ALL ON FUNCTION
            core.claim_payout_for_dispatch(TEXT, TEXT, TEXT),
            core.update_payout_dispatch_state(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, JSONB),
            core.complete_payout_atomic(TEXT, TEXT, TEXT),
            core.reject_payout_atomic(TEXT, TEXT)
        FROM actionflow_auditor;
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        NULL;
END $$;

COMMIT;
