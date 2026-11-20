import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { logger } from '../lib/logger';
import {
  normalizeCountryCode,
  resolveCountryEconomicProfile,
  type EconomicTierZone,
  type CountryEconomicProfile,
} from '../lib/geoEconomics';
import { applyDbCountryProfileRows, type EconomicRegionGroup } from '../services/worldBankPpp';
import type { ProviderReputationSnapshot } from '../lib/providerPriority';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
let pool: Pool | null = null;

if (connectionString) {
  const requiresSsl =
    connectionString.includes('sslmode=require') ||
    connectionString.includes('neon.tech') ||
    process.env.NODE_ENV === 'production';

  let sslConfig: false | { rejectUnauthorized: boolean; ca?: string } = false;
  if (requiresSsl) {
    const allowSelfSigned = process.env.PG_ALLOW_SELF_SIGNED === 'true';
    const rootCertPath = process.env.PGSSLROOTCERT;
    const ca = rootCertPath && fs.existsSync(rootCertPath) ? fs.readFileSync(rootCertPath, 'utf8') : undefined;
    sslConfig = {
      rejectUnauthorized: !allowSelfSigned,
      ...(ca ? { ca } : {}),
    };
  }

  pool = new Pool({
    connectionString,
    ssl: sslConfig,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[POSTGRES POOL ERROR]', err);
  });
}

export const dbPool = pool;

export interface LedgerBalances {
  pending_points: number;
  settled_points: number;
  withdrawable_points: number;
  reserved_points: number;
}

export interface FxRateSnapshot {
  asset: string;
  usd_per_unit: number;
  source: string;
  fetched_at: string;
  expires_at: string;
}

const KNOWN_ALLOWED_MIGRATION_GAPS = new Set<number>([3]);

export interface MigrationManifestItem {
  filename: string;
  prefixNum: number;
  migrationId: string;
  sha256: string;
  hasTransactionWrapper: boolean;
  bytes: number;
}

export interface MigrationManifestResult {
  ok: boolean;
  files: MigrationManifestItem[];
  errors: string[];
}

export function computeMigrationSha256(rawSql: string): string {
  const normalized = rawSql.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function inspectMigrationFiles(
  migrationsDir = path.join(process.cwd(), 'migrations')
): MigrationManifestResult {
  const errors: string[] = [];
  if (!fs.existsSync(migrationsDir)) {
    return { ok: true, files: [], errors: [] };
  }

  const rawEntries = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && /^\d+_/.test(f));

  const parsed: MigrationManifestItem[] = rawEntries
    .map((filename) => {
      const m = filename.match(/^(\d+)_/);
      const prefixNum = m ? Number(m[1]) : Number.NaN;
      const migrationId = m ? m[1].padStart(3, '0') : '000';
      const fullPath = path.join(migrationsDir, filename);
      const rawSql = fs.readFileSync(fullPath, 'utf8');
      const trimmed = rawSql.trim();
      const sha256 = computeMigrationSha256(rawSql);
      const hasTransactionWrapper =
        /^\s*BEGIN\s*;/im.test(rawSql) && /\bCOMMIT\s*;\s*(?:--[^\n]*)?$/im.test(trimmed);

      if (!trimmed) {
        errors.push(`EMPTY_MIGRATION_FILE:${filename}`);
      }
      const beginCount = (rawSql.match(/^\s*BEGIN\s*;/gim) || []).length;
      const commitCount = (rawSql.match(/^\s*COMMIT\s*;/gim) || []).length;
      if (beginCount !== commitCount) {
        errors.push(`UNBALANCED_TRANSACTION_WRAPPER:${filename}:BEGIN=${beginCount}:COMMIT=${commitCount}`);
      }

      return {
        filename,
        prefixNum,
        migrationId,
        sha256,
        hasTransactionWrapper,
        bytes: Buffer.byteLength(rawSql, 'utf8'),
      };
    })
    .sort((a, b) => a.prefixNum - b.prefixNum || a.filename.localeCompare(b.filename));

  const seenPrefixes = new Set<number>();
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    if (!Number.isInteger(cur.prefixNum) || cur.prefixNum <= 0) {
      errors.push(`INVALID_MIGRATION_PREFIX:${cur.filename}`);
      continue;
    }
    if (seenPrefixes.has(cur.prefixNum)) {
      errors.push(`DUPLICATE_MIGRATION_PREFIX:${cur.migrationId}:${cur.filename}`);
    }
    seenPrefixes.add(cur.prefixNum);

    if (i > 0) {
      const prev = parsed[i - 1];
      for (let missing = prev.prefixNum + 1; missing < cur.prefixNum; missing++) {
        if (!KNOWN_ALLOWED_MIGRATION_GAPS.has(missing)) {
          errors.push(`MIGRATION_SEQUENCE_GAP:${String(missing).padStart(3, '0')}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    files: parsed,
    errors,
  };
}

export function verifyAppliedMigrationChecksums(
  appliedRows: Array<{ filename: string; checksum_sha256?: string | null }>,
  manifestFiles: MigrationManifestItem[]
): {
  toApply: MigrationManifestItem[];
  skipped: MigrationManifestItem[];
  toBackfillChecksum: MigrationManifestItem[];
} {
  const appliedMap = new Map<string, string | null>();
  for (const row of appliedRows) {
    appliedMap.set(String(row.filename), row.checksum_sha256 ? String(row.checksum_sha256) : null);
  }

  const toApply: MigrationManifestItem[] = [];
  const skipped: MigrationManifestItem[] = [];
  const toBackfillChecksum: MigrationManifestItem[] = [];

  for (const file of manifestFiles) {
    if (appliedMap.has(file.filename)) {
      const storedHash = appliedMap.get(file.filename);
      if (storedHash && storedHash !== file.sha256) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH:${file.filename}:expected=${storedHash}:actual=${file.sha256}`
        );
      }
      if (!storedHash) {
        toBackfillChecksum.push(file);
      }
      skipped.push(file);
    } else {
      toApply.push(file);
    }
  }

  return { toApply, skipped, toBackfillChecksum };
}

