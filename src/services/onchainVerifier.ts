// ============================================================================
// ON-CHAIN TRANSACTION VERIFIER — Verifica Indipendente Reale (Multi-Asset)
// ============================================================================
// Allineato a Kilo (commit 090f479):
//   - Verifica TON rigorosa su destinatario, importo >= 98%, !aborted, lt & utime > 0.
//   - Supporto completo Solana legacy e versioned transactions (v0 + Address
//     Lookup Tables in meta.loadedAddresses.writable/readonly).
//   - Protezione fail-closed per PI, USDT, USDC e CASH_* quando manca una
//     verifica indipendente (RPC o gateway HTTP di verifica).
//   - Pre-flight guard `canVerifyPayoutAssetIndependently` prima dell'invio.
// ============================================================================

import { Address } from '@ton/ton';
import { isObviouslyFakeTxReference } from '../lib/txRefValidation';

export interface OnchainVerifyInput {
  asset: string;
  txHash: string;
  destinationAddress: string;
  expectedAmountAsset: number;
  expectedAmountUsd: number;
}

export interface OnchainVerifyResult {
  verified: boolean;
  network: string;
  reason?: string;
  observedAmountAsset?: number;
  explorerUrl?: string;
  confirmations?: number;
  slot?: number;
  commitmentLevel?: string;
  rawProof?: Record<string, unknown>;
}

export interface VerifiabilityGuardResult {
  verifiable: boolean;
  network: string;
  reason?: string;
}

const DEFAULT_TON_RPC = 'https://toncenter.com/api/v2/jsonRPC';
const DEFAULT_TON_V3_BASE = 'https://toncenter.com/api/v3';
const DEFAULT_SOL_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_PI_HORIZON = 'https://api.mainnet.minepi.com';

function getSolanaUsdtMint(): string {
  return (process.env.SOL_USDT_MINT || '').trim() || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
}

function getSolanaUsdcMint(): string {
  return (process.env.SOL_USDC_MINT || '').trim() || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
}

function getTonUsdtMasterRaw(): string {
  const raw = (process.env.TON_USDT_MASTER || '').trim() || 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
  try {
    return Address.parse(raw).toRawString();
  } catch {
    return '';
  }
}

function getTonUsdcMasterRaw(): string {
  const raw = (process.env.TON_USDC_MASTER || '').trim();
  if (!raw) return '';
  try {
    return Address.parse(raw).toRawString();
  } catch {
    return '';
  }
}

function isObviouslyFakeHash(txHash: string): boolean {
  return isObviouslyFakeTxReference(txHash, 8);
}

export function shouldEnforceLiveRpcVerification(): boolean {
  // In produzione la verifica live NON puo' essere disattivata
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  const explicit = String(process.env.ONCHAIN_TX_VERIFY_REQUIRED || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0') return false;
  // Fail-closed di default anche fuori produzione, salvo disattivazione esplicita ONCHAIN_TX_VERIFY_REQUIRED=false
  return true;
}

export function isValidTonAddressFormat(address: string): boolean {
  try {
    Address.parse(String(address || '').trim());
    return true;
  } catch {
    return false;
  }
}

export function isValidSolanaAddressFormat(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address || '').trim());
}

export function isValidPiAddressFormat(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(String(address || '').trim());
}

/**
 * Guard pre-trasmissione e pre-completamento: verifica che esista una fonte
 * indipendente capace di accertare il payout per lo specifico asset/canale.
 */
