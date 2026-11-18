// ============================================================================
// DEPIN & PASSIVE AI NODES VIEW — Nodi AI & Banda Passiva 100% Diretti
// Ogni fornitore ha foto cliccabile che apre le istruzioni interne e modalità.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Cpu, Search } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_DEPIN_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface DepinNodesViewProps {
  user: UserProfile;
  userCountry?: string;
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

export const DepinNodesView: React.FC<DepinNodesViewProps> = ({
  user,
  userCountry = 'IT',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProviders = useMemo(() => {
    const base = !searchQuery.trim()
      ? VERIFIED_DEPIN_PROVIDERS
      : VERIFIED_DEPIN_PROVIDERS.filter((p) => {
          const q = searchQuery.toLowerCase();
          return (
            p.name.toLowerCase().includes(q) ||
            p.currencies.toLowerCase().includes(q) ||
            p.shortDescription.toLowerCase().includes(q)
          );
        });
    return sortProvidersByPriority(base, userCountry, undefined, {
      excludeIncompatibleGeo: true,
      activityCategory: 'DEPIN',
    });
  }, [searchQuery, userCountry]);

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: `depin_ref_${provider.id}_u${user.telegramId || 0}`,
      activityCategory: 'DEPIN',
      telegramId: user.telegramId,
      kind: 'REFERRAL',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  const handleOpenWalletSignup = (provider: VerifiedProviderItem) => {
    if (!provider.walletSignupUrl) return;
    openTrackedLink(provider.walletSignupUrl, {
      partnerId: `${provider.id}_wallet_signup`,
      taskId: `depin_wallet_${provider.id}_u${user.telegramId || 0}`,
      activityCategory: 'DEPIN',
      telegramId: user.telegramId,
      kind: 'SIGNUP',
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="depin" placement="DEPIN_TOP" telegramUserId={user?.telegramId} />

      {/* HEADER */}
      <div className="rounded-2xl border border-sky-400/25 bg-[#071122]/90 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onBack}
              className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center gap-1.5 text-xs font-mono font-black uppercase tracking-wider text-cyan-300">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>📡 {t.nav.depin}</span>
              </div>
              <h2 className="text-base font-black text-white mt-0.5">
                {filteredProviders.length} {t.ui.depinSubtitle}
              </h2>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {t.ui.depinDesc}
        </p>

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

      {/* GRIGLIA NODI CON FOTO CLICCABILE E DOPPIO LINK */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredProviders.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteProvider}
            onOpenWalletSignup={handleOpenWalletSignup}
          />
        ))}
      </div>

      {/* MODALE ISTRUZIONI INTERNE */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
        onOpenWalletSignup={handleOpenWalletSignup}
      />
    </div>
  );
};

export default DepinNodesView;
