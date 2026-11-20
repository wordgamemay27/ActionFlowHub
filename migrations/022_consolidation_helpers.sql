-- Migration 022 — Consolidamento helper e verifica integrità (NON APPLICATA)
-- Consolida le funzioni helper necessarie per la verifica per-asset e l'integrità del ledger.

CREATE OR REPLACE FUNCTION core.get_asset_coverage(p_asset TEXT)
RETURNS BIGINT AS $$
  SELECT COALESCE(points_equivalent_capacity, 0)::BIGINT
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION core.get_asset_reserve(p_asset TEXT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(reserved_buffer_percent, 0.15)
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

-- Verifica integrità ledger (quadratura contabile)
CREATE OR REPLACE FUNCTION core.verify_zero_sum()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(SUM(amount), 0) = 0 FROM core.ledger_entries;
$$ LANGUAGE SQL STABLE;

-- Placeholder: nessuna modifica a saldi o movimenti.
SELECT 1;
