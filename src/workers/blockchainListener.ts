import { TonClient, Address } from '@ton/ton';
import { Connection, PublicKey } from '@solana/web3.js';
import { dbPool, LedgerService } from '../db/ledgerService';
import { ProviderReputationService } from '../services/providerReputation';
import { SettlementService } from '../db/settlementService';
import { WALLET_CONFIG } from '../config/wallets';

interface BlockchainConfig {
  ton: { rpc: string; enabled: boolean };
  solana: { rpc: string; enabled: boolean };
  tonAddress: string;
  solAddress: string;
}

const CONFIG: BlockchainConfig = {
  ton: {
    rpc: process.env.TON_RPC || 'https://toncenter.com/api/v2/jsonRPC',
    enabled: Boolean(process.env.BLOCKCHAIN_POLL_ENABLED === 'true'),
  },
  solana: {
    rpc: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
    enabled: Boolean(process.env.BLOCKCHAIN_POLL_ENABLED === 'true'),
  },
  tonAddress:
    process.env.TON_COLD_ADDRESS ||
    WALLET_CONFIG.TON.payoutAddresses[0] ||
    'UQArcaLwWBTXqOfyJCy3mjPSEuD80p66jzF_95HyXRShBOo-',
  solAddress:
    process.env.SOL_COLD_ADDRESS ||
    WALLET_CONFIG.SOL.payoutAddresses[0] ||
    'FCiSaZcMYYPyzkJQkfNXdnw4v2PjiR241KYpEm2FeqdT',
};

const POLL_INTERVAL_TON = 60_000;
const POLL_INTERVAL_SOL = 60_000;
const CONFIRMATIONS_SOL = 32;
const FX_SNAPSHOT_TTL_SECONDS = 600;

let tonClient: TonClient | null = null;
let solConnection: Connection | null = null;
let isRunning = false;
let tonTimer: NodeJS.Timeout | null = null;
let solTimer: NodeJS.Timeout | null = null;
let fxTimer: NodeJS.Timeout | null = null;
const inMemorySeenTxCache = new Set<string>();

interface CachedRate {
  rate: number;
  source: string;
  fetchedAt: string;
  expiresAtMs: number;
}
let cachedTonRate: CachedRate = { rate: 0, source: 'UNSET', fetchedAt: '', expiresAtMs: 0 };
let cachedSolRate: CachedRate = { rate: 0, source: 'UNSET', fetchedAt: '', expiresAtMs: 0 };
let cachedPiRate: CachedRate = { rate: 0, source: 'UNSET', fetchedAt: '', expiresAtMs: 0 };

export async function getTonUsdRate(): Promise<number> {
  const now = Date.now();
  if (cachedTonRate.expiresAtMs > now && cachedTonRate.rate > 0) {
    return cachedTonRate.rate;
  }

  if (dbPool) {
    try {
      const snapshots = await LedgerService.getLatestFxRates(FX_SNAPSHOT_TTL_SECONDS);
      if (snapshots.TON && snapshots.TON.usd_per_unit > 0) {
        cachedTonRate = {
          rate: snapshots.TON.usd_per_unit,
          source: snapshots.TON.source,
          fetchedAt: snapshots.TON.fetched_at,
          expiresAtMs: new Date(snapshots.TON.expires_at).getTime(),
        };
        return cachedTonRate.rate;
      }
    } catch {
      // Fallback to remote oracle
    }
  }

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500) }
    );
    if (res.ok) {
      const data = await res.json();
      const price = Number(data?.['the-open-network']?.usd);
      if (Number.isFinite(price) && price > 0) {
        cachedTonRate = {
          rate: price,
          source: 'COINGECKO_LIVE',
          fetchedAt: new Date(now).toISOString(),
          expiresAtMs: now + FX_SNAPSHOT_TTL_SECONDS * 1000,
        };
        if (dbPool) {
          await LedgerService.recordFxPriceSnapshot(
            'TON',
            price,
            'COINGECKO_LIVE',
            FX_SNAPSHOT_TTL_SECONDS
          ).catch(() => {});
        }
        return price;
      }
    }
  } catch {
    // Non-fatal rate limit / offline fallback -> fail closed with 0 if expired
  }

  return cachedTonRate.expiresAtMs > now ? cachedTonRate.rate : 0;
}

