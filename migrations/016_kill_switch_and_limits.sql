-- Migration 016 — Kill switch e limiti payout (NON APPLICATA)
CREATE TABLE IF NOT EXISTS core.kill_switch (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO core.kill_switch (key, enabled) VALUES ('PAYOUTS_DISABLED', false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.payout_limits (
  user_id BIGINT NOT NULL,
  asset TEXT NOT NULL,
  day DATE NOT NULL,
  total_points BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, asset, day)
);

CREATE TABLE IF NOT EXISTS core.payout_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO core.payout_config (key, value) VALUES
  ('MAX_SINGLE_PAYOUT_POINTS', '100000'),
  ('MAX_DAILY_PAYOUT_POINTS', '500000')
ON CONFLICT (key) DO NOTHING;
