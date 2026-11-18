import { dbPool } from '../db/ledgerService';

export type ProviderStatus = 'ACTIVE' | 'WARNING' | 'QUARANTINE' | 'BANNED';

export interface ProviderReputationRecord {
  provider_id: string;
  provider_name: string;
  category: string;
  status: ProviderStatus;
  reputation_score: number;
  ema_haircut_ratio: number;
  total_promised_usd: number;
  total_paid_usd: number;
  total_batches: number;
  consecutive_low_batches: number;
  failover_chain: string[];
  last_payment_at: string | null;
  quarantine_reason: string | null;
  updated_at: string;
}

export interface RecordPaymentInput {
  providerId: string;
  batchId: string;
  promisedUsd: number;
  paidUsd: number;
  txHash?: string;
  notes?: string;
}

const EMA_ALPHA = 0.35;
const QUARANTINE_RATIO_THRESHOLD = 0.75;
const WARNING_RATIO_THRESHOLD = 0.90;
const STRIKE_TRIGGER_RATIO_THRESHOLD = 0.95; // Qualsiasi batch < 95% del promesso fa scattare 1 Strike Fornitore


const inMemoryProviders = new Map<string, ProviderReputationRecord>([
  [
    'reelshort',
    {
      provider_id: 'reelshort',
      provider_name: 'ReelShort Direct Video',
      category: 'VIDEO',
      status: 'ACTIVE',
      reputation_score: 98.5,
      ema_haircut_ratio: 0.985,
      total_promised_usd: 1200,
      total_paid_usd: 1182,
      total_batches: 12,
      consecutive_low_batches: 0,
      failover_chain: ['dramabox', 'shorttv'],
      last_payment_at: new Date().toISOString(),
      quarantine_reason: null,
      updated_at: new Date().toISOString(),
    },
  ],
  [
    'plarium',
    {
      provider_id: 'plarium',
      provider_name: 'Plarium Direct Studio',
      category: 'GAMES',
      status: 'ACTIVE',
      reputation_score: 96.0,
      ema_haircut_ratio: 0.96,
      total_promised_usd: 2500,
      total_paid_usd: 2400,
      total_batches: 18,
      consecutive_low_batches: 0,
      failover_chain: ['wargaming', 'gaijin'],
      last_payment_at: new Date().toISOString(),
      quarantine_reason: null,
      updated_at: new Date().toISOString(),
    },
  ],
]);

export class ProviderReputationService {
  static async getAllForDashboard(): Promise<ProviderReputationRecord[]> {
    if (dbPool) {
      const res = await dbPool.query(
        'SELECT * FROM core.provider_reputation ORDER BY reputation_score DESC, provider_id ASC'
      );
      return res.rows;
    }
    return Array.from(inMemoryProviders.values());
  }

  static async getActiveProvidersForCategory(category: string): Promise<ProviderReputationRecord[]> {
    if (dbPool) {
      const res = await dbPool.query(
        `SELECT * FROM core.provider_reputation
         WHERE UPPER(category) = UPPER($1) AND status IN ('ACTIVE', 'WARNING')
         ORDER BY reputation_score DESC`,
        [category]
      );
      return res.rows;
    }
    return Array.from(inMemoryProviders.values()).filter(
      (p) => p.category.toUpperCase() === category.toUpperCase() && (p.status === 'ACTIVE' || p.status === 'WARNING')
    );
  }

  static async getFailoverChain(providerId: string): Promise<string[]> {
    if (dbPool) {
      const res = await dbPool.query(
        'SELECT failover_chain FROM core.provider_reputation WHERE provider_id = $1',
        [providerId]
      );
      return res.rows[0]?.failover_chain || [];
    }
    return inMemoryProviders.get(providerId)?.failover_chain || [];
  }

