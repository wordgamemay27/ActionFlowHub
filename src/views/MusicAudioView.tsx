// ============================================================================
// MUSIC AUDIO VIEW — Portali Musica Aperti a Tutti (Senza obbligo 1000 follower)
// Cliccando la foto si aprono le istruzioni interne di esecuzione e modalità.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Music } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_MUSIC_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { SupportedLang, useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface MusicAudioViewProps {
  user: UserProfile;
  userCountry?: string;
  lang?: SupportedLang;
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

export const MusicAudioView: React.FC<MusicAudioViewProps> = ({
  user,
  userCountry = 'IT',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const providers = useMemo(
    () =>
      sortProvidersByPriority(VERIFIED_MUSIC_PROVIDERS, userCountry, undefined, {
        excludeIncompatibleGeo: true,
        activityCategory: 'MUSIC',
      }),
    [userCountry]
  );

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: 'MUSIC',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="music" placement="MUSIC_TOP" telegramUserId={user?.telegramId} />

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
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-emerald-400">
              <Music className="w-4 h-4 text-emerald-300" />
              <span>🎵 {t.nav.music}</span>
            </div>
            <p className="text-xs text-slate-300 leading-snug mt-0.5">
              {t.ui.musicDesc}{' '}
              <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* GRIGLIA MUSICA CON FOTO CLICCABILE */}
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

      {/* MODALE ISTRUZIONI INTERNE */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default MusicAudioView;
