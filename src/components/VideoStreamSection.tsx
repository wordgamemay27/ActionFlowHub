// ============================================================================
// VIDEO STREAM SECTION — Player video interattivo con ciclo automatico unico
// ============================================================================

import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { CleanAdSlot } from './CleanAdSlot';
import { AutoInteractiveCycleEngine } from './AutoInteractiveCycleEngine';
import { useTranslation } from '../lib/i18n';
import { EXTRA_UI_LOCALIZATION } from '../lib/providerLocalization';

interface VideoStreamSectionProps {
  autoSessionTriggerKey?: number;
  telegramUserId?: number;
  userCountry?: string;
  tierZone?: string;
  onBack: () => void;
  onBalanceUpdated?: () => void;
  selectedCategories?: string[];
}

export const VideoStreamSection: React.FC<VideoStreamSectionProps> = ({
  autoSessionTriggerKey = 1,
  telegramUserId = 0,
  userCountry = 'IT',
  tierZone,
  onBack,
  onBalanceUpdated,
  selectedCategories,
}) => {
  const { lang } = useTranslation();
  const extra = EXTRA_UI_LOCALIZATION[lang] || EXTRA_UI_LOCALIZATION.en;

  return (
    <div id="video-stream-section-view" className="space-y-4 border-0 select-none animate-fade-in">
      <CleanAdSlot page="tasks" placement="TASKS_TOP" telegramUserId={telegramUserId} />

      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={extra.backToHomeTitle}
            className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-emerald-400">
              <span className="w-4 h-4 text-emerald-300">▶</span>
              <span>{extra.videoStreamTitle}</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-snug">
              {extra.videoStreamSubtitle}
            </p>
          </div>
        </div>
      </div>

      <AutoInteractiveCycleEngine
        autoStartTriggerKey={autoSessionTriggerKey}
        selectedCategories={selectedCategories}
        telegramUserId={telegramUserId}
        userCountry={userCountry}
        tierZone={tierZone}
        onExitFullScreen={onBack}
        onBalanceUpdated={onBalanceUpdated}
      />
    </div>
  );
};

export default VideoStreamSection;
