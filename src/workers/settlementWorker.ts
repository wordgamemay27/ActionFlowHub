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

  static queueSettlement(job: SettlementJob): void {
    settlementQueue.push({
      ...job,
      status: 'PENDING',
      createdAt: Date.now(),
      attempts: 0,
    });
  }

  static async processNext(): Promise<boolean> {
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
      total: settlementQueue.length,
      pending: settlementQueue.filter((j) => j.status === 'PENDING').length,
      processing: settlementQueue.filter((j) => j.status === 'PROCESSING').length,
      completed: settlementQueue.filter((j) => j.status === 'COMPLETED').length,
      failed: settlementQueue.filter((j) => j.status === 'FAILED').length,
    };
  }
}

export const settlementWorker = SettlementWorker;
