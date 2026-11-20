// ============================================================================
// INBOUND SECURITY & WEBHOOK HARDENING — Allowlist URL, Schema, HMAC & Rate Limit
// ============================================================================

import crypto from 'node:crypto';
import { ALL_VERIFIED_DIRECT_PROVIDERS } from './verifiedDirectProviders';
import { PROJECTS_CATALOG } from './catalogData';

export type InboundAnomalyCategory =
  | 'TECHNICAL_ERROR'
  | 'SUSPICIOUS_BEHAVIOR'
  | 'REPLAY_ATTEMPT'
  | 'INVALID_SIGNATURE'
  | 'UNAUTHORIZED_URL'
  | 'FRAUDULENT_ACTIVITY';

const DEFAULT_PARTNER_DOMAINS: readonly string[] = [
  'audius.co',
  'fountain.fm',
  'www.fountain.fm',
  'submithub.com',
  'www.submithub.com',
  'dramabox.com',
  'www.dramabox.com',
  'shorttv.live',
  'www.shorttv.live',
  'kalostv.com',
  'www.kalostv.com',
  'reelshort.com',
  'www.reelshort.com',
  'plarium.com',
  'wargaming.net',
  'gaijin.net',
  'premise.com',
  'www.premise.com',
  't.me',
  'telegram.me',
  'telegram.dog',
];

function extractHostnameSafe(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function buildAllowedPartnerDomains(): Set<string> {
  const domains = new Set<string>(DEFAULT_PARTNER_DOMAINS.map((d) => d.toLowerCase()));

  for (const p of ALL_VERIFIED_DIRECT_PROVIDERS) {
    if (p.isLocked) continue;
    const h = extractHostnameSafe(p.directUrl || '');
    if (h) {
      domains.add(h);
      if (h.startsWith('www.')) domains.add(h.slice(4));
    }
    const compHost = extractHostnameSafe(p.compartmentPortalUrl || '');
    if (compHost) domains.add(compHost);
  }

  for (const card of PROJECTS_CATALOG) {
    for (const act of card.actions || []) {
      const h = extractHostnameSafe(act.directUrl || '');
      if (h) {
        domains.add(h);
        if (h.startsWith('www.')) domains.add(h.slice(4));
      }
    }
  }

  const extra = String(process.env.EXTRA_ALLOWED_PARTNER_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  for (const d of extra) {
    domains.add(d);
  }

  return domains;
}

const STATIC_ALLOWED_DOMAINS = buildAllowedPartnerDomains();

export function getAllowedPartnerDomains(): string[] {
  const extra = String(process.env.EXTRA_ALLOWED_PARTNER_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (extra.length === 0) return Array.from(STATIC_ALLOWED_DOMAINS);
  return Array.from(new Set([...STATIC_ALLOWED_DOMAINS, ...extra]));
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === '::1' ||
    h === '0.0.0.0'
  ) {
    return true;
  }
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^fc00:|^fd[0-9a-f]{2}:|^fe80:/i.test(h)) return true;
  return false;
}

export function validatePartnerTrackingUrl(
  rawUrl: string | null | undefined
): { valid: boolean; reason?: string; normalizedUrl?: string; hostname?: string } {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: true };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    return { valid: false, reason: 'TRACKING_URL_TOO_LONG' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'MALFORMED_TRACKING_URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'HTTPS_REQUIRED_FOR_TRACKING_URL' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'CREDENTIALS_IN_URL_FORBIDDEN' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(hostname)) {
    return { valid: false, reason: 'PRIVATE_OR_LOCAL_URL_FORBIDDEN' };
  }

  const allowedList = getAllowedPartnerDomains();
  const isAllowedDomain = allowedList.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );

  if (!isAllowedDomain) {
    return { valid: false, reason: 'UNAUTHORIZED_PARTNER_DOMAIN', hostname };
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    hostname,
  };
}

export function findUnexpectedKeys(
  obj: unknown,
  allowedKeys: ReadonlySet<string>
): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return [];
  }
  return Object.keys(obj as Record<string, unknown>).filter((k) => !allowedKeys.has(k));
}

