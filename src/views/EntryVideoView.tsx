import { useState } from 'react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import { useTranslation } from '../lib/i18n';

const AUTO_MUSIC_TRACKS = [
  'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3',
  'https://assets.mixkit.co/music/preview/mixkit-hip-hop-02-738.mp3',
  'https://assets.mixkit.co/music/preview/mixkit-driving-ambition-32.mp3',
];

export interface EntryVideoViewProps {
  onComplete: () => void;
  telegramUserId?: number | string;
}

export function EntryVideoView({ onComplete, telegramUserId = 0 }: EntryVideoViewProps) {
  const { t } = useTranslation();
  const [videoEnded, setVideoEnded] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [autoTrackUrl] = useState(
    () => AUTO_MUSIC_TRACKS[Math.floor(Math.random() * AUTO_MUSIC_TRACKS.length)]
  );

  const handleVideoEnded = () => {
    setVideoEnded(true);
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md mb-4">
        <CleanAdSlot
          page="entry_1"
          placement="ENTRY_1_TOP"
          telegramUserId={Number(telegramUserId) || 0}
        />
      </div>

      <div className="relative w-full max-w-md aspect-video bg-[#000000] rounded-2xl overflow-hidden border border-cyan-400/30 shadow-[0_0_25px_rgba(6,182,234,0.25)]">
        <video
          src="/assets/video/intro.mp4"
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
          onEnded={handleVideoEnded}
        >
          <source src="/assets/video/intro.mp4" type="video/mp4" />
          <source src="/src/assets/video/intro.mp4" type="video/mp4" />
        </video>

        <audio src={autoTrackUrl} autoPlay className="hidden" />

        {!videoEnded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/25 pointer-events-none">
            <div className="w-8 h-8 rounded-full border-4 border-cyan-400/30 border-t-4 border-cyan-400 animate-spin"></div>
            <span className="mt-2 text-xs text-cyan-400 font-black uppercase tracking-wider">
              {t.ui.watchVideoNotice}
            </span>
          </div>
        )}
      </div>

      <label className="mt-4 w-full max-w-md flex items-center gap-3 px-4 py-3 rounded-2xl border border-cyan-400/30 bg-black/40 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={privacyAccepted}
          onChange={(e) => setPrivacyAccepted(e.target.checked)}
          className="w-4 h-4 accent-cyan-400 cursor-pointer shrink-0"
        />
        <span className="text-xs text-slate-300">
          {t.ui.privacyAcceptPrefix} <strong className="text-cyan-400">Privacy Policy, GDPR</strong>{' '}
          {t.ui.privacyAcceptSuffix}
        </span>
      </label>

      {videoEnded && (
        <button
          type="button"
          disabled={!privacyAccepted}
          onClick={onComplete}
          className={`mt-6 w-full max-w-md py-4 rounded-full border-2 font-black text-lg uppercase tracking-wider transition-all ${
            privacyAccepted
              ? 'border-cyan-400 bg-black/40 text-cyan-400 hover:bg-cyan-400 hover:text-black shadow-[0_0_20px_rgba(6,182,234,0.4)] cursor-pointer'
              : 'border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed'
          }`}
        >
          {t.continueBtn}
        </button>
      )}
    </div>
  );
}

export default EntryVideoView;
