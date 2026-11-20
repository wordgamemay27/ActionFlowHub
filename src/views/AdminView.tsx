// ============================================================================
// ADMIN VIEW — Centro di Controllo Visivo, Interattivo & Autopilot
// ============================================================================

import React, { useState, useMemo } from 'react';
import { Transaction } from '../types';
import {
  ShieldAlert,
  DollarSign,
  Activity,
  Settings,
  TrendingUp,
  CheckCircle2,
  Mail,
  ExternalLink,
  Home,
  Search,
  Lock,
  ShieldCheck,
  Globe,
  RefreshCw,
} from 'lucide-react';
import { MAIL_COMPARTMENTS_REGISTRY } from '../lib/catalogMasterData';
import {
  MASTER_PROVIDER_GROUPS,
  ALL_VERIFIED_DIRECT_PROVIDERS,
  BANNED_PROVIDER_KEYWORDS,
} from '../lib/verifiedDirectProviders';
import {
  listCountryEconomicProfiles,
  type CountryEconomicProfile,
} from '../lib/geoEconomics';
import { isObviouslyFakeTxReference } from '../lib/txRefValidation';

interface DbPayoutRow {
  request_id: string;
  user_id: number;
  points: number;
  amount_usd: number;
  amount_ton?: number;
  asset_amount?: number;
  fx_usd_per_asset?: number;
  fx_source?: string;
  crypto_asset: string;
  payout_channel: 'CASH_LOCAL' | 'CRYPTO_DIRECT';
  wallet_address: string;
  status: 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED';
  tx_hash: string | null;
  created_at: string;
}

interface AdminViewProps {
  transactions: Transaction[];
  adminToken?: string;
  onAdminTokenChange?: (token: string) => void;
  onUpdateTransactionStatus?: (
    id: string,
    status: 'APPROVED' | 'COMPLETED' | 'REJECTED',
    txHash?: string
  ) => Promise<{ ok: boolean; error?: string } | void>;
  onNavigateHome?: () => void;
}

