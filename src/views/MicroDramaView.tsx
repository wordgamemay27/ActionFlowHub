// ============================================================================
// MICRO-DRAMA VIEW — Soap & Clip con Fase Iniziale Gratis + Mail @proton.me
// Unica griglia pulita senza doppioni: clicca la foto per istruzioni interne.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Film } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_SOAP_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface MicroDramaViewProps {
  user: UserProfile;
  userCountry?: string;
  subCategory?: 'soap' | 'video_clips' | 'all';
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

const SOAP_SERIES_IDS = new Set([
  'soap-reelshort-direct',
  'soap-dramabox-direct',
  'soap-shortmax-direct',
  'soap-kalostv-direct',
  'soap-goodshort-direct',
  'soap-moboreels-direct',
]);

const VIDEO_CLIP_IDS = new Set([
  'soap-cheelee-web3',
  'soap-chingari-gari',
  'soap-thetatv-direct',
  'soap-costv-direct',
  'soap-odysee-direct',
  'soap-shorttv-direct',
  'soap-flextv-direct',
  'soap-reelshort-direct',
  'soap-shortmax-direct',
  'soap-goodshort-direct',
  'soap-moboreels-direct',
]);

export const MicroDramaView: React.FC<MicroDramaViewProps> = ({
  user,
  userCountry = 'IT',
  subCategory = 'all',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);

  const providers = useMemo(() => {
    const filtered =
      subCategory === 'soap'
        ? VERIFIED_SOAP_PROVIDERS.filter((p) => SOAP_SERIES_IDS.has(p.id))
        : subCategory === 'video_clips'
        ? VERIFIED_SOAP_PROVIDERS.filter((p) => VIDEO_CLIP_IDS.has(p.id))
        : VERIFIED_SOAP_PROVIDERS;
    return sortProvidersByPriority(filtered, userCountry, undefined, {
      excludeIncompatibleGeo: true,
      activityCategory: subCategory === 'video_clips' ? 'VIDEO' : 'MICRO_DRAMA',
    });
  }, [subCategory, userCountry]);

  const titleText =
    subCategory === 'video_clips'
      ? `📹 ${t.nav.video_clips}`
      : `🎬 ${t.nav.soap}`;

  const descText =
    subCategory === 'video_clips'
      ? t.ui.videoClipsDesc
      : t.ui.soapSeriesDesc;

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: subCategory === 'video_clips' ? 'VIDEO' : 'MICRO_DRAMA',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="micro_drama" placement="MICRODRAMA_TOP" telegramUserId={user.telegramId} />

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
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-pink-400">
              <Film className="w-4 h-4 text-pink-300" />
              <span>{titleText}</span>
            </div>
            <p className="text-xs text-slate-300 leading-snug mt-0.5">
              {descText}{' '}
              <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* UNICA GRIGLIA PULITA DI CASE MADRI SOAP (ZERO DOPPIONI) */}
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

      {/* MODALE ISTRUZIONI INTERNE QUANDO CLICCHI LA FOTO */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default MicroDramaView;