export async function getSolUsdRate(): Promise<number> {
  const now = Date.now();
  if (cachedSolRate.expiresAtMs > now && cachedSolRate.rate > 0) {
    return cachedSolRate.rate;
  }

  if (dbPool) {
    try {
      const snapshots = await LedgerService.getLatestFxRates(FX_SNAPSHOT_TTL_SECONDS);
      if (snapshots.SOL && snapshots.SOL.usd_per_unit > 0) {
        cachedSolRate = {
          rate: snapshots.SOL.usd_per_unit,
          source: snapshots.SOL.source,
          fetchedAt: snapshots.SOL.fetched_at,
          expiresAtMs: new Date(snapshots.SOL.expires_at).getTime(),
        };
        return cachedSolRate.rate;
      }
    } catch {
      // Fallback to remote oracle
    }
  }

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500) }
    );
    if (res.ok) {
      const data = await res.json();
      const price = Number(data?.solana?.usd);
      if (Number.isFinite(price) && price > 0) {
        cachedSolRate = {
          rate: price,
          source: 'COINGECKO_LIVE',
          fetchedAt: new Date(now).toISOString(),
          expiresAtMs: now + FX_SNAPSHOT_TTL_SECONDS * 1000,
        };
        if (dbPool) {
          await LedgerService.recordFxPriceSnapshot(
            'SOL',
            price,
            'COINGECKO_LIVE',
            FX_SNAPSHOT_TTL_SECONDS
          ).catch(() => {});
        }
        return price;
      }
    }
  } catch {
    // Non-fatal rate limit / offline fallback
  }

  return cachedSolRate.expiresAtMs > now ? cachedSolRate.rate : 0;
}

export async function getPiUsdRate(): Promise<number> {
  const now = Date.now();
  if (cachedPiRate.expiresAtMs > now && cachedPiRate.rate > 0) {
    return cachedPiRate.rate;
  }

  if (dbPool) {
    try {
      const snapshots = await LedgerService.getLatestFxRates(FX_SNAPSHOT_TTL_SECONDS);
      if (snapshots.PI && snapshots.PI.usd_per_unit > 0) {
        cachedPiRate = {
          rate: snapshots.PI.usd_per_unit,
          source: snapshots.PI.source,
          fetchedAt: snapshots.PI.fetched_at,
          expiresAtMs: new Date(snapshots.PI.expires_at).getTime(),
        };
        return cachedPiRate.rate;
      }
    } catch {
      // Fallback to remote oracle
    }
  }

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500) }
    );
    if (res.ok) {
      const data = await res.json();
      const price = Number(data?.['pi-network']?.usd);
      if (Number.isFinite(price) && price > 0) {
        cachedPiRate = {
          rate: price,
          source: 'COINGECKO_LIVE',
          fetchedAt: new Date(now).toISOString(),
          expiresAtMs: now + FX_SNAPSHOT_TTL_SECONDS * 1000,
        };
        if (dbPool) {
          await LedgerService.recordFxPriceSnapshot(
            'PI',
            price,
            'COINGECKO_LIVE',
            FX_SNAPSHOT_TTL_SECONDS
          ).catch(() => {});
        }
        return price;
      }
    }
  } catch {
    // Non-fatal rate limit / offline fallback -> fail closed with 0 if expired
  }

  return cachedPiRate.expiresAtMs > now ? cachedPiRate.rate : 0;
}

export async function refreshAndGetFxQuote(): Promise<{
  ok: boolean;
  usdPerPoint: number;
  tonUsdPrice: number | null;
  tonPerPoint: number | null;
  solUsdPrice: number | null;
  piUsdPrice: number | null;
  usdtUsdPrice: number;
  rates: {
    TON: number | null;
    SOL: number | null;
    PI: number | null;
    USDT: number;
    USDC: number;
  };
  source: string;
  quotedAt: string | null;
  expiresAt: string | null;
  error?: string;
}> {
  const [tonUsd, solUsd, piUsd] = await Promise.all([
    getTonUsdRate(),
    getSolUsdRate(),
    getPiUsdRate(),
  ]);

  let dbRates: Record<string, any> = {};
  if (dbPool) {
    dbRates = await LedgerService.getLatestFxRates(FX_SNAPSHOT_TTL_SECONDS).catch(() => ({}));
  }

  const tonSnapshot = dbRates.TON;
  const solSnapshot = dbRates.SOL;
  const piSnapshot = dbRates.PI;

  const effectiveTonUsd = tonSnapshot?.usd_per_unit || (tonUsd > 0 ? tonUsd : null);
  const effectiveSolUsd = solSnapshot?.usd_per_unit || (solUsd > 0 ? solUsd : null);
  const effectivePiUsd = piSnapshot?.usd_per_unit || (piUsd > 0 ? piUsd : null);
  const usdPerPoint = 0.01; // 100 PT = $1.00 USD (tasso contabile base)

  const hasAnyLiveRate = Boolean(
    (effectiveTonUsd && effectiveTonUsd > 0) ||
      (effectiveSolUsd && effectiveSolUsd > 0) ||
      (effectivePiUsd && effectivePiUsd > 0)
  );

  if (!hasAnyLiveRate) {
    return {
      ok: false,
      usdPerPoint,
      tonUsdPrice: null,
      tonPerPoint: null,
      solUsdPrice: null,
      piUsdPrice: null,
      usdtUsdPrice: 1.0,
      rates: {
        TON: null,
        SOL: null,
        PI: null,
        USDT: 1.0,
        USDC: 1.0,
      },
      source: 'FX_UNAVAILABLE',
      quotedAt: null,
      expiresAt: null,
      error: 'FX_PRICE_UNAVAILABLE',
    };
  }

  return {
    ok: true,
    usdPerPoint,
    tonUsdPrice: effectiveTonUsd,
    tonPerPoint:
      effectiveTonUsd && effectiveTonUsd > 0
        ? Number((usdPerPoint / effectiveTonUsd).toFixed(8))
        : null,
    solUsdPrice: effectiveSolUsd,
    piUsdPrice: effectivePiUsd,
    usdtUsdPrice: 1.0,
    rates: {
      TON: effectiveTonUsd,
      SOL: effectiveSolUsd,
      PI: effectivePiUsd,
      USDT: 1.0,
      USDC: 1.0,
    },
    source:
      tonSnapshot?.source ||
      solSnapshot?.source ||
      piSnapshot?.source ||
      cachedTonRate.source ||
      cachedSolRate.source ||
      cachedPiRate.source ||
      'COINGECKO_LIVE',
    quotedAt:
      tonSnapshot?.fetched_at ||
      solSnapshot?.fetched_at ||
      piSnapshot?.fetched_at ||
      cachedTonRate.fetchedAt ||
      new Date().toISOString(),
    expiresAt:
      tonSnapshot?.expires_at ||
      solSnapshot?.expires_at ||
      piSnapshot?.expires_at ||
      new Date(
        (cachedTonRate.expiresAtMs || cachedSolRate.expiresAtMs || Date.now() + FX_SNAPSHOT_TTL_SECONDS * 1000)
      ).toISOString(),
  };
}