  static async addToFailoverChain(providerId: string, backupProviderId: string): Promise<string[]> {
    if (dbPool) {
      const res = await dbPool.query(
        `UPDATE core.provider_reputation
         SET failover_chain = CASE
           WHEN NOT ($2 = ANY(failover_chain)) THEN array_append(failover_chain, $2)
           ELSE failover_chain
         END,
         updated_at = NOW()
         WHERE provider_id = $1
         RETURNING failover_chain`,
        [providerId, backupProviderId]
      );
      await dbPool.query(
        `INSERT INTO core.provider_audit_log (provider_id, action, details)
         VALUES ($1, 'FAILOVER_ADDED', $2::jsonb)`,
        [providerId, JSON.stringify({ backupProviderId })]
      );
      return res.rows[0]?.failover_chain || [];
    }

    const existing = inMemoryProviders.get(providerId);
    if (!existing) return [];
    if (!existing.failover_chain.includes(backupProviderId)) {
      existing.failover_chain.push(backupProviderId);
      existing.updated_at = new Date().toISOString();
    }
    return existing.failover_chain;
  }

  static async setStatus(
    providerId: string,
    status: ProviderStatus,
    reason?: string
  ): Promise<{ ok: boolean; provider?: ProviderReputationRecord }> {
    if (dbPool) {
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        const res = await client.query(
          `UPDATE core.provider_reputation
           SET status = $2,
               quarantine_reason = $3,
               updated_at = NOW()
           WHERE provider_id = $1
           RETURNING *`,
          [providerId, status, reason || null]
        );
        if ((res.rowCount || 0) > 0) {
          await client.query(
            `INSERT INTO core.provider_audit_log (provider_id, action, details)
             VALUES ($1, 'STATUS_CHANGE', $2::jsonb)`,
            [providerId, JSON.stringify({ status, reason: reason || null })]
          );
          await client.query('SELECT core.sync_provider_exposure_status($1)', [providerId]);
        }
        await client.query('COMMIT');
        return { ok: (res.rowCount || 0) > 0, provider: res.rows[0] };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const rec = inMemoryProviders.get(providerId);
    if (!rec) return { ok: false };
    rec.status = status;
    rec.quarantine_reason = reason || null;
    rec.updated_at = new Date().toISOString();
    return { ok: true, provider: rec };
  }

  static async recordPayment(input: RecordPaymentInput): Promise<{
    ok: boolean;
    providerId: string;
    haircutRatio: number;
    newEmaRatio: number;
    newReputationScore: number;
    status: ProviderStatus;
    strikeLevel: 0 | 1 | 2 | 3;
    strikeVerdict: '0_REGOLARE' | '1_OK_TOLLERATO' | '2_NON_BENE_WARNING' | '3_VERIFICA_E_BLOCCO';
  }> {
    const promised = Math.max(0, Number(input.promisedUsd) || 0);
    const paid = Math.max(0, Number(input.paidUsd) || 0);
    const ratio = promised > 0 ? Math.min(1.5, paid / promised) : 1.0;

    if (dbPool) {
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        const curRes = await client.query(
          'SELECT * FROM core.provider_reputation WHERE provider_id = $1 FOR UPDATE',
          [input.providerId]
        );

        let currentEma = 1.0;
        let consecutiveLow = 0;
        let currentStatus: ProviderStatus = 'ACTIVE';

        if (curRes.rowCount === 0) {
          await client.query(
            `INSERT INTO core.provider_reputation (
               provider_id, provider_name, category, status, reputation_score, ema_haircut_ratio
             ) VALUES ($1, $2, 'GENERAL', 'ACTIVE', 100.00, 1.0000)`,
            [input.providerId, input.providerId]
          );
        } else {
          const row = curRes.rows[0];
          currentEma = Number(row.ema_haircut_ratio) || 1.0;
          consecutiveLow = Number(row.consecutive_low_batches) || 0;
          currentStatus = row.status as ProviderStatus;
        }

        const newEma = Number((EMA_ALPHA * ratio + (1 - EMA_ALPHA) * currentEma).toFixed(4));
        const newScore = Number(Math.max(0, Math.min(100, newEma * 100)).toFixed(2));
        // REGOLA RIGIDA 3-STRIKE FORNITORE: ogni pagamento < 95% incrementa il contatore Strike (1 -> 2 -> 3)
        const nextConsecutiveLow = ratio < STRIKE_TRIGGER_RATIO_THRESHOLD ? consecutiveLow + 1 : 0;

        let nextStatus: ProviderStatus = currentStatus;
        let quarantineReason: string | null = null;
        let strikeLevel: 0 | 1 | 2 | 3 = 0;
        let strikeVerdict: '0_REGOLARE' | '1_OK_TOLLERATO' | '2_NON_BENE_WARNING' | '3_VERIFICA_E_BLOCCO' = '0_REGOLARE';

        if (newEma < QUARANTINE_RATIO_THRESHOLD || ratio < 0.70 || nextConsecutiveLow >= 3) {
          // STRIKE 3 = VERIFICA E BLOCCO IMMEDIATO (QUARANTINE + FAILOVER)
          nextStatus = 'QUARANTINE';
          strikeLevel = 3;
          strikeVerdict = '3_VERIFICA_E_BLOCCO';
          quarantineReason = `STRIKE 3 (VERIFICA E BLOCCO): Fornitore bloccato in quarantena (Strike=${nextConsecutiveLow}, EMA=${newEma})`;
        } else if (nextConsecutiveLow === 2 || newEma < WARNING_RATIO_THRESHOLD) {
          // STRIKE 2 = NON BENE (PENALITÀ & AVVISO SEVERO)
          nextStatus = 'WARNING';
          strikeLevel = 2;
          strikeVerdict = '2_NON_BENE_WARNING';
          quarantineReason = `STRIKE 2 (NON BENE): 2° scostamento consecutivo registrato. Al 3° scatta il blocco automatico.`;
        } else if (nextConsecutiveLow === 1) {
          // STRIKE 1 = OK (1° EPISODIO TOLLERATO CON HAIRCUT PROPORZIONALE)
          nextStatus = currentStatus !== 'BANNED' ? 'ACTIVE' : 'BANNED';
          strikeLevel = 1;
          strikeVerdict = '1_OK_TOLLERATO';
        } else if (currentStatus !== 'BANNED') {
          nextStatus = 'ACTIVE';
          strikeLevel = 0;
          strikeVerdict = '0_REGOLARE';
        }

        await client.query(
          `INSERT INTO core.provider_payments (
             provider_id, batch_id, promised_usd, paid_usd, haircut_ratio, tx_hash, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.providerId,
            input.batchId,
            promised,
            paid,
            ratio,
            input.txHash || null,
            input.notes || null,
          ]
        );

        await client.query(
          `UPDATE core.provider_reputation
           SET ema_haircut_ratio = $2,
               reputation_score = $3,
               total_promised_usd = total_promised_usd + $4,
               total_paid_usd = total_paid_usd + $5,
               total_batches = total_batches + 1,
               consecutive_low_batches = $6,
               status = $7,
               quarantine_reason = COALESCE($8, quarantine_reason),
               last_payment_at = NOW(),
               updated_at = NOW()
           WHERE provider_id = $1`,
          [
            input.providerId,
            newEma,
            newScore,
            promised,
            paid,
            nextConsecutiveLow,
            nextStatus,
            quarantineReason,
          ]
        );

        await client.query(
          `INSERT INTO core.provider_audit_log (provider_id, action, details)
           VALUES ($1, 'PAYMENT_RECORDED', $2::jsonb)`,
          [
            input.providerId,
            JSON.stringify({
              batchId: input.batchId,
              promisedUsd: promised,
              paidUsd: paid,
              haircutRatio: ratio,
              newEma,
              newScore,
              status: nextStatus,
              strikeLevel,
              strikeVerdict,
            }),
          ]
        );

        await client.query('SELECT core.sync_provider_exposure_status($1)', [input.providerId]);

        await client.query('COMMIT');
        return {
          ok: true,
          providerId: input.providerId,
          haircutRatio: ratio,
          newEmaRatio: newEma,
          newReputationScore: newScore,
          status: nextStatus,
          strikeLevel,
          strikeVerdict,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Nessun ripiego silenzioso su RAM per pagamenti fornitore quando PostgreSQL non è disponibile
    throw new Error('POSTGRES_REQUIRED_FOR_PROVIDER_PAYMENT');
  }

  static async runDailyHealthCheck(): Promise<{
    checkedCount: number;
    quarantinedIds: string[];
    warningIds: string[];
  }> {
    const all = await this.getAllForDashboard();
    const quarantinedIds: string[] = [];
    const warningIds: string[] = [];

    for (const p of all) {
      if (p.status === 'QUARANTINE') quarantinedIds.push(p.provider_id);
      if (p.status === 'WARNING') warningIds.push(p.provider_id);
    }

    return {
      checkedCount: all.length,
      quarantinedIds,
      warningIds,
    };
  }
}
