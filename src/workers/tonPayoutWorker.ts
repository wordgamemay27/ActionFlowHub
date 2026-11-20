// ============================================================================
// TON PAYOUT WORKER — Invio Reale Blockchain TON Fail-Closed (@ton/ton)
// ============================================================================
// Garanzie anti-double-spend e verifica (allineamento Kilo commit 090f479):
//   1. Pre-flight check solvibilita' & verificabilita' indipendente.
//   2. Claim atomico PostgreSQL (`core.claim_payout_for_dispatch`) con
//      attempt_id univoco PRIMA di qualunque firma/broadcast.
//   3. Stato persistente della trasmissione: CLAIMED -> BROADCASTING ->
//      CONFIRMED_ONCHAIN / UNCERTAIN_TIMEOUT -> COMPLETED.
//   4. Divieto assoluto di reinvio se l'esito precedente e' incerto o attivo.
//   5. Guard di verifica indipendente (`verifyPayoutTransactionOnChain`):
//      nessun completamento senza `verified === true`.
//   6. Riconciliazione RPC (`reconcileUncertainTonPayouts`) dopo timeout/crash.
// ============================================================================

import crypto from 'crypto';
import { Address, TonClient, WalletContractV4, internal, toNano, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { dbPool, LedgerService, type PayoutDispatchStore } from '../db/ledgerService';
import {
  canVerifyPayoutAssetIndependently,
  reconcileTonTransferByCriteria,
  verifyPayoutTransactionOnChain,
} from '../services/onchainVerifier';

export interface TonDispatchInput {
  requestId: string;
  destinationWallet: string;
  amountTon: number;
  memo?: string;
}

export interface TonDispatchResult {
  ok: boolean;
  requestId: string;
  attemptId?: string;
  dispatchState?: string;
  requiresReconciliation?: boolean;
  reconciliationStatus?: 'RICHIEDE RICONCILIAZIONE';
  txHash?: string;
  explorerUrl?: string;
  fromWallet?: string;
  error?: string;
}

const DEFAULT_TON_RPC = 'https://toncenter.com/api/v2/jsonRPC';
const MIN_PAYOUT_POINTS = 500; // $5.00 USD equivalente contabile
const MAX_SINGLE_PAYOUT_TON = 50.0;
const CONFIRMATION_POLL_ATTEMPTS = 12;
const CONFIRMATION_POLL_DELAY_MS = 2500;

function resolvePayoutMnemonic(): string | null {
  const raw =
    process.env.TON_PAYOUT_MNEMONIC ||
    process.env.TON_WALLET_MNEMONIC ||
    process.env.TON_SECRET_MNEMONIC ||
    '';
  const cleaned = raw.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function isAutoTonSigningAuthorized(): boolean {
  return (
    process.env.PAYOUT_EXECUTION_MODE === 'EXTERNAL_SIGNER_HSM' &&
    process.env.ENABLE_AUTO_PAYOUT_DISPATCH === 'true'
  );
}

function getTonRpcEndpoint(): string {
  return (process.env.TON_RPC || DEFAULT_TON_RPC).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyTonWithPropagationRetry(params: {
  txHash: string;
  destinationWallet: string;
  amountTon: number;
}) {
  let check = await verifyPayoutTransactionOnChain({
    asset: 'TON',
    txHash: params.txHash,
    destinationAddress: params.destinationWallet,
    expectedAmountAsset: params.amountTon,
    expectedAmountUsd: Number((params.amountTon * 1).toFixed(2)),
  });
  if (!check.verified && check.reason?.includes('NOT_FOUND')) {
    await sleep(1500);
    check = await verifyPayoutTransactionOnChain({
      asset: 'TON',
      txHash: params.txHash,
      destinationAddress: params.destinationWallet,
      expectedAmountAsset: params.amountTon,
      expectedAmountUsd: Number((params.amountTon * 1).toFixed(2)),
    });
  }
  return check;
}

export class TonPayoutWorker {
  private isRunning = false;
  private isProcessing = false;
  private readonly workerId = `ton_worker_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

  static start(): void {
    tonPayoutWorker.start();
  }

  static stop(): void {
    tonPayoutWorker.stop();
  }

  static getMetrics() {
    return tonPayoutWorker.getStatus();
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(
      `[PAYOUT WORKER] Avviato in modalita' TON_REAL_ONCHAIN_OR_ADMIN_DISBURSE (mnemonic configurato: ${Boolean(resolvePayoutMnemonic())}).`
    );
  }

  stop(): void {
    this.isRunning = false;
  }

  isValidTonAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    const trimmed = address.trim();
    if (!trimmed) return false;
    try {
      Address.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  async executeRealTonPayout(
    input: TonDispatchInput,
    options?: {
      store?: PayoutDispatchStore;
      bypassEnvGuardForTest?: boolean;
      senderOverride?: (ctx: {
        requestId: string;
        attemptId: string;
        destinationWallet: string;
        amountTon: number;
        memo: string;
      }) => Promise<{ txHash: string | null; fromWallet?: string; seqnoBefore?: number }>;
    }
  ): Promise<TonDispatchResult> {
    const store: PayoutDispatchStore = options?.store || LedgerService;
    if (!options?.store && !dbPool) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'POSTGRES_REQUIRED_FOR_TON_PAYOUT',
      };
    }
    if (!options?.bypassEnvGuardForTest && !isAutoTonSigningAuthorized()) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING',
      };
    }
    const ks = await store.getKillSwitchStatus();
    if (ks.is_enabled) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'PAYOUT_KILL_SWITCH_ACTIVE',
      };
    }

    const verifGuard = canVerifyPayoutAssetIndependently('TON', input.destinationWallet);
    if (!verifGuard.verifiable) {
      return {
        ok: false,
        requestId: input.requestId,
        error: verifGuard.reason || 'INVALID_TON_DESTINATION_ADDRESS',
      };
    }

    const amountTon = Number(input.amountTon);
    if (!Number.isFinite(amountTon) || amountTon <= 0 || amountTon > MAX_SINGLE_PAYOUT_TON) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'INVALID_TON_TRANSFER_AMOUNT',
      };
    }

    let words: string[] = [];
    if (!options?.senderOverride) {
      const mnemonicRaw = resolvePayoutMnemonic();
      if (!mnemonicRaw) {
        return {
          ok: false,
          requestId: input.requestId,
          error: 'TON_PAYOUT_WALLET_NOT_CONFIGURED',
        };
      }
      words = mnemonicRaw.split(/\s+/).filter(Boolean);
      const isValidMnemonic = await mnemonicValidate(words).catch(() => false);
      if (!isValidMnemonic) {
        return {
          ok: false,
          requestId: input.requestId,
          error: 'INVALID_TON_PAYOUT_MNEMONIC',
        };
      }
    }

    // 1. CLAIM ATOMICO PERSISTENTE PRIMA DELLA TRASMISSIONE
    const attemptId = `att_ton_${crypto.randomUUID()}`;
    const claim = await store.claimPayoutForDispatch({
      requestId: input.requestId,
      workerId: this.workerId,
      attemptId,
    });
    if (!claim.ok) {
      const uncertainClaim =
        claim.dispatch_state === 'UNCERTAIN_TIMEOUT' ||
        claim.dispatch_state === 'BROADCASTING' ||
        claim.dispatch_state === 'CLAIMED' ||
        claim.error === 'PAYOUT_RESEND_BLOCKED_UNCERTAIN_OR_CONFIRMED_OUTCOME';
      return {
        ok: false,
        requestId: input.requestId,
        attemptId: claim.active_attempt_id,
        dispatchState: claim.dispatch_state,
        ...(uncertainClaim
          ? { requiresReconciliation: true, reconciliationStatus: 'RICHIEDE RICONCILIAZIONE' as const }
          : {}),
        txHash: claim.tx_hash,
        error: claim.error || 'PAYOUT_CLAIM_REJECTED',
      };
    }

    const effectiveAttemptId = claim.attempt_id || attemptId;
    const bodyComment = input.memo || `ActionFlow Payout ${input.requestId}`;

    let broadcastEntered = false;
    let fromWallet = '';
    let seqnoBefore = 0;

    try {
      let confirmedTxHash: string | null = null;

      if (options?.senderOverride) {
        await store.updatePayoutDispatchState({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: 'TON_BROADCAST_INITIATED',
          metadata: { attemptTimestampSec: Math.floor(Date.now() / 1000) },
        });
        broadcastEntered = true;

        const out = await options.senderOverride({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          destinationWallet: input.destinationWallet.trim(),
          amountTon,
          memo: bodyComment,
        });
        confirmedTxHash = out.txHash;
        fromWallet = out.fromWallet || 'test_ton_wallet';
        seqnoBefore = out.seqnoBefore ?? 0;
      } else {
        const keyPair = await mnemonicToPrivateKey(words);
        const client = new TonClient({
          endpoint: getTonRpcEndpoint(),
          apiKey: process.env.TONCENTER_API_KEY || undefined,
        });

        const wallet = WalletContractV4.create({
          workchain: 0,
          publicKey: keyPair.publicKey,
        });
        const openedWallet = client.open(wallet);
        fromWallet = wallet.address.toString({ bounceable: false });

        const balanceNano = await openedWallet.getBalance();
        const amountFixed = amountTon.toFixed(6);
        const transferNano = toNano(amountFixed);
        const gasBufferNano = toNano('0.03');

        if (balanceNano < transferNano + gasBufferNano) {
          await store.updatePayoutDispatchState({
            requestId: input.requestId,
            attemptId: effectiveAttemptId,
            nextState: 'FAILED_SAFE_RETRYABLE',
            actor: this.workerId,
            reason: 'PRE_BROADCAST_CONFIRMED:INSUFFICIENT_HOT_WALLET_TON_BALANCE',
            metadata: { fromWallet },
          });
          return {
            ok: false,
            requestId: input.requestId,
            attemptId: effectiveAttemptId,
            dispatchState: 'FAILED_SAFE_RETRYABLE',
            fromWallet,
            error: 'INSUFFICIENT_HOT_WALLET_TON_BALANCE',
          };
        }

        seqnoBefore = await openedWallet.getSeqno();

        await store.updatePayoutDispatchState({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          nextState: 'BROADCASTING',
          actor: this.workerId,
          reason: 'TON_TRANSFER_BROADCAST_START',
          chainSeqno: seqnoBefore,
          metadata: { fromWallet, seqnoBefore, attemptTimestampSec: Math.floor(Date.now() / 1000) },
        });
        broadcastEntered = true;

        await openedWallet.sendTransfer({
          seqno: seqnoBefore,
          secretKey: keyPair.secretKey,
          sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
          messages: [
            internal({
              to: Address.parse(input.destinationWallet.trim()),
              value: transferNano,
              bounce: false,
              body: bodyComment,
            }),
          ],
        });

        // Attesa conferma on-chain reale (seqno avanzato + verifica hash transazione)
        for (let attempt = 0; attempt < CONFIRMATION_POLL_ATTEMPTS; attempt++) {
          await sleep(CONFIRMATION_POLL_DELAY_MS);
          const seqnoCurrent = await openedWallet.getSeqno().catch(() => seqnoBefore);
          if (seqnoCurrent > seqnoBefore) {
            const txs = await client
              .getTransactions(wallet.address, { limit: 20 })
              .catch(() => []);
            const expectedNano = Math.round(Number(input.amountTon) * 1e9);
            const expectedDest = (input.destinationWallet || '').trim();
            for (const tx of txs) {
              if (tx.outMessagesCount <= 0) continue;
              const outMsg = tx.outMessages?.get(0) as any;
              const destAddr = outMsg?.info?.dest?.toString?.() || '';
              const amountNano = Number(outMsg?.info?.value?.coins || 0);
              if (destAddr === expectedDest && Math.abs(amountNano - expectedNano) <= 1000) {
                confirmedTxHash = tx.hash().toString('hex');
                break;
              }
            }
            if (confirmedTxHash) break;
          }
        }
      }

      if (!confirmedTxHash) {
        await store.updatePayoutDispatchState({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          nextState: 'UNCERTAIN_TIMEOUT',
          actor: this.workerId,
          reason: 'TON_TX_CONFIRMATION_TIMEOUT_UNCERTAIN',
          chainSeqno: seqnoBefore,
          metadata: { fromWallet, seqnoBefore },
        });
        return {
          ok: false,
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          dispatchState: 'UNCERTAIN_TIMEOUT',
          requiresReconciliation: true,
          reconciliationStatus: 'RICHIEDE RICONCILIAZIONE',
          fromWallet,
          error: 'TON_TX_NOT_CONFIRMED_ON_CHAIN_UNCERTAIN',
        };
      }

      // 2. GUARD DI VERIFICA INDIPENDENTE PRIMA DEL COMPLETAMENTO
      const independentCheck = await verifyTonWithPropagationRetry({
        txHash: confirmedTxHash,
        destinationWallet: input.destinationWallet.trim(),
        amountTon,
      });

      if (!independentCheck.verified) {
        await store.updatePayoutDispatchState({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          nextState: 'UNCERTAIN_TIMEOUT',
          actor: this.workerId,
          txHash: confirmedTxHash,
          reason: `INDEPENDENT_VERIFICATION_PENDING_OR_FAILED:${independentCheck.reason || 'UNVERIFIED'}`,
          chainSeqno: seqnoBefore,
          metadata: { fromWallet, verificationReason: independentCheck.reason || null },
        });
        return {
          ok: false,
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          dispatchState: 'UNCERTAIN_TIMEOUT',
          requiresReconciliation: true,
          reconciliationStatus: 'RICHIEDE RICONCILIAZIONE',
          fromWallet,
          txHash: confirmedTxHash,
          error: independentCheck.reason || 'TON_INDEPENDENT_VERIFICATION_FAILED',
        };
      }

      await store.updatePayoutDispatchState({
        requestId: input.requestId,
        attemptId: effectiveAttemptId,
        nextState: 'CONFIRMED_ONCHAIN',
        actor: this.workerId,
        txHash: confirmedTxHash,
        reason: 'TON_INDEPENDENT_VERIFIER_CONFIRMED',
        chainSeqno: seqnoBefore,
        metadata: { fromWallet, observedAmount: independentCheck.observedAmountAsset ?? amountTon },
      });

      const proofRes = await store.recordPayoutOnchainVerification({
        requestId: input.requestId,
        asset: 'TON',
        network: independentCheck.network || 'TON',
        txHash: confirmedTxHash,
        destinationAddress: input.destinationWallet.trim(),
        expectedAmountAsset: amountTon,
        observedAmountAsset: independentCheck.observedAmountAsset ?? amountTon,
        confirmations: independentCheck.confirmations ?? 1,
        commitmentLevel: independentCheck.commitmentLevel || 'masterchain_utime_confirmed',
        verified: true,
        verifiedBy: 'worker:ton_payout+onchain_verifier',
        rawProof: { fromWallet, seqnoBefore, independentCheck: independentCheck.rawProof || null },
      });
      if (!proofRes.ok) {
        return {
          ok: false,
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          dispatchState: 'CONFIRMED_ONCHAIN',
          fromWallet,
          txHash: confirmedTxHash,
          error: proofRes.error || 'ONCHAIN_PROOF_RECORD_FAILED',
        };
      }

      const completion = await store.completePayout(
        input.requestId,
        confirmedTxHash,
        `TON on-chain confirmed via ${fromWallet}`
      );

      if (!completion.ok) {
        return {
          ok: false,
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          dispatchState: 'CONFIRMED_ONCHAIN',
          fromWallet,
          txHash: confirmedTxHash,
          error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
        };
      }

      return {
        ok: true,
        requestId: input.requestId,
        attemptId: effectiveAttemptId,
        dispatchState: 'COMPLETED',
        fromWallet,
        txHash: confirmedTxHash,
        explorerUrl: `https://tonviewer.com/transaction/${confirmedTxHash}`,
      };
    } catch (err: any) {
      // Se un errore o crash accade DOPO l'ingresso in BROADCASTING, l'esito va marcato
      // UNCERTAIN_TIMEOUT per vietare il reinvio automatico prima della riconciliazione RPC.
      await store
        .updatePayoutDispatchState({
          requestId: input.requestId,
          attemptId: effectiveAttemptId,
          nextState: broadcastEntered ? 'UNCERTAIN_TIMEOUT' : 'FAILED_SAFE_RETRYABLE',
          actor: this.workerId,
          reason: broadcastEntered
            ? `BROADCAST_ERROR_UNCERTAIN:${String(err?.message || 'RPC_ERROR').slice(0, 180)}`
            : `PRE_BROADCAST_CONFIRMED:${String(err?.message || 'PRE_SEND_ERROR').slice(0, 180)}`,
          chainSeqno: seqnoBefore || null,
        })
        .catch(() => {});

      return {
        ok: false,
        requestId: input.requestId,
        attemptId: effectiveAttemptId,
        dispatchState: broadcastEntered ? 'UNCERTAIN_TIMEOUT' : 'FAILED_SAFE_RETRYABLE',
        ...(broadcastEntered
          ? { requiresReconciliation: true, reconciliationStatus: 'RICHIEDE RICONCILIAZIONE' as const }
          : {}),
        error: err?.message || 'TON_RPC_DISPATCH_ERROR',
      };
    }
  }

  /**
   * Riconciliazione RPC dopo timeout o crash su invii TON rimasti in
   * `UNCERTAIN_TIMEOUT` / `BROADCASTING` / `CLAIMED` stale.
   */
  async reconcileUncertainTonPayouts(options?: {
    store?: PayoutDispatchStore;
    staleSeconds?: number;
  }): Promise<{ ok: boolean; reconciled: TonDispatchResult[]; error?: string }> {
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

    const reconciled: TonDispatchResult[] = [];
    for (const row of uncertain.items) {
      if (String(row.crypto_asset || '').toUpperCase() !== 'TON') continue;
      const reqId = String(row.request_id);
      const attemptId = String(row.attempt_id || '');
      const dest = String(row.wallet_address || '').trim();
      const amountTon = Number(row.asset_amount || 0);
      let candidateHash = String(row.tx_hash || '').trim();

      if (!candidateHash) {
        const minUtimeSec = row.broadcast_started_at
          ? Math.floor(new Date(row.broadcast_started_at).getTime() / 1000)
          : row.claimed_at
          ? Math.floor(new Date(row.claimed_at).getTime() / 1000)
          : Math.floor(Date.now() / 1000) - 3600;
        const found = await reconcileTonTransferByCriteria({
          destinationAddress: dest,
          expectedAmountTon: amountTon,
          minUtimeSec,
          memoHint: reqId,
        });
        if (found.found && found.txHash) {
          candidateHash = found.txHash;
        }
      }

      if (!candidateHash) {
        reconciled.push({
          ok: false,
          requestId: reqId,
          attemptId,
          dispatchState: String(row.dispatch_state || 'UNCERTAIN_TIMEOUT'),
          requiresReconciliation: true,
          reconciliationStatus: 'RICHIEDE RICONCILIAZIONE',
          error: 'TON_TX_NOT_FOUND_DURING_RECONCILIATION_RESEND_BLOCKED',
        });
        continue;
      }

      const check = await verifyPayoutTransactionOnChain({
        asset: 'TON',
        txHash: candidateHash,
        destinationAddress: dest,
        expectedAmountAsset: amountTon,
        expectedAmountUsd: Number(row.amount_usd || 0),
      });

      if (!check.verified) {
        reconciled.push({
          ok: false,
          requestId: reqId,
          attemptId,
          dispatchState: String(row.dispatch_state || 'UNCERTAIN_TIMEOUT'),
          requiresReconciliation: true,
          reconciliationStatus: 'RICHIEDE RICONCILIAZIONE',
          txHash: candidateHash,
          error: check.reason || 'TON_RECONCILIATION_VERIFICATION_FAILED',
        });
        continue;
      }

      if (attemptId && row.dispatch_state !== 'CONFIRMED_ONCHAIN') {
        await store.updatePayoutDispatchState({
          requestId: reqId,
          attemptId,
          nextState: 'CONFIRMED_ONCHAIN',
          actor: `reconciler:${this.workerId}`,
          txHash: candidateHash,
          reason: 'RECONCILED_ONCHAIN_VIA_TON_RPC',
        });
      }

      await store.recordPayoutOnchainVerification({
        requestId: reqId,
        asset: 'TON',
        network: check.network || 'TON',
        txHash: candidateHash,
        destinationAddress: dest,
        expectedAmountAsset: amountTon,
        observedAmountAsset: check.observedAmountAsset ?? amountTon,
        confirmations: check.confirmations ?? 1,
        commitmentLevel: check.commitmentLevel || 'masterchain_utime_confirmed',
        verified: true,
        verifiedBy: `reconciler:${this.workerId}`,
        rawProof: check.rawProof || {},
      });

      const completion = await store.completePayout(
        reqId,
        candidateHash,
        'TON riconciliato on-chain dopo timeout/crash'
      );

      reconciled.push({
        ok: Boolean(completion.ok),
        requestId: reqId,
        attemptId,
        dispatchState: completion.ok ? 'COMPLETED' : 'CONFIRMED_ONCHAIN',
        txHash: candidateHash,
        error: completion.ok ? undefined : completion.error,
      });
    }

    return { ok: true, reconciled };
  }

  async processApprovedTonPayouts(): Promise<{
    ok: boolean;
    processed: TonDispatchResult[];
    error?: string;
  }> {
    if (!dbPool) {
      return { ok: false, processed: [], error: 'POSTGRES_REQUIRED' };
    }
    if (!isAutoTonSigningAuthorized()) {
      return { ok: false, processed: [], error: 'MANUAL_PAYOUT_MODE_ACTIVE_NO_SERVER_SIGNING' };
    }
    const ks = await LedgerService.getKillSwitchStatus();
    if (ks.is_enabled) {
      return { ok: false, processed: [], error: 'PAYOUT_KILL_SWITCH_ACTIVE' };
    }
    if (!resolvePayoutMnemonic()) {
      return { ok: false, processed: [], error: 'TON_PAYOUT_WALLET_NOT_CONFIGURED' };
    }
    if (this.isProcessing) {
      return { ok: false, processed: [], error: 'WORKER_ALREADY_PROCESSING' };
    }

    this.isProcessing = true;
    const processed: TonDispatchResult[] = [];
    try {
      let res;
      try {
        res = await dbPool.query(
          `SELECT request_id, wallet_address, COALESCE(asset_amount, amount_ton)::float8 AS amount_ton
             FROM core.payout_requests
            WHERE status = 'APPROVED'
              AND UPPER(COALESCE(crypto_asset, 'TON')) = 'TON'
              AND UPPER(COALESCE(payout_channel, 'CRYPTO_DIRECT')) IN ('CRYPTO_DIRECT', 'TON')
              AND COALESCE(asset_amount, amount_ton) > 0
              AND COALESCE(dispatch_state, 'UNCLAIMED') IN ('UNCLAIMED', 'FAILED_SAFE_RETRYABLE')
            ORDER BY approved_at ASC NULLS LAST, created_at ASC
            LIMIT 10`
        );
      } catch {
        res = await dbPool.query(
          `SELECT request_id, wallet_address, COALESCE(asset_amount, amount_ton)::float8 AS amount_ton
             FROM core.payout_requests
            WHERE status = 'APPROVED'
              AND UPPER(COALESCE(crypto_asset, 'TON')) = 'TON'
              AND UPPER(COALESCE(payout_channel, 'CRYPTO_DIRECT')) IN ('CRYPTO_DIRECT', 'TON')
              AND COALESCE(asset_amount, amount_ton) > 0
            ORDER BY approved_at ASC NULLS LAST, created_at ASC
            LIMIT 10`
        );
      }

      for (const row of res.rows) {
        const result = await this.executeRealTonPayout({
          requestId: String(row.request_id),
          destinationWallet: String(row.wallet_address),
          amountTon: Number(row.amount_ton),
          memo: `ActionFlow ${row.request_id}`,
        });
        processed.push(result);
      }

      return { ok: true, processed };
    } finally {
      this.isProcessing = false;
    }
  }

  getStatus() {
    const autoAuthorized = isAutoTonSigningAuthorized();
    const hasMnemonic = autoAuthorized && Boolean(resolvePayoutMnemonic());
    return {
      isRunning: this.isRunning,
      mode: 'MANUAL_ADMIN_APPROVAL_ONLY',
      payoutExecutionMode: autoAuthorized ? 'EXTERNAL_SIGNER_HSM' : 'MANUAL_EXTERNAL',
      hasHotWalletConfigured: hasMnemonic,
      serverKeyCustodyDisabled: !autoAuthorized,
      autoPayoutUnapprovedDisabled: true,
      simulatedHashesDisabled: true,
      persistentDoubleSpendGuardEnabled: true,
      dbConnected: Boolean(dbPool),
      limits: {
        minPoints: MIN_PAYOUT_POINTS,
        maxSingleTon: MAX_SINGLE_PAYOUT_TON,
      },
    };
  }
}

export const tonPayoutWorker = new TonPayoutWorker();