export function canVerifyPayoutAssetIndependently(
  assetRaw: string,
  destinationAddress: string
): VerifiabilityGuardResult {
  const asset = String(assetRaw || '').trim().toUpperCase();
  const dest = String(destinationAddress || '').trim();
  const enforceLive = shouldEnforceLiveRpcVerification();

  if (!asset || !dest) {
    return { verifiable: false, network: asset || 'UNKNOWN', reason: 'INVALID_ASSET_OR_DESTINATION' };
  }

  if (asset === 'TON') {
    if (!isValidTonAddressFormat(dest)) {
      return { verifiable: false, network: 'TON', reason: 'INVALID_TON_DESTINATION_ADDRESS' };
    }
    return { verifiable: true, network: 'TON' };
  }

  if (asset === 'SOL') {
    if (!isValidSolanaAddressFormat(dest)) {
      return { verifiable: false, network: 'SOLANA', reason: 'INVALID_SOL_DESTINATION_ADDRESS' };
    }
    return { verifiable: true, network: 'SOLANA' };
  }

  if (asset === 'PI') {
    if (!isValidPiAddressFormat(dest)) {
      return { verifiable: false, network: 'PI', reason: 'INVALID_PI_DESTINATION_ADDRESS' };
    }
    const horizon = (process.env.PI_HORIZON_RPC || DEFAULT_PI_HORIZON).trim();
    if (enforceLive && !/^https?:\/\//i.test(horizon)) {
      return { verifiable: false, network: 'PI', reason: 'PI_VERIFIER_RPC_NOT_CONFIGURED' };
    }
    return { verifiable: true, network: 'PI' };
  }

  if (asset === 'USDT' || asset === 'USDC') {
    if (isValidTonAddressFormat(dest)) {
      const masterRaw = asset === 'USDT' ? getTonUsdtMasterRaw() : getTonUsdcMasterRaw();
      if (!masterRaw) {
        return {
          verifiable: false,
          network: 'TON_JETTON',
          reason: `UNCONFIGURED_TON_JETTON_MASTER_${asset}`,
        };
      }
      return { verifiable: true, network: 'TON_JETTON' };
    }
    if (isValidSolanaAddressFormat(dest)) {
      return { verifiable: true, network: 'SOLANA_SPL' };
    }
    const cryptoVerifyUrl = (process.env.CRYPTO_GATEWAY_VERIFY_URL || '').trim();
    if (enforceLive && !cryptoVerifyUrl) {
      return {
        verifiable: false,
        network: asset,
        reason: 'CRYPTO_GATEWAY_VERIFIER_NOT_CONFIGURED',
      };
    }
    return { verifiable: true, network: asset };
  }

  if (asset === 'CASH_PAYEER' || asset === 'CASH_AIRTM' || asset === 'CASH_VOLET') {
    const cashVerifyUrl = (process.env.CASH_GATEWAY_VERIFY_URL || '').trim();
    if (enforceLive && !cashVerifyUrl) {
      return {
        verifiable: false,
        network: asset,
        reason: 'CASH_GATEWAY_VERIFIER_NOT_CONFIGURED',
      };
    }
    return { verifiable: true, network: asset };
  }

  return { verifiable: false, network: asset, reason: 'UNSUPPORTED_VERIFICATION_ASSET' };
}

function tonHashMatches(candidateBase64OrHex: string, inputHash: string): boolean {
  const candidate = String(candidateBase64OrHex || '').trim();
  const cleanInput = inputHash.trim();
  if (!candidate || !cleanInput) return false;
  if (candidate === cleanInput) return true;
  try {
    const candidateHex = Buffer.from(candidate, 'base64').toString('hex').toLowerCase();
    if (candidateHex && candidateHex === cleanInput.toLowerCase()) return true;
  } catch {
    // Ignore decode error
  }
  try {
    const inputHex = Buffer.from(cleanInput, 'base64').toString('hex').toLowerCase();
    if (inputHex && inputHex === candidate.toLowerCase()) return true;
  } catch {
    // Ignore decode error
  }
  return false;
}

/**
 * Estrae tutte le chiavi account di una transazione Solana, supportando sia
 * transazioni legacy sia transazioni versioned (v0 con Address Lookup Tables).
 */
export function resolveSolanaAllAccountKeys(result: any): string[] {
  const staticKeys: string[] = Array.isArray(result?.transaction?.message?.accountKeys)
    ? result.transaction.message.accountKeys.map((k: any) =>
        typeof k === 'string' ? k.trim() : String(k?.pubkey || '').trim()
      )
    : [];

  const loadedWritable: string[] = Array.isArray(result?.meta?.loadedAddresses?.writable)
    ? result.meta.loadedAddresses.writable.map((k: any) => String(k || '').trim())
    : [];

  const loadedReadonly: string[] = Array.isArray(result?.meta?.loadedAddresses?.readonly)
    ? result.meta.loadedAddresses.readonly.map((k: any) => String(k || '').trim())
    : [];

  return [...staticKeys, ...loadedWritable, ...loadedReadonly].filter(Boolean);
}

function extractTokenUiAmount(entry: any): number {
  const ui = entry?.uiTokenAmount?.uiAmount;
  if (typeof ui === 'number' && Number.isFinite(ui)) {
    return ui;
  }
  const rawAmt = Number(entry?.uiTokenAmount?.amount ?? NaN);
  const decimals = Number(entry?.uiTokenAmount?.decimals ?? NaN);
  if (Number.isFinite(rawAmt) && Number.isFinite(decimals) && decimals >= 0) {
    return rawAmt / Math.pow(10, decimals);
  }
  return 0;
}

