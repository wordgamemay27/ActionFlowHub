// ============================================================================
// ACTIONFLOW HUB — FULL-STACK EXPRESS SERVER (POSTGRESQL AUTHORITATIVE LEDGER)
// ============================================================================

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { LedgerService, dbPool, bootstrapDatabaseSchema } from './db/ledgerService';
import { SettlementService } from './db/settlementService';
import providerAdminRouter from './routes/providerAdmin';
import { WALLET_CONFIG } from './config/wallets';
import { workers } from './workers';
import { refreshAndGetFxQuote } from './workers/blockchainListener';
import {
  normalizeCountryCode,
  resolveCountryEconomicProfile,
  listCountryEconomicProfiles,
  getCountryGeoEligibility,
  isNoRestrictionProvider,
} from './lib/geoEconomics';
import { refreshWorldBankPppFromApi } from './services/worldBankPpp';
import { sortProvidersByPriority } from './lib/providerPriority';
import {
  ALL_VERIFIED_DIRECT_PROVIDERS,
  VERIFIED_GAMES_PROVIDERS,
  VERIFIED_SOAP_PROVIDERS,
  VERIFIED_MUSIC_PROVIDERS,
  VERIFIED_AI_PROVIDERS,
  VERIFIED_UX_QA_PROVIDERS,
  VERIFIED_OCR_PROVIDERS,
  VERIFIED_DEPIN_PROVIDERS,
} from './lib/verifiedDirectProviders';

const TELEGRAM_AUTH_MAX_AGE_SECONDS = 300;
const ALLOWED_CATEGORIES = new Set([
  'VIDEO',
  'ADS',
  'MUSIC',
  'MICRO_DRAMA',
  'GAME',
  'SURVEY',
  'SHOPPING',
  'AI_TASK',
  'UX_QA',
  'RECEIPT',
  'TELEGRAM',
  'AIRDROP',
  'DEPIN',
  'OTHER',
]);

