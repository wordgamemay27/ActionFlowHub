import { Router, Request, Response } from 'express';
import { dbPool } from '../db/ledgerService';
import { ProviderReputationService, ProviderStatus } from '../services/providerReputation';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const providers = await ProviderReputationService.getAllForDashboard();
    const enriched = await Promise.all(
      providers.map(async (p) => {
        const chain = await ProviderReputationService.getFailoverChain(p.provider_id);
        return {
          ...p,
          payoutPercentage:
            Number(p.total_promised_usd) > 0
              ? Math.round((Number(p.total_paid_usd) / Number(p.total_promised_usd)) * 10000) / 100
              : 100,
          failoverChain: chain,
        };
      })
    );
    res.json({ ok: true, providers: enriched });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/health/check', async (_req: Request, res: Response) => {
  try {
    const report = await ProviderReputationService.runDailyHealthCheck();
    res.json({ ok: true, ...report });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (dbPool) {
      const [provider, payments, audit] = await Promise.all([
        dbPool.query('SELECT * FROM core.provider_reputation WHERE provider_id = $1', [id]),
        dbPool.query(
          'SELECT * FROM core.provider_payments WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 20',
          [id]
        ),
        dbPool.query(
          'SELECT action, details, created_at FROM core.provider_audit_log WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 20',
          [id]
        ),
      ]);

      if (provider.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Provider non trovato' });
      }

      const p = provider.rows[0];
      const payoutPct =
        Number(p.total_promised_usd) > 0
          ? Math.round((Number(p.total_paid_usd) / Number(p.total_promised_usd)) * 10000) / 100
          : 100;

      return res.json({
        ok: true,
        provider: {
          ...p,
          payoutPercentage: payoutPct,
          failoverChain: await ProviderReputationService.getFailoverChain(id),
        },
        payments: payments.rows,
        auditLog: audit.rows,
      });
    }

    const all = await ProviderReputationService.getAllForDashboard();
    const found = all.find((x) => x.provider_id === id);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Provider non trovato' });
    }
    const payoutPct =
      Number(found.total_promised_usd) > 0
        ? Math.round((Number(found.total_paid_usd) / Number(found.total_promised_usd)) * 10000) / 100
        : 100;

    return res.json({
      ok: true,
      provider: {
        ...found,
        payoutPercentage: payoutPct,
        failoverChain: await ProviderReputationService.getFailoverChain(id),
      },
      payments: [],
      auditLog: [],
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/:id/payment', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { batchId, promisedUsd, paidUsd, txHash, notes } = req.body || {};

    if (!batchId || promisedUsd === undefined || paidUsd === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'batchId, promisedUsd e paidUsd sono obbligatori',
      });
    }

    const result = await ProviderReputationService.recordPayment({
      providerId: id,
      batchId: String(batchId),
      promisedUsd: Number(promisedUsd),
      paidUsd: Number(paidUsd),
      txHash: txHash ? String(txHash) : undefined,
      notes: notes ? String(notes) : undefined,
    });

    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body || {};
    const validStatuses: ProviderStatus[] = ['ACTIVE', 'WARNING', 'QUARANTINE', 'BANNED'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Status non valido' });
    }

    const result = await ProviderReputationService.setStatus(id, status, reason);
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/:id/failover', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { backupProviderId } = req.body || {};
    if (!backupProviderId) {
      return res.status(400).json({ ok: false, error: 'backupProviderId richiesto' });
    }

    const chain = await ProviderReputationService.addToFailoverChain(id, String(backupProviderId));
    return res.json({ ok: true, providerId: id, failoverChain: chain });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
