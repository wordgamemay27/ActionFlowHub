// ============================================================================
// AI WORK VIEW — Portali AI Voce, Foto & Micro-Task Diretti (1-5 min)
// Ogni fornitore ha foto cliccabile con istruzioni interne e Mail @outlook.com.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Brain, Search } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_AI_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { SupportedLang, useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface AiWorkViewProps {
  user: UserProfile;
  userCountry?: string;
  lang: SupportedLang;
  subCategory?: 'voice' | 'photo' | 'all';
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

const VOICE_AI_IDS = new Set([
  'ai-publicai-telegram',
  'ai-olas-singapore-swiss',
  'ai-ice-dubai-telegram',
  'ai-braintrust-usdc',
  'ai-sahara-usdc',
  'ai-populii-airtm',
  'ai-lxt-direct',
  'ai-dataforce-transperfect',
  'ai-outlier-direct',
  'ai-crowdgen-appen',
  'ai-roboflow-vision',
  'ai-intispeak-direct',
  'ai-babelaudio-direct',
  'ai-shaip-direct',
  'ai-neevo-definedcrowd',
  'ai-oneforma-direct',
  'ai-rws-trainai',
]);

const PHOTO_AI_IDS = new Set([
  'ai-publicai-telegram',
  'ai-ice-dubai-telegram',
  'ai-olas-singapore-swiss',
  'ai-din-xdata',
  'ai-sahara-usdc',
  'ai-laborx-web3',
  'ai-sapien-usdc',
  'ai-dataforce-transperfect',
  'ai-lxt-direct',
  'ai-populii-airtm',
  'ai-hivemicro-direct',
  'ai-roboflow-vision',
  'ai-clickworker-direct',
  'ai-oneforma-direct',
  'ai-telus-direct',
  'ai-taskverse-direct',
  'ai-dataannotation-direct',
  'ai-rws-trainai',
]);

export const AiWorkView: React.FC<AiWorkViewProps> = ({
  user,
  userCountry = 'IT',
  subCategory = 'all',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProviders = useMemo(() => {
    const baseList =
      subCategory === 'voice'
        ? VERIFIED_AI_PROVIDERS.filter((p) => VOICE_AI_IDS.has(p.id))
        : subCategory === 'photo'
        ? VERIFIED_AI_PROVIDERS.filter((p) => PHOTO_AI_IDS.has(p.id))
        : VERIFIED_AI_PROVIDERS;

    const searched = !searchQuery.trim()
      ? baseList
      : baseList.filter((p) => {
          const q = searchQuery.toLowerCase();
          return (
            p.name.toLowerCase().includes(q) ||
            p.categoryLabel.toLowerCase().includes(q) ||
            p.shortDescription.toLowerCase().includes(q)
          );
        });

    return sortProvidersByPriority(searched, userCountry, undefined, {
      excludeIncompatibleGeo: true,
      activityCategory: 'AI_TASK',
    });
  }, [searchQuery, subCategory, userCountry]);

  const titleText =
    subCategory === 'voice'
      ? `🎙️ ${t.nav.ai_voice}`
      : subCategory === 'photo'
      ? `📸 ${t.nav.ai_photo}`
      : `📸 ${t.nav.ai}`;

  const descText =
    subCategory === 'voice'
      ? t.ui.aiVoiceDesc
      : subCategory === 'photo'
      ? t.ui.aiPhotoDesc
      : t.ui.aiAllDesc;

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: 'AI_TASK',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="ai" placement="AI_TOP" telegramUserId={user?.telegramId} />

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
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-sky-400">
              <Brain className="w-4 h-4 text-sky-300" />
              <span>{titleText}</span>
            </div>
            <h2 className="text-base font-black text-white mt-0.5">
              {filteredProviders.length} {t.ui.officialAppsReady}
            </h2>
          </div>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {descText}{' '}
          <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
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

      {/* GRIGLIA PORTALI AI CON FOTO CLICCABILE */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredProviders.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteProvider}
          />
        ))}
      </div>

      {/* MODALE ISTRUZIONI INTERNE */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default AiWorkView;

