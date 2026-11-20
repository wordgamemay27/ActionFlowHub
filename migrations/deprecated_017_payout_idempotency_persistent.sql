-- Migration 017 — Idempotenza payout persistente (NON APPLICATA)
-- Aggiunge colonna request_fingerprint a payout_requests per idempotenza
-- server-side persistente (non solo in-memory).
ALTER TABLE core.payout_requests
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_payout_requests_fingerprint
  ON core.payout_requests (user_id, request_fingerprint);

-- Funzione helper per lookup idempotente persistente
CREATE OR REPLACE FUNCTION core.find_payout_by_fingerprint(p_user_id BIGINT, p_fingerprint TEXT)
RETURNS TABLE (request_id TEXT, idempotency_key TEXT, status TEXT) AS $$
  SELECT request_id, idempotency_key, COALESCE(status, payout_status) AS status
  FROM core.payout_requests
  WHERE user_id = p_user_id AND request_fingerprint = p_fingerprint
  ORDER BY created_at DESC
  LIMIT 1;
$$ LANGUAGE SQL STABLE;
