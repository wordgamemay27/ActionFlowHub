import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExpressApp } from '../src/server';
import { dbPool } from '../src/db/ledgerService';
import { workers } from '../src/workers';

function signTelegramInitData(
  userId: number,
  botToken: string,
  authDateSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const params = new URLSearchParams();
  params.set(
    'user',
    JSON.stringify({
      id: userId,
      first_name: 'Audit',
      username: `audit_${userId}`,
      language_code: 'it',
    })
  );
  params.set('auth_date', String(authDateSeconds));
  params.set('query_id', `AAH_${userId}_${authDateSeconds}`);

  const sortedKeys = Array.from(params.keys()).sort();
  const dataCheckString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function runHttpSecurityChecks() {
  const prevAdminToken = process.env.ADMIN_API_TOKEN;
  const prevWebhookSecret = process.env.WEBHOOK_SECRET;
  const prevBotToken = process.env.TELEGRAM_BOT_TOKEN;

  const testBotToken = '123456:test_bot_token_for_hmac_verification';
  process.env.ADMIN_API_TOKEN = 'test_admin_secret_987654321';
  process.env.WEBHOOK_SECRET = 'test_webhook_secret_123456';
  process.env.TELEGRAM_BOT_TOKEN = testBotToken;

  const hasDb = Boolean(dbPool);
  const strikeUid = 900000000 + Math.floor(Math.random() * 9000000);
  const cleanUid = strikeUid + 1;

  const validInitData = signTelegramInitData(cleanUid, testBotToken);
  const validStrikeInitData = signTelegramInitData(strikeUid, testBotToken);
  const expiredInitData = signTelegramInitData(
    cleanUid,
    testBotToken,
    Math.floor(Date.now() / 1000) - 360
  );

  const app = createExpressApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health endpoint
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'OK');
    assert.equal(health.dbConnected, hasDb);
    assert.equal(health.sessionMode, 'UNIFIED_AUTO');

    // 1b. FX rates endpoint returns structured rates map (200 live or 503 fail-closed offline)
    const fxRes = await fetch(`${baseUrl}/api/fx/rates`);
    const fxBody = await fxRes.json();
    assert.ok(fxRes.status === 200 || fxRes.status === 503);
    assert.ok(fxBody && typeof fxBody.rates === 'object' && fxBody.rates !== null);
    for (const sym of ['TON', 'SOL', 'PI', 'USDT', 'USDC']) {
      assert.ok(sym in fxBody.rates, `/api/fx/rates must expose rates.${sym}`);
    }

    // 2. Telegram HMAC authentication enforced (missing or expired -> 401)
    const protectedEndpoints: Array<{ url: string; method: 'GET' | 'POST'; body?: unknown }> = [
      { url: `${baseUrl}/api/ledger/balance`, method: 'GET' },
      { url: `${baseUrl}/api/user/strikes`, method: 'GET' },
      {
        url: `${baseUrl}/api/auto-session/start`,
        method: 'POST',
        body: { categories: ['VIDEO', 'MUSIC'] },
      },
      { url: `${baseUrl}/api/auto-session/status`, method: 'GET' },
      {
        url: `${baseUrl}/api/interactions/register`,
        method: 'POST',
        body: { providerId: 'reelshort', taskId: 'task_1' },
      },
      {
        url: `${baseUrl}/api/affiliate/click`,
        method: 'POST',
        body: { partnerId: 'reelshort', taskId: 'task_1' },
      },
      {
        url: `${baseUrl}/api/payout/request`,
        method: 'POST',
        body: {
          points: 500,
          wallet_address: 'CASH-PAYEER:P12345678',
          crypto_asset: 'CASH_PAYEER',
          idempotencyKey: 'idem_no_auth',
        },
      },
    ];

    for (const ep of protectedEndpoints) {
      const noAuth = await fetch(ep.url, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(noAuth.status, 401, `${ep.url} must reject missing Telegram initData`);

      const expiredAuth = await fetch(ep.url, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': expiredInitData,
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(expiredAuth.status, 401, `${ep.url} must reject expired Telegram initData`);
    }

    // 3. Legacy timed session & client-side reward endpoints permanently disabled (410 GONE)
    for (const legacy of [
      { url: `${baseUrl}/api/session/start`, method: 'POST' },
      { url: `${baseUrl}/api/session/status`, method: 'GET' },
      { url: `${baseUrl}/api/session/complete`, method: 'POST' },
      { url: `${baseUrl}/api/rewards/record`, method: 'POST' },
      { url: `${baseUrl}/api/postback/s2s`, method: 'POST' },
    ] as const) {
      const res = await fetch(legacy.url, {
        method: legacy.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': validInitData,
        },
        body: legacy.method === 'POST' ? JSON.stringify({ points: 999 }) : undefined,
      });
      assert.equal(res.status, 410, `${legacy.url} must return 410 GONE`);
    }

    // 4. Valid HMAC balance & session calls fail closed (503) without PostgreSQL
    const balRes = await fetch(`${baseUrl}/api/ledger/balance`, {
      headers: { 'X-Telegram-Init-Data': validInitData },
    });
    const balBody = await balRes.json();
    assert.equal(balRes.status, hasDb ? 200 : 503);
    if (hasDb) {
      assert.equal(balBody.dbConnected, true);
      assert.equal(balBody.balances.withdrawable_points, 0);
    } else {
      assert.equal(balBody.dbConnected, false);
    }

    const startRes = await fetch(`${baseUrl}/api/auto-session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validInitData,
      },
      body: JSON.stringify({ categories: ['VIDEO', 'ADS'] }),
    });
    assert.equal(startRes.status, hasDb ? 200 : 503);

    // 5. Payout request validation & PostgreSQL requirement
    const belowMin = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validStrikeInitData,
      },
      body: JSON.stringify({
        points: 499,
        wallet_address: 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
        crypto_asset: 'TON',
        idempotencyKey: 'idem_1234',
      }),
    });
    assert.equal(belowMin.status, hasDb ? 400 : 503);

    const validReq = await fetch(`${baseUrl}/api/payout/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validInitData,
      },
      body: JSON.stringify({
        points: 500,
        wallet_address: 'CASH-PAYEER:P12345678',
        crypto_asset: 'CASH_PAYEER',
        idempotencyKey: 'idem_payeer_500',
      }),
    });
    const validReqBody = await validReq.json();
    assert.equal(validReqBody.ok, false);
    assert.equal(validReq.status, hasDb ? 409 : 503);

    // 6. Admin routes strictly reject spoofed user IDs / missing tokens
    const listNoAuth = await fetch(`${baseUrl}/api/payout/list`);
    assert.equal(listNoAuth.status, 401);

    const listWithAuth = await fetch(`${baseUrl}/api/payout/list`, {
      headers: { 'X-Admin-Token': 'test_admin_secret_987654321' },
    });
    assert.equal(listWithAuth.status, hasDb ? 200 : 503);

    const integrityNoAuth = await fetch(`${baseUrl}/api/audit/ledger-integrity`);
    assert.equal(integrityNoAuth.status, 401);

    const integrityWithAuth = await fetch(`${baseUrl}/api/audit/ledger-integrity`, {
      headers: { 'X-Admin-Token': 'test_admin_secret_987654321' },
    });
    assert.equal(integrityWithAuth.status, hasDb ? 200 : 503);

    const auditNoAuth = await fetch(`${baseUrl}/api/audit/guardian`);
    assert.equal(auditNoAuth.status, 401);
    const auditWithAuth = await fetch(`${baseUrl}/api/audit/guardian`, {
      headers: { 'X-Admin-Token': 'test_admin_secret_987654321' },
    });
    assert.equal(auditWithAuth.status, 200);

    const spoofAdmin = await fetch(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramUserId: 999999 }),
    });
    assert.equal(spoofAdmin.status, 401);
    const validAdmin = await fetch(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test_admin_secret_987654321',
      },
      body: JSON.stringify({}),
    });
    assert.equal(validAdmin.status, 200);
    assert.equal((await validAdmin.json()).isAdmin, true);

    const disburseNoAuth = await fetch(`${baseUrl}/api/payout/disburse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req_1', status: 'COMPLETED', txHash: 'real_hash_123456' }),
    });
    assert.equal(disburseNoAuth.status, 401);

    // 7. Webhook postback requires secret & rejects invalid params / missing DB cleanly
    const webhookNoSecret = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=1&payout=1&click_id=clk_1&txId=tx_1`
    );
    assert.equal(webhookNoSecret.status, 401);

    const webhookWithSecret = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=0&payout=0&txId=x`,
      { headers: { 'X-Webhook-Secret': 'test_webhook_secret_123456' } }
    );
    assert.equal(webhookWithSecret.status, hasDb ? 400 : 503);

    // 8. TON Worker fail-closed check (never fabricates txHash without Postgres & real mnemonic)
    const dispatchFailClosed = await workers.tonPayout.executeRealTonPayout({
      requestId: 'req_test_fail_closed',
      destinationWallet: 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
      amountTon: 1.0,
    });
    assert.equal(dispatchFailClosed.ok, false);
    assert.equal(dispatchFailClosed.txHash, undefined);
    assert.ok(
      dispatchFailClosed.error === 'POSTGRES_REQUIRED_FOR_TON_PAYOUT' ||
        dispatchFailClosed.error === 'TON_PAYOUT_WALLET_NOT_CONFIGURED'
    );

    const batchDispatch = await workers.tonPayout.processApprovedTonPayouts();
    assert.equal(batchDispatch.ok, false);
    assert.ok(
      batchDispatch.error === 'POSTGRES_REQUIRED' ||
        batchDispatch.error === 'TON_PAYOUT_WALLET_NOT_CONFIGURED'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevAdminToken;
    if (prevWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = prevWebhookSecret;
    if (prevBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevBotToken;
  }
}

function runStaticHardeningChecks() {
  const root = process.cwd();

  const m002 = fs.readFileSync(path.join(root, 'migrations/002_daily_reset_timezone.sql'), 'utf8');
  assert.equal(/RETURN\s+[^;]+\.\s*$/m.test(m002), false, '002 should have zero trailing periods in SQL');
  assert.equal(/\bEND IF\s*$/m.test(m002), false, '002 END IF statements must terminate with semicolon');

  const m008 = fs.readFileSync(path.join(root, 'migrations/008_hardening_ledger_and_payouts.sql'), 'utf8');
  for (const symbol of [
    'core.schema_migrations',
    'core.payout_requests',
    'balance_non_negative_users',
    'pg_advisory_xact_lock',
    'points >= 500',
  ]) {
    assert.ok(m008.includes(symbol), `008 missing required construct: ${symbol}`);
  }

  const m009 = fs.readFileSync(
    path.join(root, 'migrations/009_unified_auto_session_and_interactions.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.auto_sessions',
    'core.session_interactions',
    'core.fx_price_snapshots',
    'core.start_auto_session',
    'core.register_session_interaction',
    'TIME_BASED_BLOCK_REWARDS_DISABLED',
  ]) {
    assert.ok(m009.includes(symbol), `009 missing required construct: ${symbol}`);
  }

  const m010 = fs.readFileSync(
    path.join(root, 'migrations/010_reconciliation_settlement_and_payout_hardening.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.settlement_batches',
    'core.webhook_replay_guard',
    'core.record_verified_interaction_postback',
    'core.execute_batch_settlement',
    'core.release_settled_to_withdrawable_for_user',
    'core.audit_ledger_integrity',
    'core.v_treasury_solvency',
  ]) {
    assert.ok(m010.includes(symbol), `010 missing required construct: ${symbol}`);
  }

  // Zero deprecated client crediting / persistentStorage / /10 bug / fixed 0.002 TON rate in src/
  const srcFiles = collectSourceFiles(path.join(root, 'src'));
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    assert.equal(content.includes('persistentStorage'), false, `${rel} must not reference persistentStorage`);
    assert.equal(content.includes('handleEarnFlowPoints'), false, `${rel} must not define/call handleEarnFlowPoints`);
    assert.equal(content.includes('recordRealReward'), false, `${rel} must not define/call recordRealReward`);
    assert.equal(/Math\.round\([^)]*\/\s*10\)/.test(content), false, `${rel} must not contain /10 conversion bug`);
    assert.equal(content.includes('0.002'), false, `${rel} must not contain fixed 0.002 TON rate`);
    assert.equal(content.includes('sim_ton_tx_'), false, `${rel} must not contain simulated TON tx hashes`);
    assert.equal(content.includes('tx_onchain_'), false, `${rel} must not contain fake tx_onchain hashes`);
  }

  const listener = fs.readFileSync(path.join(root, 'src/workers/blockchainListener.ts'), 'utf8');
  assert.equal(/usdValue\s*=\s*10\b/.test(listener), false, 'blockchainListener must not hardcode $10 SOL credit');
  assert.ok(listener.includes('getSolUsdRate'), 'blockchainListener must convert SOL with dynamic USD rate');
  assert.ok(listener.includes('getTonUsdRate'), 'blockchainListener must convert TON with dynamic USD rate');
  assert.ok(listener.includes('getPiUsdRate'), 'blockchainListener must convert PI with dynamic USD rate');
  assert.ok(
    listener.indexOf('executeBatchSettlement') < listener.lastIndexOf('markTxProcessed'),
    'blockchainListener must run settlement before final tx hash marking'
  );

  const tonWorker = fs.readFileSync(path.join(root, 'src/workers/tonPayoutWorker.ts'), 'utf8');
  assert.ok(
    tonWorker.includes("IN ('CRYPTO_DIRECT', 'TON')"),
    'tonPayoutWorker must match payout_channel CRYPTO_DIRECT for approved TON payouts'
  );

  const serverSrc = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
  assert.ok(serverSrc.includes("'WEBHOOK_NONCE_REPLAYED'"), 'server must map WEBHOOK_NONCE_REPLAYED');
  assert.ok(serverSrc.includes("'INTERACTION_NOT_FOUND'"), 'server must map INTERACTION_NOT_FOUND to 404');
  assert.ok(serverSrc.includes('/^G[A-Z2-7]{55}$/'), 'server must validate Stellar/Pi G... 56-char addresses');

  const repSrc = fs.readFileSync(path.join(root, 'src/services/providerReputation.ts'), 'utf8');
  assert.ok(
    repSrc.includes('core.sync_provider_exposure_status'),
    'providerReputation must sync core.partner_exposure status'
  );

  assert.equal(
    fs.existsSync(path.join(root, 'src/components/RobotMascot.tsx')),
    false,
    'Deprecated RobotMascot.tsx must remain deleted'
  );
  assert.equal(
    fs.existsSync(path.join(root, 'src/components/ui')),
    false,
    'Unused src/components/ui wrapper directory must remain deleted'
  );

  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.ok(rules.includes('allow create, update, delete: if false;'), 'Firestore transactions must reject client writes');
  assert.ok(rules.includes('incoming().points == 0'), 'Firestore user creation must start at 0 points');
  assert.ok(rules.includes('incoming().points == existing().points'), 'Firestore user update must keep points immutable');

  const fsSync = fs.readFileSync(path.join(root, 'src/services/firestoreSync.ts'), 'utf8');
  assert.equal(/points:\s*profile\.points/.test(fsSync), false, 'firestoreSync must not write financial points');

  const ledgerSrc = fs.readFileSync(path.join(root, 'src/db/ledgerService.ts'), 'utf8');
  assert.equal(
    /,\s*paid_at\b/.test(ledgerSrc),
    false,
    'ledgerService must alias completed_at AS paid_at instead of querying non-existent paid_at column'
  );
  assert.ok(
    ledgerSrc.includes('completed_at AS paid_at'),
    'ledgerService must expose completed_at AS paid_at'
  );

  const cycleSrc = fs.readFileSync(path.join(root, 'src/components/AutoInteractiveCycleEngine.tsx'), 'utf8');
  assert.equal(cycleSrc.includes("providerId: 'cpx'"), false, 'AutoInteractiveCycleEngine must not embed banned cpx providerId');
  assert.equal(cycleSrc.includes('prolific.com'), false, 'AutoInteractiveCycleEngine must not embed locked prolific.com URL');

  const airdropViewSrc = fs.readFileSync(path.join(root, 'src/views/AirdropHubView.tsx'), 'utf8');
  assert.ok(airdropViewSrc.includes('isProviderAllowedByBlacklist'), 'AirdropHubView must enforce blacklist filtering');
  assert.ok(airdropViewSrc.includes('excludeIncompatibleGeo: true'), 'AirdropHubView must filter incompatible GEO providers');
}

async function main() {
  try {
    await runHttpSecurityChecks();
    runStaticHardeningChecks();
    console.log(
      '[verify-hardening] OK — Auth Telegram HMAC, disabilitazione 410 endpoint legacy, zero fallback/simulazioni, FX fail-closed e vincoli SQL 009/010 verificati.'
    );
  } finally {
    if (dbPool) {
      await dbPool.end();
    }
  }
}

main().catch((err) => {
  console.error('[verify-hardening] FAILED:', err);
  process.exit(1);
});
