-- Migration 018 — Tracking verifica on-chain (NON APPLICATA)
ALTER TABLE core.payout_requests
  ADD COLUMN IF NOT EXISTS tx_verified_on_chain BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS tx_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tx_verification_error TEXT;
