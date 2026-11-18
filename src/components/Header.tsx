// ============================================================================
// HEADER — Testata con logo, lingua, ricompense reali, nucleo geometrico
// ============================================================================

import React, { useState, useRef } from 'react';
import { UserProfile } from '../types';
import { Coins } from 'lucide-react';
import { useTranslation } from '../lib/i18n';

interface HeaderProps {
  user: UserProfile;
  onOpenAdPlayer: () => void;
  onOpenProfile: () => void;
  onSecretAdminUnlock?: () => void;
  onOpenLanguagePicker?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onOpenAdPlayer,
  onOpenProfile,
  onSecretAdminUnlock,
  onOpenLanguagePicker,
}) => {
  const { t, cycleLanguage } = useTranslation();
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [unlockedNotice, setUnlockedNotice] = useState(false);

  const startHold = () => {
    timerRef.current = setTimeout(() => {
      setUnlockedNotice(true);
      setTimeout(() => setUnlockedNotice(false), 2000);
      if (onSecretAdminUnlock) onSecretAdminUnlock();
    }, 1500);
  };

  const clearHold = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleClick = () => {
    if (!unlockedNotice) onOpenProfile();
  };

  return (
    <header
      id="main-app-header"
      className="sticky top-0 z-40 w-full bg-gradient-to-r from-[#050914]/95 via-[#0B152C]/95 to-[#050914]/95 backdrop-blur-2xl border-0 px-3 py-2.5 shadow-[0_14px_36px_rgba(0,152,234,0.22)]"
    >
      <div className="max-w-2xl mx-auto flex items-center justify-between gap-2">
        {/* Logo + Titolo */}
        <div
          onClick={handleClick}
          onMouseDown={startHold}
          onMouseUp={clearHold}
          onMouseLeave={clearHold}
          onTouchStart={startHold}
          onTouchEnd={clearHold}
          className="flex items-center gap-2 cursor-pointer select-none border-0 quantum-touch-interactive"
        >
          <div className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden shadow-[0_0_14px_rgba(34,211,238,0.6)] border border-amber-400/50 shrink-0">
            <img
              src="/assets/aistudio/IMG_20261002_004834_2e580032.png"
              alt="ActionFlow Hub by Have2Want +"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-black tracking-wide flex items-baseline gap-1 font-serif">
              <span className="text-lg sm:text-xl gold-diamond-royal-text">ActionFlow</span>
              <span className="text-lg sm:text-xl platinum-diamond-royal-text">Hub</span>
            </span>
            <span className="text-[9px] sm:text-[10px] font-bold text-amber-300/80 tracking-wider uppercase font-sans">
              by Have2Want +
            </span>
          </div>
        </div>

        {/* Selettore Lingua + Saldo Netto Utente */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Selettore Lingua */}
          <button
            type="button"
            onClick={() => {
              if (onOpenLanguagePicker) onOpenLanguagePicker();
              else cycleLanguage();
            }}
            className="px-1.5 py-1 bg-transparent border-0 text-base sm:text-lg font-black leading-none text-white flex items-center gap-1.5 cursor-pointer quantum-touch-interactive"
          >
            <span className="text-base sm:text-lg leading-none drop-shadow-[0_0_8px_rgba(255,255,255,0.45)]">{t.flag}</span>
            <span className="text-base sm:text-lg font-black leading-none holo-counter-text">{t.langLabel}</span>
          </button>

          {/* Saldo Punti Utente (Solo PostgreSQL Reale) */}
          <div
            onClick={onOpenAdPlayer}
            className="px-2.5 py-1 rounded-xl bg-emerald-500/15 border border-emerald-400/35 font-black text-xs sm:text-sm leading-none flex items-center gap-1.5 text-cyan-300 cursor-pointer quantum-touch-interactive"
          >
            <Coins className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-mono tabular-nums font-black text-white">
              {(user.withdrawablePoints ?? user.points).toLocaleString()} PT
            </span>
            {((user.pendingPoints || 0) + (user.settledPoints || 0)) > 0 && (
              <span className="text-[10px] font-mono text-amber-300">
                (+{((user.pendingPoints || 0) + (user.settledPoints || 0)).toLocaleString()} S2S)
              </span>
            )}
          </div>
        </div>
      </div>

    </header>
  );
};

export default Header;
