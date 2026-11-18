// ============================================================================
// GAMES VIEW — Giochi Case Madri Dirette & Web3 (Zero Doppioni)
// Cliccando la foto si aprono le istruzioni interne di esecuzione e Mail.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Gamepad2 } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_GAMES_PROVIDERS, VERIFIED_UX_QA_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { SupportedLang, useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface GamesViewProps {
  user: UserProfile;
  userCountry?: string;
  lang: SupportedLang;
  subCategory?: 'mobile' | 'pc' | 'all';
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

const MOBILE_GAME_IDS = new Set([
  'game-catizen-ton',
  'game-playdeck-ton',
  'game-sweat-dubai',
  'game-zbd-lightning',
  'game-thndr-lightning',
  'game-fumb-bitcoinminer',
  'game-smiles-lightning',
  'game-bling-crypto',
  'game-womplay-direct',
  'game-rollercoin-direct',
  'game-plarium-direct',
  'game-wargaming-direct',
  'game-gala-web3',
  'qa-playtestcloud-direct',
]);

const PC_WEB_GAME_IDS = new Set([
  'game-catizen-ton',
  'game-playdeck-ton',
  'game-sweat-dubai',
  'game-rollercoin-direct',
  'game-womplay-direct',
  'game-smiles-lightning',
  'game-gaijin-direct',
  'game-splinterlands-web3',
  'game-epic-direct',
  'game-xsolla-partner',
  'game-wargaming-direct',
  'game-gala-web3',
]);

export const GamesView: React.FC<GamesViewProps> = ({
  user,
  userCountry = 'IT',
  subCategory = 'all',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);

  const providers = useMemo(() => {
    const playtest = VERIFIED_UX_QA_PROVIDERS.find((p) => p.id === 'qa-playtestcloud-direct');
    const allGames = playtest ? [...VERIFIED_GAMES_PROVIDERS, playtest] : VERIFIED_GAMES_PROVIDERS;
    const filtered =
      subCategory === 'mobile'
        ? allGames.filter((p) => MOBILE_GAME_IDS.has(p.id))
        : subCategory === 'pc'
        ? allGames.filter((p) => PC_WEB_GAME_IDS.has(p.id))
        : allGames;
    return sortProvidersByPriority(filtered, userCountry, undefined, {
      excludeIncompatibleGeo: true,
      activityCategory: 'GAME',
    });
  }, [subCategory, userCountry]);

  const titleText =
    subCategory === 'mobile'
      ? `🎮 ${t.nav.games_mobile}`
      : subCategory === 'pc'
      ? `🖥️ ${t.nav.games_pc}`
      : `🎮 ${t.nav.games}`;

  const descText =
    subCategory === 'mobile'
      ? t.ui.gamesMobileDesc
      : subCategory === 'pc'
      ? t.ui.gamesPcDesc
      : t.ui.gamesAllDesc;

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: 'GAME',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="games" placement="GAMES_TOP" telegramUserId={user.telegramId} />

      <div className="rounded-2xl border border-sky-400/25 bg-[#071122]/90 p-4 space-y-2">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-sky-400">
              <Gamepad2 className="w-4 h-4 text-sky-300" />
              <span>{titleText}</span>
            </div>
            <p className="text-xs text-slate-300 leading-snug mt-0.5">
              {descText}{' '}
              <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* UNICA GRIGLIA PULITA SENZA DOPPIONI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {providers.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteProvider}
          />
        ))}
      </div>

      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default GamesView;

