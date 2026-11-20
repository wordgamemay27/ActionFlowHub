// ============================================================================
// MULTI-ASSET PAYOUT WORKER — Orchestrazione Fail-Closed per Tutti gli Asset
// ============================================================================
// Supporta:
//   - Crypto Diretta: TON (via TonPayoutWorker), SOL (via @solana/web3.js),
//     USDT / USDC (via CRYPTO_GATEWAY_API_URL), PI (via PI_PAYOUT_API_URL)
//   - Cash USD Gateway: CASH_AIRTM, CASH_PAYEER, CASH_VOLET
//     (via CASH_GATEWAY_API_URL)
//
// Garanzie anti-double-spend e verifica (allineamento Kilo commit 090f479):
//   1. Verifica solvibilita' netta per singolo asset PRIMA di ogni invio.
//   2. Guard pre-trasmissione `canVerifyPayoutAssetIndependently`: blocca PI,
//      USDT, USDC e CASH_* se manca il verificatore indipendente.
//   3. Claim atomico PostgreSQL (`core.claim_payout_for_dispatch`) con attempt_id
//      univoco + stato persistente (`CLAIMED -> BROADCASTING -> CONFIRMED_ONCHAIN
//      | UNCERTAIN_TIMEOUT -> COMPLETED`).
//   4. Divieto assoluto di reinvio se l'esito precedente e' incerto.
//   5. Guard di verifica indipendente PRIMA di `complete_payout_atomic`.
//   6. Riconciliazione RPC (`reconcileUncertainPayouts`) dopo timeout o crash.
// ============================================================================

import crypto from 'crypto';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { dbPool, LedgerService, type PayoutDispatchStore } from '../db/ledgerService';
import { SettlementService } from '../db/settlementService';
import { WALLET_CONFIG } from '../config/wallets';
import { tonPayoutWorker } from './tonPayoutWorker';
import {
  canVerifyPayoutAssetIndependently,
  verifyPayoutTransactionOnChain,
} from '../services/onchainVerifier';

export type SupportedPayoutAsset =
  | 'TON'
  | 'SOL'
  | 'PI'
  | 'USDT'
  | 'USDC'
  | 'CASH_AIRTM'
  | 'CASH_PAYEER'
  | 'CASH_VOLET';

export interface MultiAssetDispatchInput {
  requestId: string;
  cryptoAsset: SupportedPayoutAsset | string;
  destinationWallet: string;
  amountAsset: number;
  amountUsd: number;
  points?: number;
  memo?: string;
}

export interface MultiAssetDispatchResult {
  ok: boolean;
  requestId: string;
  asset: string;
  attemptId?: string;
  dispatchState?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export type MultiAssetBroadcaster = (ctx: {
  requestId: string;
  attemptId: string;
  asset: string;
  destinationWallet: string;
  amountAsset: number;
  amountUsd: number;
  memo: string;
}) => Promise<{ txHash: string; explorerUrl?: string; rawProof?: Record<string, unknown> }>;

const DEFAULT_SOL_RPC = 'https://api.mainnet-beta.solana.com';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, number>(
  Array.from(BASE58_ALPHABET).map((ch, idx) => [ch, idx])
);

function decodeBase58Bytes(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of input.trim()) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) {
      throw new Error('INVALID_BASE58_SECRET');
    }
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of input.trim()) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function parseSolSecretKey(raw: string): Uint8Array {
  const cleaned = raw.trim();
  if (cleaned.startsWith('[')) {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length < 32) {
      throw new Error('INVALID_SOL_JSON_SECRET');
    }
    return Uint8Array.from(parsed);
  }
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',').map((n) => Number(n.trim()));
    if (parts.length < 32 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('INVALID_SOL_BYTE_LIST');
    }
    return Uint8Array.from(parts);
  }
  return decodeBase58Bytes(cleaned);
}

function resolveSolSecretKey(): string | null {
  const raw =
    process.env.SOL_PAYOUT_SECRET_KEY ||
    WALLET_CONFIG.SOL.privateKey ||
    '';
  return raw.trim() || null;
}

