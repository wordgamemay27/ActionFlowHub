-- Migration 021 — Helper per-asset coverage + documentazione patch (NON APPLICATA)
-- Funzione helper: restituisce capacity SOLO per l'asset richiesto.
CREATE OR REPLACE FUNCTION core.get_asset_coverage(p_asset TEXT)
RETURNS BIGINT AS $$
  SELECT COALESCE(points_equivalent_capacity, 0)::BIGINT
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

-- Funzione helper: riserva per-asset
CREATE OR REPLACE FUNCTION core.get_asset_reserve(p_asset TEXT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(reserved_buffer_percent, 0.15)
  FROM core.treasury_vault
  WHERE asset = p_asset;
$$ LANGUAGE SQL STABLE;

-- PATCH RICHIESTO (da applicare manualmente alle funzioni esistenti):
-- In complete_payout_atomic (migrazione 010, riga ~1022):
--   SOSTITUIRE: SELECT COALESCE(SUM(points_equivalent_capacity),0) FROM core.treasury_vault;
--   CON:        SELECT COALESCE(points_equivalent_capacity,0) FROM core.treasury_vault WHERE asset = p_crypto_asset;
--
-- In release_settled_to_withdrawable_for_user (migrazione 010, riga ~1382):
--   STESSA SOSTITUZIONE (per-asset, non SUM).
--
-- In execute_batch_settlement (migrazione 012, riga ~826):
--   SOSTITUIRE: INSERT ... treasury_vault (asset='USDT', ...) ON CONFLICT DO UPDATE SET capacity = capacity + ...
--   CON:        INSERT ... treasury_vault (asset=<settlement_asset>, ...) ON CONFLICT DO UPDATE SET capacity = capacity + ...
--   (l'asset deve essere quello del settlement, non hardcoded USDT)
--
-- VERIFICA: dopo patch, treasury_vault per TON e USDT devono avere capacity indipendenti.
-- Nessun saldo viene modificato da questa migrazione.
SELECT 1;
