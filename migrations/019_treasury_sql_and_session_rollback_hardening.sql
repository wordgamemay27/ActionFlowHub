-- ============================================================================
-- MIGRATION: 019_treasury_sql_and_session_rollback_hardening.sql
-- DESCRIZIONE:
--   1. Registro persistente delle migrazioni (`core.schema_migrations`) con
--      mappatura completa AI Studio (001-019) <-> riferimento Kilo (013-020).
--   2. Protezione append-only sui log di sicurezza (`core.security_audit_logs`,
--      `core.inbound_security_logs`) + separazione privilegi operativa (`actionflow_app`)
--      vs sola lettura (`actionflow_auditor`).
--   3. Rollback automatico dei punti su revoca sessione (`core.revoke_auto_session`):
--      storna atomicamente gli eventi `PENDING` (`partner_confirm_reward`) e
--      `SETTLED` (`revoke_settled_reward`) collegati alla sessione revocata.
--   4. Hardening deadlock e cross-check SQL in `core.execute_batch_settlement`:
--      - Rifiuto input negativi / finestre temporali invertite
--      - Lock deterministico su `treasury_vault_<asset>`, `partner_exposure` e
--        `user_ledger_<user_id>` + `core.users FOR UPDATE` PRIMA dei saldi
--      - Controllo collisione hash anche verso `core.treasury_conversions`
--   5. `core.release_settled_to_withdrawable_for_user` + wrapper `core.release_settled`
--      con lock `user_ledger_<user_id>` prima di `recover_user_clawback_debt`.
--   6. Cross-check esplicito della prova on-chain/gateway in
--      `core.complete_payout_atomic` (asset, destinatario, importo osservato >= 98%,
--      anti-collisione su `core.treasury_conversions`).
--
-- NOTA: Migrazione incrementale non distruttiva; NON altera 001-018 e NON
-- modifica alcuna regola commerciale (30/70, PPP, 100 PT = 1 USD, 15% buffer,
-- soglia minima 500 PT, 8 asset/canali, MANUAL_EXTERNAL).
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- ----------------------------------------------------------------------------
-- 1. REGISTRO MIGRAZIONI PERSISTENTE (COMPATIBILE 008 `filename` + LINEAGE KILO)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'schema_migrations' AND column_name = 'filename'
    ) THEN
        ALTER TABLE core.schema_migrations ADD COLUMN filename TEXT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'schema_migrations' AND column_name = 'migration_id'
    ) THEN
        ALTER TABLE core.schema_migrations ADD COLUMN migration_id TEXT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'schema_migrations' AND column_name = 'source_reference'
    ) THEN
        ALTER TABLE core.schema_migrations ADD COLUMN source_reference TEXT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'schema_migrations' AND column_name = 'description'
    ) THEN
        ALTER TABLE core.schema_migrations ADD COLUMN description TEXT;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_filename_unique
    ON core.schema_migrations (filename)
    WHERE filename IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_migration_id_unique
    ON core.schema_migrations (migration_id)
    WHERE migration_id IS NOT NULL;

INSERT INTO core.schema_migrations (filename, migration_id, source_reference, description)
VALUES
    ('001_core_ledger_3buckets.sql', '001', 'AI_STUDIO_BASE', 'Schema core iniziale, utenti, ledger 4 conti e bilancio base'),
    ('002_daily_reset_timezone.sql', '002', 'AI_STUDIO_BASE', 'Reputazione fornitori, exposure cap iniziale e sessioni legacy'),
    ('004_pending_reward_verified.sql', '004', 'AI_STUDIO_BASE', 'Flusso pending reward verificato da postback partner'),
    ('005_provider_reputation.sql', '005', 'AI_STUDIO_BASE', 'Hardening postback, click tracking e idempotenza base'),
    ('006_execute_batch_settlement.sql', '006', 'AI_STUDIO_BASE', 'PPP World Bank per paese e split 30% utente / 70% piattaforma'),
    ('007_processed_tx_and_constraints.sql', '007', 'AI_STUDIO_BASE', 'Protezione anti-abuse e strike utente persistenti'),
    ('008_hardening_ledger_and_payouts.sql', '008', 'AI_STUDIO_BASE', 'Hardening ledger double-entry e payout'),
    ('009_unified_auto_session_and_interactions.sql', '009', 'AI_STUDIO_BASE', 'Unified auto_sessions e session_interactions'),
    ('010_reconciliation_settlement_and_payout_hardening.sql', '010', 'AI_STUDIO_BASE', 'Riconciliazione settlement, release_settled e payout FX snapshot'),
    ('011_geo_country_lock_and_provider_ranking.sql', '011', 'AI_STUDIO_BASE', 'Disattivazione definitiva fallback simulati e cleanup'),
    ('012_worldbank_ppp_and_reward_formula.sql', '012', 'AI_STUDIO_BASE', 'Allineamento batch settlement, multi-asset e viste tesoreria'),
    ('013_multi_asset_treasury_killswitch_limits_clawback.sql', '013', 'KILO_013_ALIGNED', 'Tesoreria 8 asset separati (M1-M5), Kill Switch, limiti, doppia approvazione, clawback'),
    ('014_audit_hardening_fixes.sql', '014', 'KILO_014_ALIGNED', 'Solvibilita con impegni APPROVED, recupero automatico debiti, coda settlement_jobs'),
    ('015_inbound_security_and_session_revocation.sql', '015', 'KILO_015_ALIGNED', 'Log sicurezza inbound, revoca sessioni automatiche, ruolo actionflow_auditor'),
    ('016_persistent_rate_limit_provider_thresholds_killswitch.sql', '016', 'KILO_016_ALIGNED', 'Rate limit persistente PostgreSQL, soglie anomalie fornitori 3/5, vista v_treasury_vault_status estesa'),
    ('017_payout_idempotency_payload_conflict.sql', '017', 'KILO_017_ALIGNED', 'Idempotenza payout con sha256 payload conflict check e indice univoco'),
    ('018_onchain_verification_tracking.sql', '018', 'KILO_018_ALIGNED', 'Tracciamento persistente prove on-chain payout_onchain_verifications'),
    ('019_treasury_sql_and_session_rollback_hardening.sql', '019', 'KILO_019_020_ALIGNED', 'Rollback punti revoca sessione, lock ordering deadlock-safe, cross-check proof, append-only audit e ruoli DB')