export const AdminView: React.FC<AdminViewProps> = ({
  transactions,
  adminToken = '',
  onAdminTokenChange,
  onUpdateTransactionStatus,
  onNavigateHome,
}) => {
  const [activeTab, setActiveTab] = useState<'registry' | 'mail_hub' | 'overview' | 'settings'>(
    'registry'
  );
  const [selectedGroup, setSelectedGroup] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [txHashInputs, setTxHashInputs] = useState<Record<string, string>>({});
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminStatusMsg, setAdminStatusMsg] = useState<string | null>(null);
  const [dbPayouts, setDbPayouts] = useState<DbPayoutRow[]>([]);
  const [loadingDbPayouts, setLoadingDbPayouts] = useState<boolean>(false);
  const [auditReport, setAuditReport] = useState<any>(null);
  const [releaseUserId, setReleaseUserId] = useState<string>('');
  const [releasePoints, setReleasePoints] = useState<string>('');
  const [batchId, setBatchId] = useState<string>('');
  const [batchPartnerId, setBatchPartnerId] = useState<string>('');
  const [batchExpectedUsd, setBatchExpectedUsd] = useState<string>('');
  const [batchNetUsd, setBatchNetUsd] = useState<string>('');
  const [batchHaircut, setBatchHaircut] = useState<string>('1.0');
  const [batchTxHash, setBatchTxHash] = useState<string>('');
  const [batchReceivedAsset, setBatchReceivedAsset] = useState<string>('USDT');
  const [executingBatch, setExecutingBatch] = useState<boolean>(false);
  const [processingMultiAsset, setProcessingMultiAsset] = useState<boolean>(false);
  const [syncingWorldBank, setSyncingWorldBank] = useState<boolean>(false);
  const [adminOperatorId, setAdminOperatorId] = useState<string>('');
  const [treasuryStatus, setTreasuryStatus] = useState<any>(null);
  const [loadingTreasury, setLoadingTreasury] = useState<boolean>(false);
  const [togglingKillSwitch, setTogglingKillSwitch] = useState<boolean>(false);
  const [killSwitchReason, setKillSwitchReason] = useState<string>('');
  const [convFromAsset, setConvFromAsset] = useState<string>('USDT');
  const [convToAsset, setConvToAsset] = useState<string>('TON');
  const [convAmountUsd, setConvAmountUsd] = useState<string>('');
  const [convTxRef, setConvTxRef] = useState<string>('');
  const [worldBankProfiles, setWorldBankProfiles] = useState<CountryEconomicProfile[]>(() =>
    listCountryEconomicProfiles()
  );

  const loadDbPayouts = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per caricare i prelievi da PostgreSQL.');
      return;
    }
    setLoadingDbPayouts(true);
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/payout/list?limit=50', {
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore caricamento prelievi (${res.status})`);
        setDbPayouts([]);
      } else {
        setDbPayouts(Array.isArray(data.payouts) ? data.payouts : []);
      }
    } catch {
      setAdminError('Errore di rete durante la lettura della coda prelievi.');
    } finally {
      setLoadingDbPayouts(false);
    }
  };

  const runLedgerIntegrityAudit = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per eseguire l\'audit PostgreSQL.');
      return;
    }
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/audit/ledger-integrity', {
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdminError(data?.error || `Errore audit (${res.status})`);
        return;
      }
      setAuditReport(data);
      setAdminStatusMsg(
        data?.ok
          ? 'Audit PostgreSQL OK: partita doppia a somma zero e solvibilità verificata.'
          : 'Audit rilevato stato non conforme: verifica dettagli sotto.'
      );
    } catch {
      setAdminError('Errore di rete durante audit integrità ledger.');
    }
  };

  const handleReleaseSettled = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per rilasciare fondi liquidati.');
      return;
    }
    const uid = Number(releaseUserId.trim());
    if (!Number.isFinite(uid) || uid <= 0) {
      setAdminError('Inserisci un Telegram User ID valido.');
      return;
    }
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const pts = releasePoints.trim() ? Number(releasePoints.trim()) : null;
      const res = await fetch('/api/settlement/release-withdrawable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken.trim(),
        },
        body: JSON.stringify({
          userId: uid,
          points: pts && Number.isFinite(pts) && pts > 0 ? Math.floor(pts) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore rilascio (${res.status})`);
        return;
      }
      setAdminStatusMsg(
        `Rilasciati ${Number(data.moved_points || 0)} PT da SETTLED a WITHDRAWABLE per utente #${uid}.`
      );
    } catch {
      setAdminError('Errore di rete durante rilascio SETTLED -> WITHDRAWABLE.');
    }
  };

  const handleExecuteBatchSettlement = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per eseguire un Batch Settlement.');
      return;
    }
    if (!batchId.trim() || !batchPartnerId.trim() || !batchTxHash.trim()) {
      setAdminError('batchId, partnerId e onchainTxHash sono obbligatori per il Batch Settlement.');
      return;
    }
    const expectedGrossUsd = Number(batchExpectedUsd || 0);
    const actualNetReceivedUsd = Number(batchNetUsd || 0);
    const haircutRatio = Number(batchHaircut || 1);
    if (
      !Number.isFinite(expectedGrossUsd) ||
      expectedGrossUsd < 0 ||
      !Number.isFinite(actualNetReceivedUsd) ||
      actualNetReceivedUsd <= 0 ||
      !Number.isFinite(haircutRatio) ||
      haircutRatio <= 0 ||
      haircutRatio > 1
    ) {
      setAdminError('Importi USD (>0) e haircutRatio (0..1] devono essere validi.');
      return;
    }

    setExecutingBatch(true);
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/settlement/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken.trim(),
        },
        body: JSON.stringify({
          batchId: batchId.trim(),
          partnerId: batchPartnerId.trim(),
          expectedGrossUsd,
          actualNetReceivedUsd,
          haircutRatio,
          onchainTxHash: batchTxHash.trim(),
          receivedAsset: batchReceivedAsset,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore Batch Settlement (${res.status})`);
        return;
      }
      setAdminStatusMsg(
        `Batch ${batchId.trim()} eseguito (${batchReceivedAsset}) su PostgreSQL: $${actualNetReceivedUsd.toFixed(2)} netti, tx ${batchTxHash.trim().slice(0, 12)}...`
      );
      setBatchId('');
      setBatchTxHash('');
      void loadTreasuryStatus();
    } catch {
      setAdminError('Errore di rete durante POST /api/settlement/execute.');
    } finally {
      setExecutingBatch(false);
    }
  };

  const loadTreasuryStatus = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per leggere stato Tesoreria & Kill Switch.');
      return;
    }
    setLoadingTreasury(true);
    setAdminError(null);
    try {
      const res = await fetch('/api/admin/treasury-status', {
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore lettura Tesoreria (${res.status})`);
        return;
      }
      setTreasuryStatus(data);
    } catch {
      setAdminError('Errore di rete durante GET /api/admin/treasury-status.');
    } finally {
      setLoadingTreasury(false);
    }
  };

  const handleToggleKillSwitch = async (enable: boolean) => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per modificare il Kill Switch globale.');
      return;
    }
    setTogglingKillSwitch(true);
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/admin/kill-switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken.trim(),
          ...(adminOperatorId.trim() ? { 'X-Admin-Id': adminOperatorId.trim() } : {}),
        },
        body: JSON.stringify({
          enabled: enable,
          reason: killSwitchReason.trim() || (enable ? 'MANUAL_EMERGENCY_STOP' : 'ADMIN_RESUME'),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore Kill Switch (${res.status})`);
        return;
      }
      setAdminStatusMsg(
        enable
          ? 'KILL SWITCH ATTIVO: nuovi prelievi, approvazioni e pagamenti bloccati.'
          : 'Kill Switch disattivato: pagamenti ripristinati secondo soglie e copertura.'
      );
      void loadTreasuryStatus();
    } catch {
      setAdminError('Errore di rete durante POST /api/admin/kill-switch.');
    } finally {
      setTogglingKillSwitch(false);
    }
  };

  const handleTreasuryConvert = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per registrare una conversione Tesoreria.');
      return;
    }
    const amt = Number(convAmountUsd || 0);
    if (!Number.isFinite(amt) || amt <= 0) {
      setAdminError('Inserisci un importo USD (>0) valido per la conversione.');
      return;
    }
    const cleanRef = convTxRef.trim();
    if (isObviouslyFakeTxReference(cleanRef, 8)) {
      setAdminError('Ref Swap / Tx Hash reale obbligatorio (minimo 8 caratteri, nessun prefisso test/fake).');
      return;
    }
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/admin/treasury-convert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken.trim(),
          ...(adminOperatorId.trim() ? { 'X-Admin-Id': adminOperatorId.trim() } : {}),
        },
        body: JSON.stringify({
          fromAsset: convFromAsset,
          toAsset: convToAsset,
          amountUsd: amt,
          externalTxRef: cleanRef,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Errore conversione (${res.status})`);
        return;
      }
      setAdminStatusMsg(`Conversione registrata: $${amt.toFixed(2)} da ${convFromAsset} a ${convToAsset}.`);
      setConvAmountUsd('');
      setConvTxRef('');
      void loadTreasuryStatus();
    } catch {
      setAdminError('Errore di rete durante POST /api/admin/treasury-convert.');
    }
  };

  const handleProcessTonQueue = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per processare i prelievi TON approvati.');
      return;
    }
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/payout/process-ton', {
        method: 'POST',
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Dispatch TON bloccato (${res.status})`);
        return;
      }
      setAdminStatusMsg(`Dispatch TON eseguito: ${data.processed || 0} prelievi processati.`);
      void loadDbPayouts();
    } catch {
      setAdminError('Errore di rete durante dispatch TON worker.');
    }
  };

  const handleProcessAllQueue = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per processare i prelievi multi-asset approvati.');
      return;
    }
    setProcessingMultiAsset(true);
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/payout/process-all', {
        method: 'POST',
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Dispatch Multi-Asset bloccato (${res.status})`);
        return;
      }
      setAdminStatusMsg(
        `Dispatch Multi-Asset eseguito: ${data.succeededCount ?? 0} completati (${data.failedCount ?? 0} bloccati/falliti).`
      );
      void loadDbPayouts();
    } catch {
      setAdminError('Errore di rete durante dispatch multi-asset worker.');
    } finally {
      setProcessingMultiAsset(false);
    }
  };

  const handleSyncWorldBankPpp = async () => {
    if (!adminToken.trim()) {
      setAdminError('Inserisci X-Admin-Token per sincronizzare i coefficienti PPP Banca Mondiale.');
      return;
    }
    setSyncingWorldBank(true);
    setAdminError(null);
    setAdminStatusMsg(null);
    try {
      const res = await fetch('/api/economics/sync-worldbank', {
        method: 'POST',
        headers: { 'X-Admin-Token': adminToken.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setAdminError(data?.error || `Sync Banca Mondiale fallita (${res.status})`);
        return;
      }
      if (Array.isArray(data.countries) && data.countries.length > 0) {
        setWorldBankProfiles(data.countries);
      } else {
        setWorldBankProfiles(listCountryEconomicProfiles());
      }
      setAdminStatusMsg(
        `Sync Banca Mondiale (${data.indicator || 'PA.NUS.PRVT.PP'}) completata: ${data.updatedCount || 0} Paesi (${data.source || 'WDI'}).`
      );
    } catch {
      setAdminError('Errore di rete durante la sincronizzazione PPP Banca Mondiale.');
    } finally {
      setSyncingWorldBank(false);
    }
  };

  const handleDisburseAction = async (
    requestId: string,
    status: 'APPROVED' | 'COMPLETED' | 'REJECTED'
  ) => {
    if (!onUpdateTransactionStatus) return;
    setAdminError(null);
    setAdminStatusMsg(null);
    const enteredHash = (txHashInputs[requestId] || '').trim();
    if (status === 'COMPLETED' && enteredHash.length < 8) {
      setAdminError(
        'Hash / ID transazione reale obbligatorio (minimo 8 caratteri) prima di confermare COMPLETED.'
      );
      return;
    }
    if (adminToken.trim()) {
      try {
        const res = await fetch('/api/payout/disburse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': adminToken.trim(),
            ...(adminOperatorId.trim() ? { 'X-Admin-Id': adminOperatorId.trim() } : {}),
          },
          body: JSON.stringify({
            requestId,
            status,
            txHash: status === 'COMPLETED' ? enteredHash : undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          setAdminError(data?.error || `Operazione rifiutata (${res.status})`);
          return;
        }
        const verifiedActor =
          data.payout?.second_approved_by ||
          data.payout?.first_approved_by ||
          adminOperatorId.trim() ||
          'token_operator';
        setAdminStatusMsg(
          data.requiresSecondApproval
            ? `Prima approvazione registrata da ${verifiedActor}. Richiesta seconda approvazione da operatore con token distinto (>= $50).`
            : `Payout ${requestId} aggiornato a ${status}.`
        );
        void loadDbPayouts();
        void loadTreasuryStatus();
        return;
      } catch {
        setAdminError('Errore di rete durante POST /api/payout/disburse.');
        return;
      }
    }
    if (!onUpdateTransactionStatus) return;
    const result = await onUpdateTransactionStatus(
      requestId,
      status,
      status === 'COMPLETED' ? enteredHash : undefined
    );
    if (result && result.ok === false) {
      setAdminError(result.error || 'Operazione rifiutata dal server.');
      return;
    }
    if (adminToken.trim()) {
      void loadDbPayouts();
    }
  };

  const stats = useMemo(() => {
    const activeCount = ALL_VERIFIED_DIRECT_PROVIDERS.filter((p) => !p.isLocked).length;
    const lockedCount = ALL_VERIFIED_DIRECT_PROVIDERS.filter((p) => p.isLocked).length;
    const totalPoints = transactions
      .filter(
        (t) =>
          t.status === 'COMPLETED' &&
          t.amountPoints > 0 &&
          t.type !== 'WITHDRAWAL' &&
          t.type !== 'PENALTY'
      )
      .reduce((acc, curr) => acc + curr.amountPoints, 0);
    const totalWithdrawn = transactions
      .filter((t) => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED')
      .reduce((acc, curr) => acc + curr.amountTon, 0);

    return {
      totalDirectProviders: ALL_VERIFIED_DIRECT_PROVIDERS.length,
      activeCount,
      lockedCount,
      totalPoints,
      totalWithdrawn: Number(totalWithdrawn.toFixed(4)),
    };
  }, [transactions]);

  const filteredProviders = useMemo(() => {
    const base =
      selectedGroup === 'ALL'
        ? ALL_VERIFIED_DIRECT_PROVIDERS
        : MASTER_PROVIDER_GROUPS.find((g) => g.groupKey === selectedGroup)?.items || [];

    if (!searchQuery.trim()) return base;
    const q = searchQuery.toLowerCase();
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.currencies.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    );
  }, [selectedGroup, searchQuery]);

  return (
    <div className="space-y-3 pb-12 select-none">
      {/* HEADER BAR COMPATTA */}
      <div className="rounded-2xl bg-[#091224] p-3.5 border border-sky-400/25 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-400/35 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <h2 className="text-sm font-black text-white uppercase tracking-wider">
              Control Center • PostgreSQL Authority
            </h2>
            <div className="flex items-center gap-2 text-[10px] font-mono text-emerald-300 mt-0.5">
              <span>{stats.activeCount} Attivi</span>
              <span>•</span>
              <span className="text-amber-300">{stats.lockedCount} Bloccati (PayPal)</span>
              <span>•</span>
              <span className="text-sky-300">{BANNED_PROVIDER_KEYWORDS.length} Nomi Banditi</span>
            </div>
          </div>
        </div>

        {onNavigateHome && (
          <button
            type="button"
            onClick={onNavigateHome}
            className="px-3 py-2 rounded-xl bg-sky-500 text-slate-950 font-mono text-xs font-black uppercase flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Home</span>
          </button>
        )}
      </div>

      {/* NAVIGAZIONE TAB INTERATTIVA */}
      <div className="grid grid-cols-4 gap-1.5 bg-[#070d19] p-1.5 rounded-2xl border border-sky-500/20">
        {[
          { id: 'registry' as const, label: `Fornitori (${stats.totalDirectProviders})`, icon: ShieldCheck },
          { id: 'mail_hub' as const, label: '5 Mail', icon: Mail },
          { id: 'overview' as const, label: 'Ledger & Payout', icon: Activity },
          { id: 'settings' as const, label: 'Soglie', icon: Settings },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-2 px-2 rounded-xl font-mono text-[10px] font-black uppercase flex items-center justify-center gap-1 transition-all cursor-pointer ${
                active
                  ? 'bg-sky-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: REGISTRO UNICO FORNITORI */}
      {activeTab === 'registry' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/40 p-2.5 text-center">
              <div className="text-xs font-black text-emerald-300">1 = OK</div>
              <div className="text-[10px] font-mono text-slate-300 mt-0.5">Haircut Automatico</div>
            </div>
            <div className="rounded-xl bg-amber-500/15 border border-amber-400/40 p-2.5 text-center">
              <div className="text-xs font-black text-amber-300">2 = WARNING</div>
              <div className="text-[10px] font-mono text-slate-300 mt-0.5">Avviso Automatico</div>
            </div>
            <div className="rounded-xl bg-rose-500/20 border border-rose-400/50 p-2.5 text-center">
              <div className="text-xs font-black text-rose-300">3 = BLOCCO</div>
              <div className="text-[10px] font-mono text-slate-300 mt-0.5">Quarantena + Failover</div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#091224] border border-sky-400/25 p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedGroup('ALL')}
                className={`px-2.5 py-1.5 rounded-xl font-mono text-[10px] font-black uppercase shrink-0 cursor-pointer ${
                  selectedGroup === 'ALL'
                    ? 'bg-sky-400 text-slate-950'
                    : 'bg-[#050b16] border border-white/10 text-slate-300'
                }`}
              >
                Tutti ({stats.totalDirectProviders})
              </button>
              {MASTER_PROVIDER_GROUPS.map((g) => (
                <button
                  key={g.groupKey}
                  type="button"
                  onClick={() => setSelectedGroup(g.groupKey)}
                  className={`px-2.5 py-1.5 rounded-xl font-mono text-[10px] font-black uppercase shrink-0 cursor-pointer ${
                    selectedGroup === g.groupKey
                      ? 'bg-sky-400 text-slate-950'
                      : 'bg-[#050b16] border border-white/10 text-slate-300'
                  }`}
                >
                  {g.groupTitle} ({g.items.length})
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Verifica qualsiasi nome nel registro unico..."
                className="w-full rounded-xl bg-[#050b16] border border-sky-400/25 pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
              />
            </div>

            <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
              {filteredProviders.map((p, idx) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-[#050b16] border border-white/10 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-6 h-6 rounded-lg bg-sky-500/15 border border-sky-400/30 font-mono text-[10px] font-black text-sky-300 flex items-center justify-center shrink-0">
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="font-bold text-white truncate">{p.name}</div>
                      <div className="text-[10px] font-mono text-slate-400 truncate">
                        {p.currencies} • {p.payoutInfo}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.isLocked ? (
                      <span className="px-2 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/40 font-mono text-[10px] font-black text-amber-300 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        <span>BLOCCATO</span>
                      </span>
                    ) : p.isServiceOnly ? (
                      <span className="px-2 py-0.5 rounded-md bg-sky-500/20 border border-sky-400/40 font-mono text-[10px] font-black text-sky-300">
                        SERVIZIO DIRETTO
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 font-mono text-[10px] font-black text-emerald-300 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>+{p.userPoints} PT</span>
                      </span>
                    )}
                    <a
                      href={p.directUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/20 text-sky-300"
                      title="Apri URL Fornitore"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: 5 CASELLE MAIL COMPARTIMENTATE */}
      {activeTab === 'mail_hub' && (
        <div className="grid grid-cols-1 gap-2">
          {MAIL_COMPARTMENTS_REGISTRY.map((mail) => (
            <div
              key={mail.id}
              className="rounded-2xl bg-[#090F1E] border border-indigo-500/30 p-3 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center font-mono text-xs font-black text-indigo-300 shrink-0">
                  #{mail.compartmentNumber}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-black text-white">{mail.domain}</div>
                  <div className="text-[11px] text-slate-300 truncate">{mail.scope}</div>
                </div>
              </div>
              <a
                href={mail.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-xl bg-indigo-600/30 border border-indigo-400/40 text-xs font-bold text-indigo-200 flex items-center gap-1.5 shrink-0"
              >
                <span>Apri</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ))}
        </div>
      )}

      {/* TAB 3: LEDGER, AUDIT INTEGRITÀ, RILASCIO & CODA PRELIEVI */}
      {activeTab === 'overview' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-2xl bg-[#091324] border border-sky-400/25 p-3 text-center">
              <Activity className="w-4 h-4 text-sky-400 mx-auto mb-1" />
              <div className="text-lg font-black text-white">{stats.totalDirectProviders}</div>
              <div className="text-[10px] font-mono uppercase text-slate-400">Fornitori</div>
            </div>
            <div className="rounded-2xl bg-[#091324] border border-emerald-400/25 p-3 text-center">
              <TrendingUp className="w-4 h-4 text-emerald-400 mx-auto mb-1" />
              <div className="text-lg font-black text-emerald-300">{stats.totalPoints} PT</div>
              <div className="text-[10px] font-mono uppercase text-slate-400">Punti</div>
            </div>
            <div className="rounded-2xl bg-[#091324] border border-amber-400/25 p-3 text-center">
              <DollarSign className="w-4 h-4 text-amber-400 mx-auto mb-1" />
              <div className="text-lg font-black text-amber-300">{stats.totalWithdrawn}</div>
              <div className="text-[10px] font-mono uppercase text-slate-400">Asset Payout</div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#0A1122] border border-sky-500/20 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-mono font-black uppercase tracking-wider text-sky-300">
                Controlli Contabili PostgreSQL
              </h3>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void loadDbPayouts()}
                  disabled={loadingDbPayouts}
                  className="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/40 text-[10px] font-mono font-black text-sky-200 cursor-pointer disabled:opacity-50"
                >
                  {loadingDbPayouts ? 'Caricamento...' : 'Carica Coda DB'}
                </button>
                <button
                  type="button"
                  onClick={() => void runLedgerIntegrityAudit()}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/40 text-[10px] font-mono font-black text-emerald-200 cursor-pointer"
                >
                  Audit Integrità DB
                </button>
                <button
                  type="button"
                  onClick={() => void handleProcessTonQueue()}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/40 text-[10px] font-mono font-black text-amber-200 cursor-pointer"
                >
                  Processa TON
                </button>
                <button
                  type="button"
                  disabled={processingMultiAsset}
                  onClick={() => void handleProcessAllQueue()}
                  className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/35 border border-indigo-400/40 text-[10px] font-mono font-black text-indigo-200 cursor-pointer disabled:opacity-50"
                >
                  {processingMultiAsset ? 'Dispatch...' : 'Processa Tutti (Multi-Asset)'}
                </button>
              </div>
            </div>

            {onAdminTokenChange && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="password"
                  value={adminToken}
                  onChange={(e) => onAdminTokenChange(e.target.value)}
                  placeholder="Inserisci X-Admin-Token per autorizzare le operazioni"
                  className="sm:col-span-2 rounded-xl bg-[#050b16] border border-sky-400/25 px-3 py-2 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                />
                <input
                  type="text"
                  value={adminOperatorId}
                  onChange={(e) => setAdminOperatorId(e.target.value)}
                  placeholder="ID Operatore (opz., verificato su token)"
                  className="rounded-xl bg-[#050b16] border border-sky-400/25 px-3 py-2 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                />
              </div>
            )}

            {/* KILL SWITCH & TESORERIA MULTI-ASSET */}
            <div className="rounded-xl bg-[#050b16] border border-rose-400/25 p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-mono font-black uppercase tracking-wider text-rose-300">
                  Kill Switch & Tesoreria Per-Asset ({treasuryStatus?.payoutExecutionMode || 'MANUAL_EXTERNAL'})
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={loadingTreasury}
                    onClick={() => void loadTreasuryStatus()}
                    className="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/40 text-[10px] font-mono font-black text-sky-200 cursor-pointer disabled:opacity-50"
                  >
                    {loadingTreasury ? 'Caricamento...' : 'Stato Tesoreria'}
                  </button>
                  <button
                    type="button"
                    disabled={togglingKillSwitch}
                    onClick={() => void handleToggleKillSwitch(true)}
                    className="px-2.5 py-1 rounded-lg bg-rose-500/25 hover:bg-rose-500/40 border border-rose-400/50 text-[10px] font-mono font-black text-rose-200 cursor-pointer disabled:opacity-50"
                  >
                    Attiva Kill Switch
                  </button>
                  <button
                    type="button"
                    disabled={togglingKillSwitch}
                    onClick={() => void handleToggleKillSwitch(false)}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/40 text-[10px] font-mono font-black text-emerald-200 cursor-pointer disabled:opacity-50"
                  >
                    Riattiva
                  </button>
                </div>
              </div>

              <input
                type="text"
                value={killSwitchReason}
                onChange={(e) => setKillSwitchReason(e.target.value)}
                placeholder="Motivo attivazione/disattivazione Kill Switch (opzionale)"
                className="w-full rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white placeholder:text-slate-500"
              />

              {treasuryStatus && (
                <div className="space-y-2">
                  <div className="text-[10px] font-mono text-slate-300 flex flex-wrap items-center gap-3">
                    <span>
                      Kill Switch:{' '}
                      <strong className={treasuryStatus.killSwitch?.is_enabled ? 'text-rose-400' : 'text-emerald-300'}>
                        {treasuryStatus.killSwitch?.is_enabled ? 'ATTIVO (BLOCCATO)' : 'DISATTIVO (OPERATIVO)'}
                      </strong>
                    </span>
                    <span>
                      Modalità: <strong className="text-sky-300">{treasuryStatus.payoutExecutionMode}</strong>
                    </span>
                    <span>
                      Max Singolo: <strong>{Number(treasuryStatus.limits?.max_single_payout_points || 10000)} PT</strong>
                    </span>
                  </div>

                  {Array.isArray(treasuryStatus.assets) && treasuryStatus.assets.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      {treasuryStatus.assets.map((row: any) => (
                        <div
                          key={row.asset}
                          className="rounded-lg bg-[#091224] border border-white/10 p-2 text-[10px] font-mono"
                        >
                          <div className="font-black text-white">{row.asset}</div>
                          <div className="text-emerald-300">
                            Netto: {Number(row.net_withdrawable_points || 0)} PT
                          </div>
                          <div className="text-slate-400">
                            Cap ${Number(row.actual_cash_on_chain || 0).toFixed(2)} • Pagato ${Number(row.disbursed_usd || 0).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 pt-1">
                    <select
                      value={convFromAsset}
                      onChange={(e) => setConvFromAsset(e.target.value)}
                      className="rounded-lg bg-[#091224] border border-white/15 px-2 py-1 text-[11px] font-mono text-white"
                    >
                      {['USDT', 'USDC', 'TON', 'SOL', 'PI', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'].map((a) => (
                        <option key={a} value={a}>Da: {a}</option>
                      ))}
                    </select>
                    <select
                      value={convToAsset}
                      onChange={(e) => setConvToAsset(e.target.value)}
                      className="rounded-lg bg-[#091224] border border-white/15 px-2 py-1 text-[11px] font-mono text-white"
                    >
                      {['TON', 'SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'].map((a) => (
                        <option key={a} value={a}>A: {a}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={convAmountUsd}
                      onChange={(e) => setConvAmountUsd(e.target.value)}
                      placeholder="USD"
                      className="rounded-lg bg-[#091224] border border-white/15 px-2 py-1 text-[11px] font-mono text-white"
                    />
                    <input
                      type="text"
                      value={convTxRef}
                      onChange={(e) => setConvTxRef(e.target.value)}
                      placeholder="Ref Swap / Tx Hash (obblig.)"
                      className="rounded-lg bg-[#091224] border border-white/15 px-2 py-1 text-[11px] font-mono text-white"
                    />
                    <button
                      type="button"
                      onClick={() => void handleTreasuryConvert()}
                      className="rounded-lg bg-indigo-500/25 hover:bg-indigo-500/40 border border-indigo-400/45 text-[10px] font-mono font-black text-indigo-200 uppercase cursor-pointer"
                    >
                      Converti Cassa
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* RILASCIO SETTLED -> WITHDRAWABLE */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <input
                type="number"
                value={releaseUserId}
                onChange={(e) => setReleaseUserId(e.target.value)}
                placeholder="Telegram User ID"
                className="rounded-xl bg-[#050b16] border border-sky-400/25 px-2.5 py-1.5 text-xs font-mono text-white"
              />
              <input
                type="number"
                value={releasePoints}
                onChange={(e) => setReleasePoints(e.target.value)}
                placeholder="Punti (vuoto = tutti)"
                className="rounded-xl bg-[#050b16] border border-sky-400/25 px-2.5 py-1.5 text-xs font-mono text-white"
              />
              <button
                type="button"
                onClick={() => void handleReleaseSettled()}
                className="rounded-xl bg-cyan-500/25 hover:bg-cyan-500/40 border border-cyan-400/45 text-[10px] font-mono font-black text-cyan-200 uppercase cursor-pointer"
              >
                Rilascia Prelevabili
              </button>
            </div>

            {/* BATCH SETTLEMENT (POST /api/settlement/execute) */}
            <div className="rounded-xl bg-[#050b16] border border-emerald-400/25 p-3 space-y-2">
              <div className="text-[11px] font-mono font-black uppercase tracking-wider text-emerald-300">
                Esegui Batch Settlement (PENDING → SETTLED su incasso reale)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value)}
                  placeholder="Batch ID (es. batch_2026_11)"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                />
                <input
                  type="text"
                  value={batchPartnerId}
                  onChange={(e) => setBatchPartnerId(e.target.value)}
                  placeholder="Partner ID (es. reelshort)"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                />
                <input
                  type="text"
                  value={batchTxHash}
                  onChange={(e) => setBatchTxHash(e.target.value)}
                  placeholder="Tx Hash on-chain incasso reale"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white col-span-2 sm:col-span-1"
                />
                <input
                  type="number"
                  step="0.01"
                  value={batchExpectedUsd}
                  onChange={(e) => setBatchExpectedUsd(e.target.value)}
                  placeholder="Lordo atteso ($ USD)"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                />
                <input
                  type="number"
                  step="0.01"
                  value={batchNetUsd}
                  onChange={(e) => setBatchNetUsd(e.target.value)}
                  placeholder="Netto incassato ($ USD)"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1"
                  value={batchHaircut}
                  onChange={(e) => setBatchHaircut(e.target.value)}
                  placeholder="Haircut (es. 1.0)"
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                />
                <select
                  value={batchReceivedAsset}
                  onChange={(e) => setBatchReceivedAsset(e.target.value)}
                  className="rounded-lg bg-[#091224] border border-white/15 px-2.5 py-1.5 text-xs font-mono text-white"
                >
                  {['USDT', 'USDC', 'TON', 'SOL', 'PI', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'].map((a) => (
                    <option key={a} value={a}>
                      Asset Incasso: {a}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={executingBatch}
                onClick={() => void handleExecuteBatchSettlement()}
                className="w-full py-2 rounded-lg bg-emerald-500/25 hover:bg-emerald-500/40 border border-emerald-400/45 text-[11px] font-mono font-black text-emerald-200 uppercase cursor-pointer disabled:opacity-50"
              >
                {executingBatch ? 'Esecuzione Batch Settlement...' : 'Registra Incasso & Liquida Batch'}
              </button>
            </div>

            {adminStatusMsg && (
              <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/40 px-3 py-2 text-[11px] font-mono text-emerald-200">
                {adminStatusMsg}
              </div>
            )}

            {adminError && (
              <div className="rounded-xl bg-rose-500/15 border border-rose-400/40 px-3 py-2 text-[11px] font-mono text-rose-200">
                {adminError}
              </div>
            )}

            {auditReport && (
              <div className="rounded-xl bg-[#050b16] border border-emerald-400/30 p-2.5 text-[10px] font-mono text-slate-300 space-y-1">
                <div>
                  Integrità Ledger: <strong className="text-emerald-300">{String(auditReport.ok)}</strong> • Solvibilità Treasury:{' '}
                  <strong className="text-sky-300">{String(auditReport.solvency?.isSolvent)}</strong>
                </div>
                <div>
                  Cassa Raccolta: ${Number(auditReport.solvency?.totalCashCollectedUsd || 0).toFixed(2)} • Pagata: $
                  {Number(auditReport.solvency?.totalCashDisbursedUsd || 0).toFixed(2)} • Capacità Residua:{' '}
                  {Number(auditReport.solvency?.netWithdrawableCapacityPoints || 0)} PT
                </div>
              </div>
            )}

            {dbPayouts.length > 0 && (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {dbPayouts.map((p) => (
                  <div
                    key={p.request_id}
                    className="p-2.5 rounded-xl bg-[#060c18] border border-sky-400/20 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-white truncate">
                          {p.crypto_asset} ({p.payout_channel}) → {p.wallet_address}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400">
                          ID: {p.request_id} • User #{p.user_id} • ${Number(p.amount_usd).toFixed(2)}
                          {p.asset_amount ? ` • ${Number(p.asset_amount).toFixed(4)} ${p.crypto_asset}` : ''}
                          {p.fx_source ? ` (${p.fx_source})` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-amber-300 bg-amber-500/20 border border-amber-500/30">
                          {p.status}
                        </span>
                        <span className="font-mono font-black text-emerald-300">{p.points} PT</span>
                      </div>
                    </div>

                    {(p.status === 'PENDING' || p.status === 'APPROVED') && onUpdateTransactionStatus && (
                      <div className="pt-1.5 space-y-1.5 border-t border-white/5">
                        <input
                          type="text"
                          value={txHashInputs[p.request_id] || ''}
                          onChange={(e) =>
                            setTxHashInputs((prev) => ({
                              ...prev,
                              [p.request_id]: e.target.value,
                            }))
                          }
                          placeholder="Hash on-chain / ID ricevuta gateway reale (min 8 caratteri)"
                          className="w-full rounded-lg bg-[#040812] border border-white/15 px-2.5 py-1.5 text-[11px] font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                        />
                        <div className="flex items-center gap-1.5">
                          {p.status === 'PENDING' && (
                            <button
                              type="button"
                              onClick={() => void handleDisburseAction(p.request_id, 'APPROVED')}
                              className="px-2 py-0.5 rounded bg-sky-600/30 hover:bg-sky-600/50 border border-sky-400/40 text-[10px] font-bold text-sky-200 cursor-pointer"
                            >
                              Approva
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleDisburseAction(p.request_id, 'COMPLETED')}
                            className="px-2 py-0.5 rounded bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-400/40 text-[10px] font-bold text-emerald-200 cursor-pointer"
                          >
                            Salda & Completa
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDisburseAction(p.request_id, 'REJECTED')}
                            className="px-2 py-0.5 rounded bg-rose-600/30 hover:bg-rose-600/50 border border-rose-400/40 text-[10px] font-bold text-rose-200 cursor-pointer"
                          >
                            Rifiuta & Rimborsa
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-[#0A1122] border border-sky-500/20 p-3.5 space-y-2">
            <h3 className="text-xs font-mono font-black uppercase tracking-wider text-sky-300">
              Transazioni Sessione ({transactions.length})
            </h3>
            {transactions.length === 0 ? (
              <p className="text-xs text-slate-400 py-3 text-center">
                Nessuna transazione in questa sessione.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {transactions.slice(0, 30).map((tx) => (
                  <div
                    key={tx.id}
                    className="p-2 rounded-xl bg-[#060c18] border border-white/10 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-white truncate">{tx.details || `${tx.type} (${tx.amountPoints} PT)`}</div>
                        <div className="text-[10px] font-mono text-slate-400">
                          {new Date(tx.timestamp).toLocaleString('it-IT')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                            tx.status === 'COMPLETED'
                              ? 'text-teal-300 bg-teal-500/20 border border-teal-500/30'
                              : tx.status === 'APPROVED'
                              ? 'text-sky-300 bg-sky-500/20 border border-sky-500/30'
                              : tx.status === 'FAILED' || tx.status === 'CANCELLED'
                              ? 'text-rose-300 bg-rose-500/20 border border-rose-500/30'
                              : 'text-amber-300 bg-amber-500/20 border border-amber-500/30'
                          }`}
                        >
                          {tx.status}
                        </span>
                        <span
                          className={`font-mono font-black ${
                            tx.type === 'WITHDRAWAL' || tx.type === 'PENALTY' || tx.amountPoints < 0
                              ? 'text-amber-300'
                              : 'text-emerald-300'
                          }`}
                        >
                          {tx.type === 'WITHDRAWAL' || tx.type === 'PENALTY' || tx.amountPoints < 0
                            ? `-${Math.abs(tx.amountPoints)} PT`
                            : `+${tx.amountPoints} PT`}
                        </span>
                      </div>
                    </div>

                    {tx.type === 'WITHDRAWAL' && (tx.status === 'PENDING' || tx.status === 'APPROVED') && onUpdateTransactionStatus && (
                      <div className="pt-1.5 space-y-1.5 border-t border-white/5">
                        <input
                          type="text"
                          value={txHashInputs[tx.id] || ''}
                          onChange={(e) =>
                            setTxHashInputs((prev) => ({
                              ...prev,
                              [tx.id]: e.target.value,
                            }))
                          }
                          placeholder="Hash on-chain / ID ricevuta gateway reale (min 8 caratteri)"
                          className="w-full rounded-lg bg-[#040812] border border-white/15 px-2.5 py-1 text-[11px] font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                        />
                        <div className="flex items-center gap-1.5">
                          {tx.status === 'PENDING' && (
                            <button
                              type="button"
                              onClick={() => void handleDisburseAction(tx.id, 'APPROVED')}
                              className="px-2 py-0.5 rounded bg-sky-600/30 hover:bg-sky-600/50 border border-sky-400/40 text-[10px] font-bold text-sky-200 cursor-pointer"
                            >
                              Approva
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleDisburseAction(tx.id, 'COMPLETED')}
                            className="px-2 py-0.5 rounded bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-400/40 text-[10px] font-bold text-emerald-200 cursor-pointer"
                          >
                            Salda & Completa
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDisburseAction(tx.id, 'REJECTED')}
                            className="px-2 py-0.5 rounded bg-rose-600/30 hover:bg-rose-600/50 border border-rose-400/40 text-[10px] font-bold text-rose-200 cursor-pointer"
                          >
                            Rifiuta & Rimborsa
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: REGOLE AUTOREVOLI POSTGRESQL & PPP BANCA MONDIALE */}
      {activeTab === 'settings' && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-[#0A1122] p-4 border border-sky-500/20 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-mono font-black uppercase tracking-wider text-sky-300">
                Regole Contabili PostgreSQL (Sola Lettura)
              </h3>
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/35 text-[10px] font-mono font-black text-emerald-300">
                HARDENED 008–014
              </span>
            </div>

            <div className="space-y-2">
              {[
                { label: 'Scala Contabile Unica', value: '100 PT = $1.00 USD (Prelievi invariati)' },
                {
                  label: 'Ripartizione Postback Verificati',
                  value: 'FLOOR(raw * 0.30 * ppp_coefficient) Utente / >=70% Piattaforma',
                },
                {
                  label: 'Regole Coefficienti PPP',
                  value: 'US = 1.0 • Europa = 1.0 • World Bank PA.NUS.PRVT.PP / PA.NUS.FCRF',
                },
                { label: 'Soglia Minima Prelievo', value: '500 PT ($5.00 USD) • Doppia Approvazione >= 5000 PT' },
                {
                  label: 'Tesoreria & Payout (M1-M5)',
                  value: 'MANUAL_EXTERNAL • Capacità isolata per TON, SOL, PI, USDT, USDC, CASH',
                },
                { label: 'Riserva Treasury (Solvibilità)', value: '15% per singolo asset (v_treasury_vault_status)' },
                { label: 'Protezione Anti-Abuso', value: '3-Strike + Kill Switch Globale + Verifica Tx On-Chain' },
                { label: 'Blocco Paese Economico', value: 'Persistente su core.users (migrazioni 011–014)' },
              ].map((policy) => (
                <div
                  key={policy.label}
                  className="flex items-center justify-between gap-3 rounded-xl bg-[#050b16] border border-white/10 px-3 py-2"
                >
                  <span className="text-xs font-bold text-slate-300">{policy.label}</span>
                  <span className="text-xs font-mono font-black text-emerald-300 text-right">
                    {policy.value}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              Le soglie finanziarie e i moltiplicatori PPP sono applicati direttamente dalle funzioni
              atomiche PostgreSQL e non sono modificabili arbitrariamente lato client.
            </p>
          </div>

          <div className="rounded-2xl bg-[#0A1122] p-4 border border-indigo-500/25 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-indigo-300" />
                <h3 className="text-xs font-mono font-black uppercase tracking-wider text-indigo-200">
                  Tabella PPP Banca Mondiale ({worldBankProfiles.length} Paesi)
                </h3>
              </div>
              <button
                type="button"
                disabled={syncingWorldBank}
                onClick={() => void handleSyncWorldBankPpp()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/25 hover:bg-indigo-500/40 border border-indigo-400/45 text-[10px] font-mono font-black text-indigo-100 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${syncingWorldBank ? 'animate-spin' : ''}`} />
                <span>{syncingWorldBank ? 'Sync...' : 'Aggiorna Banca Mondiale'}</span>
              </button>
            </div>

            {onAdminTokenChange && (
              <input
                type="password"
                value={adminToken}
                onChange={(e) => onAdminTokenChange(e.target.value)}
                placeholder="X-Admin-Token richiesto per sincronizzare l'API World Bank"
                className="w-full rounded-xl bg-[#050b16] border border-indigo-400/25 px-3 py-1.5 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
              />
            )}

            {adminStatusMsg && (
              <div className="rounded-xl bg-emerald-500/15 border border-emerald-400/40 px-3 py-2 text-[11px] font-mono text-emerald-200">
                {adminStatusMsg}
              </div>
            )}

            {adminError && (
              <div className="rounded-xl bg-rose-500/15 border border-rose-400/40 px-3 py-2 text-[11px] font-mono text-rose-200">
                {adminError}
              </div>
            )}

            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {worldBankProfiles.map((cp) => (
                <div
                  key={cp.countryCode}
                  className="flex items-center justify-between gap-2 rounded-lg bg-[#050b16] border border-white/10 px-2.5 py-1.5 text-[11px] font-mono"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-black text-white w-12 shrink-0">{cp.countryCode}</span>
                    <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[10px]">
                      {cp.tierZone}
                    </span>
                    <span className="text-slate-400 truncate">{cp.regionGroup}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-slate-400 text-[10px]">
                      PLI {cp.wbPriceLevelIndex.toFixed(4)}
                    </span>
                    <span className="font-black text-emerald-300">
                      x{cp.pppCoefficient.toFixed(4)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminView;