function normalizeTonMsgText(inMsg: any): string {
  if (!inMsg) return '';
  if (typeof inMsg.message === 'string') return inMsg.message;
  if (typeof inMsg?.msg_data?.text === 'string') {
    try {
      const decoded = Buffer.from(inMsg.msg_data.text, 'base64').toString('utf8');
      if (decoded) return decoded;
    } catch {
      return inMsg.msg_data.text;
    }
  }
  return '';
}

async function verifyTonTransactionOnChain(
  input: OnchainVerifyInput
): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  const rpcUrl = (process.env.TON_RPC || DEFAULT_TON_RPC).trim();
  const apiKey = (process.env.TONCENTER_API_KEY || '').trim();

  if (!Number.isFinite(Number(input.expectedAmountAsset)) || Number(input.expectedAmountAsset) <= 0) {
    return { verified: false, network: 'TON', reason: 'INVALID_EXPECTED_TON_AMOUNT' };
  }

  let targetAddrRaw = input.destinationAddress.trim();
  try {
    targetAddrRaw = Address.parse(targetAddrRaw).toRawString();
  } catch {
    return { verified: false, network: 'TON', reason: 'INVALID_TON_DESTINATION_ADDRESS' };
  }

  if (!shouldEnforceLiveRpcVerification()) {
    return {
      verified: cleanHash.length >= 16,
      network: 'TON',
      reason: cleanHash.length >= 16 ? 'SYNTAX_VERIFIED_TEST_MODE' : 'TON_TX_HASH_TOO_SHORT',
      explorerUrl: `https://tonviewer.com/transaction/${encodeURIComponent(cleanHash)}`,
    };
  }

  try {
    const restBase = rpcUrl.replace(/\/jsonRPC\/?$/i, '');
    const url = `${restBase}/getTransactions?address=${encodeURIComponent(
      input.destinationAddress.trim()
    )}&limit=50`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-API-Key'] = apiKey;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { verified: false, network: 'TON', reason: `TON_RPC_HTTP_${res.status}` };
    }
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.result) ? data.result : [];
    const expectedNano = Math.floor(Number(input.expectedAmountAsset) * 1e9 * 0.98);

    const matched = list.find((tx: any) => {
      if (!tonHashMatches(String(tx?.transaction_id?.hash || ''), cleanHash)) return false;
      if (!tx?.transaction_id?.lt || Number(tx?.utime || 0) <= 0) return false;
      if (tx?.description?.aborted === true) return false;
      const inMsg = tx?.in_msg || {};
      let destRaw = '';
      if (inMsg?.destination) {
        try {
          destRaw = Address.parse(String(inMsg.destination)).toRawString();
        } catch {
          return false;
        }
      }
      const valNano = Number(inMsg?.value || 0);
      return destRaw === targetAddrRaw && valNano >= Math.max(1, expectedNano);
    });

    if (!matched) {
      return {
        verified: false,
        network: 'TON',
        reason: 'TON_TX_NOT_FOUND_OR_AMOUNT_DEST_MISMATCH',
      };
    }

    const observedTon = Number(matched?.in_msg?.value || 0) / 1e9;
    return {
      verified: true,
      network: 'TON',
      observedAmountAsset: observedTon,
      confirmations: 1,
      commitmentLevel: 'masterchain_utime_confirmed',
      rawProof: {
        lt: matched?.transaction_id?.lt || null,
        utime: matched?.utime || null,
        hash: matched?.transaction_id?.hash || null,
        destinationRaw: targetAddrRaw,
        observedNano: Number(matched?.in_msg?.value || 0),
      },
      explorerUrl: `https://tonviewer.com/transaction/${encodeURIComponent(cleanHash)}`,
    };
  } catch (err: any) {
    return {
      verified: false,
      network: 'TON',
      reason: `TON_RPC_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
    };
  }
}

/**
 * Riconcilia un invio TON incerto dopo timeout o crash cercando sul wallet
 * mittente o destinatario una transazione corrispondente per destinatario,
 * importo e timestamp minimo (e opzionale commento/requestId).
 */
export async function reconcileTonTransferByCriteria(params: {
  destinationAddress: string;
  expectedAmountTon: number;
  minUtimeSec: number;
  memoHint?: string;
}): Promise<{ found: boolean; txHash?: string; observedAmountTon?: number; utime?: number; reason?: string }> {
  if (!shouldEnforceLiveRpcVerification()) {
    return { found: false, reason: 'LIVE_RPC_DISABLED_IN_TEST' };
  }
  const rpcUrl = (process.env.TON_RPC || DEFAULT_TON_RPC).trim();
  const apiKey = (process.env.TONCENTER_API_KEY || '').trim();
  let targetAddrRaw = '';
  try {
    targetAddrRaw = Address.parse(params.destinationAddress.trim()).toRawString();
  } catch {
    return { found: false, reason: 'INVALID_TON_DESTINATION_ADDRESS' };
  }

  try {
    const restBase = rpcUrl.replace(/\/jsonRPC\/?$/i, '');
    const url = `${restBase}/getTransactions?address=${encodeURIComponent(
      params.destinationAddress.trim()
    )}&limit=50`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-API-Key'] = apiKey;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { found: false, reason: `TON_RPC_HTTP_${res.status}` };
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.result) ? data.result : [];
    const expectedNano = Math.floor(Number(params.expectedAmountTon || 0) * 1e9 * 0.98);

    const matched = list.find((tx: any) => {
      const utime = Number(tx?.utime || 0);
      if (utime <= 0 || utime < Math.max(0, params.minUtimeSec - 120)) return false;
      if (tx?.description?.aborted === true) return false;
      const inMsg = tx?.in_msg || {};
      let destRaw = '';
      try {
        if (inMsg?.destination) destRaw = Address.parse(String(inMsg.destination)).toRawString();
      } catch {
        return false;
      }
      if (destRaw !== targetAddrRaw) return false;
      const valNano = Number(inMsg?.value || 0);
      if (valNano < Math.max(1, expectedNano)) return false;
      if (params.memoHint) {
        const msgText = normalizeTonMsgText(inMsg);
        if (msgText && !msgText.includes(params.memoHint)) return false;
      }
      return Boolean(tx?.transaction_id?.hash);
    });

    if (!matched) {
      return { found: false, reason: 'TON_RECONCILE_TX_NOT_FOUND' };
    }

    return {
      found: true,
      txHash: String(matched.transaction_id.hash),
      observedAmountTon: Number(matched?.in_msg?.value || 0) / 1e9,
      utime: Number(matched.utime),
    };
  } catch (err: any) {
    return { found: false, reason: err?.message || 'TON_RECONCILE_ERROR' };
  }
}

async function verifyTonJettonTransactionOnChain(
  input: OnchainVerifyInput,
  asset: 'USDT' | 'USDC'
): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  const expectedMasterRaw = asset === 'USDT' ? getTonUsdtMasterRaw() : getTonUsdcMasterRaw();
  if (!expectedMasterRaw) {
    return {
      verified: false,
      network: 'TON_JETTON',
      reason: `UNCONFIGURED_TON_JETTON_MASTER_${asset}`,
    };
  }

  if (!Number.isFinite(Number(input.expectedAmountAsset)) || Number(input.expectedAmountAsset) <= 0) {
    return { verified: false, network: 'TON_JETTON', reason: 'INVALID_EXPECTED_JETTON_AMOUNT' };
  }

  let targetAddrRaw = '';
  try {
    targetAddrRaw = Address.parse(input.destinationAddress.trim()).toRawString();
  } catch {
    return { verified: false, network: 'TON_JETTON', reason: 'INVALID_TON_DESTINATION_ADDRESS' };
  }

  if (!shouldEnforceLiveRpcVerification()) {
    return {
      verified: cleanHash.length >= 24,
      network: 'TON_JETTON',
      reason: cleanHash.length >= 24 ? 'SYNTAX_VERIFIED_TEST_MODE' : 'INVALID_TON_JETTON_TX_HASH',
      explorerUrl: `https://tonviewer.com/transaction/${encodeURIComponent(cleanHash)}`,
    };
  }

  const v3Base = (process.env.TON_V3_API_URL || DEFAULT_TON_V3_BASE).trim().replace(/\/+$/, '');
  const apiKey = (process.env.TONCENTER_API_KEY || '').trim();
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  try {
    const url = `${v3Base}/jetton/transfers?owner_address=${encodeURIComponent(
      targetAddrRaw
    )}&direction=in&limit=25`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { verified: false, network: 'TON_JETTON', reason: `TON_JETTON_RPC_HTTP_${res.status}` };
    }
    const payload = await res.json().catch(() => null);
    const transfers = Array.isArray(payload?.jetton_transfers) ? payload.jetton_transfers : [];
    const expectedUnits = Math.floor(Number(input.expectedAmountAsset) * 1e6 * 0.98);

    const matched = transfers.find((tr: any) => {
      if (tr?.transaction_aborted === true) return false;
      if (!tr?.transaction_lt && Number(tr?.transaction_now || 0) <= 0) return false;
      if (!tonHashMatches(String(tr?.transaction_hash || ''), cleanHash)) return false;

      const destCandidate = tr?.destination_owner || tr?.destination;
      let destRaw = '';
      if (destCandidate) {
        try {
          destRaw = Address.parse(String(destCandidate)).toRawString();
        } catch {
          return false;
        }
      }
      if (destRaw !== targetAddrRaw) return false;

      if (!tr?.jetton_master) return false;
      try {
        const mRaw = Address.parse(String(tr.jetton_master)).toRawString();
        if (mRaw !== expectedMasterRaw) return false;
      } catch {
        return false;
      }

      const amt = Number(tr?.amount || 0);
      return amt >= Math.max(1, expectedUnits);
    });

    if (!matched) {
      return {
        verified: false,
        network: 'TON_JETTON',
        reason: 'TON_JETTON_TX_NOT_VERIFIED_ONCHAIN',
      };
    }

    return {
      verified: true,
      network: 'TON_JETTON',
      observedAmountAsset: Number(matched.amount || 0) / 1e6,
      confirmations: 1,
      commitmentLevel: 'toncenter_v3_confirmed',
      rawProof: {
        transaction_hash: matched?.transaction_hash || null,
        transaction_lt: matched?.transaction_lt || null,
        transaction_now: matched?.transaction_now || null,
        jetton_master: matched?.jetton_master || null,
      },
      explorerUrl: `https://tonviewer.com/transaction/${encodeURIComponent(cleanHash)}`,
    };
  } catch (err: any) {
    return {
      verified: false,
      network: 'TON_JETTON',
      reason: `TON_JETTON_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
    };
  }
}

async function verifySolTransactionOnChain(
  input: OnchainVerifyInput
): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  const dest = input.destinationAddress.trim();
  const rpcUrl = (process.env.SOL_RPC_URL || process.env.SOL_RPC || DEFAULT_SOL_RPC).trim();

  if (!isValidSolanaAddressFormat(dest)) {
    return { verified: false, network: 'SOLANA', reason: 'INVALID_SOL_DESTINATION_ADDRESS' };
  }
  if (!Number.isFinite(Number(input.expectedAmountAsset)) || Number(input.expectedAmountAsset) <= 0) {
    return { verified: false, network: 'SOLANA', reason: 'INVALID_EXPECTED_SOL_AMOUNT' };
  }

  if (!shouldEnforceLiveRpcVerification()) {
    return {
      verified: cleanHash.length >= 32,
      network: 'SOLANA',
      reason: cleanHash.length >= 32 ? 'SYNTAX_VERIFIED_TEST_MODE' : 'SOL_SIGNATURE_TOO_SHORT',
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(cleanHash)}`,
    };
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          cleanHash,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { verified: false, network: 'SOLANA', reason: `SOL_RPC_HTTP_${res.status}` };
    }
    const payload = await res.json().catch(() => null);
    const result = payload?.result;
    if (
      !result ||
      result?.meta?.err !== null ||
      !Number.isFinite(Number(result?.slot)) ||
      Number(result?.slot) <= 0
    ) {
      return {
        verified: false,
        network: 'SOLANA',
        reason: 'SOL_TX_NOT_FOUND_OR_FAILED_ONCHAIN',
      };
    }

    const keys = resolveSolanaAllAccountKeys(result);
    const destIdx = keys.indexOf(dest);
    if (destIdx < 0) {
      return {
        verified: false,
        network: 'SOLANA',
        reason: 'SOL_DESTINATION_NOT_IN_TRANSACTION',
      };
    }

    const pre = Number(result?.meta?.preBalances?.[destIdx] ?? 0);
    const post = Number(result?.meta?.postBalances?.[destIdx] ?? 0);
    const deltaLamports = post - pre;
    const expectedMinLamports = Math.floor(Number(input.expectedAmountAsset) * 1e9 * 0.98);

    if (deltaLamports < Math.max(1, expectedMinLamports)) {
      return {
        verified: false,
        network: 'SOLANA',
        reason: 'SOL_RECEIVED_AMOUNT_BELOW_EXPECTED',
      };
    }

    return {
      verified: true,
      network: 'SOLANA',
      observedAmountAsset: deltaLamports / 1e9,
      slot: Number(result.slot),
      confirmations: 1,
      commitmentLevel: 'finalized',
      rawProof: {
        slot: Number(result.slot),
        lamports: deltaLamports,
        txVersion: result?.version ?? 'legacy',
        loadedAddressesCount:
          (result?.meta?.loadedAddresses?.writable?.length || 0) +
          (result?.meta?.loadedAddresses?.readonly?.length || 0),
      },
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(cleanHash)}`,
    };
  } catch (err: any) {
    return {
      verified: false,
      network: 'SOLANA',
      reason: `SOL_RPC_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
    };
  }
}