ON CONFLICT (filename) DO UPDATE
SET migration_id = EXCLUDED.migration_id,
    source_reference = EXCLUDED.source_reference,
    description = EXCLUDED.description;

-- ----------------------------------------------------------------------------
-- 2. TRIGGER APPEND-ONLY LOG DI SICUREZZA & SEPARAZIONE PRIVILEGI DB
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SECURITY_AUDIT_LOGS_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_security_audit_logs_immutable ON core.security_audit_logs;
CREATE TRIGGER trg_security_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON core.security_audit_logs
    FOR EACH ROW EXECUTE FUNCTION core.prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS trg_inbound_security_logs_immutable ON core.inbound_security_logs;
CREATE TRIGGER trg_inbound_security_logs_immutable
    BEFORE UPDATE OR DELETE ON core.inbound_security_logs
    FOR EACH ROW EXECUTE FUNCTION core.prevent_audit_log_mutation();

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_app') THEN
        CREATE ROLE actionflow_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    GRANT USAGE ON SCHEMA core TO actionflow_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO actionflow_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON core.security_audit_logs, core.inbound_security_logs FROM actionflow_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO actionflow_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO actionflow_app;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_auditor') THEN
        CREATE ROLE actionflow_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    GRANT USAGE ON SCHEMA core TO actionflow_auditor;
    GRANT SELECT ON core.schema_migrations, core.payout_onchain_verifications TO actionflow_auditor;
EXCEPTION
    WHEN insufficient_privilege THEN
        NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 3. REVOCA SESSIONE AUTOMATICA CON ROLLBACK AUTOMATICO DEI PUNTI
-- ----------------------------------------------------------------------------
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
    v_ev RECORD;
    v_res JSONB;
    v_rolled_pending INT := 0;
    v_rolled_settled INT := 0;
    v_rolled_points BIGINT := 0;
    v_shortfall_points BIGINT := 0;