export async function bootstrapDatabaseSchema(): Promise<{
  applied: string[];
  skipped: string[];
}> {
  if (!pool) return { applied: [], skipped: [] };

  const migrationsDir = path.join(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) return { applied: [], skipped: [] };

  const manifest = inspectMigrationFiles(migrationsDir);
  if (!manifest.ok) {
    throw new Error(`MIGRATION_MANIFEST_INVALID: ${manifest.errors.join('; ')}`);
  }

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS core`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS core.schema_migrations (
        filename TEXT PRIMARY KEY,
        migration_id TEXT,
        checksum_sha256 TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE core.schema_migrations ADD COLUMN IF NOT EXISTS migration_id TEXT`);
    await client.query(`ALTER TABLE core.schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT`);

    const appliedRes = await client.query(
      `SELECT filename, checksum_sha256 FROM core.schema_migrations`
    );
    const plan = verifyAppliedMigrationChecksums(appliedRes.rows, manifest.files);

    for (const file of plan.toBackfillChecksum) {
      await client.query(
        `UPDATE core.schema_migrations
            SET checksum_sha256 = $2,
                migration_id = COALESCE(migration_id, $3)
          WHERE filename = $1`,
        [file.filename, file.sha256, file.migrationId]
      );
    }
    for (const file of plan.skipped) {
      skipped.push(file.filename);
    }

    for (const file of plan.toApply) {
      const sql = fs.readFileSync(path.join(migrationsDir, file.filename), 'utf8');
      try {
        if (file.hasTransactionWrapper) {
          await client.query(sql);
        } else {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      await client.query(
        `INSERT INTO core.schema_migrations (filename, migration_id, checksum_sha256)
         VALUES ($1, $2, $3)
         ON CONFLICT (filename) DO UPDATE
           SET checksum_sha256 = EXCLUDED.checksum_sha256,
               migration_id = COALESCE(core.schema_migrations.migration_id, EXCLUDED.migration_id)`,
        [file.filename, file.migrationId, file.sha256]
      );
      applied.push(file.filename);
      logger.info('DB_MIGRATION', `Migrazione applicata con successo: ${file.filename}`, {
        migrationId: file.migrationId,
        sha256: file.sha256,
      });
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}

export class LedgerService {
  static async ensureUserAccounts(
    userId: number,
    username = 'User',
    geoTier = 'ZONE_C',
    adRevShare = 0.20,
    timezone = 'UTC'
  ): Promise<void> {
    if (!pool) return;
    await pool.query(`SELECT core.ensure_user_accounts($1, $2, $3, $4, $5)`, [
      userId,
      username,
      geoTier,
      adRevShare,
      timezone,
    ]);
  }

  static async upsertEntryProfile(params: {
    userId: number;
    lang: string;
    country: string;
    timezone?: string;
    selectedCategories?: string[];
  }): Promise<void> {
    if (!pool) return;
    const normalizedCountry = normalizeCountryCode(params.country);
    await pool.query(
      `SELECT core.upsert_entry_profile($1, $2, $3, $4, NULL, $5::text[], NULL)`,
      [
        params.userId,
        params.timezone || 'UTC',
        params.lang,
        normalizedCountry,
        params.selectedCategories || [],
      ]
    );
  }

  static async getUserGeoProfile(userId: number): Promise<{
    market_country: string;
    tier_zone: EconomicTierZone;
    ppp_coefficient: number;
    region_group: EconomicRegionGroup;
    country_locked: boolean;
  } | null> {
    if (!pool) return null;
    try {
      const res = await pool.query(
        `SELECT market_country, tier_zone, ppp_multiplier::float8 AS ppp_multiplier
           FROM core.users
          WHERE user_id = $1
          LIMIT 1`,
        [userId]
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      const normalized = normalizeCountryCode(row.market_country || 'OTHER');
      const profile = resolveCountryEconomicProfile(normalized);
      const zone =
        row.tier_zone === 'ZONE_A' || row.tier_zone === 'ZONE_B' || row.tier_zone === 'ZONE_C'
          ? (row.tier_zone as EconomicTierZone)
          : profile.tierZone;
      const dbPpp = Number(row.ppp_multiplier);
      const pppCoefficient =
        profile.regionGroup === 'US' || profile.regionGroup === 'EUROPE'
          ? 1.0
          : normalized !== 'OTHER' && Number.isFinite(dbPpp) && dbPpp > 0 && dbPpp <= 1.0 && Math.abs(dbPpp - 0.2) > 0.0001
          ? dbPpp
          : profile.pppCoefficient;
      return {
        market_country: normalized,
        tier_zone: zone,
        ppp_coefficient: pppCoefficient,
        region_group: profile.regionGroup,
        country_locked: normalized !== 'OTHER',
      };
    } catch {
      return null;
    }
  }

  static async loadCountryEconomicProfilesFromDb(): Promise<CountryEconomicProfile[]> {
    if (!pool) return [];
    try {
      const res = await pool.query(
        `SELECT country_code, region_group, tier_zone,
                wb_ppp_private_consumption::float8 AS wb_ppp_private_consumption,
                wb_official_fx_rate::float8 AS wb_official_fx_rate,
                wb_price_level_index::float8 AS wb_price_level_index,
                ppp_coefficient::float8 AS ppp_coefficient,
                indicator_year, source, updated_at
           FROM core.country_economic_profiles`
      );
      if (res.rows.length > 0) {
        applyDbCountryProfileRows(res.rows);
      }
      return res.rows;
    } catch {
      return [];
    }
  }

  static async upsertCountryEconomicProfilesBatch(
    profiles: CountryEconomicProfile[]
  ): Promise<number> {
    if (!pool || profiles.length === 0) return 0;
    let updated = 0;
    for (const p of profiles) {
      try {
        await pool.query(
          `SELECT core.upsert_country_economic_profile($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            p.countryCode,
            p.regionGroup,
            p.tierZone,
            p.wbPppPrivateConsumption,
            p.wbOfficialFxRate,
            p.wbPriceLevelIndex,
            p.pppCoefficient,
            p.indicatorYear,
            p.source,
          ]
        );
        updated++;
      } catch {
        // Non-blocking per-row upsert
      }
    }
    return updated;
  }

  static async getProviderReputationSnapshot(): Promise<Record<string, ProviderReputationSnapshot>> {
    if (!pool) return {};
    try {
      const res = await pool.query(
        `SELECT pr.provider_id, pr.status,
                pr.reputation_score::float8 AS reputation_score,
                pr.ema_haircut_ratio::float8 AS ema_haircut_ratio,
                pr.total_confirmed_events,
                COALESCE(si.total_clicks, 0)::BIGINT AS total_clicks,
                COALESCE(si.confirmed_events, pr.total_confirmed_events, 0)::BIGINT AS confirmed_events
           FROM core.provider_reputation pr
           LEFT JOIN (
             SELECT provider_id,
                    COUNT(*)::BIGINT AS total_clicks,
                    COUNT(*) FILTER (WHERE status IN ('POSTBACK_CONFIRMED_PENDING', 'SETTLED'))::BIGINT AS confirmed_events
               FROM core.session_interactions
              GROUP BY provider_id
           ) si ON si.provider_id = pr.provider_id`
      );
      const map: Record<string, ProviderReputationSnapshot> = {};
      for (const row of res.rows) {
        const pid = String(row.provider_id || '').trim().toLowerCase();
        if (!pid) continue;
        const clicks = Number(row.total_clicks ?? 0);
        const confirmed = Number(row.total_confirmed_events ?? row.confirmed_events ?? 0);
        const ema = Number(row.ema_haircut_ratio ?? 1);
        const completionRate =
          clicks > 0 ? Math.min(1, Math.max(0, confirmed / clicks)) : Math.min(1, Math.max(0, ema));
        map[pid] = {
          provider_id: pid,
          status: row.status,
          reputation_score: Number(row.reputation_score ?? 100),
          ema_haircut_ratio: ema,
          total_confirmed_events: confirmed,
          total_clicks: clicks,
          completion_rate: Number(completionRate.toFixed(4)),
        };
      }
      return map;
    } catch {
      try {
        const fallbackRes = await pool.query(
          `SELECT provider_id, status,
                  reputation_score::float8 AS reputation_score,
                  ema_haircut_ratio::float8 AS ema_haircut_ratio,
                  total_confirmed_events
             FROM core.provider_reputation`
        );
        const map: Record<string, ProviderReputationSnapshot> = {};
        for (const row of fallbackRes.rows) {
          const pid = String(row.provider_id || '').trim().toLowerCase();
          if (!pid) continue;
          const ema = Number(row.ema_haircut_ratio ?? 1);
          map[pid] = {
            provider_id: pid,
            status: row.status,
            reputation_score: Number(row.reputation_score ?? 100),
            ema_haircut_ratio: ema,
            total_confirmed_events: Number(row.total_confirmed_events ?? 0),
            total_clicks: 0,
            completion_rate: Math.min(1, Math.max(0, ema)),
          };
        }
        return map;
      } catch {
        return {};
      }
    }
  }

  static async getUserBalances(userId: number): Promise<LedgerBalances> {
    if (!pool) {
      return {
        pending_points: 0,
        settled_points: 0,
        withdrawable_points: 0,
        reserved_points: 0,
      };
    }

    const res = await pool.query(
      `SELECT a.account_type, COALESCE(b.balance, 0)::BIGINT AS balance
         FROM core.balances b
         JOIN core.accounts a ON a.account_id = b.account_id
        WHERE a.user_id = $1`,
      [userId]
    );

    const out: LedgerBalances = {
      pending_points: 0,
      settled_points: 0,
      withdrawable_points: 0,
      reserved_points: 0,
    };

    for (const row of res.rows) {
      const bal = Number(row.balance || 0);
      if (row.account_type === 'USER_PENDING') out.pending_points = bal;
      if (row.account_type === 'USER_SETTLED') out.settled_points = bal;
      if (row.account_type === 'USER_WITHDRAWABLE') out.withdrawable_points = bal;
      if (row.account_type === 'USER_RESERVED') out.reserved_points = bal;
    }

    return out;
  }

  static async startAutoSession(params: {
    sessionId: string;
    userId: number;
    categories: string[];
    language?: string;
    marketCountry?: string;
    timezone?: string;
    forceNew?: boolean;
    metadata?: Record<string, any>;
  }): Promise<{ ok: boolean; session?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.start_auto_session($1, $2, $3::text[], $4, $5, $6, $7, $8::jsonb) AS result`,
        [
          params.sessionId,
          params.userId,
          params.categories,
          params.language || 'it',
          params.marketCountry || 'OTHER',
          params.timezone || 'UTC',
          Boolean(params.forceNew),
          JSON.stringify(params.metadata || {}),
        ]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.success ?? r.ok),
        session: r.session,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async closeAutoSession(
    sessionId: string,
    userId: number,
    targetStatus: 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' = 'COMPLETED',
    reason = 'USER_STOPPED'
  ): Promise<{ ok: boolean; session?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.close_auto_session($1, $2, $3, $4) AS result`,
        [sessionId, userId, targetStatus, reason]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.success ?? r.ok),
        session: r.session,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async getAutoSessionStatus(
    userId: number,
    sessionId?: string
  ): Promise<{
    ok: boolean;
    session: any | null;
    interactions: any[];
    counts: Record<string, number>;
    balances: LedgerBalances;
  }> {
    if (!pool) {
      return {
        ok: false,
        session: null,
        interactions: [],
        counts: {},
        balances: {
          pending_points: 0,
          settled_points: 0,
          withdrawable_points: 0,
          reserved_points: 0,
        },
      };
    }

    const sessRes = sessionId
      ? await pool.query(
          `SELECT * FROM core.auto_sessions WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
          [sessionId, userId]
        )
      : await pool.query(
          `SELECT * FROM core.auto_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [userId]
        );

    const session = sessRes.rows[0] || null;
    const interactionsRes = session
      ? await pool.query(
          `SELECT interaction_id, click_id, provider_id, activity_category, task_id,
                  tracking_url, status, reward_event_id, expected_gross_usd,
                  confirmed_gross_usd, user_pending_points, user_settled_points,
                  clicked_at, postback_at, settled_at, revoked_at, expires_at
             FROM core.session_interactions
            WHERE session_id = $1 AND user_id = $2
            ORDER BY created_at DESC
            LIMIT 100`,
          [session.session_id, userId]
        )
      : await pool.query(
          `SELECT interaction_id, click_id, provider_id, activity_category, task_id,
                  tracking_url, status, reward_event_id, expected_gross_usd,
                  confirmed_gross_usd, user_pending_points, user_settled_points,
                  clicked_at, postback_at, settled_at, revoked_at, expires_at
             FROM core.session_interactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 50`,
          [userId]
        );

    const counts: Record<string, number> = {
      CLICK_REGISTERED: 0,
      POSTBACK_CONFIRMED_PENDING: 0,
      SETTLED: 0,
      REVOKED: 0,
      EXPIRED: 0,
      REJECTED: 0,
    };
    for (const row of interactionsRes.rows) {
      counts[row.status] = (counts[row.status] || 0) + 1;
    }

    const balances = await this.getUserBalances(userId);
    return {
      ok: true,
      session,
      interactions: interactionsRes.rows,
      counts,
      balances,
    };
  }

  static async registerSessionInteraction(params: {
    interactionId: string;
    clickId: string;
    sessionId: string;
    userId: number;
    providerId: string;
    activityCategory: string;
    taskId: string;
    trackingUrl?: string | null;
    expectedGrossUsd?: number;
    ttlHours?: number;
    payload?: Record<string, any>;
  }): Promise<{ ok: boolean; idempotent?: boolean; interaction?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.register_session_interaction($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) AS result`,
        [
          params.interactionId,
          params.clickId,
          params.sessionId,
          params.userId,
          params.providerId,
          params.activityCategory,
          params.taskId,
          params.trackingUrl || null,
          Number(params.expectedGrossUsd || 0),
          params.ttlHours ?? 24,
          JSON.stringify(params.payload || {}),
        ]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.success ?? r.ok),
        idempotent: Boolean(r.idempotent),
        interaction: r.interaction,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async expireOrRejectInteraction(
    interactionId: string,
    newStatus: 'EXPIRED' | 'REJECTED',
    reason?: string
  ): Promise<{ ok: boolean; interaction?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.expire_or_reject_interaction($1, $2, $3) AS result`,
        [interactionId, newStatus, reason || null]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.success ?? r.ok),
        interaction: r.interaction,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async recordVerifiedInteractionPostback(params: {
    eventId: string;
    partnerId: string;
    userId: number;
    clickId?: string | null;
    interactionId?: string | null;
    rawPoints?: number | null;
    grossUsd?: number | null;
    webhookNonce?: string | null;
    providerTxId?: string | null;
    metadata?: Record<string, any>;
  }): Promise<{
    success: boolean;
    idempotent?: boolean;
    event_id?: string;
    interaction_id?: string;
    click_id?: string;
    ppp_coefficient?: number;
    user_pending_points?: number;
    platform_margin_points?: number;
    error?: string;
  }> {
    if (!pool) return { success: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const confirmedGrossUsd =
        params.grossUsd !== null && params.grossUsd !== undefined
          ? Number(params.grossUsd)
          : Number(params.rawPoints || 0) / 100;
      const res = await pool.query(
        `SELECT core.record_verified_interaction_postback($1, $2, $3, $4, $5, $6, $7, $8::jsonb) AS result`,
        [
          params.eventId,
          params.clickId || null,
          params.interactionId || null,
          params.partnerId,
          params.userId,
          confirmedGrossUsd,
          params.webhookNonce || null,
          JSON.stringify({
            ...(params.metadata || {}),
            providerTxId: params.providerTxId || params.eventId,
          }),
        ]
      );
      const r = res.rows[0]?.result || {};
      const addedPending = Number(r.added_pending_points ?? r.user_pending_points ?? 0);
      const rawPts = Number(r.raw_points ?? params.rawPoints ?? 0);
      const platformMargin =
        r.platform_margin_points !== undefined && r.platform_margin_points !== null
          ? Number(r.platform_margin_points)
          : Math.max(0, rawPts - addedPending);
      return {
        success: Boolean(r.success ?? r.ok),
        idempotent: Boolean(r.idempotent),
        event_id: r.event_id,
        interaction_id: r.interaction_id,
        click_id: r.click_id,
        ppp_coefficient:
          r.ppp_coefficient !== undefined && r.ppp_coefficient !== null
            ? Number(r.ppp_coefficient)
            : undefined,
        user_pending_points: addedPending,
        platform_margin_points: platformMargin,
        error: r.error,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // Alias retrocompatibile per worker on-chain (TON/SOL) con registrazione interazione preventiva o lookup
  static async creditPartnerPendingReward(params: {
    eventId: string;
    partnerId: string;
    userId: number;
    rawPoints: number;
    metadata?: any;
  }): Promise<{ success: boolean; userPendingPoints?: number; error?: string }> {
    if (!pool) return { success: false, error: 'POSTGRES_UNAVAILABLE' };

    try {
      const res = await pool.query(
        `SELECT core.record_pending_reward($1, $2, $3, $4, $5::jsonb) AS result`,
        [
          params.eventId,
          params.partnerId,
          params.userId,
          params.rawPoints,
          JSON.stringify(params.metadata || {}),
        ]
      );
      const r = res.rows[0]?.result;
      return {
        success: Boolean(r?.success ?? r?.ok),
        userPendingPoints: r?.added_pending_points ?? r?.user_pending_points,
        error: r?.error,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  static async confirmPartnerReward(
    eventId: string,
    status: 'VERIFIED' | 'CONFIRMED' | 'REVOKED'
  ): Promise<{ success: boolean; error?: string; status?: string }> {
    if (!pool) return { success: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const mapped = status === 'REVOKED' ? 'REVOKED' : 'VERIFIED';
      const res = await pool.query(
        `SELECT core.partner_confirm_reward($1, $2) AS result`,
        [eventId, mapped]
      );
      const r = res.rows[0]?.result;
      return {
        success: Boolean(r?.success ?? r?.ok),
        status: r?.action ?? r?.status,
        error: r?.error,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  static async recordFxPriceSnapshot(
    asset: string,
    usdPerUnit: number,
    source: string,
    ttlSeconds = 600
  ): Promise<{ ok: boolean; snapshotId?: number; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.record_fx_price_snapshot($1, $2, $3, $4, '{}'::jsonb) AS snapshot_id`,
        [asset, usdPerUnit, source, ttlSeconds]
      );
      const snapshotId = Number(res.rows[0]?.snapshot_id || 0);
      return snapshotId > 0 ? { ok: true, snapshotId } : { ok: false, error: 'FX_SNAPSHOT_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async getLatestFxRates(maxAgeSeconds = 600): Promise<Record<string, FxRateSnapshot>> {
    if (!pool) return {};
    const res = await pool.query(
      `SELECT DISTINCT ON (asset)
              asset, usd_per_unit::float8 AS usd_per_unit, source, fetched_at, expires_at
         FROM core.fx_price_snapshots
        WHERE is_valid = TRUE
          AND expires_at > NOW()
          AND fetched_at >= NOW() - make_interval(secs => $1)
        ORDER BY asset, fetched_at DESC, snapshot_id DESC`,
      [maxAgeSeconds]
    );
    const map: Record<string, FxRateSnapshot> = {};
    for (const row of res.rows) {
      map[String(row.asset).toUpperCase()] = {
        asset: String(row.asset).toUpperCase(),
        usd_per_unit: Number(row.usd_per_unit),
        source: String(row.source),
        fetched_at: new Date(row.fetched_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
      };
    }
    return map;
  }

  static async releaseSettledToWithdrawable(
    userId: number,
    points?: number | null,
    referenceId?: string | null
  ): Promise<{ ok: boolean; released_points?: number; new_withdrawable_balance?: number; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.release_settled_to_withdrawable_for_user($1, $2, $3) AS result`,
        [userId, points ?? null, referenceId ?? null]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.success ?? r.ok),
        released_points: Number(r.moved_points ?? 0),
        new_withdrawable_balance: r.new_withdrawable_balance,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async requestPayout(params: {
    requestId: string;
    userId: number;
    idempotencyKey: string;
    points: number;
    cryptoAsset: 'TON' | 'SOL' | 'PI' | 'USDT' | 'USDC' | 'CASH_PAYEER' | 'CASH_AIRTM' | 'CASH_VOLET';
    payoutChannel: 'CASH_LOCAL' | 'CRYPTO_DIRECT';
    walletAddress: string;
    maxFxAgeSeconds?: number;
  }): Promise<{ ok: boolean; idempotent?: boolean; payout?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.request_payout_atomic($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
        [
          params.requestId,
          params.userId,
          params.points,
          params.cryptoAsset,
          params.payoutChannel,
          params.walletAddress,
          params.idempotencyKey,
          params.maxFxAgeSeconds ?? 600,
        ]
      );
      return res.rows[0]?.result || { ok: false, error: 'PAYOUT_REQUEST_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  static async approvePayout(
    requestId: string,
    approvedBy: string,
    note?: string
  ): Promise<{ ok: boolean; idempotent?: boolean; requires_second_approval?: boolean; payout?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    const res = await pool.query(`SELECT core.approve_payout_atomic($1, $2, $3) AS result`, [
      requestId,
      approvedBy,
      note || null,
    ]);
    return res.rows[0]?.result || { ok: false, error: 'PAYOUT_APPROVE_FAILED' };
  }

  static async completePayout(
    requestId: string,
    txHash: string,
    note?: string
  ): Promise<{ ok: boolean; idempotent?: boolean; payout?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    const res = await pool.query(`SELECT core.complete_payout_atomic($1, $2, $3) AS result`, [
      requestId,
      txHash,
      note || null,
    ]);
    return res.rows[0]?.result || { ok: false, error: 'PAYOUT_COMPLETE_FAILED' };
  }

  static async rejectPayout(
    requestId: string,
    note?: string
  ): Promise<{ ok: boolean; idempotent?: boolean; payout?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    const res = await pool.query(`SELECT core.reject_payout_atomic($1, $2) AS result`, [
      requestId,
      note || null,
    ]);
    return res.rows[0]?.result || { ok: false, error: 'PAYOUT_REJECT_FAILED' };
  }

  static async getPayoutRequests(limit = 50, statusFilter?: string): Promise<any[]> {
    if (!pool) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const params: any[] = [];
    let whereClause = '';
    if (statusFilter) {
      params.push(statusFilter.toUpperCase());
      whereClause = `WHERE status = $${params.length} OR payout_status = $${params.length}`;
    }
    params.push(safeLimit);
    try {
      const res = await pool.query(
        `SELECT request_id, user_id, idempotency_key, points, amount_usd::float8 AS amount_usd,
                amount_ton::float8 AS amount_ton, COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
                fx_usd_per_asset::float8 AS fx_usd_per_asset, fx_source, fx_quoted_at,
                crypto_asset, payout_channel, wallet_address, status, payout_status,
                COALESCE(dispatch_state, 'UNCLAIMED') AS dispatch_state,
                active_dispatch_attempt_id, dispatch_uncertainty_reason,
                tx_hash, approved_by, approved_at, completed_at AS paid_at, rejected_at, note, created_at
           FROM core.payout_requests
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return res.rows;
    } catch {
      const res = await pool.query(
        `SELECT request_id, user_id, idempotency_key, points, amount_usd::float8 AS amount_usd,
                amount_ton::float8 AS amount_ton, COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
                fx_usd_per_asset::float8 AS fx_usd_per_asset, fx_source, fx_quoted_at,
                crypto_asset, payout_channel, wallet_address, status, payout_status, tx_hash,
                approved_by, approved_at, completed_at AS paid_at, rejected_at, note, created_at
           FROM core.payout_requests
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return res.rows;
    }
  }

  static async getUserLedgerFeed(userId: number, limit = 40): Promise<{
    transactions: any[];
    interactions: any[];
    payouts: any[];
  }> {
    if (!pool) {
      return { transactions: [], interactions: [], payouts: [] };
    }

    const [txRes, intRes, payRes] = await Promise.all([
      pool.query(
        `SELECT lt.tx_id, lt.reference_type, lt.reference_id, lt.description, lt.created_at,
                le.account_id, le.amount::BIGINT AS amount, a.account_type
           FROM core.ledger_entries le
           JOIN core.ledger_transactions lt ON lt.tx_id = le.tx_id
           JOIN core.accounts a ON a.account_id = le.account_id
          WHERE a.user_id = $1
          ORDER BY lt.created_at DESC, le.entry_id DESC
          LIMIT $2`,
        [userId, limit]
      ),
      pool.query(
        `SELECT interaction_id, click_id, session_id, provider_id, activity_category,
                task_id, status, reward_event_id, expected_gross_usd::float8 AS expected_gross_usd,
                confirmed_gross_usd::float8 AS confirmed_gross_usd, user_pending_points::BIGINT AS user_pending_points,
                user_settled_points::BIGINT AS user_settled_points, clicked_at, postback_at, settled_at, revoked_at
           FROM core.session_interactions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit]
      ),
      pool.query(
        `SELECT request_id, points, amount_usd::float8 AS amount_usd, amount_ton::float8 AS amount_ton,
                COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
                fx_usd_per_asset::float8 AS fx_usd_per_asset, fx_source,
                crypto_asset, payout_channel, wallet_address, status, payout_status, tx_hash, created_at, completed_at AS paid_at
           FROM core.payout_requests
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 25`,
        [userId]
      ),
    ]);

    return {
      transactions: txRes.rows,
      interactions: intRes.rows,
      payouts: payRes.rows,
    };
  }

  static async getUserStrikes(userId: number): Promise<{
    user_id: number;
    count: number;
    is_blocked: boolean;
    last_reason: string | null;
    updated_at: string | null;
  }> {
    if (!pool) {
      throw new Error('POSTGRES_UNAVAILABLE');
    }
    const res = await pool.query(`SELECT core.get_user_strikes($1) AS result`, [userId]);
    return res.rows[0]?.result;
  }

  static async recordUserStrike(
    userId: number,
    reason: string,
    increment = true
  ): Promise<{
    user_id: number;
    count: number;
    is_blocked: boolean;
    last_reason: string | null;
    updated_at: string | null;
  }> {
    if (!pool) {
      throw new Error('POSTGRES_UNAVAILABLE');
    }
    const res = await pool.query(`SELECT core.record_user_strike($1, $2, $3) AS result`, [
      userId,
      reason,
      increment,
    ]);
    return res.rows[0]?.result;
  }

  static async auditLedgerIntegrity(): Promise<any> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    const res = await pool.query(`SELECT core.audit_ledger_integrity() AS result`);
    return res.rows[0]?.result;
  }

  static async getPayoutById(requestId: string): Promise<any | null> {
    if (!pool) return null;
    const res = await pool.query(
      `SELECT request_id, user_id, points, amount_usd::float8 AS amount_usd,
              amount_ton::float8 AS amount_ton, COALESCE(asset_amount, amount_ton)::float8 AS asset_amount,
              crypto_asset, payout_channel, wallet_address, status, payout_status, tx_hash,
              requires_dual_approval, first_approved_by, second_approved_by
         FROM core.payout_requests
        WHERE request_id = $1
        LIMIT 1`,
      [requestId]
    );
    return res.rows[0] || null;
  }

  static async getKillSwitchStatus(): Promise<{
    is_enabled: boolean;
    reason: string;
    updated_by?: string;
    updated_at?: string;
  }> {
    if (!pool) {
      return { is_enabled: true, reason: 'POSTGRES_UNAVAILABLE_FAIL_CLOSED' };
    }
    try {
      const res = await pool.query(`SELECT core.get_payout_kill_switch() AS result`);
      const row = res.rows[0]?.result;
      if (!row || typeof row.is_enabled !== 'boolean') {
        return { is_enabled: true, reason: 'KILL_SWITCH_STATUS_INVALID_FAIL_CLOSED' };
      }
      return row;
    } catch {
      return { is_enabled: true, reason: 'KILL_SWITCH_QUERY_ERROR_FAIL_CLOSED' };
    }
  }

  static async setKillSwitchStatus(
    enabled: boolean,
    reason?: string,
    updatedBy = 'admin'
  ): Promise<{ ok: boolean; is_enabled?: boolean; reason?: string; updated_by?: string; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(`SELECT core.set_payout_kill_switch($1, $2, $3) AS result`, [
        Boolean(enabled),
        reason || null,
        updatedBy || 'admin',
      ]);
      return res.rows[0]?.result || { ok: false, error: 'KILL_SWITCH_UPDATE_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'KILL_SWITCH_SQL_ERROR' };
    }
  }

  static async getFinancialLimits(): Promise<Record<string, any> | null> {
    if (!pool) return null;
    try {
      const res = await pool.query(
        `SELECT metadata FROM core.system_controls WHERE control_key = 'PAYOUT_FINANCIAL_LIMITS' LIMIT 1`
      );
      return res.rows[0]?.metadata || null;
    } catch {
      return null;
    }
  }

  static async revokeRewardPostback(
    eventId: string,
    reason = 'PARTNER_CHARGEBACK'
  ): Promise<{ ok: boolean; idempotent?: boolean; status?: string; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(`SELECT core.revoke_settled_reward($1, $2) AS result`, [
        eventId,
        reason,
      ]);
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.ok ?? r.success),
        idempotent: Boolean(r.idempotent),
        status: r.status || r.action,
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'REVOKE_POSTBACK_ERROR' };
    }
  }

  static async reverseCompletedPayout(
    requestId: string,
    reason: string,
    adminActor = 'admin'
  ): Promise<{ ok: boolean; idempotent?: boolean; payout?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(`SELECT core.reverse_completed_payout($1, $2, $3) AS result`, [
        requestId,
        reason,
        adminActor,
      ]);
      return res.rows[0]?.result || { ok: false, error: 'PAYOUT_REVERSAL_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PAYOUT_REVERSAL_SQL_ERROR' };
    }
  }

  static async recordTreasuryConversion(params: {
    conversionId: string;
    fromAsset: string;
    toAsset: string;
    amountUsd: number;
    fxRate?: number;
    externalTxRef?: string;
    recordedBy?: string;
    note?: string;
  }): Promise<{ ok: boolean; error?: string; [key: string]: any }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.record_treasury_conversion($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
        [
          params.conversionId,
          params.fromAsset,
          params.toAsset,
          params.amountUsd,
          params.fxRate ?? 1.0,
          params.externalTxRef || null,
          params.recordedBy || 'owner',
          params.note || null,
        ]
      );
      return res.rows[0]?.result || { ok: false, error: 'TREASURY_CONVERSION_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'TREASURY_CONVERSION_SQL_ERROR' };
    }
  }

  static async logInboundSecurityEvent(params: {
    endpoint: string;
    providerId?: string | null;
    userId?: number | null;
    anomalyCategory:
      | 'TECHNICAL_ERROR'
      | 'SUSPICIOUS_BEHAVIOR'
      | 'REPLAY_ATTEMPT'
      | 'INVALID_SIGNATURE'
      | 'UNAUTHORIZED_URL'
      | 'FRAUDULENT_ACTIVITY';
    errorCode: string;
    sourceIp?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    if (!pool) return;
    try {
      await pool.query(
        `SELECT core.log_inbound_security_event($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          params.endpoint,
          params.providerId || null,
          params.userId && Number.isFinite(params.userId) && params.userId > 0
            ? Math.floor(params.userId)
            : null,
          params.anomalyCategory,
          params.errorCode,
          params.sourceIp || null,
          JSON.stringify(params.details || {}),
        ]
      );
    } catch {
      // Non-blocking audit logging: fail-safe se tabella 015 non ancora applicata
    }
  }

  static async getInboundSecurityLogs(limit = 50, category?: string): Promise<any[]> {
    if (!pool) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    try {
      if (category) {
        const res = await pool.query(
          `SELECT log_id, endpoint, provider_id, user_id, anomaly_category, error_code,
                  source_ip, details_json, created_at
             FROM core.inbound_security_logs
            WHERE anomaly_category = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [category.trim().toUpperCase(), safeLimit]
        );
        return res.rows;
      }
      const res = await pool.query(
        `SELECT log_id, endpoint, provider_id, user_id, anomaly_category, error_code,
                source_ip, details_json, created_at
           FROM core.inbound_security_logs
          ORDER BY created_at DESC
          LIMIT $1`,
        [safeLimit]
      );
      return res.rows;
    } catch {
      return [];
    }
  }

  static async revokeAutoSession(
    sessionId: string,
    reason = 'ADMIN_REVOKED',
    actor = 'admin'
  ): Promise<{ ok: boolean; idempotent?: boolean; session?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(`SELECT core.revoke_auto_session($1, $2, $3) AS result`, [
        sessionId,
        reason,
        actor,
      ]);
      return res.rows[0]?.result || { ok: false, error: 'AUTO_SESSION_REVOKE_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'AUTO_SESSION_REVOKE_SQL_ERROR' };
    }
  }

  static async consumeProviderRateLimit(
    providerId: string,
    endpoint = 'default',
    defaultRpm = 10
  ): Promise<{
    ok: boolean;
    allowed: boolean;
    limit: number;
    remaining: number;
    currentCount: number;
    mode: 'POSTGRES_PERSISTENT' | 'POSTGRES_UNAVAILABLE_FAIL_CLOSED';
    error?: string;
  }> {
    if (!pool) {
      return {
        ok: false,
        allowed: false,
        limit: defaultRpm,
        remaining: 0,
        currentCount: 0,
        mode: 'POSTGRES_UNAVAILABLE_FAIL_CLOSED',
        error: 'POSTGRES_UNAVAILABLE',
      };
    }
    try {
      const res = await pool.query(
        `SELECT core.consume_provider_rate_limit($1, $2, $3) AS result`,
        [providerId, endpoint, defaultRpm]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: true,
        allowed: Boolean(r.allowed),
        limit: Number(r.limit ?? defaultRpm),
        remaining: Number(r.remaining ?? 0),
        currentCount: Number(r.current_count ?? 0),
        mode: 'POSTGRES_PERSISTENT',
      };
    } catch (err: any) {
      return {
        ok: false,
        allowed: false,
        limit: defaultRpm,
        remaining: 0,
        currentCount: 0,
        mode: 'POSTGRES_UNAVAILABLE_FAIL_CLOSED',
        error: err?.message || 'RATE_LIMIT_SQL_ERROR',
      };
    }
  }

  static async setProviderRateLimit(
    providerId: string,
    requestsPerMinute: number,
    actor = 'admin'
  ): Promise<{ ok: boolean; config?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.set_provider_rate_limit($1, $2, $3) AS result`,
        [providerId, Math.floor(requestsPerMinute), actor]
      );
      return res.rows[0]?.result || { ok: false, error: 'RATE_LIMIT_UPDATE_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'RATE_LIMIT_UPDATE_SQL_ERROR' };
    }
  }

  static async reviewProviderAnomalies(
    providerId: string,
    newStatus: 'ACTIVE' | 'WARNING' | 'QUARANTINE' | 'BANNED' = 'ACTIVE',
    reason = 'ADMIN_QUARANTINE_LIFTED',
    actor = 'admin'
  ): Promise<{ ok: boolean; provider?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.admin_review_provider_anomalies($1, $2, $3, $4) AS result`,
        [providerId, newStatus, reason, actor]
      );
      return res.rows[0]?.result || { ok: false, error: 'PROVIDER_REVIEW_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PROVIDER_REVIEW_SQL_ERROR' };
    }
  }

  static async getProviderProtectionThresholds(): Promise<{
    ok: boolean;
    warning_threshold: number;
    quarantine_threshold: number;
    ban_admin_only: boolean;
    source: 'POSTGRES' | 'DEFAULT_OFFLINE';
  }> {
    if (!pool) {
      return {
        ok: false,
        warning_threshold: 3,
        quarantine_threshold: 5,
        ban_admin_only: true,
        source: 'DEFAULT_OFFLINE',
      };
    }
    try {
      const res = await pool.query(
        `SELECT metadata FROM core.system_controls WHERE control_key = 'PROVIDER_PROTECTION_THRESHOLDS' LIMIT 1`
      );
      const m = res.rows[0]?.metadata || {};
      return {
        ok: true,
        warning_threshold: Number(m.warning_threshold ?? 3),
        quarantine_threshold: Number(m.quarantine_threshold ?? 5),
        ban_admin_only: Boolean(m.ban_admin_only ?? true),
        source: 'POSTGRES',
      };
    } catch {
      return {
        ok: false,
        warning_threshold: 3,
        quarantine_threshold: 5,
        ban_admin_only: true,
        source: 'DEFAULT_OFFLINE',
      };
    }
  }

  static async updateProviderProtectionThresholds(
    warningThreshold: number,
    quarantineThreshold: number,
    actor = 'admin'
  ): Promise<{ ok: boolean; error?: string; [key: string]: any }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.update_provider_protection_thresholds($1, $2, $3) AS result`,
        [Math.floor(warningThreshold), Math.floor(quarantineThreshold), actor]
      );
      return res.rows[0]?.result || { ok: false, error: 'THRESHOLDS_UPDATE_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'THRESHOLDS_UPDATE_SQL_ERROR' };
    }
  }

  static async recordPayoutOnchainVerification(params: {
    requestId: string;
    asset: string;
    network: string;
    txHash: string;
    destinationAddress: string;
    expectedAmountAsset: number;
    observedAmountAsset?: number | null;
    confirmations?: number | null;
    commitmentLevel?: string | null;
    verified?: boolean;
    verifiedBy?: string;
    rawProof?: Record<string, unknown>;
  }): Promise<{ ok: boolean; verification?: any; error?: string }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.record_payout_onchain_verification($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) AS result`,
        [
          params.requestId,
          params.asset,
          params.network,
          params.txHash,
          params.destinationAddress,
          Number(params.expectedAmountAsset || 0),
          params.observedAmountAsset ?? null,
          params.confirmations ?? null,
          params.commitmentLevel ?? null,
          params.verified ?? true,
          params.verifiedBy || 'onchain_verifier',
          JSON.stringify(params.rawProof || {}),
        ]
      );
      return res.rows[0]?.result || { ok: false, error: 'ONCHAIN_PROOF_RECORD_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'ONCHAIN_PROOF_RECORD_SQL_ERROR' };
    }
  }

  static async claimPayoutForDispatch(params: {
    requestId: string;
    workerId: string;
    attemptId?: string;
  }): Promise<{
    ok: boolean;
    attempt_id?: string;
    request_id?: string;
    payout?: any;
    dispatch_state?: string;
    active_attempt_id?: string;
    tx_hash?: string;
    error?: string;
  }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.claim_payout_for_dispatch($1, $2, $3) AS result`,
        [params.requestId, params.workerId, params.attemptId || null]
      );
      return res.rows[0]?.result || { ok: false, error: 'PAYOUT_CLAIM_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PAYOUT_CLAIM_SQL_ERROR' };
    }
  }

  static async updatePayoutDispatchState(params: {
    requestId: string;
    attemptId: string;
    nextState:
      | 'BROADCASTING'
      | 'UNCERTAIN_TIMEOUT'
      | 'CONFIRMED_ONCHAIN'
      | 'FAILED_SAFE_RETRYABLE'
      | 'COMPLETED';
    actor?: string;
    txHash?: string | null;
    reason?: string | null;
    chainSeqno?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    idempotent?: boolean;
    attempt_id?: string;
    from_state?: string;
    dispatch_state?: string;
    tx_hash?: string | null;
    error?: string;
  }> {
    if (!pool) return { ok: false, error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.update_payout_dispatch_state($1, $2, $3, $4, $5, $6, $7, $8::jsonb) AS result`,
        [
          params.requestId,
          params.attemptId,
          params.nextState,
          params.actor || 'worker',
          params.txHash || null,
          params.reason || null,
          params.chainSeqno ?? null,
          JSON.stringify(params.metadata || {}),
        ]
      );
      return res.rows[0]?.result || { ok: false, error: 'PAYOUT_DISPATCH_STATE_UPDATE_FAILED' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'PAYOUT_DISPATCH_STATE_SQL_ERROR' };
    }
  }

  static async getUncertainPayoutDispatches(
    limit = 50,
    staleSeconds = 90
  ): Promise<{ ok: boolean; items: any[]; error?: string }> {
    if (!pool) return { ok: false, items: [], error: 'POSTGRES_UNAVAILABLE' };
    try {
      const res = await pool.query(
        `SELECT core.get_uncertain_payout_dispatches($1, $2) AS result`,
        [Math.max(1, Math.min(200, Math.floor(limit))), Math.max(15, Math.floor(staleSeconds))]
      );
      const r = res.rows[0]?.result || {};
      return {
        ok: Boolean(r.ok),
        items: Array.isArray(r.items) ? r.items : [],
        error: r.error,
      };
    } catch (err: any) {
      return { ok: false, items: [], error: err?.message || 'UNCERTAIN_DISPATCH_QUERY_ERROR' };
    }
  }
}

export interface PayoutDispatchStore {
  getKillSwitchStatus: typeof LedgerService.getKillSwitchStatus;
  claimPayoutForDispatch: typeof LedgerService.claimPayoutForDispatch;
  updatePayoutDispatchState: typeof LedgerService.updatePayoutDispatchState;
  getUncertainPayoutDispatches: typeof LedgerService.getUncertainPayoutDispatches;
  recordPayoutOnchainVerification: typeof LedgerService.recordPayoutOnchainVerification;
  completePayout: typeof LedgerService.completePayout;
}
