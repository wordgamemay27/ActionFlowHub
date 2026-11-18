-- ============================================================================
-- MIGRATION: 007_processed_tx_and_constraints.sql
-- DESCRIZIONE: Tabella persistente transazioni blockchain elaborate
--             e vincoli di integrità su balances e provider_payments
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- 1. Tabella hash transazioni blockchain elaborate (previene double-spend / ri-elaborazione al restart)
CREATE TABLE IF NOT EXISTS core.processed_tx_hashes (
    tx_hash TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Vincolo di non-negatività sui saldi utente (i conti di sistema contra-passivi restano in partita doppia zero-sum)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative'
    ) THEN
        ALTER TABLE core.balances DROP CONSTRAINT balance_non_negative;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative_users'
    ) THEN
        ALTER TABLE core.balances
            ADD CONSTRAINT balance_non_negative_users
            CHECK (LEFT(account_id, 5) <> 'USER_' OR balance >= 0);
    END IF;
END $$;

-- 3. Vincolo di unicità provider_id + batch_id sui pagamenti fornitori
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'provider_payments_batch_unique'
    ) THEN
        ALTER TABLE core.provider_payments ADD CONSTRAINT provider_payments_batch_unique UNIQUE (provider_id, batch_id);
    END IF;
END $$;

COMMIT;
