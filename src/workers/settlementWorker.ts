import { SettlementService } from '../db/settlementService';
import { ProviderReputationService } from '../services/providerReputation';
import { dbPool } from '../db/ledgerService';

export interface SettlementJob {
  batchId: string;
  partnerId: string;
  periodStart: number;
  periodEnd: number;
  expectedGrossUsd: number;
  actualNetReceivedUsd: number;
  haircutRatio: number;
  onchainTxHash: string;
  receivedAsset?: string;
}

const settlementQueue: Array<
  SettlementJob & {
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    createdAt: number;
    attempts: number;
  }
> = [];

const SETTLEMENT_POLL_INTERVAL = 60_000;
const MAX_RETRIES = 3;

export class SettlementWorker {
  private static isRunning = false;
  private static pollTimer: NodeJS.Timeout | null = null;

  static async queueSettlement(job: SettlementJob): Promise<void> {
    const asset = String(job.receivedAsset || 'USDT').trim().toUpperCase();
    if (dbPool) {
      try {
        await dbPool.query(
          `INSERT INTO core.settlement_jobs (
             batch_id, partner_id, period_start_ms, period_end_ms,
             expected_gross_usd, actual_net_received_usd, haircut_ratio,
             onchain_tx_hash, received_asset, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
           ON CONFLICT (batch_id) DO NOTHING`,
          [
            job.batchId,
            job.partnerId,
            Math.trunc(job.periodStart),
            Math.trunc(job.periodEnd),
            job.expectedGrossUsd,
            job.actualNetReceivedUsd,
            job.haircutRatio,
            job.onchainTxHash,
            asset,
          ]
        );
        return;
      } catch (err: any) {
        console.warn('[SETTLEMENT WORKER] Fallback coda RAM (tabella settlement_jobs non disponibile):', err.message);
      }
    }

    settlementQueue.push({
      ...job,
      receivedAsset: asset,
      status: 'PENDING',
      createdAt: Date.now(),
      attempts: 0,
    });
  }

  static async processNext(): Promise<boolean> {
    if (dbPool) {
      try {
        const client = await dbPool.connect();
        let claimed: any = null;
        try {
          await client.query('BEGIN');
          const res = await client.query(
            `SELECT *
               FROM core.settlement_jobs
              WHERE status = 'PENDING' AND attempts < $1
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1`,
            [MAX_RETRIES]
          );
          if (res.rows[0]) {
            claimed = res.rows[0];
            await client.query(
              `UPDATE core.settlement_jobs
                  SET status = 'PROCESSING',
                      attempts = attempts + 1,
                      updated_at = NOW()
                WHERE batch_id = $1`,
              [claimed.batch_id]
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        if (claimed) {
          try {
            const result = await SettlementService.executeBatchSettlement({
              batchId: String(claimed.batch_id),
              partnerId: String(claimed.partner_id),
              periodStart: Number(claimed.period_start_ms),
              periodEnd: Number(claimed.period_end_ms),
              expectedGrossUsd: Number(claimed.expected_gross_usd),
              actualNetReceivedUsd: Number(claimed.actual_net_received_usd),
              haircutRatio: Number(claimed.haircut_ratio),
              onchainTxHash: String(claimed.onchain_tx_hash),
              receivedAsset: String(claimed.received_asset || 'USDT'),
            });

            if (result.success) {
              await dbPool.query(
                `UPDATE core.settlement_jobs
                    SET status = 'COMPLETED',
                        last_error = NULL,
                        updated_at = NOW()
                  WHERE batch_id = $1`,
                [claimed.batch_id]
              );
              await ProviderReputationService.runDailyHealthCheck().catch(() => {});
              return true;
            }
            throw new Error(result.error || 'Settlement execution failed');
          } catch (err: any) {
            const nextStatus = Number(claimed.attempts) + 1 >= MAX_RETRIES ? 'FAILED' : 'PENDING';
            await dbPool.query(
              `UPDATE core.settlement_jobs
                  SET status = $2,
                      last_error = $3,
                      updated_at = NOW()
                WHERE batch_id = $1`,
              [claimed.batch_id, nextStatus, String(err?.message || 'UNKNOWN_ERROR').slice(0, 400)]
            );
            return false;
          }
        }
      } catch {
        // Fallback alla coda in memoria se tabella non ancora migrata
      }
    }

    const jobIndex = settlementQueue.findIndex((j) => j.status === 'PENDING');
    if (jobIndex === -1) return false;

    const job = settlementQueue[jobIndex];
    job.status = 'PROCESSING';
    job.attempts++;

    try {
      const result = await SettlementService.executeBatchSettlement({
        batchId: job.batchId,
        partnerId: job.partnerId,
        periodStart: job.periodStart,
        periodEnd: job.periodEnd,
        expectedGrossUsd: job.expectedGrossUsd,
        actualNetReceivedUsd: job.actualNetReceivedUsd,
        haircutRatio: job.haircutRatio,
        onchainTxHash: job.onchainTxHash,
        receivedAsset: job.receivedAsset || 'USDT',
      });

      if (result.success) {
        job.status = 'COMPLETED';
        if (dbPool) {
          await ProviderReputationService.runDailyHealthCheck().catch(() => {});
        }
        return true;
      } else {
        throw new Error(result.error || 'Settlement execution failed');
      }
    } catch (err: any) {
      console.error(`[SETTLEMENT WORKER] Errore batch ${job.batchId}:`, err.message);
      if (job.attempts >= MAX_RETRIES) {
        job.status = 'FAILED';
      } else {
        job.status = 'PENDING';
      }
      return false;
    }
  }

  static start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollTimer = setInterval(() => {
      void this.processNext();
    }, SETTLEMENT_POLL_INTERVAL);
  }

  static stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
  }

  static getQueueStatus() {
    return {
      isRunning: this.isRunning,
      persistentTable: 'core.settlement_jobs',
      total: settlementQueue.length,
      pending: settlementQueue.filter((j) => j.status === 'PENDING').length,
      processing: settlementQueue.filter((j) => j.status === 'PROCESSING').length,
      completed: settlementQueue.filter((j) => j.status === 'COMPLETED').length,
      failed: settlementQueue.filter((j) => j.status === 'FAILED').length,
    };
  }
}

export const settlementWorker = SettlementWorker;