function resolveCryptoGatewayConfig(): { url: string; apiKey: string } | null {
  const url = (process.env.CRYPTO_GATEWAY_API_URL || '').trim();
  const apiKey = (process.env.CRYPTO_GATEWAY_API_KEY || '').trim();
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

function resolvePiPayoutConfig(): { url: string; apiKey: string } | null {
  const url = (process.env.PI_PAYOUT_API_URL || '').trim();
  const apiKey = (process.env.PI_API_KEY || WALLET_CONFIG.PI.privateKey || '').trim();
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

function resolveCashGatewayConfig(): { url: string; apiKey: string } | null {
  const url = (process.env.CASH_GATEWAY_API_URL || '').trim();
  const apiKey = (process.env.CASH_GATEWAY_API_KEY || '').trim();
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyWithPropagationRetry(params: {
  asset: string;
  txHash: string;
  destinationWallet: string;
  amountAsset: number;
  amountUsd: number;
}) {
  let check = await verifyPayoutTransactionOnChain({
    asset: params.asset,
    txHash: params.txHash,
    destinationAddress: params.destinationWallet,
    expectedAmountAsset: params.amountAsset,
    expectedAmountUsd: params.amountUsd,
  });
  if (
    !check.verified &&
    (check.reason?.includes('NOT_FOUND') || check.reason?.includes('NOT_VERIFIED_ONCHAIN'))
  ) {
    await sleep(1500);
    check = await verifyPayoutTransactionOnChain({
      asset: params.asset,
      txHash: params.txHash,
      destinationAddress: params.destinationWallet,
      expectedAmountAsset: params.amountAsset,
      expectedAmountUsd: params.amountUsd,
    });
  }
  return check;
}

export class MultiAssetPayoutWorker {
  private isProcessing = false;
  private readonly workerId = `multi_worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

  async dispatchApprovedPayout(
    input: MultiAssetDispatchInput,
    options?: {
      store?: PayoutDispatchStore;
      bypassEnvGuardForTest?: boolean;
      skipSolvencyCheckForTest?: boolean;
      broadcasterOverride?: MultiAssetBroadcaster;
    }
  ): Promise<MultiAssetDispatchResult> {
    const store: PayoutDispatchStore = options?.store || LedgerService;
    const asset = String(input.cryptoAsset || '').trim().toUpperCase();
    const requestId = String(input.requestId || '').trim();
    const dest = String(input.destinationWallet || '').trim();
    const points = Number(input.points || Math.round((Number(input.amountUsd) || 0) * 100));

    if (!options?.store && !dbPool) {
      return {
        ok: false,
        requestId,
        asset,
        error: 'POSTGRES_REQUIRED_FOR_PAYOUT',
      };
    }

    const autoEnabled =
      process.env.PAYOUT_EXECUTION_MODE === 'EXTERNAL_SIGNER_HSM' &&
      process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true';
    if (!options?.bypassEnvGuardForTest && !autoEnabled) {
      return {
        ok: false,
        requestId,
        asset,
        error: 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING',
      };
    }

    const ks = await store.getKillSwitchStatus();
    if (ks.is_enabled) {
      return {
        ok: false,
        requestId,
        asset,
        error: 'PAYOUT_KILL_SWITCH_ACTIVE',
      };
    }

    if (!requestId || !dest) {
      return {
        ok: false,
        requestId,
        asset,
        error: 'INVALID_PAYOUT_DISPATCH_INPUT',
      };
    }

    // 1. TON delegato al worker dedicato con il medesimo claim atomico & state machine
    if (asset === 'TON') {
      const tonRes = await tonPayoutWorker.executeRealTonPayout(
        {
          requestId,
          destinationWallet: dest,
          amountTon: Number(input.amountAsset),
          memo: input.memo,
        },
        options?.store || options?.bypassEnvGuardForTest
          ? {
              store: options.store,
              bypassEnvGuardForTest: options.bypassEnvGuardForTest,
              senderOverride: options.broadcasterOverride
                ? async (ctx) => {
                    const b = await options.broadcasterOverride!({
                      requestId: ctx.requestId,
                      attemptId: ctx.attemptId,
                      asset: 'TON',
                      destinationWallet: ctx.destinationWallet,
                      amountAsset: ctx.amountTon,
                      amountUsd: Number(input.amountUsd),
                      memo: ctx.memo,
                    });
                    return { txHash: b.txHash, fromWallet: 'test_ton_wallet' };
                  }
                : undefined,
            }
          : undefined
      );
      return {
        ok: tonRes.ok,
        requestId,
        asset,
        attemptId: tonRes.attemptId,
        dispatchState: tonRes.dispatchState,
        txHash: tonRes.txHash,
        explorerUrl: tonRes.explorerUrl,
        error: tonRes.error,
      };
    }

    // 2. Guard pre-trasmissione: verifica che l'asset sia verificabile indipendentemente
    const verifGuard = canVerifyPayoutAssetIndependently(asset, dest);
    if (!verifGuard.verifiable) {
      return {
        ok: false,
        requestId,
        asset,
        error: verifGuard.reason || 'PAYOUT_ASSET_INDEPENDENT_VERIFICATION_UNAVAILABLE',
      };
    }

    // 3. Verifica solvibilita' tesoreria PER SINGOLO ASSET prima di ogni invio fondi
    if (!options?.skipSolvencyCheckForTest) {
      try {
        const [solvency, breakdown] = await Promise.all([
          SettlementService.getTreasurySolvencyStatus(),
          SettlementService.getTreasuryAssetBreakdown(),
        ]);
        const assetVault = breakdown.find((v) => v.asset === asset);
        if (
          !solvency.isSolvent ||
          !assetVault ||
          (points > 0 && assetVault.netWithdrawablePoints < points)
        ) {
          return {
            ok: false,
            requestId,
            asset,
            error: 'TREASURY_VAULT_ASSET_INSUFFICIENT',
          };
        }
      } catch (err: any) {
        return {
          ok: false,
          requestId,
          asset,
          error: err?.message || 'TREASURY_SOLVENCY_CHECK_FAILED',
        };
      }
    }

    // Validazione pre-claim configurazione e parametri per evitare claim spuri
    let solSecret: string | null = null;
    let piCfg: { url: string; apiKey: string } | null = null;
    let cryptoGw: { url: string; apiKey: string } | null = null;
    let cashGw: { url: string; apiKey: string } | null = null;

    if (!options?.broadcasterOverride) {
      if (asset === 'SOL') {
        solSecret = resolveSolSecretKey();
        if (!solSecret) {
          return { ok: false, requestId, asset, error: 'SOL_PAYOUT_WALLET_NOT_CONFIGURED' };
        }
        try {
          new PublicKey(dest);
        } catch {
          return { ok: false, requestId, asset, error: 'INVALID_SOL_DESTINATION_ADDRESS' };
        }
        const lamports = Math.round(Number(input.amountAsset) * LAMPORTS_PER_SOL);
        if (!Number.isFinite(lamports) || lamports <= 0) {
          return { ok: false, requestId, asset, error: 'INVALID_SOL_TRANSFER_AMOUNT' };
        }
      } else if (asset === 'PI') {
        piCfg = resolvePiPayoutConfig();
        if (!piCfg) {
          return { ok: false, requestId, asset, error: 'PI_PAYOUT_API_NOT_CONFIGURED' };
        }
      } else if (asset === 'USDT' || asset === 'USDC') {
        cryptoGw = resolveCryptoGatewayConfig();
        if (!cryptoGw) {
          return { ok: false, requestId, asset, error: 'STABLECOIN_GATEWAY_NOT_CONFIGURED' };
        }
      } else if (asset === 'CASH_AIRTM' || asset === 'CASH_PAYEER' || asset === 'CASH_VOLET') {
        cashGw = resolveCashGatewayConfig();
        if (!cashGw) {
          return { ok: false, requestId, asset, error: 'CASH_GATEWAY_NOT_CONFIGURED' };
        }
      } else {
        return { ok: false, requestId, asset, error: `UNSUPPORTED_PAYOUT_ASSET_${asset || 'UNKNOWN'}` };
      }
    }

    // 4. CLAIM ATOMICO POSTGRESQL PRIMA DELLA TRASMISSIONE
    const attemptId = `att_${asset.toLowerCase()}_${crypto.randomUUID()}`;
    const claim = await store.claimPayoutForDispatch({
      requestId,
      workerId: this.workerId,
      attemptId,
    });
    if (!claim.ok) {
      return {
        ok: false,
        requestId,
        asset,
        attemptId: claim.active_attempt_id,
        dispatchState: claim.dispatch_state,
        txHash: claim.tx_hash,
        error: claim.error || 'PAYOUT_CLAIM_REJECTED',
      };
    }

    const effectiveAttemptId = claim.attempt_id || attemptId;
    let broadcastEntered = false;
    let capturedTxHash = '';
    let explorerUrl: string | undefined;
    let dispatchRawProof: Record<string, unknown> = {};
    let completionNote = `${asset} verified payout completed`;

    try {
      if (options?.broadcasterOverride) {
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: `${asset}_BROADCAST_INITIATED`,
        });
        broadcastEntered = true;

        const out = await options.broadcasterOverride({
          requestId,
          attemptId: effectiveAttemptId,
          asset,
          destinationWallet: dest,
          amountAsset: Number(input.amountAsset || input.amountUsd),
          amountUsd: Number(input.amountUsd),
          memo: input.memo || `ActionFlow ${requestId}`,
        });
        capturedTxHash = String(out.txHash || '').trim();
        explorerUrl = out.explorerUrl;
        dispatchRawProof = out.rawProof || {};
      } else if (asset === 'SOL') {
        const recipientPubkey = new PublicKey(dest);
        const lamports = Math.round(Number(input.amountAsset) * LAMPORTS_PER_SOL);
        const keypair = await Keypair.fromSecretKey(parseSolSecretKey(solSecret!));
        const rpc = (process.env.SOL_RPC || DEFAULT_SOL_RPC).trim();
        const connection = new Connection(rpc, 'finalized');
        const balance = await connection.getBalance(keypair.publicKey, 'finalized');
        const feeBufferLamports = 10_000;
        if (balance < lamports + feeBufferLamports) {
          await store.updatePayoutDispatchState({
            requestId,
            attemptId: effectiveAttemptId,
            nextState: 'FAILED_SAFE_RETRYABLE',
            actor: this.workerId,
            reason: 'PRE_BROADCAST_CONFIRMED:INSUFFICIENT_HOT_WALLET_SOL_BALANCE',
          });
          return {
            ok: false,
            requestId,
            asset,
            attemptId: effectiveAttemptId,
            dispatchState: 'FAILED_SAFE_RETRYABLE',
            error: 'INSUFFICIENT_HOT_WALLET_SOL_BALANCE',
          };
        }

        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: 'SOL_BROADCAST_INITIATED',
          metadata: { fromWallet: keypair.publicKey.toBase58(), lamports },
        });
        broadcastEntered = true;

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: recipientPubkey,
            lamports,
          })
        );
        capturedTxHash = await sendAndConfirmTransaction(connection, tx, [keypair], {
          commitment: 'finalized',
        });
        explorerUrl = `https://solscan.io/tx/${capturedTxHash}`;
        dispatchRawProof = { fromWallet: keypair.publicKey.toBase58(), lamports };
        completionNote = `SOL on-chain finalized via ${keypair.publicKey.toBase58()}`;
      } else if (asset === 'PI') {
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: 'PI_PAYOUT_API_BROADCAST_INITIATED',
        });
        broadcastEntered = true;

        const res = await fetch(piCfg!.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${piCfg!.apiKey}`,
            'Idempotency-Key': effectiveAttemptId,
          },
          body: JSON.stringify({
            requestId,
            attemptId: effectiveAttemptId,
            asset: 'PI',
            destination: dest,
            amount: Number(input.amountAsset),
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        capturedTxHash = String(data?.txid || data?.txHash || data?.identifier || '').trim();
        if (!res.ok || capturedTxHash.length < 8) {
          await store.updatePayoutDispatchState({
            requestId,
            attemptId: effectiveAttemptId,
            nextState: 'UNCERTAIN_TIMEOUT',
            actor: this.workerId,
            txHash: capturedTxHash || null,
            reason: `PI_PAYOUT_UNCERTAIN_HTTP_${res.status}`,
          });
          return {
            ok: false,
            requestId,
            asset,
            attemptId: effectiveAttemptId,
            dispatchState: 'UNCERTAIN_TIMEOUT',
            error: data?.error || `PI_PAYOUT_HTTP_${res.status}`,
          };
        }
        explorerUrl = `https://blockexplorer.minepi.com/tx/${capturedTxHash}`;
        dispatchRawProof = data || {};
        completionNote = 'PI payout confirmed via Pi API & Horizon';
      } else if (asset === 'USDT' || asset === 'USDC') {
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: `${asset}_GATEWAY_BROADCAST_INITIATED`,
        });
        broadcastEntered = true;

        const res = await fetch(cryptoGw!.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cryptoGw!.apiKey}`,
            'Idempotency-Key': effectiveAttemptId,
          },
          body: JSON.stringify({
            requestId,
            attemptId: effectiveAttemptId,
            asset,
            destination: dest,
            amount: Number(input.amountAsset || input.amountUsd),
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        capturedTxHash = String(data?.txHash || data?.tx_hash || data?.id || '').trim();
        if (!res.ok || capturedTxHash.length < 8) {
          await store.updatePayoutDispatchState({
            requestId,
            attemptId: effectiveAttemptId,
            nextState: 'UNCERTAIN_TIMEOUT',
            actor: this.workerId,
            txHash: capturedTxHash || null,
            reason: `STABLECOIN_GATEWAY_UNCERTAIN_HTTP_${res.status}`,
          });
          return {
            ok: false,
            requestId,
            asset,
            attemptId: effectiveAttemptId,
            dispatchState: 'UNCERTAIN_TIMEOUT',
            error: data?.error || `STABLECOIN_GATEWAY_HTTP_${res.status}`,
          };
        }
        dispatchRawProof = data || {};
        completionNote = `${asset} settled & verified independently`;
      } else if (asset === 'CASH_AIRTM' || asset === 'CASH_PAYEER' || asset === 'CASH_VOLET') {
        const recipientTarget = dest.includes(':') ? dest.split(':').slice(1).join(':').trim() : dest;
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: `${asset}_GATEWAY_BROADCAST_INITIATED`,
        });
        broadcastEntered = true;

        const res = await fetch(cashGw!.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cashGw!.apiKey}`,
            'Idempotency-Key': effectiveAttemptId,
          },
          body: JSON.stringify({
            requestId,
            attemptId: effectiveAttemptId,
            provider: asset.replace('CASH_', ''),
            recipient: recipientTarget,
            currency: 'USD',
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        capturedTxHash = String(
          data?.receiptId || data?.txHash || data?.transactionId || ''
        ).trim();
        if (!res.ok || capturedTxHash.length < 8) {
          await store.updatePayoutDispatchState({
            requestId,
            attemptId: effectiveAttemptId,
            nextState: 'UNCERTAIN_TIMEOUT',
            actor: this.workerId,
            txHash: capturedTxHash || null,
            reason: `CASH_GATEWAY_UNCERTAIN_HTTP_${res.status}`,
          });
          return {
            ok: false,
            requestId,
            asset,
            attemptId: effectiveAttemptId,
            dispatchState: 'UNCERTAIN_TIMEOUT',
            error: data?.error || `CASH_GATEWAY_HTTP_${res.status}`,
          };
        }
        dispatchRawProof = data || {};
        completionNote = `${asset} confirmed via Cash Gateway & Verifier`;
      }

      if (!capturedTxHash || capturedTxHash.length < 8) {
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'UNCERTAIN_TIMEOUT',
          actor: this.workerId,
          reason: 'MISSING_TX_HASH_AFTER_BROADCAST',
        });
        return {
          ok: false,
          requestId,
          asset,
          attemptId: effectiveAttemptId,
          dispatchState: 'UNCERTAIN_TIMEOUT',
          error: 'MISSING_TX_HASH_AFTER_BROADCAST',
        };
      }

      // 5. GUARD DI VERIFICA INDIPENDENTE PRIMA DEL COMPLETAMENTO:
      //    Mai marcare verified=true o chiudere il payout senza verifica reale!
      const expectedAmtAsset =
        asset === 'USDT' || asset === 'USDC' || asset.startsWith('CASH_')
          ? Number(input.amountAsset || input.amountUsd)
          : Number(input.amountAsset);

      const independentCheck = await verifyWithPropagationRetry({
        asset,
        txHash: capturedTxHash,
        destinationWallet: dest,
        amountAsset: expectedAmtAsset,
        amountUsd: Number(input.amountUsd),
      });

      if (!independentCheck.verified) {
        await store.updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: 'UNCERTAIN_TIMEOUT',
          actor: this.workerId,
          txHash: capturedTxHash,
          reason: `INDEPENDENT_VERIFICATION_FAILED:${independentCheck.reason || 'UNVERIFIED'}`,
          metadata: {
            dispatchRawProof,
            verificationReason: independentCheck.reason || null,
          },
        });
        return {
          ok: false,
          requestId,
          asset,
          attemptId: effectiveAttemptId,
          dispatchState: 'UNCERTAIN_TIMEOUT',
          txHash: capturedTxHash,
          error: independentCheck.reason || 'PAYOUT_INDEPENDENT_VERIFICATION_FAILED',
        };
      }

      await store.updatePayoutDispatchState({
        requestId,
        attemptId: effectiveAttemptId,
        nextState: 'CONFIRMED_ONCHAIN',
        actor: this.workerId,
        txHash: capturedTxHash,
        reason: 'INDEPENDENT_VERIFIER_CONFIRMED',
        metadata: {
          observedAmountAsset: independentCheck.observedAmountAsset ?? expectedAmtAsset,
          commitmentLevel: independentCheck.commitmentLevel || null,
        },
      });

      const proofRes = await store.recordPayoutOnchainVerification({
        requestId,
        asset,
        network: independentCheck.network || asset,
        txHash: capturedTxHash,
        destinationAddress: dest,
        expectedAmountAsset: expectedAmtAsset,
        observedAmountAsset: independentCheck.observedAmountAsset ?? expectedAmtAsset,
        confirmations: independentCheck.confirmations ?? 1,
        commitmentLevel: independentCheck.commitmentLevel || 'confirmed',
        verified: true,
        verifiedBy: `worker:multi_asset_${asset.toLowerCase()}+onchain_verifier`,
        rawProof: {
          dispatchRawProof,
          independentCheck: independentCheck.rawProof || null,
        },
      });
      if (!proofRes.ok) {
        return {
          ok: false,
          requestId,
          asset,
          attemptId: effectiveAttemptId,
          dispatchState: 'CONFIRMED_ONCHAIN',
          txHash: capturedTxHash,
          error: proofRes.error || 'ONCHAIN_PROOF_RECORD_FAILED',
        };
      }

      const completion = await store.completePayout(
        requestId,
        capturedTxHash,
        completionNote
      );
      if (!completion.ok) {
        return {
          ok: false,
          requestId,
          asset,
          attemptId: effectiveAttemptId,
          dispatchState: 'CONFIRMED_ONCHAIN',
          txHash: capturedTxHash,
          error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
        };
      }

      return {
        ok: true,
        requestId,
        asset,
        attemptId: effectiveAttemptId,
        dispatchState: 'COMPLETED',
        txHash: capturedTxHash,
        explorerUrl,
      };
    } catch (err: any) {
      await store
        .updatePayoutDispatchState({
          requestId,
          attemptId: effectiveAttemptId,
          nextState: broadcastEntered ? 'UNCERTAIN_TIMEOUT' : 'FAILED_SAFE_RETRYABLE',
          actor: this.workerId,
          txHash: capturedTxHash || null,
          reason: broadcastEntered
            ? `BROADCAST_ERROR_UNCERTAIN:${String(err?.message || 'DISPATCH_ERROR').slice(0, 180)}`
            : `PRE_BROADCAST_CONFIRMED:${String(err?.message || 'PRE_SEND_ERROR').slice(0, 180)}`,
        })
        .catch(() => {});

      return {
        ok: false,
        requestId,
        asset,
        attemptId: effectiveAttemptId,
        dispatchState: broadcastEntered ? 'UNCERTAIN_TIMEOUT' : 'FAILED_SAFE_RETRYABLE',
        txHash: capturedTxHash || undefined,
        error: err?.message || 'MULTI_ASSET_DISPATCH_ERROR',
      };
    }
  }

  /**
   * Riconciliazione RPC/Gateway dei payout rimasti in stato `UNCERTAIN_TIMEOUT`
   * o bloccati dopo timeout/crash con `txHash` noto.
   */
  async reconcileUncertainPayouts(options?: {
    store?: PayoutDispatchStore;
    staleSeconds?: number;
  }): Promise<{ ok: boolean; reconciled: MultiAssetDispatchResult[]; error?: string }> {
    const store: PayoutDispatchStore = options?.store || LedgerService;
    if (!options?.store && !dbPool) {
      return { ok: false, reconciled: [], error: 'POSTGRES_REQUIRED' };
    }

    const ks = await store.getKillSwitchStatus();
    if (ks.is_enabled) {
      return { ok: false, reconciled: [], error: 'PAYOUT_KILL_SWITCH_ACTIVE' };
    }

    const uncertain = await store.getUncertainPayoutDispatches(50, options?.staleSeconds ?? 90);
    if (!uncertain.ok) {
      return { ok: false, reconciled: [], error: uncertain.error || 'UNCERTAIN_FETCH_FAILED' };
    }

    const tonReconcile = await tonPayoutWorker.reconcileUncertainTonPayouts({
      store,
      staleSeconds: options?.staleSeconds ?? 90,
    });
    const reconciled: MultiAssetDispatchResult[] = tonReconcile.reconciled.map((r) => ({
      ok: r.ok,
      requestId: r.requestId,
      asset: 'TON',
      attemptId: r.attemptId,
      dispatchState: r.dispatchState,
      txHash: r.txHash,
      error: r.error,
    }));

    for (const row of uncertain.items) {
      const asset = String(row.crypto_asset || '').toUpperCase();
      if (asset === 'TON') continue;

      const reqId = String(row.request_id);
      const attemptId = String(row.attempt_id || '');
      const dest = String(row.wallet_address || '').trim();
      const txHash = String(row.tx_hash || '').trim();
      const amountAsset = Number(row.asset_amount || row.amount_usd || 0);
      const amountUsd = Number(row.amount_usd || 0);

      if (!txHash) {
        reconciled.push({
          ok: false,
          requestId: reqId,
          asset,
          attemptId,
          dispatchState: String(row.dispatch_state || 'UNCERTAIN_TIMEOUT'),
          error: 'NO_TX_HASH_FOR_RECONCILIATION_RESEND_BLOCKED',
        });
        continue;
      }

      const check = await verifyPayoutTransactionOnChain({
        asset,
        txHash,
        destinationAddress: dest,
        expectedAmountAsset: amountAsset,
        expectedAmountUsd: amountUsd,
      });

      if (!check.verified) {
        reconciled.push({
          ok: false,
          requestId: reqId,
          asset,
          attemptId,
          dispatchState: String(row.dispatch_state || 'UNCERTAIN_TIMEOUT'),
          txHash,
          error: check.reason || 'RECONCILIATION_VERIFICATION_FAILED',
        });
        continue;
      }

      if (attemptId && row.dispatch_state !== 'CONFIRMED_ONCHAIN') {
        await store.updatePayoutDispatchState({
          requestId: reqId,
          attemptId,
          nextState: 'CONFIRMED_ONCHAIN',
          actor: `reconciler:${this.workerId}`,
          txHash,
          reason: 'RECONCILED_VIA_INDEPENDENT_VERIFIER',
        });
      }

      await store.recordPayoutOnchainVerification({
        requestId: reqId,
        asset,
        network: check.network || asset,
        txHash,
        destinationAddress: dest,
        expectedAmountAsset: amountAsset,
        observedAmountAsset: check.observedAmountAsset ?? amountAsset,
        confirmations: check.confirmations ?? 1,
        commitmentLevel: check.commitmentLevel || 'reconciled_confirmed',
        verified: true,
        verifiedBy: `reconciler:${this.workerId}`,
        rawProof: check.rawProof || {},
      });

      const completion = await store.completePayout(
        reqId,
        txHash,
        `${asset} riconciliato dopo timeout/crash`
      );

      reconciled.push({
        ok: Boolean(completion.ok),
        requestId: reqId,
        asset,
        attemptId,
        dispatchState: completion.ok ? 'COMPLETED' : 'CONFIRMED_ONCHAIN',
        txHash,
        error: completion.ok ? undefined : completion.error,
      });
    }

    return { ok: true, reconciled };
  }

  async processApprovedPayouts(): Promise<{
    ok: boolean;
    processed: MultiAssetDispatchResult[];
    error?: string;
  }> {
    if (!dbPool) {
      return { ok: false, processed: [], error: 'POSTGRES_REQUIRED' };
    }
    const autoEnabled =
      process.env.PAYOUT_EXECUTION_MODE === 'EXTERNAL_SIGNER_HSM' &&
      process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true';
    if (!autoEnabled) {
      return { ok: false, processed: [], error: 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING' };
    }
    const ks = await LedgerService.getKillSwitchStatus();
    if (ks.is_enabled) {
      return { ok: false, processed: [], error: 'PAYOUT_KILL_SWITCH_ACTIVE' };
    }
    if (this.isProcessing) {
      return { ok: false, processed: [], error: 'WORKER_ALREADY_PROCESSING' };
    }

    this.isProcessing = true;
    const processed: MultiAssetDispatchResult[] = [];
    try {
      let res;
      try {
        res = await dbPool.query(
          `SELECT request_id,
                  UPPER(COALESCE(crypto_asset, 'TON')) AS crypto_asset,
                  wallet_address,
                  COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
                  amount_usd::float8 AS amount_usd,
                  points
             FROM core.payout_requests
            WHERE status = 'APPROVED'
              AND UPPER(COALESCE(crypto_asset, 'TON')) IN (
                'TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'
              )
              AND amount_usd > 0
              AND COALESCE(dispatch_state, 'UNCLAIMED') IN ('UNCLAIMED', 'FAILED_SAFE_RETRYABLE')
            ORDER BY approved_at ASC NULLS LAST, created_at ASC
            LIMIT 15`
        );
      } catch {
        res = await dbPool.query(
          `SELECT request_id,
                  UPPER(COALESCE(crypto_asset, 'TON')) AS crypto_asset,
                  wallet_address,
                  COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
                  amount_usd::float8 AS amount_usd,
                  points
             FROM core.payout_requests
            WHERE status = 'APPROVED'
              AND UPPER(COALESCE(crypto_asset, 'TON')) IN (
                'TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'
              )
              AND amount_usd > 0
            ORDER BY approved_at ASC NULLS LAST, created_at ASC
            LIMIT 15`
        );
      }

      for (const row of res.rows) {
        const dispatchRes = await this.dispatchApprovedPayout({
          requestId: String(row.request_id),
          cryptoAsset: String(row.crypto_asset),
          destinationWallet: String(row.wallet_address),
          amountAsset: Number(row.asset_amount || row.amount_usd || 0),
          amountUsd: Number(row.amount_usd || 0),
          points: Number(row.points || 0),
          memo: `ActionFlow ${row.request_id}`,
        });
        processed.push(dispatchRes);
      }

      return { ok: true, processed };
    } finally {
      this.isProcessing = false;
    }
  }

  getStatus() {
    const autoEnabled =
      process.env.PAYOUT_EXECUTION_MODE === 'EXTERNAL_SIGNER_HSM' &&
      process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true';
    return {
      dbConnected: Boolean(dbPool),
      isProcessing: this.isProcessing,
      payoutExecutionMode: autoEnabled ? 'EXTERNAL_SIGNER_HSM' : 'MANUAL_EXTERNAL',
      serverKeyCustodyDisabled: !autoEnabled,
      persistentDoubleSpendGuardEnabled: true,
      supportedAssets: [
        'TON',
        'SOL',
        'PI',
        'USDT',
        'USDC',
        'CASH_AIRTM',
        'CASH_PAYEER',
        'CASH_VOLET',
      ],
      channelsConfigured: {
        TON: autoEnabled && tonPayoutWorker.getStatus().hasHotWalletConfigured,
        SOL: autoEnabled && Boolean(resolveSolSecretKey()),
        PI: autoEnabled && Boolean(resolvePiPayoutConfig()),
        STABLECOIN_GATEWAY: autoEnabled && Boolean(resolveCryptoGatewayConfig()),
        CASH_GATEWAY: autoEnabled && Boolean(resolveCashGatewayConfig()),
      },
      solvencyGuardEnabled: true,
      perAssetVaultIsolationEnabled: true,
      simulatedHashesDisabled: true,
    };
  }
}

export const multiAssetPayoutWorker = new MultiAssetPayoutWorker();
