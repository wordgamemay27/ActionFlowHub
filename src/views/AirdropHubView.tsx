// ============================================================================
// EXCHANGE, WALLET & AIRDROP CERTIFICATI (TELEGRAM/TON + WEB3 ESCROW)
// Distinti per categoria con DOPPIO LINK:
// 1. Nostro Link Iscrizione Wallet (se l'utente non ha ancora il Wallet per partecipare)
// 2. Nostro Link Referral Airdrop / Interazione (per partecipare e incassare i token)
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, ShieldCheck, Wallet, Search, Sparkles } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
  AirdropSubKind,
} from '../components/ProviderExecutionModal';
import {
  VERIFIED_EXCHANGE_TON_PROVIDERS,
  isProviderAllowedByBlacklist,
} from '../lib/verifiedDirectProviders';
import { sortProvidersByPriority } from '../lib/providerPriority';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';

interface AirdropHubViewProps {
  user: UserProfile;
  userCountry?: string;
  onBack: () => void;
}

export const AirdropHubView: React.FC<AirdropHubViewProps> = ({
  user,
  userCountry,
  onBack,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'ALL' | AirdropSubKind>('ALL');

  const geoCompatibleProviders = useMemo(() => {
    const clean = VERIFIED_EXCHANGE_TON_PROVIDERS.filter(isProviderAllowedByBlacklist);
    return sortProvidersByPriority(clean, userCountry || user.marketCountry, undefined, {
      excludeIncompatibleGeo: true,
      activityCategory: 'AIRDROP',
    });
  }, [userCountry, user.marketCountry]);

  const filteredProviders = useMemo(() => {
    return geoCompatibleProviders.filter((p) => {
      const kind: AirdropSubKind = p.airdropKind || 'WALLET_EXCHANGE';
      if (activeFilter !== 'ALL' && kind !== activeFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.currencies.toLowerCase().includes(q) ||
        p.shortDescription.toLowerCase().includes(q)
      );
    });
  }, [geoCompatibleProviders, searchQuery, activeFilter]);

  // Link 2: Apertura Link Referral Airdrop / Servizio Principale
  const handleExecuteService = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: `airdrop_ref_${provider.id}_u${user.telegramId || 0}`,
      activityCategory: 'AIRDROP',
      telegramId: user.telegramId,
      kind: 'REFERRAL',
    });
  };

  // Link 1: Apertura Nostro Link Iscrizione Wallet (se l'utente non ha ancora il Wallet)
  const handleOpenWalletSignup = (provider: VerifiedProviderItem) => {
    if (!provider.walletSignupUrl) return;
    openTrackedLink(provider.walletSignupUrl, {
      partnerId: `${provider.id}_wallet_signup`,
      taskId: `wallet_signup_${provider.id}_u${user.telegramId || 0}`,
      activityCategory: 'AIRDROP',
      telegramId: user.telegramId,
      kind: 'SIGNUP',
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="airdrop" placement="AIRDROP_TOP" telegramUserId={user?.telegramId} />

      {/* HEADER */}
      <div className="rounded-2xl border border-sky-400/25 bg-[#071122]/90 p-4 space-y-3">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-amber-400">
              <Wallet className="w-4 h-4 text-amber-300" />
              <span>⚡ {t.nav.airdrop}</span>
            </div>
            <h2 className="text-base font-black text-white mt-0.5">
              {filteredProviders.length} {t.ui.airdropSubtitle}
            </h2>
          </div>
        </div>

        <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 p-3 flex items-start gap-2.5 text-xs text-amber-100">
          <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>{t.ui.airdropHowTo}</div>
        </div>

        {/* FILTRI SEMPLICI */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveFilter('ALL')}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer ${
              activeFilter === 'ALL'
                ? 'bg-sky-400 text-slate-950 shadow'
                : 'bg-[#0b172d] border border-sky-400/25 text-slate-300 hover:text-white'
            }`}
          >
            {t.ui.allFilter} ({geoCompatibleProviders.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('TELEGRAM_TON_AIRDROP')}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase flex items-center gap-1 transition-all cursor-pointer ${
              activeFilter === 'TELEGRAM_TON_AIRDROP'
                ? 'bg-cyan-400 text-slate-950 shadow'
                : 'bg-[#0b172d] border border-cyan-400/30 text-cyan-300 hover:text-white'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>{t.ui.telegramAirdropsFilter}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('WEB3_ESCROW_AIRDROP')}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase flex items-center gap-1 transition-all cursor-pointer ${
              activeFilter === 'WEB3_ESCROW_AIRDROP'
                ? 'bg-emerald-400 text-slate-950 shadow'
                : 'bg-[#0b172d] border border-emerald-400/30 text-emerald-300 hover:text-white'
            }`}
          >
            <ShieldCheck className="w-3 h-3" />
            <span>{t.ui.web3CampaignsFilter}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('WALLET_EXCHANGE')}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase flex items-center gap-1 transition-all cursor-pointer ${
              activeFilter === 'WALLET_EXCHANGE'
                ? 'bg-amber-400 text-slate-950 shadow'
                : 'bg-[#0b172d] border border-amber-400/30 text-amber-300 hover:text-white'
            }`}
          >
            <Wallet className="w-3 h-3" />
            <span>{t.ui.officialWalletsFilter}</span>
          </button>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.ui.searchPlaceholder}
            className="w-full rounded-xl bg-[#050b16] border border-sky-400/25 pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
          />
        </div>
      </div>

      {/* GRIGLIA WALLET & AIRDROP CON DOPPIO LINK E FOTO CLICCABILE */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredProviders.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteService}
            onOpenWalletSignup={handleOpenWalletSignup}
          />
        ))}
      </div>

      {/* MODALE ISTRUZIONI INTERNE QUANDO CLICCHI LA FOTO */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteService}
        onOpenWalletSignup={handleOpenWalletSignup}
      />
    </div>
  );
};

export default AirdropHubView;
