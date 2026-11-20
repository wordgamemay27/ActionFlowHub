import { dbPool, LedgerService } from './ledgerService';

export interface BatchSettlementInput {
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

export interface BatchSettlementResult {
  success: boolean;
  batchId: string;
  receivedAsset?: string;
  eventsSettled?: number;
  pointsCreditedToUsers?: number;
  releasedToWithdrawablePoints?: number;
  platformTreasuryGainPoints?: number;
  haircutApplied?: number;
  status?: string;
  idempotent?: boolean;
  error?: string;
}

export class SettlementService {
  static async executeBatchSettlement(
    input: BatchSettlementInput
  ): Promise<BatchSettlementResult> {
    if (!dbPool) {
      return {
        success: false,
        batchId: input.batchId,
        error: 'Database pool not initialized (PostgreSQL is required)',
      };
    }

    const receivedAsset = String(input.receivedAsset || 'USDT').trim().toUpperCase();
    const VALID_ASSETS = new Set([
      'TON',
      'SOL',
      'PI',
      'USDT',
      'USDC',
      'CASH_AIRTM',
      'CASH_PAYEER',
      'CASH_VOLET',
    ]);
    if (!VALID_ASSETS.has(receivedAsset)) {
      return {
        success: false,
        batchId: input.batchId,
        error: 'UNSUPPORTED_SETTLEMENT_ASSET',
      };
    }
    try {
      const res = await dbPool.query(
        `SELECT core.execute_batch_settlement($1, $2, $3::bigint, $4::bigint, $5::numeric, $6::numeric, $7::numeric, $8::text, $9::text) AS result`,
        [
          input.batchId,
          input.partnerId,
          Math.trunc(input.periodStart),
          Math.trunc(input.periodEnd),
          input.expectedGrossUsd,
          input.actualNetReceivedUsd,
          input.haircutRatio,
          input.onchainTxHash,
          receivedAsset,
        ]
      );

      const data = res.rows[0]?.result;
      if (!data?.success) {
        return {
          success: false,
          batchId: input.batchId,
          error: data?.error || 'Settlement rejected by ledger function',
        };
      }

      const totalSettledPts = Number(data.total_points_settled || 0);
      const unallocatedPts = Number(data.unallocated_points || 0);
      const grossReceivedPts = Math.floor((Number(input.actualNetReceivedUsd) || 0) * 100);
      const platformGainPts =
        typeof data.platform_revenue_points === 'number'
          ? Math.max(0, Number(data.platform_revenue_points))
          : Math.max(0, grossReceivedPts - totalSettledPts - unallocatedPts);
      return {
        success: true,
        batchId: input.batchId,
        receivedAsset: String(data.received_asset || receivedAsset),
        eventsSettled: Number(data.settled_users_count || 0),
        pointsCreditedToUsers: totalSettledPts,
        releasedToWithdrawablePoints: unallocatedPts,
        platformTreasuryGainPoints: platformGainPts,
        haircutApplied: Number(data.haircut_ratio ?? input.haircutRatio ?? 1),
        status: data.idempotent ? 'IDEMPOTENT' : 'COMPLETED',
        idempotent: Boolean(data.idempotent),
      };
    } catch (err: any) {
      console.error('[SETTLEMENT ERROR]:', err);
      return {
        success: false,
        batchId: input.batchId,
        error: err.message,
      };
    }
  }

  static async releaseSettledToWithdrawable(
    userId: number,
    points?: number | null,
    referenceId?: string | null
  ) {
    return LedgerService.releaseSettledToWithdrawable(userId, points, referenceId);
  }

