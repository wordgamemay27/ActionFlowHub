import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { bootstrapDatabaseSchema, dbPool } from '../src/db/ledgerService';
import { SettlementService } from '../src/db/settlementService';
import { createExpressApp } from '../src/server';

const TEST_UID = 999999001;
const TEST_PARTNER = 'test_partner_neon';

async function cleanupTestArtifacts() {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM core.payout_requests WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.user_rewards WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.reward_events WHERE user_id = $1 OR partner_id = $2`, [TEST_UID, TEST_PARTNER]);
    await client.query(`DELETE FROM core.idempotency_keys WHERE user_id = $1`, [TEST_UID]);
    await client.query(
      `DELETE FROM core.ledger_transactions
        WHERE tx_id IN (
          SELECT DISTINCT tx_id FROM core.ledger_entries
          WHERE account_id LIKE $1
        )
        OR reference_id LIKE 'batch_neon_test_%'
        OR reference_id LIKE 'settle_neon_%'`,
      [`USER_${TEST_UID}:%`]
    );
    await client.query(`DELETE FROM core.balances WHERE account_id LIKE $1`, [`USER_${TEST_UID}:%`]);
    await client.query(`DELETE FROM core.accounts WHERE account_id LIKE $1`, [`USER_${TEST_UID}:%`]);
    await client.query(`DELETE FROM core.users WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.provider_payments WHERE provider_id = $1`, [TEST_PARTNER]);
    await client.query(`DELETE FROM core.provider_audit_log WHERE provider_id = $1`, [TEST_PARTNER]);
    await client.query(`DELETE FROM core.provider_reputation WHERE provider_id = $1`, [TEST_PARTNER]);
    await client.query(`DELETE FROM core.partner_exposure WHERE partner_id = $1`, [TEST_PARTNER]);
    // Recompute SYSTEM account balances from remaining ledger entries (0 for fresh DB)
    await client.query(`
      UPDATE core.balances b
         SET balance = COALESCE((SELECT SUM(e.amount) FROM core.ledger_entries e WHERE e.account_id = b.account_id), 0),
             updated_at = NOW()
       WHERE b.account_id LIKE 'SYSTEM:%'
    `);
    await client.query(`
      UPDATE core.treasury_vault
         SET actual_cash_on_chain = 0, points_equivalent_capacity = 0, updated_at = NOW()
       WHERE asset = 'USDT'
         AND NOT EXISTS (SELECT 1 FROM core.ledger_transactions WHERE reference_type = 'SETTLEMENT')
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  assert.ok(dbPool, 'dbPool must be configured with Neon DATABASE_URL');

  // 1. Apply migrations & verify idempotency
  const boot1 = await bootstrapDatabaseSchema();
  const boot2 = await bootstrapDatabaseSchema();
  assert.ok(Array.isArray(boot1.applied) && Array.isArray(boot1.skipped));
  assert.equal(boot2.applied.length, 0);

  const migRes = await dbPool.query('SELECT filename FROM core.schema_migrations ORDER BY filename');
  assert.ok(migRes.rows.length >= 7);

  // Clean any prior synthetic test state before starting
  await cleanupTestArtifacts();

  const prevAdminToken = process.env.ADMIN_API_TOKEN;
  const prevWebhookSecret = process.env.WEBHOOK_SECRET;
  const prevBotToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.ADMIN_API_TOKEN = 'neon_live_test_admin_token_12345';
  process.env.WEBHOOK_SECRET = 'neon_live_test_webhook_secret_123';
  delete process.env.TELEGRAM_BOT_TOKEN;

  const app = createExpressApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // 2. HTTP Health check with live DB
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.dbConnected, true);
    assert.equal(health.payoutMode, 'MANUAL_ADMIN_APPROVAL_ONLY');

    // 3. Webhook postback -> record_pending_reward (30%) + idempotency
    const evtId = `evt_neon_live_${Date.now()}`;
    const postback1 = await fetch(
      `${baseUrl}/api/webhook/postback?provider=${TEST_PARTNER}&userId=${TEST_UID}&payout=20&txId=${evtId}`,
      { headers: { 'X-Webhook-Secret': 'neon_live_test_webhook_secret_123' } }
    );
    assert.equal(postback1.status, 200);
    const pb1Body = await postback1.json();
    assert.equal(pb1Body.ok, true);
    assert.equal(pb1Body.idempotent, false);
    assert.equal(pb1Body.userPendingPointsAdded, 600); // 30% of $20 (2000 PT)

    // Duplicate webhook postback MUST NOT double-credit
    const postback2 = await fetch(
      `${baseUrl}/api/webhook/postback?provider=${TEST_PARTNER}&userId=${TEST_UID}&payout=20&txId=${evtId}`,
      { headers: { 'X-Webhook-Secret': 'neon_live_test_webhook_secret_123' } }
    );
    assert.equal(postback2.status, 200);
    const pb2Body = await postback2.json();
    assert.equal(pb2Body.idempotent, true);
    assert.equal(pb2Body.userPendingPointsAdded, 0);

    // 4. Confirm reward S2S -> PENDING -> SETTLED + 70% PLATFORM_REVENUE
    const confirm1 = await dbPool.query(`SELECT core.partner_confirm_reward($1, 'VERIFIED') AS r`, [evtId]);
    assert.equal(confirm1.rows[0].r.success, true);
    assert.equal(confirm1.rows[0].r.user_settled_points, 600);
    assert.equal(confirm1.rows[0].r.platform_revenue_points, 1400);

    // Idempotent re-confirm
    const confirm2 = await dbPool.query(`SELECT core.partner_confirm_reward($1, 'VERIFIED') AS r`, [evtId]);
    assert.equal(confirm2.rows[0].r.idempotent, true);

    // 5. Revocation test: PENDING returns cleanly to 0
    const evtRev = `evt_neon_rev_${Date.now()}`;
    await dbPool.query(`SELECT core.record_pending_reward($1, $2, $3, $4, '{}'::jsonb)`, [
      evtRev,
      TEST_PARTNER,
      TEST_UID,
      100,
    ]);
    const revRes = await dbPool.query(`SELECT core.partner_confirm_reward($1, 'REVOKED') AS r`, [evtRev]);
    assert.equal(revRes.rows[0].r.action, 'REVOKED');
    assert.equal(revRes.rows[0].r.revoked_points, 30);

    // 6. Batch settlement revenue cap test: $10 promised (1000 raw -> 300 pending), $4.00 actual received -> 120 user + 280 platform = 400
    const evtBatch = `evt_neon_batch_${Date.now()}`;
    await dbPool.query(`SELECT core.record_pending_reward($1, $2, $3, $4, '{}'::jsonb)`, [
      evtBatch,
      TEST_PARTNER,
      TEST_UID,
      1000,
    ]);
    const batchId = `batch_neon_test_${Date.now()}`;
    const batchRes = await SettlementService.executeBatchSettlement({
      batchId,
      partnerId: TEST_PARTNER,
      periodStart: Date.now() - 600_000,
      periodEnd: Date.now() + 60_000,
      expectedGrossUsd: 10,
      actualNetReceivedUsd: 4,
      haircutRatio: 1.0, // Even if caller passes 1.0, SQL MUST cap to actual $4.00
      onchainTxHash: '0xbatch_live_test_hash_123456',
    });
    assert.equal(batchRes.success, true);
    assert.equal(batchRes.pointsCreditedToUsers, 120); // 30% of $4.00

    // Verify PENDING = 0 (no stuck dust) and SETTLED = 720 (600 + 120)
    let balRes = await (await fetch(`${baseUrl}/api/ledger/balance?telegramUserId=${TEST_UID}`)).json();
    assert.equal(balRes.balances.pending_points, 0);
    assert.equal(balRes.balances.settled_points, 720);

    // 7. Settle SETTLED -> WITHDRAWABLE (plus another 500 PT so we can test both COMPLETED and REJECTED)
    const evtExtra = `evt_neon_extra_${Date.now()}`;
    await dbPool.query(`SELECT core.record_pending_reward($1, $2, $3, $4, '{}'::jsonb)`, [
      evtExtra,
      TEST_PARTNER,
      TEST_UID,
      2000,
    ]);
    await dbPool.query(`SELECT core.partner_confirm_reward($1, 'VERIFIED')`, [evtExtra]);
    // Now SETTLED = 720 + 600 = 1320
    const moveRes = await SettlementService.releaseSettledToWithdrawable(TEST_UID, 1320, `settle_neon_${Date.now()}`);
    assert.equal(moveRes.ok, true);
    assert.equal(moveRes.new_withdrawable_balance, 1320);

    // 8. Concurrent duplicate payout requests (500 PT CASH_PAYEER) -> only ONE debit of 500 PT
    const idemKey1 = `idem_neon_payeer_${Date.now()}`;
    const [wd1, wd2] = await Promise.all([
      fetch(`${baseUrl}/api/payout/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_user_id: TEST_UID,
          points: 500,
          wallet_address: 'CASH-PAYEER:P12345678',
          crypto_asset: 'CASH_PAYEER',
          idempotencyKey: idemKey1,
        }),
      }),
      fetch(`${baseUrl}/api/payout/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_user_id: TEST_UID,
          points: 500,
          wallet_address: 'CASH-PAYEER:P12345678',
          crypto_asset: 'CASH_PAYEER',
          idempotencyKey: idemKey1,
        }),
      }),
    ]);
    assert.equal(wd1.status, 200);
    assert.equal(wd2.status, 200);
    const wd1Body = await wd1.json();
    const wd2Body = await wd2.json();
    assert.equal(wd1Body.requestId, wd2Body.requestId);

    balRes = await (await fetch(`${baseUrl}/api/ledger/balance?telegramUserId=${TEST_UID}`)).json();
    assert.equal(balRes.balances.withdrawable_points, 820);
    assert.equal(balRes.balances.reserved_points, 500);

    // 9. Admin list -> approve -> reject simulated hash -> complete with real receipt
    const listRes = await fetch(`${baseUrl}/api/payout/list?status=PENDING`, {
      headers: { 'X-Admin-Token': 'neon_live_test_admin_token_12345' },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.payouts.some((p: any) => p.request_id === wd1Body.requestId));

    const approveRes = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_token_12345',
      },
      body: JSON.stringify({ requestId: wd1Body.requestId, status: 'APPROVED' }),
    });
    assert.equal(approveRes.status, 200);

    const fakeComplete = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_token_12345',
      },
      body: JSON.stringify({
        requestId: wd1Body.requestId,
        status: 'COMPLETED',
        txHash: 'tx_onchain_fake_999',
      }),
    });
    assert.equal(fakeComplete.status, 409);

    const realComplete = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_token_12345',
      },
      body: JSON.stringify({
        requestId: wd1Body.requestId,
        status: 'COMPLETED',
        txHash: 'payeer_real_receipt_88442211',
      }),
    });
    assert.equal(realComplete.status, 200);

    balRes = await (await fetch(`${baseUrl}/api/ledger/balance?telegramUserId=${TEST_UID}`)).json();
    assert.equal(balRes.balances.withdrawable_points, 820);
    assert.equal(balRes.balances.reserved_points, 0);

    // 10. Rejection & automatic refund RESERVED -> WITHDRAWABLE
    const wd3 = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_user_id: TEST_UID,
        points: 500,
        wallet_address: 'UQB1234567890abcdef1234567890abcdef1234567890abcd',
        crypto_asset: 'TON',
        idempotencyKey: `idem_neon_ton_rej_${Date.now()}`,
      }),
    });
    assert.equal(wd3.status, 200);
    const wd3Body = await wd3.json();

    const rejectRes = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_token_12345',
      },
      body: JSON.stringify({
        requestId: wd3Body.requestId,
        status: 'REJECTED',
        note: 'Test rimborso automatico',
      }),
    });
    assert.equal(rejectRes.status, 200);

    balRes = await (await fetch(`${baseUrl}/api/ledger/balance?telegramUserId=${TEST_UID}`)).json();
    assert.equal(balRes.balances.withdrawable_points, 820);
    assert.equal(balRes.balances.reserved_points, 0);

    // 11. Zero-sum & non-negative audit across ALL ledger transactions
    const zeroCheck = await dbPool.query(`
      SELECT COUNT(*) AS bad_txs
        FROM (
          SELECT tx_id, SUM(amount) AS s
            FROM core.ledger_entries
           GROUP BY tx_id
          HAVING SUM(amount) <> 0
        ) t
    `);
    assert.equal(Number(zeroCheck.rows[0].bad_txs), 0, 'Every ledger transaction must sum to 0');

    const negCheck = await dbPool.query(`
      SELECT COUNT(*) AS neg_users
        FROM core.balances
       WHERE LEFT(account_id, 5) = 'USER_' AND balance < 0
    `);
    assert.equal(Number(negCheck.rows[0].neg_users), 0, 'No user balance may be negative');

    console.log(
      '[verify-neon-live] OK — Tutte le 7 migrazioni, idempotenza, 70/30 revenue cap, concorrenza prelievi, rimborso automatico e partita doppia a somma zero verificati su Neon PostgreSQL reale!'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupTestArtifacts();
    if (prevAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevAdminToken;
    if (prevWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = prevWebhookSecret;
    if (prevBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevBotToken;
    await dbPool.end();
  }
}

main().catch((err) => {
  console.error('[verify-neon-live] FAILED:', err);
  process.exit(1);
});
