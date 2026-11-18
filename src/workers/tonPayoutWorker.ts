// ============================================================================
// TON PAYOUT WORKER — Invio Reale Blockchain TON Fail-Closed (@ton/ton)
// ============================================================================
// Nessun hash simulato, nessun completamento senza tx_hash confermato on-chain.
// Se mnemonic/RPC/saldo/conferma mancano o falliscono, restituisce errore
// esplicito e lascia il prelievo intatto senza mai invocare complete_payout_atomic.
// ============================================================================

import { Address, TonClient, WalletContractV4, internal, toNano, SendMode } from '@ton/ton';
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { dbPool, LedgerService } from '../db/ledgerService';

export interface TonDispatchInput {
  requestId: string;
  destinationWallet: string;
  amountTon: number;
  memo?: string;
}

export interface TonDispatchResult {
  ok: boolean;
  requestId: string;
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

function getTonRpcEndpoint(): string {
  return (process.env.TON_RPC || DEFAULT_TON_RPC).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TonPayoutWorker {
  private isRunning = false;
  private isProcessing = false;

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
      `[PAYOUT WORKER] Avviato in modalità TON_REAL_ONCHAIN_OR_ADMIN_DISBURSE (mnemonic configurato: ${Boolean(resolvePayoutMnemonic())}).`
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

  async executeRealTonPayout(input: TonDispatchInput): Promise<TonDispatchResult> {
    if (!dbPool) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'POSTGRES_REQUIRED_FOR_TON_PAYOUT',
      };
    }

    if (!this.isValidTonAddress(input.destinationWallet)) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'INVALID_TON_DESTINATION_ADDRESS',
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

    const mnemonicRaw = resolvePayoutMnemonic();
    if (!mnemonicRaw) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'TON_PAYOUT_WALLET_NOT_CONFIGURED',
      };
    }

    const words = mnemonicRaw.split(/\s+/).filter(Boolean);
    const isValidMnemonic = await mnemonicValidate(words).catch(() => false);
    if (!isValidMnemonic) {
      return {
        ok: false,
        requestId: input.requestId,
        error: 'INVALID_TON_PAYOUT_MNEMONIC',
      };
    }

    try {
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
      const fromWallet = wallet.address.toString({ bounceable: false });

      const balanceNano = await openedWallet.getBalance();
      const amountFixed = amountTon.toFixed(6);
      const transferNano = toNano(amountFixed);
      const gasBufferNano = toNano('0.03');

      if (balanceNano < transferNano + gasBufferNano) {
        return {
          ok: false,
          requestId: input.requestId,
          fromWallet,
          error: 'INSUFFICIENT_HOT_WALLET_TON_BALANCE',
        };
      }

      const seqnoBefore = await openedWallet.getSeqno();
      const bodyComment = input.memo || `ActionFlow Payout ${input.requestId}`;

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
      let confirmedTxHash: string | null = null;
      for (let attempt = 0; attempt < CONFIRMATION_POLL_ATTEMPTS; attempt++) {
        await sleep(CONFIRMATION_POLL_DELAY_MS);
        const seqnoCurrent = await openedWallet.getSeqno().catch(() => seqnoBefore);
        if (seqnoCurrent > seqnoBefore) {
          const txs = await client
            .getTransactions(wallet.address, { limit: 5 })
            .catch(() => []);
          for (const tx of txs) {
            if (tx.outMessagesCount > 0) {
              confirmedTxHash = tx.hash().toString('hex');
              break;
            }
          }
          if (confirmedTxHash) break;
        }
      }

      if (!confirmedTxHash) {
        return {
          ok: false,
          requestId: input.requestId,
          fromWallet,
          error: 'TON_TX_NOT_CONFIRMED_ON_CHAIN',
        };
      }

      const completion = await LedgerService.completePayout(
        input.requestId,
        confirmedTxHash,
        `TON on-chain confirmed via ${fromWallet}`
      );

      if (!completion.ok) {
        return {
          ok: false,
          requestId: input.requestId,
          fromWallet,
          txHash: confirmedTxHash,
          error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
        };
      }

      return {
        ok: true,
        requestId: input.requestId,
        fromWallet,
        txHash: confirmedTxHash,
        explorerUrl: `https://tonviewer.com/transaction/${confirmedTxHash}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        requestId: input.requestId,
        error: err?.message || 'TON_RPC_DISPATCH_ERROR',
      };
    }
  }

  async processApprovedTonPayouts(): Promise<{
    ok: boolean;
    processed: TonDispatchResult[];
    error?: string;
  }> {
    if (!dbPool) {
      return { ok: false, processed: [], error: 'POSTGRES_REQUIRED' };
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
      const res = await dbPool.query(
        `SELECT request_id, wallet_address, COALESCE(asset_amount, amount_ton)::float8 AS amount_ton
           FROM core.payout_requests
          WHERE status = 'APPROVED'
            AND UPPER(COALESCE(crypto_asset, 'TON')) = 'TON'
            AND UPPER(COALESCE(payout_channel, 'CRYPTO_DIRECT')) IN ('CRYPTO_DIRECT', 'TON')
            AND COALESCE(asset_amount, amount_ton) > 0
          ORDER BY approved_at ASC NULLS LAST, created_at ASC
          LIMIT 10`
      );

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
    const hasMnemonic = Boolean(resolvePayoutMnemonic());
    return {
      isRunning: this.isRunning,
      mode: hasMnemonic ? 'APPROVED_ONCHAIN_TON_DISPATCH' : 'ADMIN_APPROVAL_AND_REAL_HASH_REQUIRED',
      hasHotWalletConfigured: hasMnemonic,
      autoPayoutUnapprovedDisabled: true,
      simulatedHashesDisabled: true,
      dbConnected: Boolean(dbPool),
      limits: {
        minPoints: MIN_PAYOUT_POINTS,
        maxSingleTon: MAX_SINGLE_PAYOUT_TON,
      },
    };
  }
}

export const tonPayoutWorker = new TonPayoutWorker();
