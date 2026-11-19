-- ============================================================================
-- MIGRATION 013 — Treasury per-asset (per-asset treasury vault)
-- ============================================================================
-- Obiettivo: estendere core.treasury_vault a TUTTI gli asset supportati da
-- ActionFlow (TON, USDT, SOL, PI, USDC, CASH_PAYEER, CASH_AIRTM, CASH_VOLET)
-- senza alterare saldi esistenti, senza generare movimenti finanziari, senza
-- riclassificare crediti.
--
-- Vincoli:
--   - idempotente (ON CONFLICT DO NOTHING)
--   - non modifica righe esistenti (TON, USDT)
--   - nuove righe partono con disponibilita' 0 (non finanziate)
--   - rollback sicuro: DELETE solo righe con capacity=0 AND disbursed=0
-- ============================================================================

-- 1. Estendi CHECK constraint su asset
ALTER TABLE core.treasury_vault
  DROP CONSTRAINT IF EXISTS treasury_vault_asset_check;

ALTER TABLE core.treasury_vault
  ADD CONSTRAINT treasury_vault_asset_check
  CHECK (asset IN ('TON', 'USDT', 'SOL', 'PI', 'USDC', 'CASH_PAYEER', 'CASH_AIRTM', 'CASH_VOLET'));

-- 2. Inserisci nuove righe (idempotente, zero disponibilita')
INSERT INTO core.treasury_vault (asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent)
VALUES
    ('SOL', 0.000000, 0, 0.15),
    ('PI', 0.000000, 0, 0.15),
    ('USDC', 0.000000, 0, 0.15),
    ('CASH_PAYEER', 0.000000, 0, 0.15),
    ('CASH_AIRTM', 0.000000, 0, 0.15),
    ('CASH_VOLET', 0.000000, 0, 0.15)
ON CONFLICT (asset) DO NOTHING;

-- 3. Verifica post-migrazione (commentata, da eseguire manualmente)
-- SELECT asset, actual_cash_on_chain, points_equivalent_capacity, reserved_buffer_percent
-- FROM core.treasury_vault ORDER BY asset;
-- Atteso: 8 righe, TON e USDT invariati, nuove righe a zero.
