// ============================================================================
// MULTI-ASSET PAYOUT WORKER — Orchestrazione Fail-Closed per Tutti gli Asset
// ============================================================================
// Supporta:
//   - Crypto Diretta: TON (via TonPayoutWorker), SOL (via @solana/web3.js),
//     USDT / USDC (via CRYPTO_GATEWAY_API_URL), PI (via PI_PAYOUT_API_URL)
//   - Cash USD Gateway: CASH_AIRTM, CASH_PAYEER, CASH_VOLET
//     (via CASH_GATEWAY_API_URL)
//
// Garanzie inderogabili:
//   1. Verifica PostgreSQL + solvibilita' netta `SettlementService.getTreasurySolvencyStatus()`
//      prima di qualunque invio fondi.
//   2. Nessun hash simulato o fittizio: in assenza di credenziali / RPC / conferma
//      reale restituisce errore esplicito (`txHash: undefined`) senza mai
//      invocare `core.complete_payout_atomic`.
// ============================================================================

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { dbPool, LedgerService } from '../db/ledgerService';
import { SettlementService } from '../db/settlementService';
import { WALLET_CONFIG } from '../config/wallets';
import { tonPayoutWorker } from './tonPayoutWorker';

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
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

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

export class MultiAssetPayoutWorker {
  private isProcessing = false;

  async dispatchApprovedPayout(input: MultiAssetDispatchInput): Promise<MultiAssetDispatchResult> {
    const asset = String(input.cryptoAsset || '').trim().toUpperCase();
    const requestId = String(input.requestId || '').trim();
    const dest = String(input.destinationWallet || '').trim();
    const points = Number(input.points || Math.round((Number(input.amountUsd) || 0) * 100));

    if (!dbPool) {
      return {
        ok: false,
        requestId,
        asset,
        error: 'POSTGRES_REQUIRED_FOR_PAYOUT',
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

    // Verifica rigorosa solvibilita' tesoreria netta prima di ogni invio fondi
    try {
      const solvency = await SettlementService.getTreasurySolvencyStatus();
      if (!solvency.isSolvent || (points > 0 && solvency.remainingGrossPointsCapacity < points)) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'TREASURY_SOLVENCY_INSUFFICIENT',
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

    // 1. TON (reale on-chain via TonPayoutWorker)
    if (asset === 'TON') {
      const tonRes = await tonPayoutWorker.executeRealTonPayout({
        requestId,
        destinationWallet: dest,
        amountTon: Number(input.amountAsset),
        memo: input.memo,
      });
      return {
        ok: tonRes.ok,
        requestId,
        asset,
        txHash: tonRes.txHash,
        explorerUrl: tonRes.explorerUrl,
        error: tonRes.error,
      };
    }

    // 2. SOL (reale on-chain via @solana/web3.js)
    if (asset === 'SOL') {
      const solSecret = resolveSolSecretKey();
      if (!solSecret) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'SOL_PAYOUT_WALLET_NOT_CONFIGURED',
        };
      }

      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(dest);
      } catch {
        return {
          ok: false,
          requestId,
          asset,
          error: 'INVALID_SOL_DESTINATION_ADDRESS',
        };
      }

      const lamports = Math.round(Number(input.amountAsset) * LAMPORTS_PER_SOL);
      if (!Number.isFinite(lamports) || lamports <= 0) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'INVALID_SOL_TRANSFER_AMOUNT',
        };
      }