BEGIN
    IF length(v_clean_id) < 8 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_SESSION_ID');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('auto_session_' || v_clean_id));

    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = v_clean_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SESSION_NOT_FOUND');
    END IF;

    IF v_session.status = 'REVOKED' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'idempotent', true,
            'session', row_to_json(v_session),
            'rolled_back_pending_events', 0,
            'rolled_back_settled_events', 0,
            'rolled_back_total_points', 0
        );
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('user_ledger_' || v_session.user_id::text));
    PERFORM 1 FROM core.users WHERE user_id = v_session.user_id FOR UPDATE;

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

    -- Rollback atomico di tutti i punti generati in questa sessione (PENDING e SETTLED)
    FOR v_ev IN
        SELECT event_id, status, interaction_id
          FROM core.reward_events
         WHERE session_id = v_clean_id
           AND status IN ('PENDING', 'SETTLED')
         ORDER BY created_at ASC, event_id ASC
         FOR UPDATE
    LOOP
        IF v_ev.status = 'PENDING' THEN
            v_res := core.partner_confirm_reward(v_ev.event_id, 'REVOKED');
            IF COALESCE((v_res->>'success')::boolean, FALSE) AND NOT COALESCE((v_res->>'idempotent')::boolean, FALSE) THEN
                v_rolled_pending := v_rolled_pending + 1;
                v_rolled_points := v_rolled_points + COALESCE((v_res->>'revoked_points')::bigint, 0);
            END IF;
        ELSIF v_ev.status = 'SETTLED' THEN
            v_res := core.revoke_settled_reward(v_ev.event_id, 'SESSION_REVOKED:' || v_reason);
            IF COALESCE((v_res->>'ok')::boolean, FALSE) AND NOT COALESCE((v_res->>'idempotent')::boolean, FALSE) THEN
                v_rolled_settled := v_rolled_settled + 1;
                v_rolled_points := v_rolled_points + COALESCE((v_res->>'recovered_points')::bigint, 0);
                v_shortfall_points := v_shortfall_points + COALESCE((v_res->>'shortfall_debt_points')::bigint, 0);
                IF v_ev.interaction_id IS NOT NULL THEN
                    UPDATE core.auto_sessions
                       SET interactions_settled = GREATEST(0, interactions_settled - 1),
                           interactions_revoked = interactions_revoked + 1,
                           updated_at = NOW()
                     WHERE session_id = v_clean_id;
                END IF;
            END IF;
        END IF;
    END LOOP;

    SELECT * INTO v_session
      FROM core.auto_sessions
     WHERE session_id = v_clean_id;

    INSERT INTO core.security_audit_logs (event_type, actor, target_id, details)
    VALUES (
        'AUTO_SESSION_REVOKED',
        v_actor,
        v_clean_id,
        jsonb_build_object(
            'user_id', v_session.user_id,
            'reason', v_reason,
            'rolled_back_pending_events', v_rolled_pending,
            'rolled_back_settled_events', v_rolled_settled,
            'rolled_back_total_points', v_rolled_points,
            'shortfall_debt_points', v_shortfall_points
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'session', row_to_json(v_session),
        'rolled_back_pending_events', v_rolled_pending,
        'rolled_back_settled_events', v_rolled_settled,
        'rolled_back_total_points', v_rolled_points,
        'shortfall_debt_points', v_shortfall_points
    );
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. BATCH SETTLEMENT DEADLOCK-SAFE + LOCK TESORERIA + CHECK CONVERSIONI
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
    v_actual_net NUMERIC := COALESCE(p_actual_net_usd, 0);
    v_expected_gross NUMERIC := COALESCE(p_expected_gross_usd, 0);
    v_clean_tx TEXT := trim(COALESCE(p_onchain_tx_hash, ''));
    v_received_asset TEXT := upper(trim(COALESCE(NULLIF(p_received_asset, ''), 'USDT')));
    v_points_capacity BIGINT;
    v_remaining_capacity BIGINT;
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
    v_ratio NUMERIC;
    v_effective_ratio NUMERIC := 0;
    v_start_ts TIMESTAMPTZ;
    v_end_ts TIMESTAMPTZ;
BEGIN
    IF length(v_clean_batch) < 3 OR length(v_clean_partner) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_BATCH_OR_PARTNER_ID');
    END IF;

    IF v_expected_gross < 0
       OR v_actual_net < 0
       OR COALESCE(p_haircut_ratio, 1.0) < 0
       OR p_period_start IS NULL
       OR p_period_end IS NULL
       OR p_period_start < 0
       OR p_period_end < p_period_start THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_SETTLEMENT_NUMERIC_INPUT');
    END IF;

    v_actual_net := GREATEST(0, v_actual_net);
    v_points_capacity := FLOOR(v_actual_net * 100);
    v_remaining_capacity := v_points_capacity;
    v_ratio := LEAST(1.0, GREATEST(0, COALESCE(p_haircut_ratio, 1.0)));
    v_start_ts := to_timestamp(p_period_start / 1000.0);
    v_end_ts := to_timestamp(p_period_end / 1000.0);

    IF v_received_asset NOT IN ('TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET') THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_SETTLEMENT_ASSET', 'asset', v_received_asset);
    END IF;

    IF v_actual_net > 0 AND (
        length(v_clean_tx) < 8
        OR v_clean_tx ~* '^(sim_|fake_|mock_|test_|demo_|tx_confirmed_|tx_onchain_)'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'REAL_VERIFIABLE_SETTLEMENT_TX_REQUIRED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('settlement_batch_' || v_clean_batch));
    IF length(v_clean_tx) > 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext('settlement_tx_' || v_clean_tx));
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('treasury_vault_' || v_received_asset));

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
           OR EXISTS (SELECT 1 FROM core.treasury_conversions WHERE external_tx_ref = v_clean_tx)
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

    PERFORM 1 FROM core.partner_exposure WHERE partner_id = v_clean_partner FOR UPDATE;

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
        -- Ordine lock canonico anti-deadlock:
        -- 1) user_ledger advisory + core.users FOR UPDATE
        -- 2) core.balances per utente e conti di sistema
        PERFORM pg_advisory_xact_lock(hashtext('user_ledger_' || v_event.user_id::text));
        PERFORM 1 FROM core.users WHERE user_id = v_event.user_id FOR UPDATE;

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
        v_expected_gross, v_actual_net, v_ratio, v_effective_ratio,
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
-- 5. RELEASE SETTLED -> WITHDRAWABLE DEADLOCK-SAFE + WRAPPER `core.release_settled`
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
    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_USER_ID');
    END IF;

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

    PERFORM pg_advisory_xact_lock(hashtext('user_ledger_' || p_user_id::text));
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

CREATE OR REPLACE FUNCTION core.release_settled(
    p_user_id BIGINT,
    p_points BIGINT DEFAULT NULL,
    p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    RETURN core.release_settled_to_withdrawable_for_user(p_user_id, p_points, p_reference_id);
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. CROSS-CHECK COMPLETO PROVA ON-CHAIN & CONVERSIONI IN `complete_payout_atomic`
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
