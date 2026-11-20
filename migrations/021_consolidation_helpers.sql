-- Migration 021 — Consolidamento helper e verifica integrità (NON APPLICATA)
-- Consolida le funzioni helper necessarie per la verifica per-asset e l'integrità del ledger.

BEGIN;

CREATE OR REPLACE FUNCTION core.get_asset_coverage(p_asset TEXT)
RETURNS BIGINT AS $$
  SELECT COALESCE(GREATEST(0, points_equivalent_capacity - disbursed_points), 0)::BIGINT
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION core.get_asset_reserve(p_asset TEXT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(reserved_buffer_percent, 0.15)
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

-- Verifica integrità ledger (quadratura contabile) — funzione booleana separata
-- dal trigger verify_zero_sum (RETURNS TRIGGER) definito in 001.
CREATE OR REPLACE FUNCTION core.check_ledger_zero_sum()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(SUM(amount), 0) = 0 FROM core.ledger_entries;
$$ LANGUAGE SQL STABLE;

COMMIT;

-- Placeholder: nessuna modifica a saldi o movimenti.
SELECT 1;