function safeTokenEquals(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Validazione crittografica rigorosa Telegram WebApp (HMAC-SHA256 + anti-replay auth_date <= 300s).
 * Nessun bypass isPreview per i flussi finanziari o di lettura saldo.
 */
export function verifyTelegramWebAppData(rawInitData: string | undefined): {
  valid: boolean;
  error?: string;
  userData?: { id: number; username?: string; first_name?: string; language_code?: string };
  authDate?: number;
} {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) {
    return { valid: false, error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' };
  }
  if (!rawInitData || typeof rawInitData !== 'string' || !rawInitData.trim()) {
    return { valid: false, error: 'TELEGRAM_INIT_DATA_REQUIRED' };
  }

  try {
    const params = new URLSearchParams(rawInitData);
    const hash = params.get('hash');
    if (!hash) {
      return { valid: false, error: 'TELEGRAM_HASH_MISSING' };
    }

    const authDate = Number(params.get('auth_date') || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate <= 0) {
      return { valid: false, error: 'TELEGRAM_AUTH_DATE_MISSING' };
    }
    if (nowSec - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS || authDate > nowSec + 30) {
      return { valid: false, error: 'TELEGRAM_INIT_DATA_EXPIRED' };
    }

    params.delete('hash');
    const sortedKeys = Array.from(params.keys()).sort();
    const dataCheckString = sortedKeys.map((key) => `${key}=${params.get(key)}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!safeTokenEquals(computedHash, hash)) {
      return { valid: false, error: 'TELEGRAM_HMAC_INVALID' };
    }

    const userRaw = params.get('user');
    const userData = userRaw ? JSON.parse(userRaw) : undefined;
    const numericId = Number(userData?.id || 0);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return { valid: false, error: 'TELEGRAM_USER_ID_MISSING' };
    }

    return {
      valid: true,
      userData: { ...userData, id: numericId },
      authDate,
    };
  } catch {
    return { valid: false, error: 'TELEGRAM_INIT_DATA_MALFORMED' };
  }
}

function extractTelegramInitData(req: Request): string | undefined {
  const headerVal = req.headers['x-telegram-init-data'];
  if (typeof headerVal === 'string' && headerVal.trim()) return headerVal.trim();
  if (typeof req.body?.initData === 'string' && req.body.initData.trim()) {
    return req.body.initData.trim();
  }
  return undefined;
}

function validatePayoutDestination(
  payoutChannel: 'CASH_LOCAL' | 'CRYPTO_DIRECT',
  asset: string,
  walletAddress: string
): { valid: boolean; reason?: string } {
  const clean = walletAddress.trim();
  if (clean.length < 4 || clean.length > 160) {
    return { valid: false, reason: 'INVALID_RECIPIENT_LENGTH' };
  }

  const upperAsset = asset.toUpperCase();
  if (payoutChannel === 'CASH_LOCAL') {
    if (upperAsset === 'CASH_PAYEER' || clean.startsWith('CASH-PAYEER:')) {
      const id = clean.startsWith('CASH-PAYEER:') ? clean.slice('CASH-PAYEER:'.length).trim() : clean;
      return /^P\d{6,15}$/i.test(id) ? { valid: true } : { valid: false, reason: 'INVALID_PAYEER_ID' };
    }
    const target = clean.includes(':') ? clean.split(':').slice(1).join(':').trim() : clean;
    const valid = /^([^\s@]+@[^\s@]+\.[^\s@]{2,}|[a-z0-9._-]{3,40})$/i.test(target);
    return valid ? { valid: true } : { valid: false, reason: 'INVALID_CASH_ACCOUNT' };
  }

  if (upperAsset === 'TON') {
    return workers.tonPayout.isValidTonAddress(clean)
      ? { valid: true }
      : { valid: false, reason: 'INVALID_TON_ADDRESS' };
  }
  if (upperAsset === 'USDT' || upperAsset === 'SOL' || upperAsset === 'USDC') {
    if (
      workers.tonPayout.isValidTonAddress(clean) ||
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)
    ) {
      return { valid: true };
    }
    return { valid: false, reason: 'INVALID_CRYPTO_ADDRESS' };
  }
  if (upperAsset === 'PI') {
    return /^G[A-Z2-7]{55}$/.test(clean)
      ? { valid: true }
      : { valid: false, reason: 'INVALID_PI_ADDRESS' };
  }

  return { valid: true };
}

function normalizeCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['VIDEO', 'ADS', 'MUSIC'];
  const cleaned = raw
    .map((c) => String(c || '').trim().toUpperCase())
    .filter((c) => ALLOWED_CATEGORIES.has(c));
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : ['VIDEO', 'ADS', 'MUSIC'];
}

function resolveClickIdFromQuery(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return u.searchParams.get('click_id') || null;
  } catch {
    return null;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createExpressApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json({ limit: '64kb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  const generalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'RATE_LIMIT_EXCEEDED' },
  });

  const financialLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'FINANCIAL_RATE_LIMIT_EXCEEDED' },
  });

  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'ADMIN_RATE_LIMIT_EXCEEDED' },
  });

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'WEBHOOK_RATE_LIMIT_EXCEEDED' },
  });

  const perProviderRateLimit = new Map<string, { count: number; resetAt: number }>();
  const payoutIdempotencyFingerprints = new Map<string, string>();

  app.use('/api', generalApiLimiter);

  function requireAdmin(req: Request, res: Response, next: () => void) {
    const token = req.header('x-admin-token') || '';
    const expected = process.env.ADMIN_API_TOKEN || '';
    if (expected && safeTokenEquals(token, expected)) {
      return next();
    }

    const tgCheck = verifyTelegramWebAppData(extractTelegramInitData(req));
    if (tgCheck.valid && tgCheck.userData?.id) {
      const admins = (process.env.ADMIN_TELEGRAM_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (admins.includes(String(tgCheck.userData.id))) {
        return next();
      }
    }

    return res.status(401).json({ ok: false, error: 'ADMIN_AUTH_REQUIRED' });
  }

  function requireTelegramUser(
    req: Request,
    res: Response
  ): { userId: number; username?: string; firstName?: string; lang?: string } | null {
    const tgCheck = verifyTelegramWebAppData(extractTelegramInitData(req));
    if (!tgCheck.valid || !tgCheck.userData?.id) {
      res.status(401).json({
        ok: false,
        error: tgCheck.error || 'TELEGRAM_AUTH_INVALID',
      });
      return null;
    }
    return {
      userId: Number(tgCheck.userData.id),
      username: tgCheck.userData.username,
      firstName: tgCheck.userData.first_name,
      lang: tgCheck.userData.language_code,
    };
  }

  // ============================================================================
  // ADMIN VERIFY
  // ============================================================================
  app.post('/api/admin/verify', adminLimiter, (req: Request, res: Response) => {
    const tokenHeader = req.header('x-admin-token') || '';
    const expectedToken = process.env.ADMIN_API_TOKEN || '';
    if (expectedToken && safeTokenEquals(tokenHeader, expectedToken)) {
      return res.json({ ok: true, isAdmin: true });
    }

    const tgCheck = verifyTelegramWebAppData(extractTelegramInitData(req));
    if (!tgCheck.valid || !tgCheck.userData?.id) {
      return res.status(401).json({ ok: false, isAdmin: false, error: 'ADMIN_AUTH_REQUIRED' });
    }

    const admins = (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!admins.includes(String(tgCheck.userData.id))) {
      return res.status(403).json({ ok: false, isAdmin: false, error: 'FORBIDDEN' });
    }
    return res.json({ ok: true, isAdmin: true });
  });

  // ============================================================================
  // SYSTEM HEALTH & FX RATES
  // ============================================================================
  app.get('/api/health', (_req: Request, res: Response) => {
    const workerMetrics = workers.tonPayout.getMetrics();
    res.json({
      status: 'OK',
      service: 'ActionFlow Hub Backend',
      dbConnected: Boolean(dbPool),
      sessionMode: 'UNIFIED_AUTO',
      payoutMode: workerMetrics.mode,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/fx/rates', async (_req: Request, res: Response) => {
    const quote = await refreshAndGetFxQuote();
    if (!quote.ok) {
      return res.status(503).json(quote);
    }
    return res.json(quote);
  });

  // ============================================================================
  // TELEGRAM INIT VERIFY
  // ============================================================================
  app.post('/api/init', (req: Request, res: Response) => {
    const result = verifyTelegramWebAppData(extractTelegramInitData(req));
    if (result.valid && result.userData) {
      return res.json({
        ok: true,
        success: true,
        user: result.userData,
        authDate: result.authDate,
      });
    }
    return res.status(401).json({
      ok: false,
      success: false,
      error: result.error || 'Invalid HMAC signature',
    });
  });

  // ============================================================================
  // SALDI E FEED AUTOREVOLE POSTGRESQL (4 BUCKET)
  // ============================================================================
  app.get('/api/ledger/balance', async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        dbConnected: false,
        error: 'POSTGRES_REQUIRED_FOR_BALANCES',
      });
    }

    await LedgerService.ensureUserAccounts(
      authUser.userId,
      authUser.username || authUser.firstName || 'User'
    );
    const [balances, feed, geoProfile] = await Promise.all([
      LedgerService.getUserBalances(authUser.userId),
      LedgerService.getUserLedgerFeed(authUser.userId),
      LedgerService.getUserGeoProfile(authUser.userId),
    ]);

    const balanceMarketCountry = geoProfile?.market_country || 'OTHER';
    const balanceCountryProfile = resolveCountryEconomicProfile(balanceMarketCountry);

    return res.json({
      ok: true,
      dbConnected: true,
      userId: authUser.userId,
      marketCountry: balanceMarketCountry,
      tierZone: geoProfile?.tier_zone || balanceCountryProfile.tierZone,
      pppCoefficient: geoProfile?.ppp_coefficient ?? balanceCountryProfile.pppCoefficient,
      regionGroup: geoProfile?.region_group ?? balanceCountryProfile.regionGroup,
      countryLocked: Boolean(geoProfile?.country_locked),
      balances,
      transactions: feed.transactions,
      interactions: feed.interactions,
      payouts: feed.payouts,
    });
  });

  // ============================================================================
  // STATO STRIKE POSTGRESQL
  // ============================================================================
  app.get('/api/user/strikes', async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_STRIKES',
      });
    }

    const strike = await LedgerService.getUserStrikes(authUser.userId);
    return res.json({
      ok: true,
      policy: '1 = OK (Tollerato) • 2 = NON BENE (Avviso Severo) • 3 = VERIFICA E BLOCCO IMMEDIATO',
      strikeRecord: {
        telegramUserId: strike.user_id,
        strikes: strike.count,
        blockedForVerification: strike.is_blocked,
        lastAnomalyReason: strike.last_reason,
        updatedAt: strike.updated_at,
      },
    });
  });

  // ============================================================================
  // UNIFIED AUTO SESSION ENGINE (SENZA TIMER 10/20/30m E SENZA PREMI A TEMPO)
  // ============================================================================
  app.post('/api/auto-session/start', async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_AUTO_SESSION',
      });
    }

    const categories = normalizeCategories(req.body?.categories);
    const lang = String(req.body?.lang || authUser.lang || 'it').slice(0, 12);
    const requestedCountry = normalizeCountryCode(req.body?.country || 'OTHER');
    const existingGeo = await LedgerService.getUserGeoProfile(authUser.userId);
    const effectiveCountry =
      existingGeo && existingGeo.market_country !== 'OTHER'
        ? existingGeo.market_country
        : requestedCountry;
    const effectiveCountryProfile = resolveCountryEconomicProfile(effectiveCountry);
    const effectiveTierZone = effectiveCountryProfile.tierZone;
    const countryLocked = Boolean(existingGeo && existingGeo.market_country !== 'OTHER');
    const sessionId =
      typeof req.body?.sessionId === 'string' && req.body.sessionId.trim().length >= 8
        ? req.body.sessionId.trim().slice(0, 64)
        : `autosess_${authUser.userId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

    const timeZone = String(req.body?.timeZone || 'UTC').slice(0, 64);
    await LedgerService.upsertEntryProfile({
      userId: authUser.userId,
      lang,
      country: effectiveCountry,
      timezone: timeZone,
      selectedCategories: categories,
    });

    const started = await LedgerService.startAutoSession({
      sessionId,
      userId: authUser.userId,
      categories,
      language: lang,
      marketCountry: effectiveCountry,
      timezone: timeZone,
      metadata: {
        lang,
        country: effectiveCountry,
        tierZone: effectiveTierZone,
        pppCoefficient: effectiveCountryProfile.pppCoefficient,
        regionGroup: effectiveCountryProfile.regionGroup,
        source: 'UNIFIED_AUTO_ENGINE',
      },
    });

    if (!started.ok) {
      const status = started.error === 'USER_BLOCKED' ? 403 : 409;
      return res.status(status).json({
        ok: false,
        error: started.error || 'AUTO_SESSION_START_FAILED',
      });
    }

    const statusData = await LedgerService.getAutoSessionStatus(
      authUser.userId,
      started.session?.session_id || sessionId
    );

    return res.json({
      ok: true,
      dbConnected: true,
      mode: 'UNIFIED_AUTO',
      marketCountry: effectiveCountry,
      tierZone: effectiveTierZone,
      pppCoefficient: effectiveCountryProfile.pppCoefficient,
      regionGroup: effectiveCountryProfile.regionGroup,
      countryLocked,
      session: statusData.session,
      interactions: statusData.interactions,
      counts: statusData.counts,
      balances: statusData.balances,
    });
  });

  // ============================================================================
  // PROFILI ECONOMICI BANCA MONDIALE (PPP) & FORNITORI PRIORITIZZATI (7 CRITERI)
  // ============================================================================
  app.get('/api/economics/countries', (_req: Request, res: Response) => {
    const countries = listCountryEconomicProfiles();
    return res.json({
      ok: true,
      methodology: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP',
      rules: {
        US: 1.0,
        EUROPE: 1.0,
        OTHERS: 'ROUND(PA.NUS.PRVT.PP / PA.NUS.FCRF, 4)',
      },
      count: countries.length,
      countries,
    });
  });

  app.post('/api/economics/sync-worldbank', adminLimiter, requireAdmin, async (_req: Request, res: Response) => {
    const refreshed = await refreshWorldBankPppFromApi();
    let persistedCount = 0;
    if (dbPool && refreshed.ok) {
      persistedCount = await LedgerService.upsertCountryEconomicProfilesBatch(refreshed.profiles);
    }
    return res.json({
      ok: refreshed.ok,
      updatedCount: refreshed.updatedCount,
      persistedToDb: persistedCount,
      countries: refreshed.profiles,
      error: refreshed.error,
    });
  });

  app.get('/api/providers/prioritized', async (req: Request, res: Response) => {
    const rawCat = String(req.query.category || 'all').trim().toLowerCase();
    const country = normalizeCountryCode(req.query.country || 'IT');
    const countryProfile = resolveCountryEconomicProfile(country);
    const tierZone = countryProfile.tierZone;
    const geoEligibility = getCountryGeoEligibility(country);

    const poolByCategory =
      rawCat === 'games'
        ? VERIFIED_GAMES_PROVIDERS
        : rawCat === 'soap'
        ? VERIFIED_SOAP_PROVIDERS
        : rawCat === 'music'
        ? VERIFIED_MUSIC_PROVIDERS
        : rawCat === 'ai'
        ? VERIFIED_AI_PROVIDERS
        : rawCat === 'ux_qa'
        ? VERIFIED_UX_QA_PROVIDERS
        : rawCat === 'ocr'
        ? VERIFIED_OCR_PROVIDERS
        : rawCat === 'depin'
        ? VERIFIED_DEPIN_PROVIDERS
        : ALL_VERIFIED_DIRECT_PROVIDERS;

    const reputationMap = dbPool
      ? await LedgerService.getProviderReputationSnapshot()
      : {};

    const prioritized = sortProvidersByPriority(poolByCategory, country, reputationMap, {
      excludeIncompatibleGeo: true,
    }).filter((p) => !p.isLocked && !p.isServiceOnly);

    return res.json({
      ok: true,
      country,
      tierZone,
      pppCoefficient: countryProfile.pppCoefficient,
      regionGroup: countryProfile.regionGroup,
      geoEligibility,
      reputationSource: dbPool ? 'POSTGRES' : 'CATALOG',
      reputationMap,
      count: prioritized.length,
      providers: prioritized.map((p, index) => ({
        rank: index + 1,
        id: p.id,
        name: p.name,
        geoRegion: p.geoRegion || 'GLOBAL',
        noRestriction: isNoRestrictionProvider(p.geoRegion),
        actionDuration: p.actionDuration,
        modalityBadge: p.modalityBadge,
        payoutInfo: p.payoutInfo,
        currencies: p.currencies,
        userPoints: p.userPoints,
        directUrl: p.directUrl,
      })),
    });
  });

  app.get('/api/auto-session/status', async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_AUTO_SESSION',
      });
    }

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : undefined;
    const statusData = await LedgerService.getAutoSessionStatus(authUser.userId, sessionId);
    return res.json({
      ok: true,
      dbConnected: true,
      mode: 'UNIFIED_AUTO',
      session: statusData.session,
      interactions: statusData.interactions,
      counts: statusData.counts,
      balances: statusData.balances,
    });
  });

  app.post('/api/auto-session/close', async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_AUTO_SESSION',
      });
    }

    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'SESSION_ID_REQUIRED' });
    }

    const closed = await LedgerService.closeAutoSession(sessionId, authUser.userId);
    if (!closed.ok) {
      return res.status(404).json({ ok: false, error: closed.error || 'SESSION_NOT_FOUND' });
    }
    return res.json({ ok: true, session: closed.session });
  });

  // ============================================================================
  // DISATTIVAZIONE DEFINITIVA ENDPOINT LEGACY TIMED SESSION & CLIENT CREDITS
  // ============================================================================
  app.post('/api/session/start', (_req: Request, res: Response) => {
    return res.status(410).json({
      ok: false,
      error: 'LEGACY_TIMED_SESSIONS_DISABLED: usa POST /api/auto-session/start',
    });
  });

  app.get('/api/session/status', (_req: Request, res: Response) => {
    return res.status(410).json({
      ok: false,
      error: 'LEGACY_TIMED_SESSIONS_DISABLED: usa GET /api/auto-session/status',
    });
  });

  app.post('/api/session/complete', financialLimiter, (_req: Request, res: Response) => {
    return res.status(410).json({
      ok: false,
      error: 'TIME_BASED_BLOCK_REWARDS_DISABLED: nessun accredito da timer 10/20/30m',
    });
  });

  app.post('/api/rewards/record', financialLimiter, (_req: Request, res: Response) => {
    return res.status(410).json({
      ok: false,
      error: 'CLIENT_REWARD_RECORDING_DISABLED: gli accrediti avvengono solo via postback partner verificato',
    });
  });

  app.post('/api/postback/s2s', financialLimiter, (_req: Request, res: Response) => {
    return res.status(410).json({
      ok: false,
      error: 'LEGACY_CLIENT_POSTBACK_DISABLED: usa /api/webhook/postback autenticato da partner',
    });
  });

  // ============================================================================
  // REGISTRAZIONE REALE CLICK & SINGOLA INTERAZIONE (0 PUNTI AGGIUNTI AL CLICK)
  // ============================================================================
  const handleRegisterInteraction = async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_INTERACTION_TRACKING',
      });
    }

    const providerId = String(req.body?.providerId || req.body?.partnerId || '').trim().toLowerCase();
    const taskId = String(req.body?.taskId || req.body?.task_id || '').trim();
    const rawCat = String(req.body?.activityCategory || req.body?.category || 'OTHER')
      .trim()
      .toUpperCase();
    const activityCategory = ALLOWED_CATEGORIES.has(rawCat) ? rawCat : 'OTHER';
    const trackingUrl = req.body?.trackingUrl ? String(req.body.trackingUrl).trim() : null;
    const expectedGrossUsd = Number(req.body?.expectedGrossUsd || 0);

    if (!providerId || !taskId) {
      return res.status(400).json({
        ok: false,
        error: 'providerId e taskId sono obbligatori per registrare l\'interazione.',
      });
    }

    const clickId =
      String(req.body?.clickId || resolveClickIdFromQuery(trackingUrl || '') || '').trim() ||
      `clk_${authUser.userId}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const interactionId =
      String(req.body?.interactionId || '').trim() ||
      `int_${authUser.userId}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

    let sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) {
      const current = await LedgerService.getAutoSessionStatus(authUser.userId);
      if (current.session && current.session.status === 'ACTIVE') {
        sessionId = current.session.session_id;
      } else {
        sessionId = `autosess_${authUser.userId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        const created = await LedgerService.startAutoSession({
          sessionId,
          userId: authUser.userId,
          categories: [activityCategory],
          metadata: { autoCreatedOnInteraction: true },
        });
        if (!created.ok) {
          return res.status(created.error === 'USER_BLOCKED' ? 403 : 409).json({
            ok: false,
            error: created.error || 'AUTO_SESSION_CREATION_FAILED',
          });
        }
        sessionId = created.session?.session_id || sessionId;
      }
    }

    const result = await LedgerService.registerSessionInteraction({
      interactionId,
      clickId,
      sessionId,
      userId: authUser.userId,
      providerId,
      activityCategory,
      taskId,
      trackingUrl,
      expectedGrossUsd: Number.isFinite(expectedGrossUsd) && expectedGrossUsd >= 0 ? expectedGrossUsd : 0,
      payload: {
        userAgent: req.header('user-agent') || null,
        registeredAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      const err = result.error || 'INTERACTION_REGISTER_FAILED';
      const statusCode =
        err === 'USER_BLOCKED' || err.includes('PROVIDER_BLOCKED') || err.includes('EXPOSURE')
          ? 403
          : err === 'PROVIDER_NOT_REGISTERED' || err === 'SESSION_NOT_FOUND'
          ? 404
          : 409;
      return res.status(statusCode).json({ ok: false, error: err });
    }

    return res.json({
      ok: true,
      idempotent: Boolean(result.idempotent),
      sessionId,
      interactionId: result.interaction?.interaction_id || interactionId,
      clickId: result.interaction?.click_id || clickId,
      trackingUrl: result.interaction?.tracking_url || trackingUrl,
      status: result.interaction?.status || 'CLICK_REGISTERED',
      userPendingPointsAdded: 0,
      interaction: result.interaction,
    });
  };

  app.post('/api/interactions/register', financialLimiter, handleRegisterInteraction);
  app.post('/api/affiliate/click', financialLimiter, handleRegisterInteraction);

  // ============================================================================
  // WEBHOOK S2S VERIFICATO FORNITORI (PostgreSQL + click_id/interaction_id + anti-replay)
  // ============================================================================
  const handlePostback = async (req: Request, res: Response) => {
    const webhookSecret = process.env.WEBHOOK_SECRET || '';
    const providedSecret =
      req.header('x-webhook-secret') || String(req.query.secret || req.body?.secret || '');
    const providedSignature = req.header('x-webhook-signature') || '';
    const webhookTimestampRaw =
      req.header('x-webhook-timestamp') ||
      String(req.query.timestamp || req.body?.timestamp || '');
    const webhookTimestamp = Number(webhookTimestampRaw);

    // HMAC con timestamp (nuova firma): signature = HMAC-SHA256(secret, timestamp + "." + rawBody)
    let hmacValid = false;
    if (providedSignature && Number.isFinite(webhookTimestamp) && webhookTimestamp > 0) {
      const rawBody = (req as any).rawBody
        ? (req as any).rawBody.toString('utf8')
        : JSON.stringify(req.body ?? {});
      const message = `${webhookTimestamp}.${rawBody}`;
      const expected = crypto.createHmac('sha256', webhookSecret).update(message).digest('hex');
      try {
        hmacValid =
          providedSignature.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(providedSignature, 'hex'), Buffer.from(expected, 'hex'));
      } catch {
        hmacValid = false;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - webhookTimestamp) > 300) hmacValid = false;
    }

    // Firma legacy (solo secret) — transizione controllata
    const legacyValid = !providedSignature && !!webhookSecret && safeTokenEquals(providedSecret, webhookSecret);

    if (!webhookSecret || (!hmacValid && !legacyValid)) {
      return res.status(401).json({ ok: false, error: 'WEBHOOK_AUTH_REQUIRED' });
    }

    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_WEBHOOK' });
    }

    const statusParam = String(req.query.status || req.body?.status || 'CONFIRMED')
      .trim()
      .toUpperCase();
    const provider = String(
      req.query.provider || req.query.partnerId || req.body?.provider || req.body?.partnerId || ''
    )
      .trim()
      .toLowerCase()
      .slice(0, 64);
    const userIdRaw = String(
      req.query.userId || req.query.subId || req.query.sub_id || req.body?.userId || req.body?.subId || req.body?.sub_id || ''
    ).trim();
    const clickId = String(
      req.query.click_id || req.query.clickId || req.body?.click_id || req.body?.clickId || ''
    ).trim();
    const interactionId = String(
      req.query.interaction_id || req.query.interactionId || req.body?.interaction_id || req.body?.interactionId || ''
    ).trim();
    const txId = String(
      req.query.txId ||
        req.query.conversionId ||
        req.query.eventId ||
        req.body?.txId ||
        req.body?.conversionId ||
        req.body?.eventId ||
        ''
    ).trim();
    const webhookNonce = String(
      req.header('x-webhook-nonce') ||
        req.query.nonce ||
        req.body?.nonce ||
        req.body?.webhookNonce ||
        ''
    ).trim();
    const payoutRaw = Number(
      req.query.payout || req.query.revenue || req.body?.payout || req.body?.revenue || 0
    );

    if (statusParam === 'REVOKED' || statusParam === 'CHARGEBACK') {
      if (!txId || txId.length < 3) {
        return res.status(400).json({ ok: false, error: 'TX_ID_REQUIRED_FOR_REVOCATION' });
      }
      const revokeRes = await LedgerService.confirmPartnerReward(txId, 'REVOKED');
      if (!revokeRes.success) {
        return res.status(409).json({ ok: false, error: revokeRes.error || 'REVOKE_FAILED' });
      }
      return res.json({
        ok: true,
        eventId: txId,
        status: 'REVOKED',
      });
    }

    const numericUserId = Number(userIdRaw);
    if (
      !provider ||
      !Number.isFinite(numericUserId) ||
      numericUserId <= 0 ||
      !Number.isFinite(payoutRaw) ||
      payoutRaw <= 0 ||
      txId.length < 3 ||
      (!clickId && !interactionId)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'PARAMETRI_POSTBACK_INVALIDI: provider, txId, click_id/interaction_id, userId (>0) e payout (>0) obbligatori.',
      });
    }

    const rawPoints = Math.round(payoutRaw * 100);

    // Rate limit per-fornitore (10 req/min per provider)
    {
      const now = Date.now();
      const windowMs = 60 * 1000;
      const maxPerProvider = 10;
      const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
      let count = 0;
      if (dbPool) {
        try {
          const r = await dbPool.query(
            `INSERT INTO core.provider_rate_limit (provider, window_start, request_count)
             VALUES ($1, $2, 1)
             ON CONFLICT (provider, window_start)
             DO UPDATE SET request_count = core.provider_rate_limit.request_count + 1
             RETURNING request_count`,
            [provider, windowStart]
          );
          count = r.rows[0]?.request_count || 1;
        } catch {
          // Fallback in-memory se tabella non esiste
          const key = `provider:${provider}`;
          const entry = perProviderRateLimit.get(key) || { count: 0, resetAt: now + windowMs };
          if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
          entry.count += 1;
          perProviderRateLimit.set(key, entry);
          count = entry.count;
        }
      } else {
        const key = `provider:${provider}`;
        const entry = perProviderRateLimit.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count += 1;
        perProviderRateLimit.set(key, entry);
        count = entry.count;
      }
      if (count > maxPerProvider) {
        return res.status(429).json({ ok: false, error: 'PROVIDER_RATE_LIMIT_EXCEEDED' });
      }
    }
    const ledgerRes = await LedgerService.recordVerifiedInteractionPostback({
      eventId: txId,
      partnerId: provider,
      userId: numericUserId,
      clickId: clickId || null,
      interactionId: interactionId || null,
      rawPoints,
      grossUsd: payoutRaw,
      webhookNonce: webhookNonce || null,
      providerTxId: txId,
      metadata: {
        provider,
        payoutUsd: payoutRaw,
        clickId: clickId || null,
        interactionId: interactionId || null,
        receivedAt: new Date().toISOString(),
      },
    });

    if (!ledgerRes.success) {
      const code =
        ledgerRes.error === 'WEBHOOK_NONCE_REPLAYED' ||
        ledgerRes.error === 'EVENT_ID_REPLAY_CONFLICT'
          ? 409
          : ledgerRes.error === 'INTERACTION_NOT_FOUND' ||
            ledgerRes.error === 'INTERACTION_EXPIRED' ||
            ledgerRes.error === 'PROVIDER_NOT_REGISTERED'
          ? 404
          : ledgerRes.error === 'USER_BLOCKED' ||
            ledgerRes.error === 'PROVIDER_BLOCKED_BY_REPUTATION' ||
            ledgerRes.error === 'PROVIDER_EXPOSURE_BLOCKED'
          ? 403
          : 409;
      return res.status(code).json({ ok: false, error: ledgerRes.error || 'WEBHOOK_LEDGER_ERROR' });
    }

    return res.json({
      ok: true,
      idempotent: Boolean(ledgerRes.idempotent),
      provider,
      txId,
      interactionId: ledgerRes.interaction_id || interactionId || null,
      clickId: ledgerRes.click_id || clickId || null,
      payoutUsd: payoutRaw,
      pppCoefficient: ledgerRes.ppp_coefficient ?? 1.0,
      userPendingPointsAdded: Number(ledgerRes.user_pending_points || 0),
      platformMarginPoints: Number(ledgerRes.platform_margin_points || 0),
      status: 'POSTBACK_CONFIRMED_PENDING',
    });
  };

  app.get('/api/webhook/postback', webhookLimiter, handlePostback);
  app.post('/api/webhook/postback', webhookLimiter, handlePostback);

  // ============================================================================
  // SETTLEMENT, RELEASE TO WITHDRAWABLE & AUDIT INTEGRITÀ (SOLO ADMIN)
  // ============================================================================
  app.post('/api/settlement/execute', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!dbPool) {
        return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_SETTLEMENT' });
      }
      const {
        batchId,
        partnerId,
        periodStart = Date.now() - 86400_000,
        periodEnd = Date.now(),
        expectedGrossUsd = 0,
        actualNetReceivedUsd = 0,
        haircutRatio = 1.0,
        onchainTxHash = '',
      } = req.body || {};

      if (!batchId || !partnerId || !onchainTxHash) {
        return res.status(400).json({ ok: false, error: 'batchId, partnerId e onchainTxHash richiesti' });
      }

      const result = await SettlementService.executeBatchSettlement({
        batchId: String(batchId),
        partnerId: String(partnerId),
        periodStart: Number(periodStart),
        periodEnd: Number(periodEnd),
        expectedGrossUsd: Number(expectedGrossUsd),
        actualNetReceivedUsd: Number(actualNetReceivedUsd),
        haircutRatio: Number(haircutRatio),
        onchainTxHash: String(onchainTxHash),
      });

      if (!result.success) {
        return res.status(409).json({ ok: false, ...result });
      }
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/settlement/release-withdrawable', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_SETTLEMENT' });
    }
    const userId = Number(req.body?.userId || 0);
    const points = req.body?.points !== undefined && req.body?.points !== null ? Number(req.body.points) : null;
    const referenceId = req.body?.referenceId ? String(req.body.referenceId) : null;

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: 'VALID_USER_ID_REQUIRED' });
    }

    const result = await SettlementService.releaseSettledToWithdrawable(userId, points, referenceId);
    if (!result.ok) {
      return res.status(409).json(result);
    }
    return res.json(result);
  });

  app.get('/api/audit/ledger-integrity', adminLimiter, requireAdmin, async (_req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_AUDIT' });
    }
    const [integrity, solvency] = await Promise.all([
      LedgerService.auditLedgerIntegrity(),
      SettlementService.getTreasurySolvencyStatus(),
    ]);
    return res.json({
      ok: Boolean(integrity?.ok),
      integrity,
      solvency,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/audit/guardian', adminLimiter, requireAdmin, async (_req: Request, res: Response) => {
    const workerMetrics = workers.tonPayout.getMetrics();
    const solvency = dbPool ? await SettlementService.getTreasurySolvencyStatus().catch(() => null) : null;
    const integrity = dbPool ? await LedgerService.auditLedgerIntegrity().catch(() => null) : null;
    const fxQuote = await refreshAndGetFxQuote().catch(() => null);

    res.json({
      ok: true,
      dbConnected: Boolean(dbPool),
      payoutMode: workerMetrics.mode,
      solvency,
      integrity,
      fxQuote,
      workers: {
        blockchainListener: workers.blockchain.getStatus(),
        settlementWorker: workers.settlement.getStatus(),
        tonPayoutWorker: workerMetrics,
        multiAssetPayoutWorker: workers.multiAssetPayout.getStatus(),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ============================================================================
  // RICHIESTA PRELIEVO ATOMICA (PostgreSQL WITHDRAWABLE -> RESERVED + FX LIVE)
  // ============================================================================
  app.post('/api/payout/request', financialLimiter, async (req: Request, res: Response) => {
    const authUser = requireTelegramUser(req, res);
    if (!authUser) return;

    if (!dbPool) {
      return res.status(503).json({
        ok: false,
        error: 'POSTGRES_REQUIRED_FOR_PAYOUT',
      });
    }

    const uid = authUser.userId;
    const currentStrike = await LedgerService.getUserStrikes(uid);
    if (currentStrike.is_blocked) {
      return res.status(403).json({
        ok: false,
        error: 'STRIKE_3_VERIFICA_E_BLOCCO: Prelievi sospesi per anomalie rilevate.',
        strikeRecord: currentStrike,
      });
    }

    const numericPoints = Math.floor(Number(req.body?.points || 0));
    const cleanAddress = String(req.body?.wallet_address || req.body?.walletAddress || '').trim();
    const rawAsset = String(req.body?.crypto_asset || req.body?.cryptoAsset || 'TON')
      .trim()
      .toUpperCase()
      .slice(0, 24);

    if (!Number.isFinite(numericPoints) || numericPoints < 500) {
      const updatedStrike = await LedgerService.recordUserStrike(
        uid,
        'TENTATIVO_PRELIEVO_SOTTO_SOGLIA',
        true
      );
      return res.status(400).json({
        ok: false,
        error: `Minimo 500 PT ($5.00 USD) richiesti [Strike ${updatedStrike.count}/3]`,
        strikeRecord: updatedStrike,
      });
    }

    const ALLOWED_CRYPTO_ASSETS = new Set([
      'TON',
      'SOL',
      'PI',
      'USDT',
      'USDC',
      'CASH_PAYEER',
      'CASH_AIRTM',
      'CASH_VOLET',
    ]);
    let cryptoAsset = rawAsset;
    if (cleanAddress.startsWith('CASH-PAYEER:')) cryptoAsset = 'CASH_PAYEER';
    else if (cleanAddress.startsWith('CASH-AIRTM:')) cryptoAsset = 'CASH_AIRTM';
    else if (cleanAddress.startsWith('CASH-VOLET:')) cryptoAsset = 'CASH_VOLET';

    if (!ALLOWED_CRYPTO_ASSETS.has(cryptoAsset)) {
      return res.status(400).json({
        ok: false,
        error: 'UNSUPPORTED_PAYOUT_ASSET',
      });
    }

    const payoutChannel: 'CASH_LOCAL' | 'CRYPTO_DIRECT' = cryptoAsset.startsWith('CASH_')
      ? 'CASH_LOCAL'
      : 'CRYPTO_DIRECT';

    const destCheck = validatePayoutDestination(payoutChannel, cryptoAsset, cleanAddress);
    if (!destCheck.valid) {
      return res.status(400).json({
        ok: false,
        error: destCheck.reason || 'INVALID_PAYOUT_DESTINATION',
      });
    }

    // Se il prelievo è in asset volatile (TON/SOL/PI), aggiorniamo/verifichiamo la quota live per lo specifico asset
    if (cryptoAsset === 'TON' || cryptoAsset === 'SOL' || cryptoAsset === 'PI') {
      const fx = await refreshAndGetFxQuote();
      const assetUsdRate =
        cryptoAsset === 'TON'
          ? fx.tonUsdPrice
          : cryptoAsset === 'SOL'
          ? fx.solUsdPrice
          : fx.piUsdPrice;
      if (!fx.ok || !assetUsdRate || assetUsdRate <= 0) {
        return res.status(503).json({
          ok: false,
          error: 'FX_PRICE_UNAVAILABLE_PAYOUT_BLOCKED',
          asset: cryptoAsset,
        });
      }
    }

    const payloadFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ uid, numericPoints, cryptoAsset, cleanAddress }))
      .digest('hex');
    const clientRequestId = String(req.body?.requestId || req.header('x-request-id') || '').trim();
    let idemKey: string;
    if (clientRequestId.length >= 8) {
      const stored = payoutIdempotencyFingerprints.get(clientRequestId);
      if (stored) {
        const [storedUid, storedFp] = stored.split(':');
        if (storedUid !== String(uid)) {
          return res.status(403).json({ ok: false, error: 'IDEMPOTENCY_KEY_USER_MISMATCH' });
        }
        if (storedFp !== payloadFingerprint) {
          return res.status(409).json({ ok: false, error: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });
        }
      }
      payoutIdempotencyFingerprints.set(clientRequestId, `${uid}:${payloadFingerprint}`);
      idemKey = clientRequestId;
    } else {
      idemKey = crypto.randomUUID();
      payoutIdempotencyFingerprints.set(idemKey, `${uid}:${payloadFingerprint}`);
    }

    const reqId = `payout_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const result = await LedgerService.requestPayout({
      requestId: reqId,
      userId: uid,
      idempotencyKey: idemKey,
      points: numericPoints,
      cryptoAsset: cryptoAsset as 'TON' | 'SOL' | 'PI' | 'USDT' | 'USDC' | 'CASH_PAYEER' | 'CASH_AIRTM' | 'CASH_VOLET',
      payoutChannel,
      walletAddress: cleanAddress,
      maxFxAgeSeconds: 600,
    });

    if (!result.ok || !result.payout) {
      return res.status(409).json({
        ok: false,
        error: result.error || 'PAYOUT_REQUEST_FAILED',
      });
    }

    return res.json({
      ok: true,
      idempotent: Boolean(result.idempotent),
      requestId: result.payout.request_id,
      userId: String(result.payout.user_id),
      points: Number(result.payout.points),
      amountUsd: Number(result.payout.amount_usd),
      amountTon: Number(result.payout.amount_ton),
      assetAmount: Number(result.payout.asset_amount || result.payout.amount_ton),
      fxUsdPerAsset: Number(result.payout.fx_usd_per_asset || 0),
      fxSource: result.payout.fx_source || null,
      fxQuotedAt: result.payout.fx_quoted_at || null,
      cryptoAsset: result.payout.crypto_asset,
      payoutChannel: result.payout.payout_channel,
      walletAddress: result.payout.wallet_address,
      status: result.payout.status,
      payoutStatus: result.payout.payout_status,
      message: 'Richiesta registrata atomicamente su PostgreSQL.',
    });
  });

  // ============================================================================
  // GESTIONE E DISPATCH ON-CHAIN PRELIEVI (SOLO ADMIN)
  // ============================================================================
  app.get('/api/payout/list', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_PAYOUT' });
    }
    const statusFilter = req.query.status ? String(req.query.status) : undefined;
    const limit = Number(req.query.limit) || 100;
    const payouts = await LedgerService.getPayoutRequests(limit, statusFilter);
    return res.json({ ok: true, count: payouts.length, payouts });
  });

  app.post('/api/payout/disburse', adminLimiter, requireAdmin, async (req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_PAYOUT' });
    }

    const { requestId, status, txHash, note } = req.body || {};
    if (!requestId || !status) {
      return res.status(400).json({ ok: false, error: 'requestId e status sono obbligatori' });
    }

    const reqId = String(requestId).trim();
    const targetStatus = String(status).toUpperCase();

    if (targetStatus === 'APPROVED') {
      const r = await LedgerService.approvePayout(reqId, 'admin', note ? String(note) : undefined);
      if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
      return res.json({ ok: true, idempotent: Boolean((r as any).idempotent), payout: r.payout });
    }

    if (targetStatus === 'COMPLETED') {
      const cleanTxHash = String(txHash || '').trim();
      if (!cleanTxHash || cleanTxHash.length < 8) {
        return res.status(400).json({
          ok: false,
          error: 'REAL_VERIFIABLE_TX_HASH_REQUIRED',
        });
      }
      const r = await LedgerService.completePayout(reqId, cleanTxHash, note ? String(note) : undefined);
      if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
      return res.json({ ok: true, idempotent: r.idempotent, payout: r.payout });
    }

    if (targetStatus === 'REJECTED') {
      const r = await LedgerService.rejectPayout(reqId, note ? String(note) : undefined);
      if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
      return res.json({ ok: true, idempotent: r.idempotent, payout: r.payout });
    }

    return res.status(400).json({ ok: false, error: 'Stato prelievo non valido (APPROVED | COMPLETED | REJECTED)' });
  });

  app.post('/api/payout/process-ton', adminLimiter, requireAdmin, async (_req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_PAYOUT' });
    }
    const dispatchRes = await workers.tonPayout.processApprovedTonPayouts();
    if (!dispatchRes.ok) {
      const code = dispatchRes.error === 'TON_PAYOUT_WALLET_NOT_CONFIGURED' ? 503 : 409;
      return res.status(code).json(dispatchRes);
    }
    return res.json(dispatchRes);
  });

  app.post('/api/payout/process-all', adminLimiter, requireAdmin, async (_req: Request, res: Response) => {
    if (!dbPool) {
      return res.status(503).json({ ok: false, error: 'POSTGRES_REQUIRED_FOR_PAYOUT' });
    }
    const dispatchRes = await workers.multiAssetPayout.processApprovedPayouts();
    if (!dispatchRes.ok) {
      return res.status(409).json(dispatchRes);
    }
    const succeededCount = dispatchRes.processed.filter((p) => p.ok).length;
    const failedCount = dispatchRes.processed.length - succeededCount;
    return res.json({
      ok: true,
      processedCount: dispatchRes.processed.length,
      succeededCount,
      failedCount,
      processed: dispatchRes.processed,
    });
  });

  // ============================================================================
  // PROVIDER REPUTATION ADMIN ROUTES & WALLET CONFIG
  // ============================================================================
  app.use('/api/admin/providers', adminLimiter, requireAdmin, providerAdminRouter);

  app.get('/api/wallets/config', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      payoutMode: workers.tonPayout.getMetrics().mode,
      wallets: {
        TON: {
          receiveAddress: WALLET_CONFIG.TON.receiveAddress,
          payoutAddresses: WALLET_CONFIG.TON.payoutAddresses,
          network: WALLET_CONFIG.TON.network,
        },
        SOL: {
          receiveAddress: WALLET_CONFIG.SOL.receiveAddress,
          payoutAddresses: WALLET_CONFIG.SOL.payoutAddresses,
          network: WALLET_CONFIG.SOL.network,
        },
        PI: {
          receiveAddress: WALLET_CONFIG.PI.receiveAddress,
          payoutAddresses: WALLET_CONFIG.PI.payoutAddresses,
          network: WALLET_CONFIG.PI.network,
        },
      },
    });
  });

  return app;
}

let serverStarted = false;

export async function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  if (dbPool) {
    await bootstrapDatabaseSchema();
    await LedgerService.loadCountryEconomicProfilesFromDb().catch(() => {});
  }
  const app = createExpressApp();
  const PORT = Number(process.env.PORT) || 3000;

  workers.tonPayout.start();
  workers.settlement.start();
  workers.blockchain.start();

  // Aggiornamento periodico coefficienti PPP Banca Mondiale ogni 24 ore (non bloccante)
  const wbSyncTimer = setInterval(() => {
    void refreshWorldBankPppFromApi()
      .then((r) => {
        if (dbPool && r.ok) {
          return LedgerService.upsertCountryEconomicProfilesBatch(r.profiles);
        }
        return 0;
      })
      .catch(() => {});
  }, 24 * 60 * 60 * 1000);
  wbSyncTimer.unref();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, '../dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ActionFlow Hub Server listening on http://0.0.0.0:${PORT}`);
  });
}

const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('/src/server.ts') || process.argv[1].endsWith('/src/server.js'));
if (isDirectEntry) {
  startServer().catch((err) => {
    console.error('[SERVER STARTUP ABORTED] Migrazione o avvio fallito:', err);
    process.exit(1);
  });
}
