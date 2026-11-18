import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateUserRewardFromGrossUsdt,
  calculateTonFromLiveRate,
  calculateUsdtEquivalent,
  isValidTonAddress,
} from '../src/types';

function main() {
  // 1. Regola contabile 30% utente / 70% piattaforma (100 PT = $1.00 USD)
  const share1 = calculateUserRewardFromGrossUsdt(1.0);
  assert.equal(share1.userPoints, 30);
  assert.equal(share1.userUsdt, 0.3);
  assert.equal(share1.platformUsdt, 0.7);

  const share2 = calculateUserRewardFromGrossUsdt(5.0);
  assert.equal(share2.userPoints, 150);
  assert.equal(calculateUsdtEquivalent(500), 5.0);

  // 2. Conversione TON live fail-closed (nessun tasso fisso)
  assert.equal(calculateTonFromLiveRate(500, null), null);
  assert.equal(calculateTonFromLiveRate(500, 0), null);
  assert.equal(calculateTonFromLiveRate(500, -2), null);
  assert.equal(calculateTonFromLiveRate(500, 5.0), 1.0); // 500 PT = $5.00 / $5.00 per TON = 1.0000 TON

  // 3. Validazione indirizzi TON
  assert.equal(isValidTonAddress('UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-'), true);
  assert.equal(isValidTonAddress('invalid_wallet'), false);

  // 4. Verifica statica invarianti SQL 009 & 010 (zero crediti al click/timer, partita doppia)
  const root = process.cwd();
  const m009 = fs.readFileSync(
    path.join(root, 'migrations/009_unified_auto_session_and_interactions.sql'),
    'utf8'
  );
  const m010 = fs.readFileSync(
    path.join(root, 'migrations/010_reconciliation_settlement_and_payout_hardening.sql'),
    'utf8'
  );

  for (const sym of [
    'core.auto_sessions',
    'core.session_interactions',
    'core.fx_price_snapshots',
    'core.start_auto_session',
    'core.register_session_interaction',
    'core.claim_block_atomic',
    'TIME_BASED_BLOCK_REWARDS_DISABLED',
    "WHERE partner_id = 'internal_relay'",
  ]) {
    assert.ok(m009.includes(sym), `009 missing expected construct: ${sym}`);
  }

  for (const sym of [
    'core.settlement_batches',
    'core.webhook_replay_guard',
    'core.record_verified_interaction_postback',
    'core.partner_confirm_reward',
    'core.execute_batch_settlement',
    'core.release_settled_to_withdrawable_for_user',
    'core.request_payout_atomic',
    'core.audit_ledger_integrity',
    'core.v_treasury_solvency',
    'reward_events_user_pending_cap_30pct',
    'session_interactions_pending_cap_30pct',
  ]) {
    assert.ok(m010.includes(sym), `010 missing expected construct: ${sym}`);
  }

  console.log(
    '[verify-ledger] OK — Regola 30/70, conversione FX fail-closed, validazione wallet e invarianti SQL 009/010 verificati.'
  );
}

main();
