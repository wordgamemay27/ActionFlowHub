-- ============================================================================
-- MIGRATION: 004_pending_reward_verified.sql
-- DESCRIZIONE: Chiude il ciclo ricompense: PENDING -> VERIFIED/CLAIMED
--             + trigger VERIFIED/CLAIMED -> WITHDRAWABLE / tonBalance
--             + core.settle_to_withdrawable per spostamento SETTLED -> WITHDRAWABLE
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.reward_events (
    event_id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES core.users(user_id),
    raw_points BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    source TEXT DEFAULT 'S2S_POSTBACK',
    payload_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.user_rewards (
    reward_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES core.users(user_id),
    kind TEXT NOT NULL DEFAULT 'TOKEN',
    project TEXT,
    token_symbol TEXT,
    amount NUMERIC NOT NULL DEFAULT 0,
    network TEXT DEFAULT 'TON',
    status TEXT NOT NULL DEFAULT 'PENDING',
    source TEXT DEFAULT 'DIRECT',
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. RICOMPENSA REALE UTENTE: verifica transizione di stato
CREATE OR REPLACE FUNCTION core.verify_user_reward(
    p_reward_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_reward core.user_rewards%ROWTYPE;
    v_user core.users%ROWTYPE;
BEGIN
    SELECT * INTO v_reward FROM core.user_rewards WHERE reward_id = p_reward_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'REWARD_NOT_FOUND');
    END IF;

    IF v_reward.status NOT IN ('VERIFIED', 'CLAIMED') THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATUS_TRANSITION');
    END IF;

    SELECT * INTO v_user FROM core.users WHERE user_id = v_reward.user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
    END IF;

    -- Accredita nel bucket WITHDRAWABLE
    UPDATE core.balances SET balance = balance + v_reward.amount, updated_at = NOW()
     WHERE account_id = 'USER_' || v_reward.user_id || ':WITHDRAWABLE';

    IF v_reward.token_symbol = 'TON' THEN
        UPDATE core.users SET ton_balance = ton_balance + v_reward.amount, updated_at = NOW()
         WHERE user_id = v_reward.user_id;
    ELSIF v_reward.token_symbol = 'GRAM' THEN
        UPDATE core.users SET gram_balance = gram_balance + v_reward.amount, updated_at = NOW()
         WHERE user_id = v_reward.user_id;
    END IF;

    UPDATE core.user_rewards
       SET status = 'CLAIMED',
           updated_at = NOW()
     WHERE reward_id = p_reward_id;

    RETURN jsonb_build_object('success', true, 'reward_id', p_reward_id);
END;
$$ LANGUAGE plpgsql;

-- 2. PARTNER CONFIRM REWARD S2S (PENDING -> SETTLED + Quota Piattaforma 70/30)
CREATE OR REPLACE FUNCTION core.partner_confirm_reward(
    p_event_id TEXT,
    p_status TEXT DEFAULT 'VERIFIED' -- 'VERIFIED' | 'REVOKED'
) RETURNS JSONB AS $$
DECLARE
    v_event core.reward_events%ROWTYPE;
    v_user_settled_points BIGINT;
    v_platform_revenue_points BIGINT;
    v_tx_id UUID;
BEGIN
    SELECT * INTO v_event FROM core.reward_events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
    END IF;

    IF v_event.status = 'SETTLED' OR v_event.status = 'REVOKED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'ALREADY_PROCESSED');
    END IF;

    -- Assicura esistenza account piattaforma
    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('SYSTEM:PLATFORM_REVENUE', 'SYSTEM_EQUITY', NULL)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('SYSTEM:PLATFORM_REVENUE', 0)
    ON CONFLICT (account_id) DO NOTHING;

    IF p_status = 'REVOKED' THEN
        -- Revoca: refund inverso da USER_*:PENDING e riaccredito SYSTEM:UNEARNED_REVENUE
        INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
        VALUES ('REWARD_REVOKE', p_event_id, 'Revoca Evento Ricompensa ' || p_event_id)
        RETURNING tx_id INTO v_tx_id;

        INSERT INTO core.ledger_entries (tx_id, account_id, amount)
        VALUES
            (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_event.raw_points),
            (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', v_event.raw_points);

        UPDATE core.balances SET balance = balance - v_event.raw_points, updated_at = NOW()
         WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

        UPDATE core.balances SET balance = balance + v_event.raw_points, updated_at = NOW()
         WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

        UPDATE core.reward_events SET status = 'REVOKED', updated_at = NOW() WHERE event_id = p_event_id;

        UPDATE core.partner_exposure
           SET pending_points_exposure = GREATEST(0, pending_points_exposure - v_event.raw_points),
               updated_at = NOW()
         WHERE partner_id = v_event.partner_id;

        RETURN jsonb_build_object('success', true, 'action', 'REVOKED');
    END IF;

    -- p_status = 'VERIFIED':
    -- 1. Sposta raw_points * 0.30 da USER_*:PENDING a USER_*:SETTLED
    -- 2. Sposta raw_points * 0.70 da SYSTEM:UNEARNED_REVENUE a SYSTEM:PLATFORM_REVENUE
    -- 3. Aggiorna reward_events.status = 'SETTLED'
    v_user_settled_points := ROUND(v_event.raw_points * 0.30);
    v_platform_revenue_points := ROUND(v_event.raw_points * 0.70);

    INSERT INTO core.accounts (account_id, account_type, user_id)
    VALUES ('USER_' || v_event.user_id || ':SETTLED', 'USER_SETTLED', v_event.user_id)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.balances (account_id, balance)
    VALUES ('USER_' || v_event.user_id || ':SETTLED', 0)
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('REWARD_VERIFY', p_event_id, 'Conferma S2S Ricompensa ' || p_event_id)
    RETURNING tx_id INTO v_tx_id;

    INSERT INTO core.ledger_entries (tx_id, account_id, amount)
    VALUES
        (v_tx_id, 'USER_' || v_event.user_id || ':PENDING', -v_user_settled_points),
        (v_tx_id, 'USER_' || v_event.user_id || ':SETTLED', v_user_settled_points),
        (v_tx_id, 'SYSTEM:UNEARNED_REVENUE', -v_platform_revenue_points),
        (v_tx_id, 'SYSTEM:PLATFORM_REVENUE', v_platform_revenue_points);

    UPDATE core.balances SET balance = balance - v_user_settled_points, updated_at = NOW()
     WHERE account_id = 'USER_' || v_event.user_id || ':PENDING';

    UPDATE core.balances SET balance = balance + v_user_settled_points, updated_at = NOW()
     WHERE account_id = 'USER_' || v_event.user_id || ':SETTLED';

    UPDATE core.balances SET balance = balance - v_platform_revenue_points, updated_at = NOW()
     WHERE account_id = 'SYSTEM:UNEARNED_REVENUE';

    UPDATE core.balances SET balance = balance + v_platform_revenue_points, updated_at = NOW()
     WHERE account_id = 'SYSTEM:PLATFORM_REVENUE';

    UPDATE core.reward_events SET status = 'SETTLED', updated_at = NOW() WHERE event_id = p_event_id;

    -- Crea/aggiorna user_rewards come VERIFIED
    INSERT INTO core.user_rewards (
        reward_id, user_id, kind, project, token_symbol, amount, network, status, source, tx_hash
    ) VALUES (
        'rw_' || p_event_id || '_' || floor(extract(epoch from now()) * 1000)::text,
        v_event.user_id,
        'TOKEN',
        v_event.payload_json->>'project',
        v_event.payload_json->>'tokenSymbol',
        (v_event.payload_json->>'amount')::numeric,
        COALESCE(NULLIF(v_event.payload_json->>'network', ''), 'TON'),
        'VERIFIED',
        v_event.source,
        NULL
    )
    ON CONFLICT (reward_id) DO UPDATE SET
        status = 'VERIFIED',
        updated_at = NOW();

    RETURN jsonb_build_object(
        'success', true,
        'action', 'SETTLED',
        'user_settled_points', v_user_settled_points,
        'platform_revenue_points', v_platform_revenue_points
    );
END;
$$ LANGUAGE plpgsql;

-- 3. SETTLE TO WITHDRAWABLE (SETTLED -> WITHDRAWABLE)
CREATE OR REPLACE FUNCTION core.settle_to_withdrawable(
    p_user_id BIGINT,
    p_points BIGINT,
    p_reference_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_user_settled_balance BIGINT := 0;
    v_tx_id UUID;
    v_points_to_move BIGINT;
BEGIN
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

    v_points_to_move := LEAST(v_user_settled_balance, GREATEST(0, p_points));
    IF v_points_to_move <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_POINTS_AMOUNT');
    END IF;

    INSERT INTO core.ledger_transactions (reference_type, reference_id, description)
    VALUES ('SETTLE_TO_WITHDRAWABLE', COALESCE(p_reference_id, 'manual_' || floor(extract(epoch from now()))::text), 'Transito SETTLED -> WITHDRAWABLE per utente ' || p_user_id)
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

    RETURN jsonb_build_object(
        'success', true,
        'user_id', p_user_id,
        'moved_points', v_points_to_move,
        'new_withdrawable_balance', (
            SELECT balance FROM core.balances WHERE account_id = 'USER_' || p_user_id || ':WITHDRAWABLE'
        )
    );
END;
$$ LANGUAGE plpgsql;

COMMIT;
