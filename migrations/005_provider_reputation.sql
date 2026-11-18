-- ============================================================================
-- MIGRATION 005: PROVIDER REPUTATION, PAYMENTS, AUDIT LOG & FAILOVER CHAIN
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.provider_reputation (
    provider_id VARCHAR(64) PRIMARY KEY,
    provider_name VARCHAR(128) NOT NULL,
    category VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WARNING', 'QUARANTINE', 'BANNED')),
    reputation_score NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    ema_haircut_ratio NUMERIC(6,4) NOT NULL DEFAULT 1.0000,
    total_promised_usd NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
    total_paid_usd NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
    total_batches INTEGER NOT NULL DEFAULT 0,
    consecutive_low_batches INTEGER NOT NULL DEFAULT 0,
    failover_chain TEXT[] NOT NULL DEFAULT '{}',
    last_payment_at TIMESTAMPTZ,
    quarantine_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.provider_payments (
    id BIGSERIAL PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL REFERENCES core.provider_reputation(provider_id) ON DELETE CASCADE,
    batch_id VARCHAR(64) NOT NULL,
    promised_usd NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
    paid_usd NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
    haircut_ratio NUMERIC(6,4) NOT NULL DEFAULT 1.0000,
    tx_hash VARCHAR(128),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.provider_audit_log (
    id BIGSERIAL PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_reputation_cat_status
    ON core.provider_reputation(category, status, reputation_score DESC);

CREATE INDEX IF NOT EXISTS idx_provider_payments_provider
    ON core.provider_payments(provider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_audit_provider
    ON core.provider_audit_log(provider_id, created_at DESC);

CREATE OR REPLACE VIEW core.v_provider_dashboard AS
SELECT
    pr.provider_id,
    pr.provider_name,
    pr.category,
    pr.status,
    pr.reputation_score,
    pr.ema_haircut_ratio,
    pr.total_promised_usd,
    pr.total_paid_usd,
    CASE
        WHEN pr.total_promised_usd > 0 THEN ROUND((pr.total_paid_usd / pr.total_promised_usd) * 100, 2)
        ELSE 100.00
    END AS payout_percentage,
    pr.total_batches,
    pr.consecutive_low_batches,
    pr.failover_chain,
    pr.last_payment_at,
    pr.quarantine_reason,
    pr.updated_at
FROM core.provider_reputation pr
ORDER BY pr.reputation_score DESC, pr.provider_id ASC;

COMMIT;