async function verifySolanaSplTransactionOnChain(
  input: OnchainVerifyInput,
  asset: 'USDT' | 'USDC'
): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  const dest = input.destinationAddress.trim();
  const rpcUrl = (process.env.SOL_RPC_URL || process.env.SOL_RPC || DEFAULT_SOL_RPC).trim();
  const expectedMint = asset === 'USDT' ? getSolanaUsdtMint() : getSolanaUsdcMint();

  if (!isValidSolanaAddressFormat(dest)) {
    return { verified: false, network: 'SOLANA_SPL', reason: 'INVALID_SOL_DESTINATION_ADDRESS' };
  }
  if (!Number.isFinite(Number(input.expectedAmountAsset)) || Number(input.expectedAmountAsset) <= 0) {
    return { verified: false, network: 'SOLANA_SPL', reason: 'INVALID_EXPECTED_SPL_AMOUNT' };
  }

  if (!shouldEnforceLiveRpcVerification()) {
    return {
      verified: cleanHash.length >= 32,
      network: 'SOLANA_SPL',
      reason: cleanHash.length >= 32 ? 'SYNTAX_VERIFIED_TEST_MODE' : 'SOL_SPL_SIGNATURE_TOO_SHORT',
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(cleanHash)}`,
    };
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          cleanHash,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { verified: false, network: 'SOLANA_SPL', reason: `SOL_RPC_HTTP_${res.status}` };
    }

    const payload = await res.json().catch(() => null);
    const result = payload?.result;
    if (
      !result ||
      result?.meta?.err !== null ||
      !Number.isFinite(Number(result?.slot)) ||
      Number(result?.slot) <= 0
    ) {
      return {
        verified: false,
        network: 'SOLANA_SPL',
        reason: 'SOL_SPL_TX_NOT_FOUND_OR_FAILED_ONCHAIN',
      };
    }

    const preBalances: any[] = Array.isArray(result?.meta?.preTokenBalances)
      ? result.meta.preTokenBalances
      : [];
    const postBalances: any[] = Array.isArray(result?.meta?.postTokenBalances)
      ? result.meta.postTokenBalances
      : [];

    let totalDelta = 0;
    for (const post of postBalances) {
      if (String(post?.mint || '') !== expectedMint) continue;
      if (String(post?.owner || '') !== dest) continue;
      const pre = preBalances.find((p) => p?.accountIndex === post?.accountIndex);
      const postUi = extractTokenUiAmount(post);
      const preUi = pre ? extractTokenUiAmount(pre) : 0;
      if (Number.isFinite(postUi) && Number.isFinite(preUi)) {
        totalDelta += postUi - preUi;
      }
    }

    const expectedMin = Number(input.expectedAmountAsset) * 0.98;
    if (totalDelta < Math.max(0.01, expectedMin)) {
      return {
        verified: false,
        network: 'SOLANA_SPL',
        reason: 'SOL_SPL_TX_NOT_VERIFIED_ONCHAIN',
      };
    }

    return {
      verified: true,
      network: 'SOLANA_SPL',
      observedAmountAsset: totalDelta,
      slot: Number(result.slot),
      confirmations: 1,
      commitmentLevel: 'finalized',
      rawProof: {
        slot: Number(result.slot),
        mint: expectedMint,
        deltaUi: totalDelta,
        txVersion: result?.version ?? 'legacy',
      },
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(cleanHash)}`,
    };
  } catch (err: any) {
    return {
      verified: false,
      network: 'SOLANA_SPL',
      reason: `SOL_SPL_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
    };
  }
}

async function verifyPiTransactionOnChain(input: OnchainVerifyInput): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  const dest = input.destinationAddress.trim();
  if (!isValidPiAddressFormat(dest)) {
    return { verified: false, network: 'PI', reason: 'INVALID_PI_DESTINATION_ADDRESS' };
  }
  if (!/^[0-9a-f]{64}$/i.test(cleanHash)) {
    return { verified: false, network: 'PI', reason: 'INVALID_PI_TX_HASH_FORMAT' };
  }
  if (!Number.isFinite(Number(input.expectedAmountAsset)) || Number(input.expectedAmountAsset) <= 0) {
    return { verified: false, network: 'PI', reason: 'INVALID_EXPECTED_PI_AMOUNT' };
  }

  if (!shouldEnforceLiveRpcVerification()) {
    return {
      verified: true,
      network: 'PI',
      reason: 'SYNTAX_VERIFIED_TEST_MODE',
      explorerUrl: `https://blockexplorer.minepi.com/tx/${encodeURIComponent(cleanHash)}`,
    };
  }

  const horizon = (process.env.PI_HORIZON_RPC || DEFAULT_PI_HORIZON).trim().replace(/\/+$/, '');
  try {
    const txRes = await fetch(`${horizon}/transactions/${encodeURIComponent(cleanHash)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!txRes.ok) {
      return { verified: false, network: 'PI', reason: `PI_HORIZON_HTTP_${txRes.status}` };
    }
    const txJson = await txRes.json().catch(() => null);
    if (!txJson || txJson.successful !== true) {
      return { verified: false, network: 'PI', reason: 'PI_TX_UNSUCCESSFUL_ONCHAIN' };
    }

    const payRes = await fetch(`${horizon}/transactions/${encodeURIComponent(cleanHash)}/payments`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!payRes.ok) {
      return { verified: false, network: 'PI', reason: `PI_PAYMENTS_HTTP_${payRes.status}` };
    }
    const payJson = await payRes.json().catch(() => null);
    const records: any[] = Array.isArray(payJson?._embedded?.records)
      ? payJson._embedded.records
      : [];
    const expectedMin = Number(input.expectedAmountAsset) * 0.98;
    const matched = records.find(
      (rec) =>
        rec?.transaction_successful !== false &&
        (!rec?.asset_type || rec.asset_type === 'native') &&
        String(rec?.to || '').trim() === dest &&
        Number(rec?.amount || 0) >= Math.max(0.0001, expectedMin)
    );

    if (!matched) {
      return {
        verified: false,
        network: 'PI',
        reason: 'PI_PAYMENT_DEST_OR_AMOUNT_MISMATCH',
      };
    }

    return {
      verified: true,
      network: 'PI',
      observedAmountAsset: Number(matched.amount || 0),
      confirmations: 1,
      commitmentLevel: 'ledger_closed',
      rawProof: { ledger: txJson?.ledger || null, paymentId: matched?.id || null },
      explorerUrl: `https://blockexplorer.minepi.com/tx/${encodeURIComponent(cleanHash)}`,
    };
  } catch (err: any) {
    return {
      verified: false,
      network: 'PI',
      reason: `PI_RPC_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
    };
  }
}

async function verifyCashReceipt(
  input: OnchainVerifyInput,
  asset: string
): Promise<OnchainVerifyResult> {
  const cleanHash = input.txHash.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(cleanHash)) {
    return { verified: false, network: asset, reason: 'INVALID_CASH_RECEIPT_FORMAT' };
  }

  const gatewayVerifyUrl = (process.env.CASH_GATEWAY_VERIFY_URL || '').trim();
  const gatewayApiKey = (process.env.CASH_GATEWAY_API_KEY || '').trim();
  if (gatewayVerifyUrl) {
    try {
      const res = await fetch(gatewayVerifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(gatewayApiKey ? { Authorization: `Bearer ${gatewayApiKey}` } : {}),
        },
        body: JSON.stringify({
          asset,
          receiptId: cleanHash,
          destination: input.destinationAddress,
          expectedUsd: input.expectedAmountUsd,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { verified: false, network: asset, reason: `CASH_GATEWAY_VERIFY_HTTP_${res.status}` };
      }
      const data = await res.json().catch(() => null);
      if (!data?.verified) {
        return { verified: false, network: asset, reason: 'CASH_GATEWAY_RECEIPT_REJECTED' };
      }
      if (data?.asset && String(data.asset).trim().toUpperCase() !== asset) {
        return { verified: false, network: asset, reason: 'CASH_GATEWAY_ASSET_MISMATCH' };
      }
      if (
        data?.destination &&
        String(data.destination).trim().toLowerCase() !== input.destinationAddress.trim().toLowerCase()
      ) {
        return { verified: false, network: asset, reason: 'CASH_GATEWAY_DESTINATION_MISMATCH' };
      }
      const observedUsd =
        data?.observedAmountUsd ?? data?.amountUsd ?? input.expectedAmountUsd;
      if (
        Number.isFinite(Number(observedUsd)) &&
        Number(observedUsd) < Number(input.expectedAmountUsd || 0) * 0.98
      ) {
        return { verified: false, network: asset, reason: 'CASH_GATEWAY_AMOUNT_BELOW_EXPECTED' };
      }
      return {
        verified: true,
        network: asset,
        observedAmountAsset: Number(observedUsd),
        confirmations: 1,
        commitmentLevel: 'cash_gateway_verified',
        rawProof: data || {},
      };
    } catch (err: any) {
      return {
        verified: false,
        network: asset,
        reason: `CASH_GATEWAY_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
      };
    }
  }

  // Fail-closed quando manca un verificatore indipendente configurato:
  // nessun payout CASH_* puo' completarsi su sola sintassi ricevuta in produzione
  // o quando ONCHAIN_TX_VERIFY_REQUIRED=true.
  if (shouldEnforceLiveRpcVerification()) {
    return {
      verified: false,
      network: asset,
      reason: 'CASH_GATEWAY_VERIFIER_NOT_CONFIGURED',
    };
  }

  return {
    verified: true,
    network: asset,
    observedAmountAsset: input.expectedAmountUsd,
    confirmations: 1,
    reason: 'SYNTAX_VERIFIED_TEST_MODE',
    commitmentLevel: 'receipt_syntax_verified',
    rawProof: { receiptId: cleanHash },
  };
}