export async function isTxProcessed(txHash: string): Promise<boolean> {
  if (inMemorySeenTxCache.has(txHash)) return true;
  if (!dbPool) return false;
  try {
    const res = await dbPool.query('SELECT 1 FROM core.processed_tx_hashes WHERE tx_hash = $1', [txHash]);
    if (res.rows && res.rows.length > 0) {
      inMemorySeenTxCache.add(txHash);
      return true;
    }
  } catch (err: any) {
    console.warn('[BLOCKCHAIN LISTENER] Errore verifica tx hash:', err.message);
  }
  return false;
}

export async function markTxProcessed(txHash: string): Promise<void> {
  if (!dbPool) {
    throw new Error('POSTGRES_REQUIRED_FOR_TX_TRACKING');
  }
  await dbPool.query(
    'INSERT INTO core.processed_tx_hashes (tx_hash) VALUES ($1) ON CONFLICT DO NOTHING',
    [txHash]
  );
  inMemorySeenTxCache.add(txHash);
}

async function initClients(): Promise<void> {
  if (!tonClient) {
    tonClient = new TonClient({ endpoint: CONFIG.ton.rpc });
  }
  if (!solConnection) {
    solConnection = new Connection(CONFIG.solana.rpc, 'finalized');
  }
}

export async function checkTonDeposits(): Promise<void> {
  if (!CONFIG.ton.enabled || !dbPool) return;
  try {
    await initClients();
    if (!tonClient) return;

    const parsedAddress = Address.parse(CONFIG.tonAddress);
    const transactions = await tonClient.getTransactions(parsedAddress, { limit: 20 });

    for (const tx of transactions) {
      const txHash = tx.hash().toString('hex');
      if (await isTxProcessed(txHash)) continue;

      const inMsg = tx.inMessage;
      if (inMsg && inMsg.info.type === 'internal') {
        const valueNano = inMsg.info.value.coins;
        if (valueNano > 0n) {
          const tonRate = await getTonUsdRate();
          if (tonRate <= 0) continue;

          const amountTon = Number(valueNano) / 1e9;
          const usdEstimate = Number((amountTon * tonRate).toFixed(2));
          if (usdEstimate <= 0) continue;

          const settleRes = await SettlementService.executeBatchSettlement({
            batchId: `ton_batch_${txHash.slice(0, 12)}`,
            partnerId: 'ton_onchain_partner',
            periodStart: Date.now() - 86400_000,
            periodEnd: Date.now(),
            expectedGrossUsd: usdEstimate,
            actualNetReceivedUsd: usdEstimate,
            haircutRatio: 1.0,
            onchainTxHash: txHash,
            receivedAsset: 'TON',
          });

          if (settleRes.success || settleRes.error === 'SETTLEMENT_TX_HASH_ALREADY_USED') {
            if (settleRes.success && !settleRes.idempotent) {
              await ProviderReputationService.recordPayment({
                providerId: 'ton_onchain_partner',
                batchId: `ton_batch_${txHash.slice(0, 12)}`,
                promisedUsd: usdEstimate,
                paidUsd: usdEstimate,
                txHash,
                notes: `TON Deposit verified: ${amountTon.toFixed(6)} TON @ $${tonRate}/TON`,
              }).catch(() => {});
            }
            await markTxProcessed(txHash);
          }
        }
      }
    }
  } catch {
    // Non-fatal RPC polling warning
  }
}

