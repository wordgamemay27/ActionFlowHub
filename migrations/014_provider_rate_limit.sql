-- Migration 014 — Rate limit per-fornitore persistente e condiviso
-- (NON APPLICATA — solo creata per verifica statica)
CREATE TABLE IF NOT EXISTS core.provider_rate_limit (
  provider TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, window_start)
);

-- Indice per pulizia automatica
CREATE INDEX IF NOT EXISTS idx_provider_rate_limit_window
  ON core.provider_rate_limit (window_start);
