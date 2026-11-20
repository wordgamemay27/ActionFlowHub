import { bootstrapDatabaseSchema, dbPool, LedgerService } from '../src/db/ledgerService';
import { tonPayoutWorker } from '../src/workers/tonPayoutWorker';
import { multiAssetPayoutWorker } from '../src/workers/multiAssetPayoutWorker';

async function probeUrl(label: string, url: string | undefined, init?: RequestInit) {
  if (!url || !url.trim()) {
    return { target: label, configured: false, reachable: false, status: 'NOT_CONFIGURED_FAIL_CLOSED' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url.trim(), { ...init, signal: ctrl.signal });
    return {
      target: label,
      configured: true,
      reachable: res.ok,
      status: `HTTP_${res.status}`,
    };
  } catch (err: any) {
    return {
      target: label,
      configured: true,
      reachable: false,
      status: err?.name === 'AbortError' ? 'TIMEOUT' : err?.message || 'FETCH_ERROR',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const mode = process.env.PAYOUT_EXECUTION_MODE || 'MANUAL_EXTERNAL';
  const autoDispatch = process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true';
  const requireHmac = process.env.WEBHOOK_REQUIRE_HMAC !== 'false';

  if (mode !== 'MANUAL_EXTERNAL') {
    throw new Error(`UNSAFE_MODE: PAYOUT_EXECUTION_MODE=${mode} (must be MANUAL_EXTERNAL)`);
  }
  if (autoDispatch) {
    throw new Error('UNSAFE_MODE: ENABLE_AUTO_PAYOUT_DISPATCH must be false');
  }
  if (!requireHmac) {
    throw new Error('UNSAFE_MODE: WEBHOOK_REQUIRE_HMAC must be true');
  }

  if (!dbPool || !process.env.DATABASE_URL) {
    console.error('[staging-prepare] DATABASE_URL / PostgreSQL staging non configurato nell ambiente corrente.');
    process.exit(2);
  }

  // 1. Pre-check schema esistente e snapshot metadata/integrita' prima delle migrazioni
  const preTables = await dbPool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'core'
     ORDER BY table_name
  `);
  const hasCoreMigrations = preTables.rows.some((r) => r.table_name === 'schema_migrations');
  const existingMigrations = hasCoreMigrations
    ? (await dbPool.query(`SELECT filename FROM core.schema_migrations ORDER BY filename`)).rows.map(
        (r) => String(r.filename)
      )
    : [];

  let preAudit: unknown = null;
  if (preTables.rows.some((r) => r.table_name === 'ledger_entries')) {
    preAudit = await LedgerService.auditLedgerIntegrity().catch(() => null);
  }

  console.log('[staging-prepare] Pre-migration snapshot:', {
    existingTablesCount: preTables.rows.length,
    alreadyAppliedMigrations: existingMigrations.length,
    preAudit,
  });

  // 2. Applicazione ordinata e idempotente delle sole migrazioni mancanti (001..020)
  const { applied, skipped } = await bootstrapDatabaseSchema();
  console.log('[staging-prepare] Migrazioni applicate:', applied);
  console.log('[staging-prepare] Migrazioni gia presenti:', skipped.length);

  // 3. Mantiene obbligatoriamente PAYOUT_KILL_SWITCH = TRUE sullo staging prima di test manuali
  const ksSet = await LedgerService.setKillSwitchStatus(
    true,
    'STAGING_PREP_FAIL_CLOSED_LOCKED',
    'staging_prepare'
  );
  if (!ksSet.ok) {
    throw new Error(`Impossibile bloccare PAYOUT_KILL_SWITCH=TRUE: ${ksSet.error}`);
  }

  const postAudit = await LedgerService.auditLedgerIntegrity();
  const ksStatus = await LedgerService.getKillSwitchStatus();
  console.log('[staging-prepare] Kill Switch attivo:', ksStatus);
  console.log('[staging-prepare] Audit post-migrazione:', postAudit);

  // 4. Verifica worker TON / Solana in modalita manuale e probe gateway/RPC configurati
  const tonCheck = await tonPayoutWorker.processApprovedTonPayouts();
  const multiCheck = await multiAssetPayoutWorker.processApprovedPayouts();
  console.log('[staging-prepare] Worker guard MANUAL_EXTERNAL:', {
    tonWorker: tonCheck.error,
    multiAssetWorker: multiCheck.error,
  });

  const rpcProbes = await Promise.all([
    probeUrl('TON_RPC', process.env.TON_RPC || process.env.TONCENTER_RPC),
    probeUrl('SOL_RPC', process.env.SOL_RPC || process.env.SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    }),
    probeUrl('PI_HORIZON_RPC', process.env.PI_HORIZON_RPC),
    probeUrl('CRYPTO_GATEWAY_VERIFY_URL', process.env.CRYPTO_GATEWAY_VERIFY_URL),
    probeUrl('CASH_GATEWAY_VERIFY_URL', process.env.CASH_GATEWAY_VERIFY_URL),
  ]);
  console.log('[staging-prepare] Probe RPC/Gateway:', rpcProbes);

  await dbPool.end();
}

main().catch((err) => {
  console.error('[staging-prepare] FAILED:', err);
  process.exit(1);
});