export function safeHexOrStringEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyWebhookHmacSignature(params: {
  secret: string;
  timestampRaw: string;
  signatureRaw: string;
  canonicalPayload: string;
  maxSkewSeconds?: number;
  nowMs?: number;
}): { valid: boolean; reason?: string; timestampSeconds?: number } {
  const {
    secret,
    timestampRaw,
    signatureRaw,
    canonicalPayload,
    maxSkewSeconds = 300,
    nowMs = Date.now(),
  } = params;

  if (!secret) {
    return { valid: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  }

  const tsNum = Number(String(timestampRaw || '').trim());
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: 'WEBHOOK_TIMESTAMP_REQUIRED' };
  }

  const tsSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : Math.floor(tsNum);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - tsSec > maxSkewSeconds || tsSec - nowSec > 30) {
    return { valid: false, reason: 'WEBHOOK_TIMESTAMP_EXPIRED', timestampSeconds: tsSec };
  }

  const providedSig = String(signatureRaw || '')
    .trim()
    .replace(/^sha256=/i, '')
    .toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(providedSig)) {
    return { valid: false, reason: 'INVALID_WEBHOOK_SIGNATURE_FORMAT', timestampSeconds: tsSec };
  }

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${tsSec}.${canonicalPayload}`)
    .digest('hex')
    .toLowerCase();

  if (!safeHexOrStringEquals(providedSig, expectedHex)) {
    return { valid: false, reason: 'INVALID_WEBHOOK_SIGNATURE', timestampSeconds: tsSec };
  }

  return { valid: true, timestampSeconds: tsSec };
}

/**
 * Verifica HMAC-SHA256 direttamente sui byte raw ricevuti (`timestamp + "." + rawBody`).
 * Zero ricostruzioni o fallback a `JSON.stringify(req.body)`.
 */
export function verifyWebhookRawBodyHmac(params: {
  secret: string;
  timestampRaw: string;
  signatureRaw: string;
  rawBody: Buffer | Uint8Array | string | null | undefined;
  maxSkewSeconds?: number;
  nowMs?: number;
}): { valid: boolean; reason?: string; timestampSeconds?: number } {
  const {
    secret,
    timestampRaw,
    signatureRaw,
    rawBody,
    maxSkewSeconds = 300,
    nowMs = Date.now(),
  } = params;

  if (!secret) {
    return { valid: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  }
  if (rawBody === null || rawBody === undefined) {
    return { valid: false, reason: 'RAW_BODY_REQUIRED_FOR_HMAC' };
  }

  const tsNum = Number(String(timestampRaw || '').trim());
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: 'WEBHOOK_TIMESTAMP_REQUIRED' };
  }

  const tsSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : Math.floor(tsNum);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - tsSec > maxSkewSeconds || tsSec - nowSec > 30) {
    return { valid: false, reason: 'WEBHOOK_TIMESTAMP_EXPIRED', timestampSeconds: tsSec };
  }

  const providedSig = String(signatureRaw || '')
    .trim()
    .replace(/^sha256=/i, '')
    .toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(providedSig)) {
    return { valid: false, reason: 'INVALID_WEBHOOK_SIGNATURE_FORMAT', timestampSeconds: tsSec };
  }

  const bodyBytes = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === 'string'
    ? Buffer.from(rawBody, 'utf8')
    : Buffer.from(rawBody);

  const prefixBytes = Buffer.from(`${tsSec}.`, 'utf8');
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([prefixBytes, bodyBytes]))
    .digest('hex')
    .toLowerCase();

  if (!safeHexOrStringEquals(providedSig, expectedHex)) {
    return { valid: false, reason: 'INVALID_WEBHOOK_SIGNATURE', timestampSeconds: tsSec };
  }

  return { valid: true, timestampSeconds: tsSec };
}

/**
 * Controlla la finestra controllata di transizione per webhook legacy basati su secret condiviso.
 */
export function checkLegacyWebhookTransition(nowMs = Date.now()): {
  hmacStrictlyRequired: boolean;
  legacyExpired: boolean;
  sunsetAtIso: string | null;
} {
  const sunsetRaw = String(process.env.WEBHOOK_LEGACY_SECRET_SUNSET_AT || '').trim();
  let sunsetAtMs: number | null = null;
  let sunsetAtIso: string | null = null;
  if (sunsetRaw) {
    const parsed = Date.parse(sunsetRaw);
    if (Number.isFinite(parsed)) {
      sunsetAtMs = parsed;
      sunsetAtIso = new Date(parsed).toISOString();
    }
  }
  const legacyExpired = sunsetAtMs !== null && nowMs >= sunsetAtMs;
  const hmacStrictlyRequired =
    legacyExpired ||
    process.env.WEBHOOK_REQUIRE_HMAC === 'true' ||
    (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_REQUIRE_HMAC !== 'false');

  return {
    hmacStrictlyRequired,
    legacyExpired,
    sunsetAtIso,
  };
}

export function buildCanonicalWebhookPayload(fields: {
  provider: string;
  txId: string;
  userId: string;
  clickId: string;
  interactionId: string;
  payout: string;
  status: string;
  nonce: string;
}): string {
  return [
    `provider=${fields.provider}`,
    `txId=${fields.txId}`,
    `userId=${fields.userId}`,
    `clickId=${fields.clickId}`,
    `interactionId=${fields.interactionId}`,
    `payout=${fields.payout}`,
    `status=${fields.status}`,
    `nonce=${fields.nonce}`,
  ].join('&');
}

export class PerProviderRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(maxRequests = 120, windowMs = 60_000) {
    this.maxRequests = Math.max(1, maxRequests);
    this.windowMs = Math.max(1000, windowMs);
  }

  consume(providerKey: string, nowMs = Date.now()): {
    allowed: boolean;
    remaining: number;
    limit: number;
  } {
    const key = String(providerKey || 'unknown').trim().toLowerCase() || 'unknown';
    const cutoff = nowMs - this.windowMs;
    const prev = this.windows.get(key) || [];
    const active = prev.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      this.windows.set(key, active);
      return { allowed: false, remaining: 0, limit: this.maxRequests };
    }

    active.push(nowMs);
    this.windows.set(key, active);

    // Opportunistic bound against unbounded map growth
    if (this.windows.size > 500) {
      for (const [k, list] of this.windows.entries()) {
        if (list.every((ts) => ts <= cutoff)) {
          this.windows.delete(k);
        }
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - active.length),
      limit: this.maxRequests,
    };
  }
}