export async function checkSolanaDeposits(): Promise<void> {
  if (!CONFIG.solana.enabled || !dbPool) return;
  try {
    await initClients();
    if (!solConnection) return;

    const pubKey = new PublicKey(CONFIG.solAddress);
    const signatures = await solConnection.getSignaturesForAddress(pubKey, { limit: 20 }, 'finalized');

    for (const sigInfo of signatures) {
      if (sigInfo.err) continue;
      if (await isTxProcessed(sigInfo.signature)) continue;

      const parsedTx = await solConnection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'finalized',
      });
      if (!parsedTx || !parsedTx.meta) continue;

      const accountKeys = parsedTx.transaction.message.accountKeys;
      const targetIndex = accountKeys.findIndex(
        (k: any) => (k.pubkey ? k.pubkey.toBase58() : String(k)) === CONFIG.solAddress
      );
      if (targetIndex < 0) {
        await markTxProcessed(sigInfo.signature);
        continue;
      }

      const preLamports = Number(parsedTx.meta.preBalances?.[targetIndex] ?? 0);
      const postLamports = Number(parsedTx.meta.postBalances?.[targetIndex] ?? 0);
      const deltaLamports = postLamports - preLamports;
      if (deltaLamports <= 0) {
        await markTxProcessed(sigInfo.signature);
        continue;
      }

      const solRate = await getSolUsdRate();
      if (solRate <= 0) continue;

      const amountSol = deltaLamports / 1e9;
      const usdEstimate = Number((amountSol * solRate).toFixed(2));
      if (usdEstimate <= 0) continue;

      const batchId = `sol_dep_${sigInfo.signature.slice(0, 12)}`;
      const settleRes = await SettlementService.executeBatchSettlement({
        batchId,
        partnerId: 'sol_onchain_partner',
        periodStart: Date.now() - 86400_000,
        periodEnd: Date.now(),
        expectedGrossUsd: usdEstimate,
        actualNetReceivedUsd: usdEstimate,
        haircutRatio: 1.0,
        onchainTxHash: sigInfo.signature,
        receivedAsset: 'SOL',
      });

      if (settleRes.success || settleRes.error === 'SETTLEMENT_TX_HASH_ALREADY_USED') {
        if (settleRes.success && !settleRes.idempotent) {
          await ProviderReputationService.recordPayment({
            providerId: 'sol_onchain_partner',
            batchId,
            promisedUsd: usdEstimate,
            paidUsd: usdEstimate,
            txHash: sigInfo.signature,
            notes: `SOL Deposit verified (${CONFIRMATIONS_SOL} conf): ${amountSol.toFixed(6)} SOL @ $${solRate}/SOL`,
          }).catch(() => {});
        }
        await markTxProcessed(sigInfo.signature);
      }
    }
  } catch {
    // Non-fatal RPC polling warning
  }
}

export function startBlockchainListener(): void {
  if (isRunning) return;
  isRunning = true;

  if (dbPool) {
    void refreshAndGetFxQuote().catch(() => {});
    fxTimer = setInterval(() => {
      void getTonUsdRate().catch(() => {});
      void getSolUsdRate().catch(() => {});
      void getPiUsdRate().catch(() => {});
    }, 300_000);
  }

  if (!CONFIG.ton.enabled && !CONFIG.solana.enabled) {
    console.log('[BLOCKCHAIN LISTENER] FX sync attivo; deposito polling in attesa di BLOCKCHAIN_POLL_ENABLED=true.');
    return;
  }

  void initClients();
  tonTimer = setInterval(() => {
    void checkTonDeposits();
  }, POLL_INTERVAL_TON);
  solTimer = setInterval(() => {
    void checkSolanaDeposits();
  }, POLL_INTERVAL_SOL);
}

export function stopBlockchainListener(): void {
  if (tonTimer) {
    clearInterval(tonTimer);
    tonTimer = null;
  }
  if (solTimer) {
    clearInterval(solTimer);
    solTimer = null;
  }
  if (fxTimer) {
    clearInterval(fxTimer);
    fxTimer = null;
  }
  isRunning = false;
}

export function getListenerStatus() {
  return {
    isRunning,
    tonEnabled: CONFIG.ton.enabled,
    solanaEnabled: CONFIG.solana.enabled,
    tonAddress: CONFIG.tonAddress,
    solAddress: CONFIG.solAddress,
    processedCacheCount: inMemorySeenTxCache.size,
  };
}