  static async getTreasurySolvencyStatus(): Promise<{
    totalCashCollectedUsd: number;
    totalCashDisbursedUsd: number;
    remainingGrossPointsCapacity: number;
    netWithdrawableCapacityPoints: number;
    totalUserWithdrawableAndReservedPoints: number;
    totalUserPendingPoints: number;
    totalUserSettledPoints: number;
    isSolvent: boolean;
  }> {
    if (!dbPool) {
      return {
        totalCashCollectedUsd: 0,
        totalCashDisbursedUsd: 0,
        remainingGrossPointsCapacity: 0,
        netWithdrawableCapacityPoints: 0,
        totalUserWithdrawableAndReservedPoints: 0,
        totalUserPendingPoints: 0,
        totalUserSettledPoints: 0,
        isSolvent: true,
      };
    }

    const res = await dbPool.query(`SELECT * FROM core.v_treasury_solvency`);
    const r = res.rows[0] || {};
    const netWithdrawableCapacityPoints = Number(r.net_withdrawable_capacity_points || 0);
    const totalUserWithdrawableAndReservedPoints = Number(
      r.total_user_withdrawable_and_reserved_points || 0
    );

    return {
      totalCashCollectedUsd: Number(r.total_cash_collected_usd || 0),
      totalCashDisbursedUsd: Number(r.total_cash_disbursed_usd || 0),
      remainingGrossPointsCapacity: Number(r.remaining_gross_points_capacity || 0),
      netWithdrawableCapacityPoints,
      totalUserWithdrawableAndReservedPoints,
      totalUserPendingPoints: Number(r.total_user_pending_points || 0),
      totalUserSettledPoints: Number(r.total_user_settled_points || 0),
      isSolvent: netWithdrawableCapacityPoints >= totalUserWithdrawableAndReservedPoints,
    };
  }

  static async getTreasuryAssetBreakdown(): Promise<
    Array<{
      asset: string;
      actualCashOnChainUsd: number;
      disbursedUsd: number;
      pointsCapacity: number;
      disbursedPoints: number;
      reservedBufferPercent: number;
      grossRemainingPoints: number;
      netWithdrawablePoints: number;
      approvedPendingPoints: number;
      availableAfterApprovedPoints: number;
      reserved15PctPoints: number;
      updatedAt: string | null;
    }>
  > {
    if (!dbPool) return [];
    try {
      const res = await dbPool.query(`SELECT * FROM core.v_treasury_vault_status`);
      return res.rows.map((r) => {
        const grossRem = Number(r.gross_remaining_points || 0);
        const netWithdrawable = Number(r.net_withdrawable_points || 0);
        const approvedPending = Number(r.approved_pending_points || 0);
        return {
          asset: String(r.asset),
          actualCashOnChainUsd: Number(r.actual_cash_on_chain || 0),
          disbursedUsd: Number(r.disbursed_usd || 0),
          pointsCapacity: Number(r.points_equivalent_capacity || 0),
          disbursedPoints: Number(r.disbursed_points || 0),
          reservedBufferPercent: Number(r.reserved_buffer_percent ?? 0.15),
          grossRemainingPoints: grossRem,
          netWithdrawablePoints: netWithdrawable,
          approvedPendingPoints: approvedPending,
          availableAfterApprovedPoints: Number(
            r.available_after_approved_points ?? Math.max(0, netWithdrawable - approvedPending)
          ),
          reserved15PctPoints: Number(
            r.reserved_15pct_points ?? Math.max(0, grossRem - netWithdrawable)
          ),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        };
      });
    } catch {
      const res = await dbPool.query(
        `SELECT asset, actual_cash_on_chain, disbursed_usd, points_equivalent_capacity, disbursed_points, reserved_buffer_percent, updated_at
           FROM core.treasury_vault
          ORDER BY asset ASC`
      );
      return res.rows.map((r) => {
        const grossRem = Math.max(
          0,
          Number(r.points_equivalent_capacity || 0) - Number(r.disbursed_points || 0)
        );
        const buf = Number(r.reserved_buffer_percent ?? 0.15);
        const netW = Math.floor(grossRem * (1 - buf));
        return {
          asset: String(r.asset),
          actualCashOnChainUsd: Number(r.actual_cash_on_chain || 0),
          disbursedUsd: Number(r.disbursed_usd || 0),
          pointsCapacity: Number(r.points_equivalent_capacity || 0),
          disbursedPoints: Number(r.disbursed_points || 0),
          reservedBufferPercent: buf,
          grossRemainingPoints: grossRem,
          netWithdrawablePoints: netW,
          approvedPendingPoints: 0,
          availableAfterApprovedPoints: netW,
          reserved15PctPoints: Math.max(0, grossRem - netW),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        };
      });
    }
  }
}
