import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { bootstrapDatabaseSchema, dbPool, LedgerService } from '../src/db/ledgerService';
import { SettlementService } from '../src/db/settlementService';
import { createExpressApp } from '../src/server';
import { tonPayoutWorker } from '../src/workers/tonPayoutWorker';
import { multiAssetPayoutWorker } from '../src/workers/multiAssetPayoutWorker';

const TEST_UID = 999999001;
const TEST_PARTNER = 'test_partner_neon';
const TEST_ADMIN_1 = 'admin_neon_primary';
const TEST_ADMIN_2 = 'admin_neon_secondary';
const TEST_WEBHOOK_SECRET = 'neon_live_test_webhook_secret_123';

function signRawWebhook(secret: string, rawBody: string, tsSec = Math.floor(Date.now() / 1000)) {
  const sigHex = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${tsSec}.`, 'utf8'), Buffer.from(rawBody, 'utf8')]))
    .digest('hex');
  return {
    ts: String(tsSec),
    signature: `sha256=${sigHex}`,
  };
}

async function cleanupTestArtifacts() {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // Non tocchiamo mai le tabelle append-only (payout_dispatch_audit, security_audit_logs, inbound_security_logs)
    // perche' protette da trigger BEFORE UPDATE OR DELETE immutable.
    await client.query(
      `DELETE FROM core.payout_onchain_verifications
        WHERE request_id IN (SELECT request_id FROM core.payout_requests WHERE user_id = $1)`,
      [TEST_UID]
    );
    await client.query(
      `DELETE FROM core.payout_dispatch_attempts
        WHERE request_id IN (SELECT request_id FROM core.payout_requests WHERE user_id = $1)`,
      [TEST_UID]
    );
    await client.query(`DELETE FROM core.payout_requests WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.session_interactions WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.auto_sessions WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.user_rewards WHERE user_id = $1`, [TEST_UID]);
    await client.query(`DELETE FROM core.reward_events WHERE user_id = $1 OR partner_id = $2`, [
      TEST_UID,
      TEST_PARTNER,
    ]);
    await client.query(`DELETE FROM core.idempotency_keys WHERE user_id = $1`, [TEST_UID]);
    await client.query(
      `DELETE FROM core.settlement_batches WHERE partner_id = $1 OR batch_id LIKE 'batch_neon_test_%'`,
      [TEST_PARTNER]
    );
    await client.query(
      `DELETE FROM core.treasury_conversions WHERE conversion_id LIKE 'conv_neon_test_%'`
    );
    await client.query(
      `DELETE FROM core.processed_tx_hashes
        WHERE tx_hash LIKE 'payout:neontx_%'
           OR tx_hash LIKE 'settlement:0xneontest%'
           OR tx_hash LIKE 'conv:neontest_%'`
    );
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
    await client.query(`DELETE FROM core.provider_rate_limit_windows WHERE provider_id = $1`, [TEST_PARTNER]);
    await client.query(`DELETE FROM core.provider_rate_limits WHERE provider_id = $1`, [TEST_PARTNER]);

    // Ricalcola i saldi SYSTEM:* dalle righe ledger superstiti (0 su DB staging pulito)
    await client.query(`
      UPDATE core.balances b
         SET balance = COALESCE((SELECT SUM(e.amount) FROM core.ledger_entries e WHERE e.account_id = b.account_id), 0),
             updated_at = NOW()
       WHERE b.account_id LIKE 'SYSTEM:%'
    `);

    // Su DB staging senza batch/conversioni reali esterne, riporta a zero il test delta
    await client.query(`
      UPDATE core.treasury_vault
         SET actual_cash_on_chain = 0,
             points_equivalent_capacity = 0,
             disbursed_usd = 0,
             disbursed_points = 0,
             updated_at = NOW()
       WHERE NOT EXISTS (SELECT 1 FROM core.settlement_batches)
         AND NOT EXISTS (SELECT 1 FROM core.treasury_conversions)
         AND NOT EXISTS (SELECT 1 FROM core.payout_requests WHERE status = 'COMPLETED')
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seedStagingPartnerAndFx() {
  assert.ok(dbPool);
  await dbPool.query(
    `INSERT INTO core.partner_exposure (partner_id, parent_broker, pending_points_exposure, max_exposure_limit, status)
     VALUES ($1, 'direct_staging', 0, 5000000, 'ACTIVE')
     ON CONFLICT (partner_id) DO UPDATE
     SET status = 'ACTIVE', max_exposure_limit = 5000000, updated_at = NOW()`,
    [TEST_PARTNER]
  );

  await dbPool.query(
    `INSERT INTO core.provider_reputation (
        provider_id, provider_name, category, status, reputation_score, ema_haircut_ratio
     ) VALUES ($1, 'Test Partner Neon', 'SURVEYS', 'ACTIVE', 100.00, 1.0000)
     ON CONFLICT (provider_id) DO UPDATE
     SET status = 'ACTIVE', reputation_score = 100.00, updated_at = NOW()`,
    [TEST_PARTNER]
  );

  await dbPool.query(
    `SELECT core.upsert_country_economic_profile('US', 'US', 'ZONE_A', 1.000000, 1.000000, 1.0000, 1.0000, 2025, 'STAGING_US_BASE')`
  );

  await LedgerService.ensureUserAccounts(TEST_UID, 'neon_staging_user', 'ZONE_A', 0.30, 'UTC');
  await LedgerService.upsertEntryProfile({
    userId: TEST_UID,
    lang: 'en',
    country: 'US',
    timezone: 'UTC',
    selectedCategories: ['SURVEYS'],
  });

  await LedgerService.recordFxPriceSnapshot('TON', 5.0, 'staging_fx', 3600);
  await LedgerService.recordFxPriceSnapshot('SOL', 150.0, 'staging_fx', 3600);
  await LedgerService.recordFxPriceSnapshot('USDT', 1.0, 'staging_fx', 3600);
  await LedgerService.recordFxPriceSnapshot('CASH_PAYEER', 1.0, 'staging_fx', 3600);
}

async function main() {
  assert.ok(dbPool, 'dbPool must be configured with Neon/Staging DATABASE_URL');

  // 1. Applica migrazioni 001..020 e verifica idempotenza
  const boot1 = await bootstrapDatabaseSchema();
  const boot2 = await bootstrapDatabaseSchema();
  assert.ok(Array.isArray(boot1.applied) && Array.isArray(boot1.skipped));
  assert.equal(boot2.applied.length, 0, 'Second bootstrapDatabaseSchema() pass must apply 0 migrations');

  const migRes = await dbPool.query(
    `SELECT filename, migration_id FROM core.schema_migrations ORDER BY filename`
  );
  assert.ok(migRes.rows.length >= 19, 'All migrations 001..020 (19 files) must be registered');
  assert.ok(
    migRes.rows.some((r) => r.filename === '019_treasury_sql_and_session_rollback_hardening.sql' && r.migration_id === '019'),
    'Migration 019 must be registered with filename and migration_id'
  );
  assert.ok(
    migRes.rows.some((r) => r.filename === '020_payout_dispatch_claims_and_double_spend_guard.sql' && r.migration_id === '020'),
    'Migration 020 must be registered with filename and migration_id'
  );

  // Verifica schema, indici, trigger e ruoli delle migrazioni 011-020
  const dbChecks = await dbPool.query(`
    SELECT
      to_regclass('core.payout_dispatch_attempts') IS NOT NULL AS has_attempts_tbl,
      to_regclass('core.payout_dispatch_audit') IS NOT NULL AS has_audit_tbl,
      to_regclass('core.payout_onchain_verifications') IS NOT NULL AS has_verif_tbl,
      EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'core' AND indexname = 'idx_payout_dispatch_one_blocking_attempt'
      ) AS has_unique_claim_idx,
      EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'core' AND indexname = 'idx_payout_requests_idempotency_unique'
      ) AS has_idem_idx,
      EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payout_dispatch_audit_immutable'
      ) AS has_dispatch_audit_trg,
      EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_security_audit_logs_immutable'
      ) AS has_sec_audit_trg,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_app') AS has_app_role,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actionflow_auditor') AS has_auditor_role
  `);
  const chk = dbChecks.rows[0];
  assert.equal(chk.has_attempts_tbl, true);
  assert.equal(chk.has_audit_tbl, true);
  assert.equal(chk.has_verif_tbl, true);
  assert.equal(chk.has_unique_claim_idx, true);
  assert.equal(chk.has_idem_idx, true);
  assert.equal(chk.has_dispatch_audit_trg, true);
  assert.equal(chk.has_sec_audit_trg, true);
  if (chk.has_app_role) {
    const privRes = await dbPool.query(`
      SELECT
        has_function_privilege('actionflow_app', 'core.claim_payout_for_dispatch(text,text,text)', 'EXECUTE') AS can_claim,
        has_function_privilege('actionflow_app', 'core.update_payout_dispatch_state(text,text,text,text,text,text,bigint,jsonb)', 'EXECUTE') AS can_update_disp,
        has_function_privilege('actionflow_app', 'core.get_uncertain_payout_dispatches(integer,integer)', 'EXECUTE') AS can_get_uncertain,
        has_function_privilege('actionflow_app', 'core.complete_payout_atomic(text,text,text)', 'EXECUTE') AS can_complete,
        has_function_privilege('actionflow_app', 'core.reject_payout_atomic(text,text)', 'EXECUTE') AS can_reject
    `);
    assert.equal(privRes.rows[0].can_claim, true);
    assert.equal(privRes.rows[0].can_update_disp, true);
    assert.equal(privRes.rows[0].can_get_uncertain, true);
    assert.equal(privRes.rows[0].can_complete, true);
    assert.equal(privRes.rows[0].can_reject, true);
  }

  // Conserva lo stato originale del Kill Switch per ripristinarlo sempre nel blocco finally
  const prevKillSwitch = await LedgerService.getKillSwitchStatus();

  await cleanupTestArtifacts();
  await seedStagingPartnerAndFx();

  const prevEnv = {
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    ADMIN_SECONDARY_API_TOKEN: process.env.ADMIN_SECONDARY_API_TOKEN,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    WEBHOOK_REQUIRE_HMAC: process.env.WEBHOOK_REQUIRE_HMAC,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    CASH_GATEWAY_VERIFY_URL: process.env.CASH_GATEWAY_VERIFY_URL,
    CASH_GATEWAY_API_KEY: process.env.CASH_GATEWAY_API_KEY,
  };

  // Micro-verifier locale HTTP per simulare la risposta indipendente del gateway Payeer su staging
  const gatewayExpectedByTx = new Map<string, { dest: string; amountUsd: number; asset: string }>();
  const gatewayServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const txHash = url.searchParams.get('txHash') || '';
    const found = gatewayExpectedByTx.get(txHash);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!found) {
      res.end(JSON.stringify({ verified: false, status: 'NOT_FOUND' }));
      return;
    }
    res.end(
      JSON.stringify({
        verified: true,
        status: 'COMPLETED',
        asset: found.asset,
        destination: found.dest,
        amountUsd: found.amountUsd,
      })
    );
  });
  await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', () => resolve()));
  const gatewayUrl = `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}/verify`;

  process.env.ADMIN_API_TOKEN = 'neon_live_test_admin_primary_12345';
  process.env.ADMIN_SECONDARY_API_TOKEN = 'neon_live_test_admin_secondary_67890';
  process.env.WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.WEBHOOK_REQUIRE_HMAC = 'true';
  process.env.CASH_GATEWAY_VERIFY_URL = gatewayUrl;
  process.env.CASH_GATEWAY_API_KEY = 'staging_cash_verifier_secret';
  delete process.env.TELEGRAM_BOT_TOKEN;

  const app = createExpressApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // 2. HTTP Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.dbConnected, true);

    // 3. Sessione + Interazione + Webhook raw-body HMAC + anti-replay + 30/70
    const ts = Date.now();
    const sessionId = `sess_neon_${ts}`;
    const startSess = await LedgerService.startAutoSession({
      sessionId,
      userId: TEST_UID,
      categories: ['SURVEYS'],
      language: 'en',
      marketCountry: 'US',
      timezone: 'UTC',
      forceNew: true,
    });
    assert.equal(startSess.ok, true);

    const interactionId = `int_neon_${ts}`;
    const clickId = `clk_neon_${ts}`;
    const regInt = await LedgerService.registerSessionInteraction({
      interactionId,
      clickId,
      sessionId,
      userId: TEST_UID,
      providerId: TEST_PARTNER,
      activityCategory: 'SURVEYS',
      taskId: 'task_staging_1',
      trackingUrl: 'https://example.com/offer/1',
      expectedGrossUsd: 20,
    });
    assert.equal(regInt.ok, true);

    const evtId = `evt_neon_live_${ts}`;
    const rawPbPayload = JSON.stringify({
      provider: TEST_PARTNER,
      userId: TEST_UID,
      payout: 20,
      txId: evtId,
      click_id: clickId,
      interaction_id: interactionId,
    });
    const signed1 = signRawWebhook(TEST_WEBHOOK_SECRET, rawPbPayload);
    const nonce1 = `nonce_${ts}_1`;

    const postback1 = await fetch(`${baseUrl}/api/webhook/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': signed1.ts,
        'X-Webhook-Signature': signed1.signature,
        'X-Webhook-Nonce': nonce1,
      },
      body: rawPbPayload,
    });
    assert.equal(postback1.status, 200);
    const pb1Body = await postback1.json();
    assert.equal(pb1Body.ok, true);
    assert.equal(pb1Body.userPendingPointsAdded, 600); // 30% di $20 (2000 PT) con PPP 1.0

    // Replay con stesso nonce / evento deve essere bloccato o idempotente senza doppio accredito
    const postbackReplay = await fetch(`${baseUrl}/api/webhook/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': signed1.ts,
        'X-Webhook-Signature': signed1.signature,
        'X-Webhook-Nonce': nonce1,
      },
      body: rawPbPayload,
    });
    assert.ok([200, 409].includes(postbackReplay.status));
    if (postbackReplay.status === 200) {
      const pb2Body = await postbackReplay.json();
      assert.equal(pb2Body.idempotent, true);
      assert.equal(pb2Body.userPendingPointsAdded, 0);
    }

    // 4. Conferma S2S -> PENDING -> SETTLED + 70% PLATFORM_REVENUE
    const confirm1 = await dbPool.query(`SELECT core.partner_confirm_reward($1, 'VERIFIED') AS r`, [evtId]);
    assert.equal(confirm1.rows[0].r.success, true);
    assert.equal(confirm1.rows[0].r.user_settled_points, 600);
    assert.equal(confirm1.rows[0].r.platform_revenue_points, 1400);

    // 5. Batch settlement multi-asset + conversioni tesoreria per-asset
    const intBatchId = `int_neon_batch_${ts}`;
    const clkBatchId = `clk_neon_batch_${ts}`;
    await LedgerService.registerSessionInteraction({
      interactionId: intBatchId,
      clickId: clkBatchId,
      sessionId,
      userId: TEST_UID,
      providerId: TEST_PARTNER,
      activityCategory: 'SURVEYS',
      taskId: 'task_staging_batch',
      trackingUrl: 'https://example.com/offer/2',
      expectedGrossUsd: 10,
    });
    const evtBatch = `evt_neon_batch_${ts}`;
    const regBatchPb = await LedgerService.recordVerifiedInteractionPostback({
      eventId: evtBatch,
      clickId: clkBatchId,
      interactionId: intBatchId,
      partnerId: TEST_PARTNER,
      userId: TEST_UID,
      grossUsd: 10,
      webhookNonce: `nonce_batch_${ts}`,
      metadata: {},
    });
    assert.equal(regBatchPb.success, true);

    // Registra extra fondi S2S per avere capienza >= 7000 PT per test dual-approval (5000 PT) + doppio spend (1000 PT) + reject (500 PT)
    const evtExtra = `evt_neon_extra_${ts}`;
    await dbPool.query(`SELECT core.record_pending_reward($1, $2, $3, $4, '{}'::jsonb)`, [
      evtExtra,
      TEST_PARTNER,
      TEST_UID,
      20000, // 20000 raw -> 6000 user settled
    ]);
    await dbPool.query(`SELECT core.partner_confirm_reward($1, 'VERIFIED')`, [evtExtra]);

    const batchId = `batch_neon_test_${ts}`;
    const batchRes = await SettlementService.executeBatchSettlement({
      batchId,
      partnerId: TEST_PARTNER,
      periodStart: Date.now() - 600_000,
      periodEnd: Date.now() + 60_000,
      expectedGrossUsd: 100,
      actualNetReceivedUsd: 100, // 10,000 PT capacita' in USDT (8500 PT netti post riserva 15%)
      haircutRatio: 1.0,
      onchainTxHash: `0xneontest_${ts}_batchhash_abcdef`,
      receivedAsset: 'USDT',
    });
    assert.equal(batchRes.success, true);

    // Converte liquidita' da USDT verso CASH_PAYEER, TON e SOL nei rispettivi vault separati
    const convPayeer = await LedgerService.recordTreasuryConversion({
      conversionId: `conv_neon_test_payeer_${ts}`,
      fromAsset: 'USDT',
      toAsset: 'CASH_PAYEER',
      amountUsd: 15,
      fxRate: 1.0,
      externalTxRef: `neontest_conv_payeer_${ts}`,
      recordedBy: TEST_ADMIN_1,
      note: 'Staging liquidity allocation PAYEER',
    });
    assert.equal(convPayeer.ok, true);

    const convSol = await LedgerService.recordTreasuryConversion({
      conversionId: `conv_neon_test_sol_${ts}`,
      fromAsset: 'USDT',
      toAsset: 'SOL',
      amountUsd: 65,
      fxRate: 1.0,
      externalTxRef: `neontest_conv_sol_${ts}`,
      recordedBy: TEST_ADMIN_1,
      note: 'Staging liquidity allocation SOL',
    });
    assert.equal(convSol.ok, true);

    // Release SETTLED -> WITHDRAWABLE (6900 PT totali)
    const moveRes = await SettlementService.releaseSettledToWithdrawable(
      TEST_UID,
      6900,
      `settle_neon_${ts}`
    );
    assert.equal(moveRes.ok, true);
    assert.equal(moveRes.new_withdrawable_balance, 6900);

    // 6. Kill Switch globale attivo blocca request/approve/claim/complete
    await LedgerService.setKillSwitchStatus(true, 'STAGING_KILL_SWITCH_TEST', TEST_ADMIN_1);
    const ksBlockedReq = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_user_id: TEST_UID,
        points: 500,
        wallet_address: 'CASH-PAYEER:P12345678',
        crypto_asset: 'CASH_PAYEER',
        idempotencyKey: `idem_ks_${ts}`,
      }),
    });
    assert.equal(ksBlockedReq.status, 423);
    const ksBlockedBody = await ksBlockedReq.json();
    assert.equal(ksBlockedBody.error, 'PAYOUT_KILL_SWITCH_ACTIVE');

    // Disabilita Kill Switch per eseguire i test transazionali di staging
    await LedgerService.setKillSwitchStatus(false, 'STAGING_VALIDATION_ACTIVE', TEST_ADMIN_1);

    // 6b. Verifica limiti finanziari (soglia 500 PT, limite singolo 10,000 PT) + modalita MANUAL_EXTERNAL worker
    const belowMin = await LedgerService.requestPayout({
      requestId: `req_neon_min_${ts}`,
      userId: TEST_UID,
      idempotencyKey: `idem_neon_min_${ts}`,
      points: 499,
      cryptoAsset: 'CASH_PAYEER',
      payoutChannel: 'CASH_LOCAL',
      walletAddress: 'CASH-PAYEER:P12345678',
    });
    assert.equal(belowMin.ok, false);
    assert.equal(belowMin.error, 'MINIMUM_500_PT_REQUIRED');

    const overMaxSingle = await LedgerService.requestPayout({
      requestId: `req_neon_max_${ts}`,
      userId: TEST_UID,
      idempotencyKey: `idem_neon_max_${ts}`,
      points: 10001,
      cryptoAsset: 'CASH_PAYEER',
      payoutChannel: 'CASH_LOCAL',
      walletAddress: 'CASH-PAYEER:P12345678',
    });
    assert.equal(overMaxSingle.ok, false);
    assert.equal(overMaxSingle.error, 'SINGLE_PAYOUT_LIMIT_EXCEEDED');

    const tonManualGuard = await tonPayoutWorker.processApprovedTonPayouts();
    assert.equal(tonManualGuard.ok, false);
    assert.equal(tonManualGuard.error, 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING');

    const multiManualGuard = await multiAssetPayoutWorker.processApprovedPayouts();
    assert.equal(multiManualGuard.ok, false);
    assert.equal(multiManualGuard.error, 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING');

    // 7. Richieste concorrenti idempotenti + payload conflict + Payeer completion verificata
    const idemKey1 = `idem_neon_payeer_${ts}`;
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

    // Stessa idempotencyKey con importo diverso -> PAYLOAD CONFLICT
    const wdConflict = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_user_id: TEST_UID,
        points: 600,
        wallet_address: 'CASH-PAYEER:P12345678',
        crypto_asset: 'CASH_PAYEER',
        idempotencyKey: idemKey1,
      }),
    });
    assert.ok([400, 409].includes(wdConflict.status));

    // Approva Payeer payout e completa via verifier HTTP reale + proof SQL
    const approvePayeer = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_primary_12345',
        'X-Admin-Id': TEST_ADMIN_1,
      },
      body: JSON.stringify({ requestId: wd1Body.requestId, status: 'APPROVED' }),
    });
    assert.equal(approvePayeer.status, 200);

    // Verifica guard SQL: completamento senza record_payout_onchain_verification deve fallire
    const directCompleteNoProof = await LedgerService.completePayout(
      wd1Body.requestId,
      `neontx_payeer_${ts}_0001`
    );
    assert.equal(directCompleteNoProof.ok, false);
    assert.equal(directCompleteNoProof.error, 'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED');

    const payeerTxHash = `neontx_payeer_${ts}_verified`;
    gatewayExpectedByTx.set(payeerTxHash, {
      dest: 'CASH-PAYEER:P12345678',
      amountUsd: 5.0,
      asset: 'CASH_PAYEER',
    });

    const realComplete = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_primary_12345',
        'X-Admin-Id': TEST_ADMIN_1,
      },
      body: JSON.stringify({
        requestId: wd1Body.requestId,
        status: 'COMPLETED',
        txHash: payeerTxHash,
      }),
    });
    assert.equal(realComplete.status, 200);

    // 8. DUAL APPROVAL (>= 5000 PT) + SUITE DOUBLE-SPEND MIGRAZIONE 020 SU POSTGRES REALE
    const solWallet = 'SysvarRent111111111111111111111111111111111';
    const highPayoutReq = await LedgerService.requestPayout({
      requestId: `req_neon_ds_${ts}`,
      userId: TEST_UID,
      idempotencyKey: `idem_neon_ds_${ts}`,
      points: 5000, // >= 5000 PT -> requires_dual_approval = TRUE
      cryptoAsset: 'SOL',
      payoutChannel: 'CRYPTO_DIRECT',
      walletAddress: solWallet,
    });
    assert.equal(highPayoutReq.ok, true);
    assert.equal(highPayoutReq.payout.requires_dual_approval, true);

    // Prima approvazione Admin 1
    const firstApp = await LedgerService.approvePayout(`req_neon_ds_${ts}`, TEST_ADMIN_1, 'First check');
    assert.equal(firstApp.ok, true);
    assert.equal(firstApp.requires_second_approval, true);

    // Stesso admin che tenta la seconda approvazione DEVE essere bloccato
    const sameAdminSecond = await LedgerService.approvePayout(`req_neon_ds_${ts}`, TEST_ADMIN_1);
    assert.equal(sameAdminSecond.ok, false);
    assert.equal(sameAdminSecond.error, 'DUAL_APPROVAL_SAME_ADMIN_FORBIDDEN');

    // Claim prima della seconda approvazione DEVE essere bloccato
    const claimBeforeDual = await LedgerService.claimPayoutForDispatch({
      requestId: `req_neon_ds_${ts}`,
      workerId: 'worker_staging_a',
    });
    assert.equal(claimBeforeDual.ok, false);
    assert.equal(claimBeforeDual.error, 'PAYOUT_NOT_APPROVED_FOR_DISPATCH');

    // Seconda approvazione da Admin 2 distinto -> ora status = 'APPROVED'
    const secondApp = await LedgerService.approvePayout(`req_neon_ds_${ts}`, TEST_ADMIN_2, 'Second check');
    assert.equal(secondApp.ok, true);
    assert.equal(secondApp.payout.status, 'APPROVED');

    // A. Kill Switch attivo durante claim -> bloccato fail-closed
    await LedgerService.setKillSwitchStatus(true, 'TEST_CLAIM_BLOCKED', TEST_ADMIN_1);
    const claimWithKs = await LedgerService.claimPayoutForDispatch({
      requestId: `req_neon_ds_${ts}`,
      workerId: 'worker_staging_a',
    });
    assert.equal(claimWithKs.ok, false);
    assert.equal(claimWithKs.error, 'PAYOUT_KILL_SWITCH_ACTIVE');
    await LedgerService.setKillSwitchStatus(false, 'TEST_RESUME', TEST_ADMIN_1);

    // B. SIMULTANEOUS CLAIMS (4 worker paralleli su PostgreSQL reale)
    const claimAttempts = await Promise.all([
      LedgerService.claimPayoutForDispatch({ requestId: `req_neon_ds_${ts}`, workerId: 'w_1' }),
      LedgerService.claimPayoutForDispatch({ requestId: `req_neon_ds_${ts}`, workerId: 'w_2' }),
      LedgerService.claimPayoutForDispatch({ requestId: `req_neon_ds_${ts}`, workerId: 'w_3' }),
      LedgerService.claimPayoutForDispatch({ requestId: `req_neon_ds_${ts}`, workerId: 'w_4' }),
    ]);
    const claimWinners = claimAttempts.filter((c) => c.ok);
    const claimLosers = claimAttempts.filter((c) => !c.ok);
    assert.equal(claimWinners.length, 1, 'Strictly ONE concurrent claim may win on PostgreSQL');
    assert.equal(claimLosers.length, 3);
    for (const loser of claimLosers) {
      assert.equal(loser.error, 'PAYOUT_ALREADY_CLAIMED_BY_WORKER');
    }
    const activeAttemptId = claimWinners[0].attempt_id!;

    // C. Verifica indice univoco DB parziale idx_payout_dispatch_one_blocking_attempt
    let uniqueViolationCaught = false;
    try {
      await dbPool.query(
        `INSERT INTO core.payout_dispatch_attempts (
            attempt_id, request_id, worker_id, asset, destination_address, expected_amount_asset, status
         ) VALUES ($1, $2, 'rogue_worker', 'SOL', $3, 0.3333, 'CLAIMED')`,
        [`att_dup_${ts}`, `req_neon_ds_${ts}`, solWallet]
      );
    } catch (err: any) {
      if (err?.code === '23505') uniqueViolationCaught = true;
    }
    assert.equal(uniqueViolationCaught, true, 'Partial unique index must enforce max 1 blocking attempt at DB level');

    // D. Divieto reject/refund mentre un dispatch e' CLAIMED / BROADCASTING / UNCERTAIN_TIMEOUT
    const rejectWhileClaimed = await LedgerService.rejectPayout(`req_neon_ds_${ts}`, 'Should fail');
    assert.equal(rejectWhileClaimed.ok, false);
    assert.equal(
      rejectWhileClaimed.error,
      'PAYOUT_CANNOT_BE_REJECTED_WHILE_DISPATCH_ACTIVE_OR_UNCERTAIN'
    );

    // E. Transizioni di stato + divieto passaggio a retryable dopo BROADCASTING / UNCERTAIN senza riconciliazione
    const toBroadcast = await LedgerService.updatePayoutDispatchState({
      requestId: `req_neon_ds_${ts}`,
      attemptId: activeAttemptId,
      nextState: 'BROADCASTING',
      actor: 'w_winner',
      reason: 'PREPARING_TX',
    });
    assert.equal(toBroadcast.ok, true);

    const illegalRetryFromBroadcast = await LedgerService.updatePayoutDispatchState({
      requestId: `req_neon_ds_${ts}`,
      attemptId: activeAttemptId,
      nextState: 'FAILED_SAFE_RETRYABLE',
      actor: 'w_winner',
      reason: 'SOCKET_RESET',
    });
    assert.equal(illegalRetryFromBroadcast.ok, false);
    assert.equal(
      illegalRetryFromBroadcast.error,
      'CANNOT_MARK_RETRYABLE_AFTER_BROADCAST_WITHOUT_RECONCILIATION'
    );

    // Simula crash/timeout durante trasmissione -> UNCERTAIN_TIMEOUT (race concorrente verso UNCERTAIN vs CONFIRMED/RETRY)
    const solTxHash = `neontx_sol_${ts}_5j7s6NiJS3JAkvgkoc18WVAsiSaci2px`;
    const [u1, u2] = await Promise.all([
      LedgerService.updatePayoutDispatchState({
        requestId: `req_neon_ds_${ts}`,
        attemptId: activeAttemptId,
        nextState: 'UNCERTAIN_TIMEOUT',
        actor: 'w_winner',
        txHash: solTxHash,
        reason: 'RPC_TIMEOUT_AFTER_SEND',
      }),
      LedgerService.updatePayoutDispatchState({
        requestId: `req_neon_ds_${ts}`,
        attemptId: activeAttemptId,
        nextState: 'FAILED_SAFE_RETRYABLE',
        actor: 'w_racing',
        reason: 'TIMEOUT_RETRY_ATTEMPT',
      }),
    ]);
    assert.equal(u1.ok, true);
    assert.equal(u1.dispatch_state, 'UNCERTAIN_TIMEOUT');
    assert.equal(u2.ok, false);

    // Divieto reinvio (nuovo claim) quando dispatch_state = UNCERTAIN_TIMEOUT
    const resendAfterTimeout = await LedgerService.claimPayoutForDispatch({
      requestId: `req_neon_ds_${ts}`,
      workerId: 'w_retry',
    });
    assert.equal(resendAfterTimeout.ok, false);
    assert.equal(resendAfterTimeout.error, 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME');

    // get_uncertain_payout_dispatches trova il payout incerto
    const uncertainList = await LedgerService.getUncertainPayoutDispatches(50, 15);
    assert.equal(uncertainList.ok, true);
    assert.ok(uncertainList.items.some((item) => item.request_id === `req_neon_ds_${ts}`));

    // F. Riconciliazione + prova on-chain + completamento concorrente (zero doppio pagamento)
    const toConfirmed = await LedgerService.updatePayoutDispatchState({
      requestId: `req_neon_ds_${ts}`,
      attemptId: activeAttemptId,
      nextState: 'CONFIRMED_ONCHAIN',
      actor: 'reconciler_staging',
      txHash: solTxHash,
      reason: 'RECONCILED_ONCHAIN_STAGING',
    });
    assert.equal(toConfirmed.ok, true);

    const proofSaveSol = await LedgerService.recordPayoutOnchainVerification({
      requestId: `req_neon_ds_${ts}`,
      asset: 'SOL',
      network: 'SOLANA_MAINNET',
      txHash: solTxHash,
      destinationAddress: solWallet,
      expectedAmountAsset: Number(highPayoutReq.payout.asset_amount || 0.33333333),
      observedAmountAsset: Number(highPayoutReq.payout.asset_amount || 0.33333333),
      confirmations: 32,
      commitmentLevel: 'finalized',
      verified: true,
      verifiedBy: 'reconciler_staging',
    });
    assert.equal(proofSaveSol.ok, true);

    const vaultBeforeSol = await dbPool.query(
      `SELECT disbursed_points FROM core.treasury_vault WHERE asset = 'SOL'`
    );
    const disbursedBeforeSol = Number(vaultBeforeSol.rows[0].disbursed_points);

    const [comp1, comp2] = await Promise.all([
      LedgerService.completePayout(`req_neon_ds_${ts}`, solTxHash, 'Complete 1'),
      LedgerService.completePayout(`req_neon_ds_${ts}`, solTxHash, 'Complete 2'),
    ]);
    assert.equal(comp1.ok, true);
    assert.equal(comp2.ok, true);
    const nonIdempotentCount = [comp1, comp2].filter((c) => !c.idempotent).length;
    assert.equal(nonIdempotentCount, 1, 'Strictly one complete_payout_atomic execution may apply accounting');

    const vaultAfterSol = await dbPool.query(
      `SELECT disbursed_points FROM core.treasury_vault WHERE asset = 'SOL'`
    );
    assert.equal(
      Number(vaultAfterSol.rows[0].disbursed_points) - disbursedBeforeSol,
      5000,
      'SOL vault disbursed_points must increment strictly ONCE (5000 PT)'
    );

    // Tentativo completamento con txHash differente deve andare in conflitto
    const compConflict = await LedgerService.completePayout(
      `req_neon_ds_${ts}`,
      `neontx_sol_${ts}_DIFFERENT_HASH`
    );
    assert.equal(compConflict.ok, false);
    assert.equal(compConflict.error, 'PAYOUT_TX_HASH_CONFLICT');

    // G. Immutabilita' log audit (trigger append-only)
    let auditMutateBlocked = false;
    try {
      await dbPool.query(
        `UPDATE core.payout_dispatch_audit SET reason = 'TAMPERED' WHERE request_id = $1`,
        [`req_neon_ds_${ts}`]
      );
    } catch (err: any) {
      if (String(err?.message || '').includes('SECURITY_AUDIT_LOGS_APPEND_ONLY')) {
        auditMutateBlocked = true;
      }
    }
    assert.equal(auditMutateBlocked, true, 'payout_dispatch_audit must reject UPDATE via trigger');

    // 9. Rejection & rimborso automatico RESERVED -> WITHDRAWABLE su richiesta UNCLAIMED
    const wd3 = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_user_id: TEST_UID,
        points: 500,
        wallet_address: 'CASH-PAYEER:P12345678',
        crypto_asset: 'CASH_PAYEER',
        idempotencyKey: `idem_neon_rej_${ts}`,
      }),
    });
    assert.equal(wd3.status, 200);
    const wd3Body = await wd3.json();

    const rejectRes = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'neon_live_test_admin_primary_12345',
        'X-Admin-Id': TEST_ADMIN_1,
      },
      body: JSON.stringify({
        requestId: wd3Body.requestId,
        status: 'REJECTED',
        note: 'Test rimborso automatico',
      }),
    });
    assert.equal(rejectRes.status, 200);

    const balRes = await (
      await fetch(`${baseUrl}/api/ledger/balance?telegramUserId=${TEST_UID}`)
    ).json();
    // 6900 iniziali - 500 Payeer - 5000 SOL = 1400 withdrawable, 0 reserved
    assert.equal(balRes.balances.withdrawable_points, 1400);
    assert.equal(balRes.balances.reserved_points, 0);

    // 10. Audit integrita' partita doppia a somma zero e zero saldi negativi
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
      '[verify-neon-live] OK — Migrazioni 001-020, idempotenza, 70/30, conversioni tesoreria, doppia approvazione, kill switch, claim simultanei 020, indice univoco, divieto reinvio su UNCERTAIN_TIMEOUT, riconciliazione, audit append-only e somma zero verificati su PostgreSQL staging!'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await LedgerService.setKillSwitchStatus(
      prevKillSwitch.is_enabled,
      prevKillSwitch.reason || 'RESTORED_AFTER_STAGING_TEST',
      prevKillSwitch.updated_by || 'staging_test_restore'
    ).catch(() => {});
    await cleanupTestArtifacts();

    if (prevEnv.ADMIN_API_TOKEN === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevEnv.ADMIN_API_TOKEN;
    if (prevEnv.ADMIN_SECONDARY_API_TOKEN === undefined) delete process.env.ADMIN_SECONDARY_API_TOKEN;
    else process.env.ADMIN_SECONDARY_API_TOKEN = prevEnv.ADMIN_SECONDARY_API_TOKEN;
    if (prevEnv.WEBHOOK_SECRET === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = prevEnv.WEBHOOK_SECRET;
    if (prevEnv.WEBHOOK_REQUIRE_HMAC === undefined) delete process.env.WEBHOOK_REQUIRE_HMAC;
    else process.env.WEBHOOK_REQUIRE_HMAC = prevEnv.WEBHOOK_REQUIRE_HMAC;
    if (prevEnv.TELEGRAM_BOT_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevEnv.TELEGRAM_BOT_TOKEN;
    if (prevEnv.CASH_GATEWAY_VERIFY_URL === undefined) delete process.env.CASH_GATEWAY_VERIFY_URL;
    else process.env.CASH_GATEWAY_VERIFY_URL = prevEnv.CASH_GATEWAY_VERIFY_URL;
    if (prevEnv.CASH_GATEWAY_API_KEY === undefined) delete process.env.CASH_GATEWAY_API_KEY;
    else process.env.CASH_GATEWAY_API_KEY = prevEnv.CASH_GATEWAY_API_KEY;

    await dbPool.end();
  }
}

main().catch((err) => {
  console.error('[verify-neon-live] FAILED:', err);
  process.exit(1);
});
