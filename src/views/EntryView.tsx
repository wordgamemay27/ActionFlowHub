import { useState } from 'react';
import { useTranslation, SupportedLang } from '../lib/i18n';
import { CleanAdSlot } from '../components/CleanAdSlot';

const AUTO_MUSIC_TRACKS = [
  'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3',
  'https://assets.mixkit.co/music/preview/mixkit-hip-hop-02-738.mp3',
  'https://assets.mixkit.co/music/preview/mixkit-driving-ambition-32.mp3',
];

export const LANGUAGES: { code: SupportedLang; flag: string; name: string }[] = [
  { code: 'it', flag: '🇮🇹', name: 'Italiano' },
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'es', flag: '🇪🇸', name: 'Español' },
  { code: 'fr', flag: '🇫🇷', name: 'Français' },
  { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
  { code: 'pt', flag: '🇵🇹', name: 'Português' },
  { code: 'ru', flag: '🇷🇺', name: 'Русский' },
  { code: 'zh', flag: '🇨🇳', name: '中文' },
  { code: 'ja', flag: '🇯🇵', name: '日本語' },
  { code: 'ko', flag: '🇰🇷', name: '한국어' },
  { code: 'ar', flag: '🇸🇦', name: 'العربية' },
  { code: 'hi', flag: '🇮🇳', name: 'हिन्दी' },
  { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
  { code: 'id', flag: '🇮🇩', name: 'Indonesia' },
];

export interface EntryViewProps {
  initialLang?: SupportedLang;
  onStart: (lang: SupportedLang) => void;
}

export function EntryView({
  initialLang = 'it',
  onStart,
}: EntryViewProps) {
  const { lang: globalLang, setLang: setGlobalLang, t } = useTranslation();
  const [lang, setLang] = useState<SupportedLang>(globalLang || initialLang);
  const [autoTrackUrl] = useState(
    () => AUTO_MUSIC_TRACKS[Math.floor(Math.random() * AUTO_MUSIC_TRACKS.length)]
  );

  const handleSelectLang = (code: SupportedLang) => {
    setLang(code);
    setGlobalLang(code);
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col items-center justify-center p-6">
      <h1 className="text-4xl font-black mb-6 tracking-tighter">ActionFlow</h1>

      <div className="w-full max-w-md mb-6">
        <CleanAdSlot page="entry_2" placement="ENTRY_2_TOP" />
      </div>

      <div className="mb-8 w-full max-w-md aspect-video bg-[#000000] rounded-2xl overflow-hidden border border-cyan-400/30 shadow-[0_0_25px_rgba(6,182,234,0.2)]">
        <video
          src="/assets/video/intro.mp4"
          autoPlay
          loop
          muted
          playsInline
          className="w-full h-full object-cover"
        >
          <source src="/assets/video/intro.mp4" type="video/mp4" />
          <source src="/src/assets/video/intro.mp4" type="video/mp4" />
        </video>
        <audio src={autoTrackUrl} autoPlay loop className="hidden" />
      </div>

      <div className="mb-8">
        <p className="text-cyan-400 mb-4 text-xs uppercase tracking-widest text-center">
          {t.selectLanguageLabel}
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => handleSelectLang(l.code)}
              className={`rounded-full border-2 px-4 py-2 text-sm font-black transition-all cursor-pointer ${
                lang === l.code
                  ? 'border-cyan-400 text-cyan-400 shadow-[0_0_15px_rgba(6,182,234,0.6)]'
                  : 'border-slate-600/50 text-slate-400 hover:border-cyan-400/50'
              }`}
            >
              {l.flag} {l.name}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onStart(lang)}
        className="w-full max-w-md py-4 rounded-full border-2 border-cyan-400 bg-black/40 text-cyan-400 font-black text-lg uppercase tracking-wider transition-all hover:bg-cyan-400 hover:text-black shadow-[0_0_20px_rgba(6,182,234,0.4)] cursor-pointer"
      >
        {t.startSessionBtn}
      </button>
    </div>
  );
}

export default EntryView;
