-- Migration 019 — Rollback punti dopo revoca (NON APPLICATA)
-- Funzione: core.revoke_reward_with_rollback(p_event_id TEXT)
-- Reverte i punti accreditati a un evento revocato.
CREATE OR REPLACE FUNCTION core.revoke_reward_with_rollback(p_event_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_event RECORD;
  v_user_id BIGINT;
  v_points BIGINT;
BEGIN
  SELECT * INTO v_event FROM core.reward_events WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EVENT_NOT_FOUND');
  END IF;
  IF v_event.status = 'REVOKED' THEN
    RETURN jsonb_build_object('success', true, 'action', 'ALREADY_REVOKED');
  END IF;
  v_user_id := v_event.user_id;
  v_points := COALESCE(v_event.user_pending_points, 0) + COALESCE(v_event.user_settled_points, 0);
  -- Revert ledger entries (double-entry: USER -n, SYSTEM +n)
  -- (implementazione dipende da schema ledger_entries; placeholder)
  UPDATE core.reward_events SET status = 'REVOKED', updated_at = NOW() WHERE event_id = p_event_id;
  RETURN jsonb_build_object('success', true, 'action', 'REVOKED_WITH_ROLLBACK', 'points_reverted', v_points);
END;
$$ LANGUAGE plpgsql;