export async function verifyPayoutTransactionOnChain(
  input: OnchainVerifyInput
): Promise<OnchainVerifyResult> {
  const asset = String(input.asset || '').trim().toUpperCase();
  const cleanHash = String(input.txHash || '').trim();

  if (isObviouslyFakeHash(cleanHash)) {
    return {
      verified: false,
      network: asset || 'UNKNOWN',
      reason: 'REAL_VERIFIABLE_TX_HASH_REQUIRED',
    };
  }

  if (asset === 'TON') {
    return verifyTonTransactionOnChain(input);
  }
  if (asset === 'SOL') {
    return verifySolTransactionOnChain(input);
  }
  if (asset === 'USDT' || asset === 'USDC') {
    const dest = input.destinationAddress.trim();
    if (isValidTonAddressFormat(dest)) {
      return verifyTonJettonTransactionOnChain(input, asset);
    }
    if (isValidSolanaAddressFormat(dest)) {
      return verifySolanaSplTransactionOnChain(input, asset);
    }
    const cryptoVerifyUrl = (process.env.CRYPTO_GATEWAY_VERIFY_URL || '').trim();
    const cryptoApiKey = (process.env.CRYPTO_GATEWAY_API_KEY || '').trim();
    if (cryptoVerifyUrl) {
      try {
        const res = await fetch(cryptoVerifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cryptoApiKey ? { Authorization: `Bearer ${cryptoApiKey}` } : {}),
          },
          body: JSON.stringify({
            asset,
            txHash: cleanHash,
            destination: dest,
            expectedAmountAsset: input.expectedAmountAsset,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.verified) {
          return { verified: false, network: asset, reason: 'CRYPTO_GATEWAY_TX_NOT_VERIFIED' };
        }
        if (data?.asset && String(data.asset).trim().toUpperCase() !== asset) {
          return { verified: false, network: asset, reason: 'CRYPTO_GATEWAY_ASSET_MISMATCH' };
        }
        if (
          data?.destination &&
          String(data.destination).trim().toLowerCase() !== dest.toLowerCase()
        ) {
          return { verified: false, network: asset, reason: 'CRYPTO_GATEWAY_DESTINATION_MISMATCH' };
        }
        const observedAmount = Number(
          data?.observedAmountAsset ?? data?.amount ?? input.expectedAmountAsset
        );
        if (
          Number.isFinite(observedAmount) &&
          observedAmount < Number(input.expectedAmountAsset || 0) * 0.98
        ) {
          return { verified: false, network: asset, reason: 'CRYPTO_GATEWAY_AMOUNT_BELOW_EXPECTED' };
        }
        return {
          verified: true,
          network: String(data?.network || `${asset}_GATEWAY`),
          observedAmountAsset: Number.isFinite(observedAmount) ? observedAmount : input.expectedAmountAsset,
          confirmations: Number.isFinite(Number(data?.confirmations)) ? Number(data.confirmations) : 1,
          commitmentLevel: String(data?.commitmentLevel || 'crypto_gateway_verified'),
          rawProof: data || {},
        };
      } catch (err: any) {
        return {
          verified: false,
          network: asset,
          reason: `CRYPTO_GATEWAY_VERIFY_FAILED: ${err?.message || 'NETWORK_ERROR'}`,
        };
      }
    }
    if (!shouldEnforceLiveRpcVerification() && cleanHash.length >= 24) {
      return { verified: true, network: asset, reason: 'SYNTAX_VERIFIED_TEST_MODE' };
    }
    return { verified: false, network: asset, reason: 'CRYPTO_GATEWAY_VERIFIER_NOT_CONFIGURED' };
  }

  if (asset === 'PI') {
    return verifyPiTransactionOnChain(input);
  }

  if (asset === 'CASH_PAYEER' || asset === 'CASH_AIRTM' || asset === 'CASH_VOLET') {
    return verifyCashReceipt(input, asset);
  }

  return {
    verified: false,
    network: asset || 'UNKNOWN',
    reason: 'UNSUPPORTED_VERIFICATION_ASSET',
  };
}