      try {
        const keypair = await Keypair.fromSecretKey(parseSolSecretKey(solSecret));
        const rpc = (process.env.SOL_RPC || DEFAULT_SOL_RPC).trim();
        const connection = new Connection(rpc, 'confirmed');
        const balance = await connection.getBalance(keypair.publicKey, 'confirmed');
        const feeBufferLamports = 10_000;
        if (balance < lamports + feeBufferLamports) {
          return {
            ok: false,
            requestId,
            asset,
            error: 'INSUFFICIENT_HOT_WALLET_SOL_BALANCE',
          };
        }

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: recipientPubkey,
            lamports,
          })
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
          commitment: 'confirmed',
        });

        const completion = await LedgerService.completePayout(
          requestId,
          signature,
          `SOL on-chain confirmed via ${keypair.publicKey.toBase58()}`
        );
        if (!completion.ok) {
          return {
            ok: false,
            requestId,
            asset,
            txHash: signature,
            error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
          };
        }

        return {
          ok: true,
          requestId,
          asset,
          txHash: signature,
          explorerUrl: `https://solscan.io/tx/${signature}`,
        };
      } catch (err: any) {
        return {
          ok: false,
          requestId,
          asset,
          error: err?.message || 'SOL_RPC_DISPATCH_ERROR',
        };
      }
    }

    // 3. PI Network (Stellar G... + API ufficiale Pi)
    if (asset === 'PI') {
      if (!/^G[A-Z2-7]{55}$/.test(dest)) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'INVALID_PI_DESTINATION_ADDRESS',
        };
      }
      const piCfg = resolvePiPayoutConfig();
      if (!piCfg) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'PI_PAYOUT_API_NOT_CONFIGURED',
        };
      }

      try {
        const res = await fetch(piCfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${piCfg.apiKey}`,
          },
          body: JSON.stringify({
            requestId,
            asset: 'PI',
            destination: dest,
            amount: Number(input.amountAsset),
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        const txHash = String(data?.txid || data?.txHash || data?.identifier || '').trim();
        if (!res.ok || txHash.length < 8) {
          return {
            ok: false,
            requestId,
            asset,
            error: data?.error || `PI_PAYOUT_HTTP_${res.status}`,
          };
        }
        const completion = await LedgerService.completePayout(
          requestId,
          txHash,
          `PI payout confirmed via Pi API`
        );
        if (!completion.ok) {
          return {
            ok: false,
            requestId,
            asset,
            txHash,
            error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
          };
        }
        return {
          ok: true,
          requestId,
          asset,
          txHash,
          explorerUrl: `https://blockexplorer.minepi.com/tx/${txHash}`,
        };
      } catch (err: any) {
        return {
          ok: false,
          requestId,
          asset,
          error: err?.message || 'PI_PAYOUT_DISPATCH_ERROR',
        };
      }
    }

    // 4. Stablecoin 1:1 USD (USDT / USDC via Crypto Custody Gateway API)
    if (asset === 'USDT' || asset === 'USDC') {
      const cryptoGw = resolveCryptoGatewayConfig();
      if (!cryptoGw) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'STABLECOIN_GATEWAY_NOT_CONFIGURED',
        };
      }

      try {
        const res = await fetch(cryptoGw.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cryptoGw.apiKey}`,
          },
          body: JSON.stringify({
            requestId,
            asset,
            destination: dest,
            amount: Number(input.amountAsset || input.amountUsd),
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        const txHash = String(data?.txHash || data?.tx_hash || data?.id || '').trim();
        if (!res.ok || txHash.length < 8) {
          return {
            ok: false,
            requestId,
            asset,
            error: data?.error || `STABLECOIN_GATEWAY_HTTP_${res.status}`,
          };
        }
        const completion = await LedgerService.completePayout(
          requestId,
          txHash,
          `${asset} settled via Custody Gateway`
        );
        if (!completion.ok) {
          return {
            ok: false,
            requestId,
            asset,
            txHash,
            error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
          };
        }
        return { ok: true, requestId, asset, txHash };
      } catch (err: any) {
        return {
          ok: false,
          requestId,
          asset,
          error: err?.message || 'STABLECOIN_GATEWAY_DISPATCH_ERROR',
        };
      }
    }

    // 5. Gateway Cash USD (Airtm / Payeer / Volet)
    if (asset === 'CASH_AIRTM' || asset === 'CASH_PAYEER' || asset === 'CASH_VOLET') {
      const cashGw = resolveCashGatewayConfig();
      if (!cashGw) {
        return {
          ok: false,
          requestId,
          asset,
          error: 'CASH_GATEWAY_NOT_CONFIGURED',
        };
      }

      const recipientTarget = dest.includes(':') ? dest.split(':').slice(1).join(':').trim() : dest;
      try {
        const res = await fetch(cashGw.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cashGw.apiKey}`,
          },
          body: JSON.stringify({
            requestId,
            provider: asset.replace('CASH_', ''),
            recipient: recipientTarget,
            currency: 'USD',
            amountUsd: Number(input.amountUsd),
            memo: input.memo || `ActionFlow ${requestId}`,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        const data = await res.json().catch(() => ({}));
        const receiptId = String(
          data?.receiptId || data?.txHash || data?.transactionId || ''
        ).trim();
        if (!res.ok || receiptId.length < 8) {
          return {
            ok: false,
            requestId,
            asset,
            error: data?.error || `CASH_GATEWAY_HTTP_${res.status}`,
          };
        }
        const completion = await LedgerService.completePayout(
          requestId,
          receiptId,
          `${asset} confirmed via Cash Gateway`
        );
        if (!completion.ok) {
          return {
            ok: false,
            requestId,
            asset,
            txHash: receiptId,
            error: completion.error || 'LEDGER_COMPLETE_PAYOUT_FAILED',
          };
        }
        return { ok: true, requestId, asset, txHash: receiptId };
      } catch (err: any) {
        return {
          ok: false,
          requestId,
          asset,
          error: err?.message || 'CASH_GATEWAY_DISPATCH_ERROR',
        };
      }
    }

    return {
      ok: false,
      requestId,
      asset,
      error: `UNSUPPORTED_PAYOUT_ASSET_${asset || 'UNKNOWN'}`,
    };
  }

  async processApprovedPayouts(): Promise<{
    ok: boolean;
    processed: MultiAssetDispatchResult[];
    error?: string;
  }> {
    if (!dbPool) {
      return { ok: false, processed: [], error: 'POSTGRES_REQUIRED' };
    }
    if (this.isProcessing) {
      return { ok: false, processed: [], error: 'WORKER_ALREADY_PROCESSING' };
    }

    this.isProcessing = true;
    const processed: MultiAssetDispatchResult[] = [];
    try {
      const res = await dbPool.query(
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
    return {
      dbConnected: Boolean(dbPool),
      isProcessing: this.isProcessing,
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
        TON: tonPayoutWorker.getStatus().hasHotWalletConfigured,
        SOL: Boolean(resolveSolSecretKey()),
        PI: Boolean(resolvePiPayoutConfig()),
        STABLECOIN_GATEWAY: Boolean(resolveCryptoGatewayConfig()),
        CASH_GATEWAY: Boolean(resolveCashGatewayConfig()),
      },
      solvencyGuardEnabled: true,
      simulatedHashesDisabled: true,
    };
  }
}

export const multiAssetPayoutWorker = new MultiAssetPayoutWorker();
