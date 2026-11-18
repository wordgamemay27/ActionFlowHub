-- ============================================================================
-- MIGRATION: 006_execute_batch_settlement.sql
-- DESCRIZIONE: Funzione SQL atomica core.execute_batch_settlement
--             per settlement batch con haircut contabile e accredito tesoreria.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

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
    v_points_capacity BIGINT := ROUND(v_actual_net * 100);
    v_settled_count INT := 0;
    v_total_points_settled BIGINT := 0;
    v_tx_id UUID;
    v_event RECORD;
    v_user_settled_points BIGINT;
    v_platform_revenue_points BIGINT;
    v_ratio NUMERIC := GREATEST(0, COALESCE(p_haircut_ratio, 1.0));
    v_start_ts TIMESTAMPTZ := to_timestamp(p_period_start / 1000.0);
    v_end_ts TIMESTAMPTZ := to_timestamp(p_period_end / 1000.0);
BEGIN
    -- Assicura esistenza account di piattaforma
    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('SYSTEM:PLATFORM_REVENUE', 'SYSTEM_EQUITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('SYSTEM:PLATFORM_REVENUE', 0)
    ON CONFLICT (account_id) DO NOTHING;

    -- 1. Aggiorna o incrementa la cassa reale di tesoreria USDT
    INSERT INTO core.treasury_vault (asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent)
    VALUES ('USDT', v_actual_net, v_points_capacity, 0.15)
    ON CONFLICT (asset) DO UPDATE
    SET actual_cash_on_chain = core.treasury_vault.actual_cash_on_chain + EXCLUDED.actual_cash_on_chain,
        points_equivalent_capacity = core.treasury_vault.points_equivalent_capacity + EXCLUDED.points_equivalent_capacity,
        updated_at = NOW();

    -- 2. Decrementa l'esposizione del partner per l'importo saldato
    UPDATE core.partner_exposure
       SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_points_capacity),
           updated_at = NOW()
     WHERE partner_id = p_partner_id;

    -- 3. Itera su tutti gli eventi PENDING del partner nel periodo (FOR UPDATE)
    FOR v_event IN
        SELECT event_id, user_id, raw_points
          FROM core.reward_events
         WHERE partner_id = p_partner_id
           AND status = 'PENDING'
           AND (created_at >= v_start_ts AND created_at <= v_end_ts)
         FOR UPDATE
    LOOP
        v_user_settled_points := ROUND(v_event.raw_points * 0.30 * v_ratio);
        v_platform_revenue_points := ROUND(v_event.raw_points * 0.70 * v_ratio);

        -- Assicura esistenza account utente SETTLED
        INSERT INTO core.accounts (account_id, account_type, user_id)
        VALUES ('USER_' || v_event.user_id || ':SETTLED', 'USER_SETTLED', v_event.user_id)
        ON CONFLICT (account_id) DO NOTHING;

        INSERT INTO core.balances (account_id, balance)
        VALUES ('USER_' || v_event.user_id || ':SETTLED', 0)
        ON CONFLICT (account_id) DO NOTHING;

        -- Crea transazione contabile atomica
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('BATCH_SETTLEMENT_USER', v_event.event_id, 'Liquidazione Utente Evento ' || v_event.event_id || ' Batch ' || p_batch_id)
        RETURNING tx_id INTO v_tx_id;

        -- Movimenti contabili Double-Entry
        INSERT INTO core.ledger_entries (tx_id, account_id, amount)
        VALUES
            (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_user_settled_points),
            (v_tx_id, 'USER_' || v_event.user_id || ':SETTLED', v_user_settled_points),
            (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_platform_revenue_points),
            (v_tx_id, 'SYSTEM:PLATFORM_REVENUE', v_platform_revenue_points);

        UPDATE core.balances
           SET balance = balance - v_user_settled_points, updated_at = NOW()
         WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

        UPDATE core.balances
           SET balance = balance + v_user_settled_points, updated_at = NOW()
         WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED';

        UPDATE core.balances
           SET balance = balance - v_platform_revenue_points, updated_at = NOW()
         WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

        UPDATE core.balances
           SET balance = balance + v_platform_revenue_points, updated_at = NOW()
         WHERE account_id = 'SYSTEM:PLATFORM_REVENUE';

        -- Aggiorna stato evento a SETTLED
        UPDATE core.reward_events
           SET status = 'SETTLED',
               updated_at = NOW()
         WHERE event_id = v_event.event_id;

        v_settled_count := v_settled_count + 1;
        v_total_points_settled := v_total_points_settled + v_user_settled_points;
    END LOOP;

    -- Se ci sono fondi netti in cassa registriamo l'accredito di tesoreria
    IF v_points_capacity > 0 THEN
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('SETTLEMENT', p_batch_id, 'Liquidazione Tesoreria Batch ' || p_partner_id || ' ratio ' || v_ratio)
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
        'batch_id', p_batch_id,
        'partner_id', p_partner_id,
        'settled_users_count', v_settled_count,
        'total_points_settled', v_total_points_settled,
        'haircut_ratio', v_ratio,
        'onchain_tx_hash', p_onchain_tx_hash
    );
END;
$$ LANGUAGE plpgsql;

COMMIT;
