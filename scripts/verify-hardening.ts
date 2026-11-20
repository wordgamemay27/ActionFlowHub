import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExpressApp } from '../src/server';
import { LedgerService, dbPool, type PayoutDispatchStore } from '../src/db/ledgerService';
import { workers, tonPayoutWorker, multiAssetPayoutWorker } from '../src/workers';
import {
  verifyPayoutTransactionOnChain,
  canVerifyPayoutAssetIndependently,
  shouldEnforceLiveRpcVerification,
} from '../src/services/onchainVerifier';
import { newClickId, newInteractionId, resolveCanonicalProviderId } from '../src/lib/affiliate';
import {
  buildCanonicalWebhookPayload,
  PerProviderRateLimiter,
  validatePartnerTrackingUrl,
  verifyWebhookRawBodyHmac,
  checkLegacyWebhookTransition,
} from '../src/lib/inboundSecurity';
import { isSafeExternalHttpsUrl } from '../src/utils/navigation';
import { buildPrioritizedAutoCycleSteps, type CycleStepCandidate } from '../src/lib/providerPriority';

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
  const prevSecondaryAdminToken = process.env.ADMIN_SECONDARY_API_TOKEN;
  const prevOperatorTokens = process.env.ADMIN_OPERATOR_TOKENS;
  const prevWebhookSecret = process.env.WEBHOOK_SECRET;
  const prevBotToken = process.env.TELEGRAM_BOT_TOKEN;

  const testBotToken = '123456:test_bot_token_for_hmac_verification';
  process.env.ADMIN_API_TOKEN = 'test_admin_secret_987654321';
  process.env.ADMIN_SECONDARY_API_TOKEN = 'test_admin_secondary_secret_12345';
  process.env.ADMIN_OPERATOR_TOKENS = JSON.stringify({ auditor_op: 'test_auditor_secret_67890' });
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
    const validAdminBody = await validAdmin.json();
    assert.equal(validAdminBody.isAdmin, true);
    assert.equal(validAdminBody.actor, 'admin_primary');

    // Spoofing X-Admin-Id header with mismatched token must be rejected (403 ADMIN_ACTOR_MISMATCH)
    const spoofActorHeader = await fetch(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test_admin_secret_987654321',
        'X-Admin-Id': 'admin_2',
      },
      body: JSON.stringify({}),
    });
    assert.equal(spoofActorHeader.status, 403);
    assert.equal((await spoofActorHeader.json()).error, 'ADMIN_ACTOR_MISMATCH');

    // Distinct secondary / mapped operator tokens bind to distinct actors
    const secondaryAdmin = await fetch(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test_admin_secondary_secret_12345',
      },
      body: JSON.stringify({}),
    });
    assert.equal(secondaryAdmin.status, 200);
    assert.equal((await secondaryAdmin.json()).actor, 'admin_secondary');

    const mappedOperator = await fetch(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test_auditor_secret_67890',
        'X-Admin-Id': 'auditor_op',
      },
      body: JSON.stringify({}),
    });
    assert.equal(mappedOperator.status, 200);
    assert.equal((await mappedOperator.json()).actor, 'auditor_op');

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

    // 8. Admin Kill Switch, Treasury Status, Convert & Reverse endpoints require auth & DB fail-closed
    for (const ep of [
      { url: `${baseUrl}/api/admin/kill-switch`, method: 'GET' as const },
      { url: `${baseUrl}/api/admin/kill-switch`, method: 'POST' as const, body: { enabled: true } },
      { url: `${baseUrl}/api/admin/treasury-status`, method: 'GET' as const },
      {
        url: `${baseUrl}/api/admin/treasury-convert`,
        method: 'POST' as const,
        body: {
          fromAsset: 'USDT',
          toAsset: 'TON',
          amountUsd: 10,
          externalTxRef: 'swap_tx_0123456789abcdef',
        },
      },
      {
        url: `${baseUrl}/api/admin/payout/reverse`,
        method: 'POST' as const,
        body: { requestId: 'req_1', reason: 'DISPUTE' },
      },
    ]) {
      const noAuth = await fetch(ep.url, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(noAuth.status, 401, `${ep.url} must reject unauthenticated admin request`);

      const withAuth = await fetch(ep.url, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': 'test_admin_secret_987654321',
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(withAuth.status, hasDb ? 200 : 503, `${ep.url} fail-closed DB check`);
    }

    // 9. MANUAL_EXTERNAL enforcement & worker fail-closed check (zero server custody / zero fake txHash)
    const tonWorkerStatus = workers.tonPayout.getStatus();
    assert.equal(tonWorkerStatus.payoutExecutionMode, 'MANUAL_EXTERNAL');
    assert.equal(tonWorkerStatus.serverKeyCustodyDisabled, true);

    const dispatchFailClosed = await workers.tonPayout.executeRealTonPayout({
      requestId: 'req_test_fail_closed',
      destinationWallet: 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
      amountTon: 1.0,
    });
    assert.equal(dispatchFailClosed.ok, false);
    assert.equal(dispatchFailClosed.txHash, undefined);
    assert.ok(
      dispatchFailClosed.error === 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING' ||
        dispatchFailClosed.error === 'POSTGRES_REQUIRED_FOR_TON_PAYOUT' ||
        dispatchFailClosed.error === 'TON_PAYOUT_WALLET_NOT_CONFIGURED'
    );

    const batchDispatch = await workers.tonPayout.processApprovedTonPayouts();
    assert.equal(batchDispatch.ok, false);
    assert.ok(
      batchDispatch.error === 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING' ||
        batchDispatch.error === 'POSTGRES_REQUIRED' ||
        batchDispatch.error === 'TON_PAYOUT_WALLET_NOT_CONFIGURED'
    );

    // 10. On-chain verifier rejects synthetic/short/fake hashes AND defaults to fail-closed RPC check
    assert.equal(shouldEnforceLiveRpcVerification(), true, 'Live RPC verification must default to fail-closed');

    for (const fakeHash of ['abc', 'sim_ton_tx_123456', 'fake_hash_999999', 'mock_payout_12345', 'test_receipt_99']) {
      const vr = await verifyPayoutTransactionOnChain({
        asset: 'TON',
        txHash: fakeHash,
        destinationAddress: 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
        expectedAmountAsset: 1.0,
        expectedAmountUsd: 5.0,
      });
      assert.equal(vr.verified, false, `verifyPayoutTransactionOnChain must reject fake hash ${fakeHash}`);
    }

    // USDT/USDC without real RPC verification must never blindly pass on length alone
    const unverifiedUsdtTon = await verifyPayoutTransactionOnChain({
      asset: 'USDT',
      txHash: 'a'.repeat(64),
      destinationAddress: 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
      expectedAmountAsset: 10,
      expectedAmountUsd: 10,
    });
    assert.equal(unverifiedUsdtTon.verified, false, 'USDT on TON must not blindly pass without on-chain verification');

    const unverifiedUsdcSol = await verifyPayoutTransactionOnChain({
      asset: 'USDC',
      txHash: '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7',
      destinationAddress: '11111111111111111111111111111111',
      expectedAmountAsset: 10,
      expectedAmountUsd: 10,
    });
    assert.equal(unverifiedUsdcSol.verified, false, 'USDC on Solana must not blindly pass without SPL verification');

    const badPiFormat = await verifyPayoutTransactionOnChain({
      asset: 'PI',
      txHash: 'short_pi_ref',
      destinationAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      expectedAmountAsset: 5,
      expectedAmountUsd: 5,
    });
    assert.equal(badPiFormat.verified, false, 'PI must reject non-64-hex transaction hashes');

    // Unconfigured independent verifiers must fail-closed (CASH_*, gateway USDT/USDC, TON USDC without master)
    const prevCashVerifyUrl = process.env.CASH_GATEWAY_VERIFY_URL;
    const prevCryptoVerifyUrl = process.env.CRYPTO_GATEWAY_VERIFY_URL;
    delete process.env.CASH_GATEWAY_VERIFY_URL;
    delete process.env.CRYPTO_GATEWAY_VERIFY_URL;
    try {
      const cashGuardUnconfigured = canVerifyPayoutAssetIndependently('CASH_PAYEER', 'CASH-PAYEER:P12345678');
      assert.equal(cashGuardUnconfigured.verifiable, false);
      assert.equal(cashGuardUnconfigured.reason, 'CASH_GATEWAY_VERIFIER_NOT_CONFIGURED');

      const validCashReceiptNoVerifier = await verifyPayoutTransactionOnChain({
        asset: 'CASH_PAYEER',
        txHash: 'payeer_rcpt_99887766',
        destinationAddress: 'CASH-PAYEER:P12345678',
        expectedAmountAsset: 10,
        expectedAmountUsd: 10,
      });
      assert.equal(
        validCashReceiptNoVerifier.verified,
        false,
        'CASH_PAYEER must fail-closed when CASH_GATEWAY_VERIFY_URL is missing'
      );
      assert.equal(validCashReceiptNoVerifier.reason, 'CASH_GATEWAY_VERIFIER_NOT_CONFIGURED');

      const genericUsdtGuard = canVerifyPayoutAssetIndependently('USDT', '0x1234567890abcdef1234567890abcdef12345678');
      assert.equal(genericUsdtGuard.verifiable, false);
      assert.equal(genericUsdtGuard.reason, 'CRYPTO_GATEWAY_VERIFIER_NOT_CONFIGURED');

      const usdtUnverified = await verifyPayoutTransactionOnChain({
        asset: 'USDT',
        txHash: 'f'.repeat(64),
        destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
        expectedAmountAsset: 10,
        expectedAmountUsd: 10,
      });
      assert.equal(usdtUnverified.verified, false);
      assert.equal(usdtUnverified.reason, 'CRYPTO_GATEWAY_VERIFIER_NOT_CONFIGURED');

      const badPiDest = canVerifyPayoutAssetIndependently('PI', 'NOT_A_VALID_PI_ADDRESS');
      assert.equal(badPiDest.verifiable, false);
      assert.equal(badPiDest.reason, 'INVALID_PI_DESTINATION_ADDRESS');
    } finally {
      if (prevCashVerifyUrl === undefined) delete process.env.CASH_GATEWAY_VERIFY_URL;
      else process.env.CASH_GATEWAY_VERIFY_URL = prevCashVerifyUrl;
      if (prevCryptoVerifyUrl === undefined) delete process.env.CRYPTO_GATEWAY_VERIFY_URL;
      else process.env.CRYPTO_GATEWAY_VERIFY_URL = prevCryptoVerifyUrl;
    }

    // Kill Switch fail-closed when DB is unavailable
    if (!hasDb) {
      const ks = await LedgerService.getKillSwitchStatus();
      assert.equal(ks.is_enabled, true, 'Kill Switch must fail-closed (is_enabled=true) when Postgres is unavailable');
    }

    // 11. Inbound Security: Unexpected Fields, Banned Provider, Tracking URL Allowlist, XSS, HMAC Webhook
    const unexpectedIntRes = await fetch(`${baseUrl}/api/interactions/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validInitData,
      },
      body: JSON.stringify({
        providerId: 'reelshort',
        taskId: 'task_1',
        evilInjectedField: true,
      }),
    });
    assert.equal(unexpectedIntRes.status, 400);
    assert.equal((await unexpectedIntRes.json()).error, 'UNEXPECTED_FIELDS');

    const bannedCpxRes = await fetch(`${baseUrl}/api/interactions/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validInitData,
      },
      body: JSON.stringify({
        providerId: 'cpx',
        taskId: 'survey_1',
      }),
    });
    assert.equal(bannedCpxRes.status, 403);
    assert.equal((await bannedCpxRes.json()).error, 'PROVIDER_BANNED_BY_POLICY');

    const badUrlRes = await fetch(`${baseUrl}/api/interactions/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': validInitData,
      },
      body: JSON.stringify({
        providerId: 'reelshort',
        taskId: 'task_1',
        trackingUrl: 'https://evil-phishing-domain.example/steal?click_id=clk_1',
      }),
    });
    assert.equal(badUrlRes.status, 400);
    assert.equal((await badUrlRes.json()).error, 'UNAUTHORIZED_TRACKING_URL');

    const unexpectedWebhookRes = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=1&payout=1&click_id=clk_1&txId=tx_1&hackParam=1`,
      { headers: { 'X-Webhook-Secret': 'test_webhook_secret_123456' } }
    );
    assert.equal(unexpectedWebhookRes.status, 400);
    assert.equal((await unexpectedWebhookRes.json()).error, 'UNEXPECTED_FIELDS');

    // HMAC-SHA256 Webhook verification (valid signature, expired timestamp, invalid signature, query-secret strict block)
    const nowSec = Math.floor(Date.now() / 1000);
    const canonical = buildCanonicalWebhookPayload({
      provider: 'reelshort',
      txId: 'tx_hmac_1',
      userId: '0',
      clickId: '',
      interactionId: '',
      payout: '0',
      status: 'CONFIRMED',
      nonce: '',
    });
    const validHmacSig = crypto
      .createHmac('sha256', 'test_webhook_secret_123456')
      .update(`${nowSec}.${canonical}`)
      .digest('hex');

    const validHmacRes = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=0&payout=0&txId=tx_hmac_1`,
      {
        headers: {
          'X-Webhook-Timestamp': String(nowSec),
          'X-Webhook-Signature': `sha256=${validHmacSig}`,
        },
      }
    );
    assert.equal(validHmacRes.status, hasDb ? 400 : 503, 'Valid HMAC signature must pass auth layer');

    const expiredHmacRes = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=0&payout=0&txId=tx_hmac_1`,
      {
        headers: {
          'X-Webhook-Timestamp': String(nowSec - 600),
          'X-Webhook-Signature': `sha256=${validHmacSig}`,
        },
      }
    );
    assert.equal(expiredHmacRes.status, 401);
    assert.equal((await expiredHmacRes.json()).error, 'WEBHOOK_TIMESTAMP_EXPIRED');

    const invalidHmacRes = await fetch(
      `${baseUrl}/api/webhook/postback?provider=reelshort&userId=0&payout=0&txId=tx_hmac_1`,
      {
        headers: {
          'X-Webhook-Timestamp': String(nowSec),
          'X-Webhook-Signature': `sha256=${'0'.repeat(64)}`,
        },
      }
    );
    assert.equal(invalidHmacRes.status, 401);
    assert.equal((await invalidHmacRes.json()).error, 'INVALID_WEBHOOK_SIGNATURE');

    const prevRequireHmac = process.env.WEBHOOK_REQUIRE_HMAC;
    process.env.WEBHOOK_REQUIRE_HMAC = 'true';
    try {
      const querySecretRes = await fetch(
        `${baseUrl}/api/webhook/postback?provider=reelshort&userId=1&payout=1&click_id=clk_1&txId=tx_1&secret=test_webhook_secret_123456`
      );
      assert.equal(querySecretRes.status, 401);
      assert.equal((await querySecretRes.json()).error, 'QUERY_SECRET_DISABLED');
    } finally {
      if (prevRequireHmac === undefined) delete process.env.WEBHOOK_REQUIRE_HMAC;
      else process.env.WEBHOOK_REQUIRE_HMAC = prevRequireHmac;
    }

    // 11b. Raw-body POST HMAC-SHA256 verification (exact bytes, whitespace-sensitive, zero JSON.stringify fallback)
    const rawPostJson = '{"provider":"reelshort",  "txId":"tx_raw_post_1","userId":0, "payout":0}';
    const postTs = Math.floor(Date.now() / 1000);
    const postRawSig = crypto
      .createHmac('sha256', 'test_webhook_secret_123456')
      .update(Buffer.concat([Buffer.from(`${postTs}.`, 'utf8'), Buffer.from(rawPostJson, 'utf8')]))
      .digest('hex');

    const validRawPostRes = await fetch(`${baseUrl}/api/webhook/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(postTs),
        'X-Webhook-Signature': `sha256=${postRawSig}`,
      },
      body: rawPostJson,
    });
    assert.equal(
      validRawPostRes.status,
      hasDb ? 400 : 503,
      'POST raw-body HMAC over exact bytes with custom whitespace must pass signature verification'
    );

    // If re-serialized JSON without whitespace is sent with same signature, raw bytes check MUST reject 401
    const reserializedJson = JSON.stringify(JSON.parse(rawPostJson));
    const tamperedRawPostRes = await fetch(`${baseUrl}/api/webhook/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': String(postTs),
        'X-Webhook-Signature': `sha256=${postRawSig}`,
      },
      body: reserializedJson,
    });
    assert.equal(tamperedRawPostRes.status, 401, 'Re-serialized body bytes must fail raw-body HMAC verification');
    assert.equal((await tamperedRawPostRes.json()).error, 'INVALID_WEBHOOK_SIGNATURE');

    // Legacy sunset transition enforcement
    const prevSunset = process.env.WEBHOOK_LEGACY_SECRET_SUNSET_AT;
    process.env.WEBHOOK_LEGACY_SECRET_SUNSET_AT = '2020-01-01T00:00:00Z';
    try {
      assert.equal(checkLegacyWebhookTransition().legacyExpired, true);
      const expiredLegacyRes = await fetch(
        `${baseUrl}/api/webhook/postback?provider=reelshort&userId=1&payout=1&click_id=clk_1&txId=tx_1`,
        { headers: { 'X-Webhook-Secret': 'test_webhook_secret_123456' } }
      );
      assert.equal(expiredLegacyRes.status, 401);
      assert.equal((await expiredLegacyRes.json()).error, 'LEGACY_WEBHOOK_TRANSITION_EXPIRED');
    } finally {
      if (prevSunset === undefined) delete process.env.WEBHOOK_LEGACY_SECRET_SUNSET_AT;
      else process.env.WEBHOOK_LEGACY_SECRET_SUNSET_AT = prevSunset;
    }

    // Raw-body HMAC unit check
    assert.equal(
      verifyWebhookRawBodyHmac({
        secret: 's',
        timestampRaw: String(postTs),
        signatureRaw: crypto.createHmac('sha256', 's').update(`${postTs}.${rawPostJson}`).digest('hex'),
        rawBody: Buffer.from(rawPostJson, 'utf8'),
      }).valid,
      true
    );

    // 11c. Server-side idempotency key endpoint (crypto.randomUUID)
    const idemNoAuth = await fetch(`${baseUrl}/api/payout/idempotency-key`, { method: 'POST' });
    assert.equal(idemNoAuth.status, 401);
    const [idemRes1, idemRes2] = await Promise.all([
      fetch(`${baseUrl}/api/payout/idempotency-key`, {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': validInitData },
      }),
      fetch(`${baseUrl}/api/payout/idempotency-key`, {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': validInitData },
      }),
    ]);
    assert.equal(idemRes1.status, 200);
    assert.equal(idemRes2.status, 200);
    const idemB1 = await idemRes1.json();
    const idemB2 = await idemRes2.json();
    assert.match(idemB1.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(idemB1.idempotencyKey, idemB2.idempotencyKey);

    // Admin session revocation, inbound security log, and provider rate-limit / threshold / review endpoints enforce auth + DB fail-closed
    for (const ep of [
      {
        url: `${baseUrl}/api/admin/auto-session/revoke`,
        method: 'POST' as const,
        body: { sessionId: 'autosess_test_12345', reason: 'AUDIT_REVOKE' },
      },
      {
        url: `${baseUrl}/api/admin/security/inbound-logs`,
        method: 'GET' as const,
      },
      {
        url: `${baseUrl}/api/admin/providers/thresholds/config`,
        method: 'GET' as const,
      },
      {
        url: `${baseUrl}/api/admin/providers/thresholds/config`,
        method: 'POST' as const,
        body: { warningThreshold: 3, quarantineThreshold: 5 },
      },
      {
        url: `${baseUrl}/api/admin/providers/reelshort/rate-limit`,
        method: 'POST' as const,
        body: { requestsPerMinute: 15 },
      },
      {
        url: `${baseUrl}/api/admin/providers/reelshort/review`,
        method: 'POST' as const,
        body: { status: 'ACTIVE', reason: 'AUDIT_REVIEW' },
      },
      {
        url: `${baseUrl}/api/payout/reconcile-uncertain`,
        method: 'POST' as const,
      },
    ]) {
      const noAuth = await fetch(ep.url, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(noAuth.status, 401, `${ep.url} must require admin auth`);
      const withAuth = await fetch(ep.url, {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': 'test_admin_secret_987654321',
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      if (ep.url.endsWith('/thresholds/config') && ep.method === 'GET') {
        assert.equal(withAuth.status, 200);
      } else {
        assert.equal(withAuth.status, hasDb ? 200 : 503, `${ep.url} must fail-closed when DB missing`);
      }
    }

    // Unit checks: URL/XSS guard, per-provider rate limiter, canonical banned cpx removal, and fail-closed reputation filter
    assert.equal(isSafeExternalHttpsUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalHttpsUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isSafeExternalHttpsUrl('http://www.reelshort.com/'), false);
    assert.equal(isSafeExternalHttpsUrl('https://www.reelshort.com/'), true);

    assert.equal(validatePartnerTrackingUrl('https://127.0.0.1/callback').valid, false);
    assert.equal(validatePartnerTrackingUrl('https://www.reelshort.com/?click_id=clk_1').valid, true);
    assert.notEqual(resolveCanonicalProviderId('unknown_survey', 'SURVEY'), 'cpx');

    const rl = new PerProviderRateLimiter(2, 60_000);
    assert.equal(rl.consume('reelshort', 1000).allowed, true);
    assert.equal(rl.consume('reelshort', 1001).allowed, true);
    assert.equal(rl.consume('reelshort', 1002).allowed, false);

    const mockSteps: CycleStepCandidate[] = [
      {
        id: 'step_ok',
        titles: { it: 'OK', en: 'OK', es: 'OK', fr: 'OK', de: 'OK', pt: 'OK', ru: 'OK', zh: 'OK', ja: 'OK', ko: 'OK', ar: 'OK', hi: 'OK', tr: 'OK', id: 'OK' },
        category: 'SOAP_DRAMA',
        activityCategory: 'MICRO_DRAMA',
        providerId: 'reelshort',
        providerLabel: 'ReelShort',
        targetUrl: 'https://www.reelshort.com/',
        durationSec: 45,
        geoRegion: 'GLOBAL',
      },
      {
        id: 'step_warning',
        titles: { it: 'Warn', en: 'Warn', es: 'Warn', fr: 'Warn', de: 'Warn', pt: 'Warn', ru: 'Warn', zh: 'Warn', ja: 'Warn', ko: 'Warn', ar: 'Warn', hi: 'Warn', tr: 'Warn', id: 'Warn' },
        category: 'HIGH_PAY_VIDEO',
        activityCategory: 'VIDEO',
        providerId: 'dramabox',
        providerLabel: 'DramaBox',
        targetUrl: 'https://www.dramabox.com/',
        durationSec: 45,
        geoRegion: 'GLOBAL',
      },
      {
        id: 'step_quarantine',
        titles: { it: 'Q', en: 'Q', es: 'Q', fr: 'Q', de: 'Q', pt: 'Q', ru: 'Q', zh: 'Q', ja: 'Q', ko: 'Q', ar: 'Q', hi: 'Q', tr: 'Q', id: 'Q' },
        category: 'TIKTOK_VIRAL',
        activityCategory: 'ADS',
        providerId: 'shorttv',
        providerLabel: 'ShortTV',
        targetUrl: 'https://www.shorttv.live/',
        durationSec: 45,
        geoRegion: 'GLOBAL',
      },
      {
        id: 'step_unscored',
        titles: { it: 'U', en: 'U', es: 'U', fr: 'U', de: 'U', pt: 'U', ru: 'U', zh: 'U', ja: 'U', ko: 'U', ar: 'U', hi: 'U', tr: 'U', id: 'U' },
        category: 'MUSIC_HIT',
        activityCategory: 'MUSIC',
        providerId: 'fountain',
        providerLabel: 'Fountain',
        targetUrl: 'https://www.fountain.fm/',
        durationSec: 45,
        geoRegion: 'GLOBAL',
      },
    ];
    const strictPlaylist = buildPrioritizedAutoCycleSteps(
      mockSteps,
      ['videos', 'games', 'interactions'],
      'IT',
      {
        reelshort: { provider_id: 'reelshort', status: 'ACTIVE', reputation_score: 100 },
        dramabox: { provider_id: 'dramabox', status: 'WARNING', reputation_score: 70 },
        shorttv: { provider_id: 'shorttv', status: 'QUARANTINE', reputation_score: 30 },
      },
      { requireRegisteredReputation: true }
    );
    assert.deepEqual(
      strictPlaylist.map((s) => s.providerId),
      ['reelshort', 'dramabox'],
      'Fail-closed reputation filter must allow ACTIVE & WARNING while excluding QUARANTINE & UNSCORED'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevAdminToken;
    if (prevSecondaryAdminToken === undefined) delete process.env.ADMIN_SECONDARY_API_TOKEN;
    else process.env.ADMIN_SECONDARY_API_TOKEN = prevSecondaryAdminToken;
    if (prevOperatorTokens === undefined) delete process.env.ADMIN_OPERATOR_TOKENS;
    else process.env.ADMIN_OPERATOR_TOKENS = prevOperatorTokens;
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

  // Migrazione 011: colonne provider_reputation necessarie a v_prioritized_providers (011/012)
  const m011 = fs.readFileSync(
    path.join(root, 'migrations/011_geo_country_lock_and_provider_ranking.sql'),
    'utf8'
  );
  assert.ok(
    m011.includes('strikes_count INTEGER NOT NULL DEFAULT 0') &&
      m011.includes('total_confirmed_events INTEGER NOT NULL DEFAULT 0'),
    '011 must ensure strikes_count and total_confirmed_events exist on core.provider_reputation before creating views'
  );

  // Migrazione 013: tesoreria multi-asset (M1-M5), storni post-regolamento, kill switch, limiti & cap globale
  const m013 = fs.readFileSync(
    path.join(root, 'migrations/013_multi_asset_treasury_killswitch_limits_clawback.sql'),
    'utf8'
  );
  for (const symbol of [
    'chk_treasury_vault_asset',
    'CASH_VOLET',
    'core.treasury_conversions',
    'core.v_treasury_vault_status',
    'core.record_treasury_conversion',
    'core.set_payout_kill_switch',
    'core.get_payout_kill_switch',
    'core.revoke_settled_reward',
    'core.reverse_completed_payout',
    'DUAL_APPROVAL_DISTINCT_ADMIN_REQUIRED',
    'TREASURY_VAULT_ASSET_INSUFFICIENT',
    'MANUAL_EXTERNAL',
    'trg_enforce_global_partner_exposure_limit',
  ]) {
    assert.ok(m013.includes(symbol), `013 missing required construct: ${symbol}`);
  }
  assert.ok(
    /VALUES\s*\(\s*'PAYOUT_KILL_SWITCH'\s*,\s*TRUE\b/.test(m013),
    '013 must seed PAYOUT_KILL_SWITCH = TRUE (fail-closed)'
  );
  // Migrazione 014: Audit hardening fixes (clawback auto-recovery, kill-switch fail-closed, concurrent approval lock, durable settlement queue, conversion tx validation)
  const m014 = fs.readFileSync(
    path.join(root, 'migrations/014_audit_hardening_fixes.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.settlement_jobs',
    'core.recover_user_clawback_debt',
    'KILL_SWITCH_CONTROL_ROW_MISSING_FAIL_CLOSED',
    'CONVERSION_EXTERNAL_TX_REF_REQUIRED',
    'CONVERSION_FX_DEVIATION_EXCEEDED',
    'DUAL_APPROVAL_REQUIRED_BEFORE_COMPLETE',
    'idx_treasury_conversions_ext_tx_ref_unique',
    'ACTIVE_WINDOW_15S',
  ]) {
    assert.ok(m014.includes(symbol), `014 missing required construct: ${symbol}`);
  }
  assert.ok(
    /VALUES\s*\(\s*'PAYOUT_KILL_SWITCH'\s*,\s*TRUE\b/.test(m014),
    '014 must seed PAYOUT_KILL_SWITCH = TRUE (fail-closed)'
  );
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m014), false, '014 must never drop/truncate tables');

  const envExampleSrc = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const lockLine of [
    'PAYOUT_KILL_SWITCH="TRUE"',
    'PAYOUT_EXECUTION_MODE="MANUAL_EXTERNAL"',
    'ENABLE_AUTO_PAYOUT_DISPATCH="false"',
    'WEBHOOK_REQUIRE_HMAC="true"',
  ]) {
    assert.ok(envExampleSrc.includes(lockLine), `.env.example must document lock ${lockLine}`);
  }

  const prepareStagingSrc = fs.readFileSync(path.join(root, 'scripts/prepare-staging.ts'), 'utf8');
  assert.ok(
    prepareStagingSrc.includes("mode !== 'MANUAL_EXTERNAL'") &&
      prepareStagingSrc.includes("process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true'") &&
      prepareStagingSrc.includes("process.env.WEBHOOK_REQUIRE_HMAC !== 'false'") &&
      prepareStagingSrc.includes('setKillSwitchStatus(\n    true,'),
    'scripts/prepare-staging.ts must enforce all mandatory staging safety locks'
  );

  assert.ok(
    listener.includes("receivedAsset: 'TON'") && listener.includes("receivedAsset: 'SOL'"),
    'blockchainListener must pass explicit receivedAsset (TON / SOL) into executeBatchSettlement'
  );
  const settlementWorkerSrc = fs.readFileSync(path.join(root, 'src/workers/settlementWorker.ts'), 'utf8');
  assert.ok(settlementWorkerSrc.includes('core.settlement_jobs'), 'settlementWorker must persist jobs to PostgreSQL');
  assert.ok(settlementWorkerSrc.includes('FOR UPDATE SKIP LOCKED'), 'settlementWorker must claim jobs atomically');
  const settlementSvcSrc = fs.readFileSync(path.join(root, 'src/db/settlementService.ts'), 'utf8');
  assert.ok(settlementSvcSrc.includes('UNSUPPORTED_SETTLEMENT_ASSET'), 'settlementService must validate receivedAsset');
  assert.ok(serverSrc.includes('ADMIN_ACTOR_MISMATCH'), 'server.ts must prevent X-Admin-Id spoofing');
  assert.ok(serverSrc.includes('CONVERSION_EXTERNAL_TX_REF_REQUIRED'), 'server.ts must require externalTxRef on treasury conversion');

  // ID crittografici (zero Math.random per ID click/interazione/payout/sessione)
  const affiliateSrc = fs.readFileSync(path.join(root, 'src/lib/affiliate.ts'), 'utf8');
  assert.equal(affiliateSrc.includes('Math.random'), false, 'affiliate.ts must not use Math.random');
  assert.equal(affiliateSrc.includes("'cpx'"), false, 'affiliate.ts must not reference banned cpx provider');
  const c1 = newClickId();
  const c2 = newClickId();
  const i1 = newInteractionId();
  const i2 = newInteractionId();
  assert.notEqual(c1, c2);
  assert.notEqual(i1, i2);

  // Migrazione 015, navigazione HTTPS-only, finalità Solana finalized, AutoEngine fail-closed e docs/
  const m015 = fs.readFileSync(
    path.join(root, 'migrations/015_inbound_security_and_session_revocation.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.inbound_security_logs',
    'core.log_inbound_security_event',
    'core.revoke_auto_session',
    'AUTO_SESSION_REVOKED_OR_EXPIRED',
    'actionflow_auditor',
  ]) {
    assert.ok(m015.includes(symbol), `015 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m015), false, '015 must never drop/truncate tables');

  const verifierSrc = fs.readFileSync(path.join(root, 'src/services/onchainVerifier.ts'), 'utf8');
  assert.ok(verifierSrc.includes("commitment: 'finalized'"), 'Solana verifier must require finalized commitment');
  assert.ok(verifierSrc.includes('transaction_successful'), 'Pi verifier must verify transaction_successful');

  const navSrc = fs.readFileSync(path.join(root, 'src/utils/navigation.ts'), 'utf8');
  assert.ok(navSrc.includes('isSafeExternalHttpsUrl'), 'navigation.ts must enforce HTTPS-only external navigation');

  assert.ok(cycleSrc.includes('useState(false)'), 'AutoInteractiveCycleEngine must initialize running=false fail-closed');
  assert.ok(cycleSrc.includes('requireRegisteredReputation'), 'AutoInteractiveCycleEngine must pass requireRegisteredReputation');
  assert.ok(cycleSrc.includes('isSafeExternalHttpsUrl'), 'AutoInteractiveCycleEngine must verify HTTPS before launching');

  const archDocPath = path.join(root, 'docs/ACTIONFLOW_ARCHITECTURE_AND_SECURITY.md');
  assert.ok(fs.existsSync(archDocPath), 'docs/ACTIONFLOW_ARCHITECTURE_AND_SECURITY.md must exist');
  const archDoc = fs.readFileSync(archDocPath, 'utf8');
  assert.ok(archDoc.includes('AutoInteractiveCycleEngine') && archDoc.includes('MANUAL_EXTERNAL') && archDoc.includes('CASH_VOLET'));

  // Migrazioni 016, 017, 018 + allineamento finale server/worker
  const m016 = fs.readFileSync(
    path.join(root, 'migrations/016_persistent_rate_limit_provider_thresholds_killswitch.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.provider_rate_limits',
    'core.provider_rate_limit_windows',
    'core.consume_provider_rate_limit',
    'consecutive_suspicious_anomalies',
    'technical_error_count',
    'PROVIDER_PROTECTION_THRESHOLDS',
    'core.admin_review_provider_anomalies',
    'approved_pending_points',
  ]) {
    assert.ok(m016.includes(symbol), `016 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m016), false, '016 must never drop/truncate tables');

  const m017 = fs.readFileSync(
    path.join(root, 'migrations/017_payout_idempotency_payload_conflict.sql'),
    'utf8'
  );
  for (const symbol of [
    'request_payload_hash',
    'idx_payout_requests_idempotency_unique',
    'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
    'sha256(',
  ]) {
    assert.ok(m017.includes(symbol), `017 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m017), false, '017 must never drop/truncate tables');

  const m018 = fs.readFileSync(
    path.join(root, 'migrations/018_onchain_verification_tracking.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.payout_onchain_verifications',
    'core.record_payout_onchain_verification',
    'PAYOUT_ONCHAIN_PROOF_REQUIRED',
    'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED',
    'onchain_verified',
  ]) {
    assert.ok(m018.includes(symbol), `018 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m018), false, '018 must never drop/truncate tables');

  assert.ok(serverSrc.includes('verifyWebhookRawBodyHmac'), 'server must verify webhook HMAC over raw bytes');
  assert.ok(serverSrc.includes('consumeProviderRateLimit'), 'server must use PostgreSQL persistent per-provider rate limiting');
  assert.ok(serverSrc.includes('/api/payout/idempotency-key'), 'server must expose /api/payout/idempotency-key');
  assert.ok(serverSrc.includes('recordPayoutOnchainVerification'), 'server must persist on-chain proof before completing payout');

  const multiWorkerSrc = fs.readFileSync(path.join(root, 'src/workers/multiAssetPayoutWorker.ts'), 'utf8');
  assert.ok(multiWorkerSrc.includes("commitment: 'finalized'"), 'multiAssetPayoutWorker SOL must require finalized commitment');
  assert.ok(multiWorkerSrc.includes('recordPayoutOnchainVerification'), 'multiAssetPayoutWorker must persist on-chain verification proof');
  assert.ok(multiWorkerSrc.includes('verifyPayoutTransactionOnChain'), 'multiAssetPayoutWorker must run independent verifier before recording proof');
  assert.ok(tonWorker.includes('recordPayoutOnchainVerification'), 'tonPayoutWorker must persist on-chain verification proof');
  assert.ok(tonWorker.includes('verifyPayoutTransactionOnChain'), 'tonPayoutWorker must run independent verifier before recording proof');

  // Migrazione 019 + Registro Migrazioni + Rollback sessione + Deadlock-safe lock + Cross-check proof
  const m019 = fs.readFileSync(
    path.join(root, 'migrations/019_treasury_sql_and_session_rollback_hardening.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.schema_migrations',
    'filename TEXT PRIMARY KEY',
    'ON CONFLICT (filename) DO UPDATE',
    '019_treasury_sql_and_session_rollback_hardening.sql',
    'core.prevent_audit_log_mutation',
    'trg_security_audit_logs_immutable',
    'actionflow_app',
    'core.revoke_settled_reward',
    'core.partner_confirm_reward',
    'rolled_back_total_points',
    'user_ledger_',
    'core.release_settled',
    'ONCHAIN_PROOF_ASSET_MISMATCH',
    'ONCHAIN_PROOF_DESTINATION_MISMATCH',
    'ONCHAIN_PROOF_AMOUNT_BELOW_EXPECTED',
    'INVALID_SETTLEMENT_NUMERIC_INPUT',
  ]) {
    assert.ok(m019.includes(symbol), `019 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m019), false, '019 must never drop/truncate tables');

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const envKey of [
    'WEBHOOK_REQUIRE_HMAC',
    'WEBHOOK_LEGACY_SECRET_SUNSET_AT',
    'PAYOUT_EXECUTION_MODE',
    'ENABLE_AUTO_PAYOUT_DISPATCH',
    'SOL_USDT_MINT',
    'TON_USDT_MASTER',
  ]) {
    assert.ok(envExample.includes(envKey), `.env.example missing ${envKey}`);
  }

  const opsDocPath = path.join(root, 'docs/ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md');
  assert.ok(fs.existsSync(opsDocPath), 'docs/ACTIONFLOW_OPERATIONS_AND_MIGRATIONS.md must exist');
  const opsDoc = fs.readFileSync(opsDocPath, 'utf8');
  assert.ok(opsDoc.includes('020_payout_dispatch_claims_and_double_spend_guard.sql') && opsDoc.includes('pg_dump'));

  // Migrazione 020: Claim atomico, state machine anti-double-spend, audit immutabile, reject guard & privilegi
  const m020 = fs.readFileSync(
    path.join(root, 'migrations/020_payout_dispatch_claims_and_double_spend_guard.sql'),
    'utf8'
  );
  for (const symbol of [
    '020_payout_dispatch_claims_and_double_spend_guard.sql',
    'core.payout_dispatch_attempts',
    'core.payout_dispatch_audit',
    'idx_payout_dispatch_one_blocking_attempt',
    'trg_payout_dispatch_audit_immutable',
    'core.claim_payout_for_dispatch',
    'core.update_payout_dispatch_state',
    'core.get_uncertain_payout_dispatches',
    'core.reject_payout_atomic',
    'PAYOUT_CANNOT_BE_REJECTED_WHILE_DISPATCH_ACTIVE_OR_UNCERTAIN',
    'GRANT EXECUTE ON FUNCTION',
    'PAYOUT_ALREADY_CLAIMED_BY_WORKER',
    'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME',
    'CANNOT_MARK_RETRYABLE_AFTER_BROADCAST_WITHOUT_RECONCILIATION',
    'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED',
  ]) {
    assert.ok(m020.includes(symbol), `020 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m020), false, '020 must never drop/truncate tables');
  assert.ok(
    serverSrc.includes('/api/payout/reconcile-uncertain') &&
      serverSrc.includes('canVerifyPayoutAssetIndependently'),
    'server must expose reconcile-uncertain and pre-completion verifiability guard'
  );
}

interface MockPayoutState {
  requestId: string;
  asset: string;
  walletAddress: string;
  amountAsset: number;
  amountUsd: number;
  dispatchState:
    | 'UNCLAIMED'
    | 'CLAIMED'
    | 'BROADCASTING'
    | 'UNCERTAIN_TIMEOUT'
    | 'CONFIRMED_ONCHAIN'
    | 'FAILED_SAFE_RETRYABLE'
    | 'COMPLETED';
  activeAttemptId: string | null;
  txHash: string | null;
  proofRecordedVerified: boolean;
  completed: boolean;
  auditLog: Array<{ attemptId: string; fromState: string; toState: string; reason: string | null }>;
}

function createMockPayoutDispatchStore(seed: Array<{
  requestId: string;
  asset: string;
  walletAddress: string;
  amountAsset: number;
  amountUsd: number;
}>) {
  const rows = new Map<string, MockPayoutState>();
  for (const s of seed) {
    rows.set(s.requestId, {
      ...s,
      dispatchState: 'UNCLAIMED',
      activeAttemptId: null,
      txHash: null,
      proofRecordedVerified: false,
      completed: false,
      auditLog: [],
    });
  }

  const store: PayoutDispatchStore = {
    async getKillSwitchStatus() {
      return { is_enabled: false, reason: 'TEST_DISABLED' };
    },
    async claimPayoutForDispatch({ requestId, attemptId }) {
      const row = rows.get(requestId);
      if (!row) return { ok: false, error: 'PAYOUT_NOT_FOUND' };
      if (row.dispatchState === 'COMPLETED' || row.completed) {
        return {
          ok: false,
          dispatch_state: row.dispatchState,
          active_attempt_id: row.activeAttemptId || undefined,
          tx_hash: row.txHash || undefined,
          error: 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME',
        };
      }
      if (row.dispatchState === 'UNCERTAIN_TIMEOUT' || row.dispatchState === 'CONFIRMED_ONCHAIN') {
        return {
          ok: false,
          dispatch_state: row.dispatchState,
          active_attempt_id: row.activeAttemptId || undefined,
          tx_hash: row.txHash || undefined,
          error: 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME',
        };
      }
      if (row.dispatchState === 'CLAIMED' || row.dispatchState === 'BROADCASTING') {
        return {
          ok: false,
          dispatch_state: row.dispatchState,
          active_attempt_id: row.activeAttemptId || undefined,
          error: 'PAYOUT_ALREADY_CLAIMED_BY_WORKER',
        };
      }
      const prev = row.dispatchState;
      const effAttempt = attemptId || `att_${crypto.randomUUID()}`;
      row.activeAttemptId = effAttempt;
      row.dispatchState = 'CLAIMED';
      row.auditLog.push({ attemptId: effAttempt, fromState: prev, toState: 'CLAIMED', reason: 'CLAIMED' });
      return {
        ok: true,
        attempt_id: effAttempt,
        request_id: requestId,
        dispatch_state: 'CLAIMED',
      };
    },
    async updatePayoutDispatchState({ requestId, attemptId, nextState, txHash, reason }) {
      const row = rows.get(requestId);
      if (!row) return { ok: false, error: 'PAYOUT_NOT_FOUND' };
      if (row.activeAttemptId !== attemptId) {
        return { ok: false, error: 'DISPATCH_ATTEMPT_NOT_FOUND_OR_NOT_ACTIVE' };
      }
      if (
        (row.dispatchState === 'BROADCASTING' || row.dispatchState === 'UNCERTAIN_TIMEOUT') &&
        nextState === 'FAILED_SAFE_RETRYABLE' &&
        !String(reason || '').startsWith('PRE_BROADCAST_CONFIRMED:') &&
        !String(reason || '').startsWith('RECONCILED_NOT_SENT:')
      ) {
        return { ok: false, error: 'UNCERTAIN_TO_RETRY_FORBIDDEN_WITHOUT_RECONCILIATION_PROOF' };
      }
      const prev = row.dispatchState;
      row.dispatchState = nextState;
      if (txHash) row.txHash = txHash;
      row.auditLog.push({
        attemptId,
        fromState: prev,
        toState: nextState,
        reason: reason || null,
      });
      return {
        ok: true,
        attempt_id: attemptId,
        from_state: prev,
        dispatch_state: nextState,
        tx_hash: row.txHash,
      };
    },
    async getUncertainPayoutDispatches() {
      const items = Array.from(rows.values())
        .filter((r) => !r.completed && ['BROADCASTING', 'UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN'].includes(r.dispatchState))
        .map((r) => ({
          request_id: r.requestId,
          crypto_asset: r.asset,
          wallet_address: r.walletAddress,
          asset_amount: r.amountAsset,
          amount_usd: r.amountUsd,
          dispatch_state: r.dispatchState,
          attempt_id: r.activeAttemptId,
          tx_hash: r.txHash,
        }));
      return { ok: true, items };
    },
    async recordPayoutOnchainVerification(params) {
      const row = rows.get(params.requestId);
      if (!row) return { ok: false, error: 'PAYOUT_NOT_FOUND' };
      if (!params.verified) return { ok: false, error: 'VERIFIED_MUST_BE_TRUE' };
      row.proofRecordedVerified = true;
      row.txHash = params.txHash;
      return { ok: true };
    },
    async completePayout(requestId, txHash) {
      const row = rows.get(requestId);
      if (!row) return { ok: false, error: 'PAYOUT_NOT_FOUND' };
      if (!row.proofRecordedVerified) {
        return { ok: false, error: 'ONCHAIN_PROOF_NOT_RECORDED_OR_UNVERIFIED' };
      }
      const prev = row.dispatchState;
      row.completed = true;
      row.dispatchState = 'COMPLETED';
      row.txHash = txHash;
      if (row.activeAttemptId) {
        row.auditLog.push({
          attemptId: row.activeAttemptId,
          fromState: prev,
          toState: 'COMPLETED',
          reason: 'COMPLETED',
        });
      }
      return { ok: true, payout: { request_id: requestId, status: 'COMPLETED', tx_hash: txHash } };
    },
  };

  return { store, rows };
}

async function runKilo090f479AlignmentAndDoubleSpendTests() {
  const realFetch = globalThis.fetch;
  const prevCashVerifyUrl = process.env.CASH_GATEWAY_VERIFY_URL;
  const prevCashApiKey = process.env.CASH_GATEWAY_API_KEY;
  const prevPiRpc = process.env.PI_HORIZON_RPC;

  const tonDest = 'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-';
  const tonWrongDest = 'UQB_00000000000000000000000000000000000000000001';
  const validTonHash = 'b'.repeat(64);

  const solDest = '11111111111111111111111111111111';
  const solStatic0 = 'Vote111111111111111111111111111111111111111';
  const solAltDest = 'SysvarRent111111111111111111111111111111111';
  const solUsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const solSigV0Ok = '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7';
  const solSigV0Err = '4k8s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Derr';
  const solSigV0Spl = '3m9s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dspl';
  const solSigLegacy = '2n7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dleg';

  const piDest = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const piHashOk = 'c'.repeat(64);
  const piHashMismatch = 'd'.repeat(64);

  process.env.CASH_GATEWAY_VERIFY_URL = 'https://cash-verify.example.test/verify';
  process.env.CASH_GATEWAY_API_KEY = 'test_cash_verify_key';
  process.env.PI_HORIZON_RPC = 'https://pi-horizon.example.test';

  let tonScenario: 'OK' | 'MISMATCH_DEST' | 'LOW_AMOUNT' | 'ABORTED' = 'OK';
  let cashScenario: 'OK' | 'MISMATCH_DEST' = 'OK';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // 1. Toncenter v2 REST getTransactions mock
    if (url.includes('toncenter.com/api/v2/getTransactions')) {
      const destAddr =
        tonScenario === 'MISMATCH_DEST'
          ? tonWrongDest
          : tonDest;
      const valNano = tonScenario === 'LOW_AMOUNT' ? '500000000' : '2500000000';
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              transaction_id: { lt: '42000000001', hash: validTonHash },
              utime: Math.floor(Date.now() / 1000) - 20,
              description: { aborted: tonScenario === 'ABORTED' },
              in_msg: { destination: destAddr, value: valNano },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Solana JSON-RPC mock (legacy + v0 ALT)
    if (url.includes('mainnet-beta.solana.com') || url.includes('solana')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === 'getTransaction') {
        const sig = body.params?.[0];
        const encoding = body.params?.[1]?.maxSupportedTransactionVersion;
        assert.equal(encoding, 0, 'Solana verifier must pass maxSupportedTransactionVersion: 0');
        assert.equal(body.params?.[1]?.commitment, 'finalized', 'Solana verifier must request finalized commitment');

        if (sig === solSigLegacy) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              result: {
                slot: 310000001,
                version: 'legacy',
                transaction: { message: { accountKeys: [solStatic0, solDest] } },
                meta: { err: null, preBalances: [5_000_000_000, 0], postBalances: [4_000_000_000, 1_000_000_000] },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (sig === solSigV0Ok) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              result: {
                slot: 310000002,
                version: 0,
                transaction: { message: { accountKeys: [{ pubkey: solStatic0 }] } },
                meta: {
                  err: null,
                  loadedAddresses: { writable: [solAltDest], readonly: [] },
                  preBalances: [5_000_000_000, 100_000_000],
                  postBalances: [3_500_000_000, 1_600_000_000],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (sig === solSigV0Err) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              result: {
                slot: 310000003,
                version: 0,
                transaction: { message: { accountKeys: [solStatic0] } },
                meta: {
                  err: { InstructionError: [0, 'Custom'] },
                  loadedAddresses: { writable: [solAltDest], readonly: [] },
                  preBalances: [5_000_000_000, 0],
                  postBalances: [4_999_995_000, 0],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (sig === solSigV0Spl) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              result: {
                slot: 310000004,
                version: 0,
                transaction: { message: { accountKeys: [solStatic0] } },
                meta: {
                  err: null,
                  loadedAddresses: { writable: [solAltDest], readonly: [] },
                  preTokenBalances: [],
                  postTokenBalances: [
                    {
                      accountIndex: 1,
                      mint: solUsdcMint,
                      owner: solAltDest,
                      uiTokenAmount: { amount: '12500000', decimals: 6, uiAmount: null },
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(JSON.stringify({ jsonrpc: '2.0', result: null }), { status: 200 });
      }
    }

    // 3. Pi Horizon mock
    if (url.startsWith('https://pi-horizon.example.test')) {
      if (url.endsWith(`/transactions/${piHashOk}`)) {
        return new Response(
          JSON.stringify({ successful: true, ledger: 900123 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith(`/transactions/${piHashOk}/payments`)) {
        return new Response(
          JSON.stringify({
            _embedded: { records: [{ to: piDest, amount: '15.0', asset_type: 'native' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith(`/transactions/${piHashMismatch}`)) {
        return new Response(
          JSON.stringify({ successful: true, ledger: 900124 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith(`/transactions/${piHashMismatch}/payments`)) {
        return new Response(
          JSON.stringify({
            _embedded: { records: [{ to: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB42Q', amount: '15.0', asset_type: 'native' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // 4. Cash gateway verifier mock
    if (url.startsWith('https://cash-verify.example.test/verify')) {
      return new Response(
        JSON.stringify({
          verified: true,
          status: 'COMPLETED',
          asset: 'CASH_PAYEER',
          destination: cashScenario === 'MISMATCH_DEST' ? 'CASH-PAYEER:P99999999' : 'CASH-PAYEER:P12345678',
          amountUsd: 10,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // --- A. TON Verification (Recipient + Amount + Aborted) ---
    tonScenario = 'OK';
    const tonOk = await verifyPayoutTransactionOnChain({
      asset: 'TON',
      txHash: validTonHash,
      destinationAddress: tonDest,
      expectedAmountAsset: 2.5,
      expectedAmountUsd: 12.5,
    });
    assert.equal(tonOk.verified, true, 'TON matching recipient & amount must verify');
    assert.equal(tonOk.observedAmountAsset, 2.5);

    tonScenario = 'MISMATCH_DEST';
    const tonBadDest = await verifyPayoutTransactionOnChain({
      asset: 'TON',
      txHash: validTonHash,
      destinationAddress: tonDest,
      expectedAmountAsset: 2.5,
      expectedAmountUsd: 12.5,
    });
    assert.equal(tonBadDest.verified, false, 'TON recipient mismatch must fail');
    assert.equal(tonBadDest.reason, 'TON_TX_NOT_FOUND_OR_AMOUNT_DEST_MISMATCH');

    tonScenario = 'LOW_AMOUNT';
    const tonLowAmt = await verifyPayoutTransactionOnChain({
      asset: 'TON',
      txHash: validTonHash,
      destinationAddress: tonDest,
      expectedAmountAsset: 2.5,
      expectedAmountUsd: 12.5,
    });
    assert.equal(tonLowAmt.verified, false, 'TON underpayment must fail');
    assert.equal(tonLowAmt.reason, 'TON_TX_NOT_FOUND_OR_AMOUNT_DEST_MISMATCH');

    tonScenario = 'ABORTED';
    const tonAborted = await verifyPayoutTransactionOnChain({
      asset: 'TON',
      txHash: validTonHash,
      destinationAddress: tonDest,
      expectedAmountAsset: 2.5,
      expectedAmountUsd: 12.5,
    });
    assert.equal(tonAborted.verified, false, 'TON aborted tx must fail');
    assert.equal(tonAborted.reason, 'TON_TX_NOT_FOUND_OR_AMOUNT_DEST_MISMATCH');
    tonScenario = 'OK';

    // --- B. Solana Legacy + Versioned (v0 ALT) + SPL + Failed tx ---
    const solLeg = await verifyPayoutTransactionOnChain({
      asset: 'SOL',
      txHash: solSigLegacy,
      destinationAddress: solDest,
      expectedAmountAsset: 1.0,
      expectedAmountUsd: 150,
    });
    assert.equal(solLeg.verified, true, 'Solana legacy transaction must verify');

    const solV0 = await verifyPayoutTransactionOnChain({
      asset: 'SOL',
      txHash: solSigV0Ok,
      destinationAddress: solAltDest,
      expectedAmountAsset: 1.5,
      expectedAmountUsd: 225,
    });
    assert.equal(solV0.verified, true, 'Solana v0 ALT transaction must verify via loadedAddresses');
    assert.equal(solV0.rawProof?.txVersion, 0);
    assert.equal(solV0.observedAmountAsset, 1.5);

    const solV0Err = await verifyPayoutTransactionOnChain({
      asset: 'SOL',
      txHash: solSigV0Err,
      destinationAddress: solAltDest,
      expectedAmountAsset: 1.5,
      expectedAmountUsd: 225,
    });
    assert.equal(solV0Err.verified, false, 'Failed Solana v0 tx must reject');
    assert.equal(solV0Err.reason, 'SOL_TX_NOT_FOUND_OR_FAILED_ONCHAIN');

    const solV0Spl = await verifyPayoutTransactionOnChain({
      asset: 'USDC',
      txHash: solSigV0Spl,
      destinationAddress: solAltDest,
      expectedAmountAsset: 12.5,
      expectedAmountUsd: 12.5,
    });
    assert.equal(solV0Spl.verified, true, 'Solana v0 SPL new-ATA transfer with decimals fallback must verify');
    assert.equal(solV0Spl.observedAmountAsset, 12.5);

    // --- C. PI & Stubbed Cash Gateway Verification ---
    const piOk = await verifyPayoutTransactionOnChain({
      asset: 'PI',
      txHash: piHashOk,
      destinationAddress: piDest,
      expectedAmountAsset: 15,
      expectedAmountUsd: 15,
    });
    assert.equal(piOk.verified, true);

    const piBad = await verifyPayoutTransactionOnChain({
      asset: 'PI',
      txHash: piHashMismatch,
      destinationAddress: piDest,
      expectedAmountAsset: 15,
      expectedAmountUsd: 15,
    });
    assert.equal(piBad.verified, false);
    assert.equal(piBad.reason, 'PI_PAYMENT_DEST_OR_AMOUNT_MISMATCH');

    cashScenario = 'MISMATCH_DEST';
    const cashBad = await verifyPayoutTransactionOnChain({
      asset: 'CASH_PAYEER',
      txHash: 'payeer_rcpt_99887766',
      destinationAddress: 'CASH-PAYEER:P12345678',
      expectedAmountAsset: 10,
      expectedAmountUsd: 10,
    });
    assert.equal(cashBad.verified, false);
    assert.equal(cashBad.reason, 'CASH_GATEWAY_DESTINATION_MISMATCH');

    cashScenario = 'OK';
    const cashOk = await verifyPayoutTransactionOnChain({
      asset: 'CASH_PAYEER',
      txHash: 'payeer_rcpt_99887766',
      destinationAddress: 'CASH-PAYEER:P12345678',
      expectedAmountAsset: 10,
      expectedAmountUsd: 10,
    });
    assert.equal(cashOk.verified, true);

    // --- D. Double-Spend Protection Tests (Concurrent Retries, Timeout, Crash, Reconciliation, Pre-Completion Guard) ---
    const mock = createMockPayoutDispatchStore([
      { requestId: 'req_ds_concurrent', asset: 'SOL', walletAddress: solAltDest, amountAsset: 1.5, amountUsd: 225 },
      { requestId: 'req_ds_timeout_ton', asset: 'TON', walletAddress: tonDest, amountAsset: 2.5, amountUsd: 12.5 },
      { requestId: 'req_ds_crash_sol', asset: 'SOL', walletAddress: solAltDest, amountAsset: 1.5, amountUsd: 225 },
      { requestId: 'req_ds_uncertain_nohash', asset: 'SOL', walletAddress: solAltDest, amountAsset: 1.5, amountUsd: 225 },
      { requestId: 'req_ds_bad_guard', asset: 'SOL', walletAddress: solAltDest, amountAsset: 1.5, amountUsd: 225 },
    ]);

    // D1. Concurrent retries: two parallel workers racing on the same requestId
    let concurrentBroadcastCount = 0;
    const [race1, race2] = await Promise.all([
      multiAssetPayoutWorker.dispatchApprovedPayout(
        {
          requestId: 'req_ds_concurrent',
          cryptoAsset: 'SOL',
          destinationWallet: solAltDest,
          amountAsset: 1.5,
          amountUsd: 225,
        },
        {
          store: mock.store,
          bypassEnvGuardForTest: true,
          skipSolvencyCheckForTest: true,
          broadcasterOverride: async () => {
            concurrentBroadcastCount++;
            await new Promise((r) => setTimeout(r, 25));
            return { txHash: solSigV0Ok };
          },
        }
      ),
      multiAssetPayoutWorker.dispatchApprovedPayout(
        {
          requestId: 'req_ds_concurrent',
          cryptoAsset: 'SOL',
          destinationWallet: solAltDest,
          amountAsset: 1.5,
          amountUsd: 225,
        },
        {
          store: mock.store,
          bypassEnvGuardForTest: true,
          skipSolvencyCheckForTest: true,
          broadcasterOverride: async () => {
            concurrentBroadcastCount++;
            await new Promise((r) => setTimeout(r, 25));
            return { txHash: solSigV0Ok };
          },
        }
      ),
    ]);
    assert.equal(concurrentBroadcastCount, 1, 'Concurrent retry race must broadcast at most ONCE');
    const raceWinners = [race1, race2].filter((r) => r.ok);
    const raceLosers = [race1, race2].filter((r) => !r.ok);
    assert.equal(raceWinners.length, 1);
    assert.equal(raceLosers.length, 1);
    assert.equal(raceLosers[0].error, 'PAYOUT_ALREADY_CLAIMED_BY_WORKER');
    assert.equal(mock.rows.get('req_ds_concurrent')!.completed, true);

    // D2. Timeout -> UNCERTAIN_TIMEOUT -> strictly forbidden resend!
    let tonTimeoutCalls = 0;
    const tonTimeoutRes = await tonPayoutWorker.executeRealTonPayout(
      {
        requestId: 'req_ds_timeout_ton',
        destinationWallet: tonDest,
        amountTon: 2.5,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        senderOverride: async () => {
          tonTimeoutCalls++;
          return { txHash: null, fromWallet: 'test_ton_wallet', seqnoBefore: 10 };
        },
      }
    );
    assert.equal(tonTimeoutRes.ok, false);
    assert.equal(tonTimeoutRes.dispatchState, 'UNCERTAIN_TIMEOUT');

    const tonResendAfterTimeout = await tonPayoutWorker.executeRealTonPayout(
      {
        requestId: 'req_ds_timeout_ton',
        destinationWallet: tonDest,
        amountTon: 2.5,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        senderOverride: async () => {
          tonTimeoutCalls++;
          return { txHash: validTonHash, fromWallet: 'test_ton_wallet', seqnoBefore: 11 };
        },
      }
    );
    assert.equal(tonResendAfterTimeout.ok, false);
    assert.equal(
      tonResendAfterTimeout.error,
      'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME',
      'TON resend after timeout must be blocked'
    );
    assert.equal(tonTimeoutCalls, 1, 'senderOverride must never be called twice after uncertain timeout');

    // D3. Crash mid-broadcast -> UNCERTAIN_TIMEOUT -> resend blocked -> RPC reconciliation completes when txHash was emitted before failure
    let crashBroadcastCount = 0;
    const crashRes = await multiAssetPayoutWorker.dispatchApprovedPayout(
      {
        requestId: 'req_ds_crash_sol',
        cryptoAsset: 'SOL',
        destinationWallet: solAltDest,
        amountAsset: 1.5,
        amountUsd: 225,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        skipSolvencyCheckForTest: true,
        broadcasterOverride: async () => {
          crashBroadcastCount++;
          throw new Error('PROCESS_CRASH_DURING_BROADCAST');
        },
      }
    );
    assert.equal(crashRes.ok, false);
    assert.equal(crashRes.dispatchState, 'UNCERTAIN_TIMEOUT');

    const crashResendRes = await multiAssetPayoutWorker.dispatchApprovedPayout(
      {
        requestId: 'req_ds_crash_sol',
        cryptoAsset: 'SOL',
        destinationWallet: solAltDest,
        amountAsset: 1.5,
        amountUsd: 225,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        skipSolvencyCheckForTest: true,
        broadcasterOverride: async () => {
          crashBroadcastCount++;
          return { txHash: solSigV0Ok };
        },
      }
    );
    assert.equal(crashResendRes.ok, false);
    assert.equal(crashResendRes.error, 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME');
    assert.equal(crashBroadcastCount, 1, 'Resend after broadcast crash must never execute');

    // Crash without txHash on req_ds_uncertain_nohash -> reconcile refuses resend!
    await multiAssetPayoutWorker.dispatchApprovedPayout(
      {
        requestId: 'req_ds_uncertain_nohash',
        cryptoAsset: 'SOL',
        destinationWallet: solAltDest,
        amountAsset: 1.5,
        amountUsd: 225,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        skipSolvencyCheckForTest: true,
        broadcasterOverride: async () => {
          throw new Error('CRASH_NO_SIG');
        },
      }
    );

    // Simulate txHash persisted before crash on req_ds_crash_sol and run reconcileUncertainPayouts
    mock.rows.get('req_ds_crash_sol')!.txHash = solSigV0Ok;
    const reconcileRes = await multiAssetPayoutWorker.reconcileUncertainPayouts({
      store: mock.store,
      staleSeconds: 0,
    });
    assert.equal(reconcileRes.ok, true);
    const solReconciled = reconcileRes.reconciled.find((r) => r.requestId === 'req_ds_crash_sol');
    const tonReconciled = reconcileRes.reconciled.find((r) => r.requestId === 'req_ds_timeout_ton');
    const noHashReconciled = reconcileRes.reconciled.find((r) => r.requestId === 'req_ds_uncertain_nohash');
    assert.ok(solReconciled && solReconciled.ok && solReconciled.dispatchState === 'COMPLETED', 'RPC reconciliation must finalize confirmed SOL tx');
    assert.ok(tonReconciled && tonReconciled.ok && tonReconciled.dispatchState === 'COMPLETED', 'TON RPC criteria discovery must reconcile timed-out TON tx');
    assert.ok(
      noHashReconciled && !noHashReconciled.ok && noHashReconciled.error === 'NO_TX_HASH_FOR_RECONCILIATION_RESEND_BLOCKED',
      'Uncertain item without txHash must block resend during reconciliation'
    );

    // D4. Pre-completion verification guard blocks completion when on-chain verification fails
    const badGuardRes = await multiAssetPayoutWorker.dispatchApprovedPayout(
      {
        requestId: 'req_ds_bad_guard',
        cryptoAsset: 'SOL',
        destinationWallet: solAltDest,
        amountAsset: 1.5,
        amountUsd: 225,
      },
      {
        store: mock.store,
        bypassEnvGuardForTest: true,
        skipSolvencyCheckForTest: true,
        broadcasterOverride: async () => ({ txHash: solSigV0Err }),
      }
    );
    assert.equal(badGuardRes.ok, false);
    assert.equal(badGuardRes.dispatchState, 'UNCERTAIN_TIMEOUT');
    assert.equal(badGuardRes.error, 'SOL_TX_NOT_FOUND_OR_FAILED_ONCHAIN');
    assert.equal(mock.rows.get('req_ds_bad_guard')!.proofRecordedVerified, false, 'Failed on-chain check must NEVER persist verified=true');
    assert.equal(mock.rows.get('req_ds_bad_guard')!.completed, false, 'Failed on-chain check must NEVER complete payout');

    // Audit trail integrity check on crash-then-reconciled item
    const crashAuditStates = mock.rows.get('req_ds_crash_sol')!.auditLog.map((e) => e.toState);
    assert.deepEqual(
      crashAuditStates,
      ['CLAIMED', 'BROADCASTING', 'UNCERTAIN_TIMEOUT', 'CONFIRMED_ONCHAIN', 'COMPLETED'],
      'Dispatch state machine transitions must follow exact persistent audit sequence'
    );
  } finally {
    globalThis.fetch = realFetch;
    if (prevCashVerifyUrl === undefined) delete process.env.CASH_GATEWAY_VERIFY_URL;
    else process.env.CASH_GATEWAY_VERIFY_URL = prevCashVerifyUrl;
    if (prevCashApiKey === undefined) delete process.env.CASH_GATEWAY_API_KEY;
    else process.env.CASH_GATEWAY_API_KEY = prevCashApiKey;
    if (prevPiRpc === undefined) delete process.env.PI_HORIZON_RPC;
    else process.env.PI_HORIZON_RPC = prevPiRpc;
  }
}

async function main() {
  try {
    await runHttpSecurityChecks();
    runStaticHardeningChecks();
    await runKilo090f479AlignmentAndDoubleSpendTests();
    console.log(
      '[verify-hardening] OK — Auth Telegram HMAC, disabilitazione 410 endpoint legacy, zero fallback/simulazioni, FX fail-closed, TON/Solana v0 ALT/PI/CASH verifier, protezione double-spend (crash/concorrenza/timeout/riconciliazione) e vincoli SQL 009-020 verificati.'
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
