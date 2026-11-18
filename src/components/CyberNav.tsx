// ============================================================================
// UNICA BARRA DI NAVIGAZIONE — Orizzontale, scorrevole, in vetro/cyber
// ============================================================================
// Regole strutturali:
//  - esiste UNA sola barra di navigazione in tutta l'app;
//  - scorre lateralmente col dito (scroll-snap, nessun limite di lunghezza);
//  - ospita tutte le viste: 1 Categoria = 1 Pagina Dedicata;
//  - nessuna sotto-barra di filtri o reparti interni alle pagine.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../lib/i18n';

export type CyberTab =
  | 'home'
  | 'games_mobile'
  | 'games_pc'
  | 'games'
  | 'soap'
  | 'video_clips'
  | 'music'
  | 'ai_voice'
  | 'ai_photo'
  | 'ai'
  | 'ocr'
  | 'ux_sites'
  | 'ux_apps'
  | 'surveys'
  | 'ux_qa'
  | 'shopping'
  | 'depin'
  | 'airdrop'
  | 'wallet'
  | 'profile'
  | 'admin';

export interface CyberNavItem {
  tab: CyberTab;
  label: string;
  glyph: string;
}

export const CYBER_NAV_ITEMS: CyberNavItem[] = [
  { tab: 'home', label: 'Home', glyph: '⌂' },
  { tab: 'games_mobile', label: 'Giochi Telefono', glyph: '🎮' },
  { tab: 'games_pc', label: 'Giochi PC & Web', glyph: '🖥️' },
  { tab: 'soap', label: 'Serie TV Brevi', glyph: '🎬' },
  { tab: 'video_clips', label: 'Video Brevi', glyph: '📹' },
  { tab: 'music', label: 'Ascolto Musica', glyph: '🎵' },
  { tab: 'ai_voice', label: 'Registra Voce', glyph: '🎙️' },
  { tab: 'ai_photo', label: 'Scatta Foto', glyph: '📸' },
  { tab: 'ocr', label: 'Foto Scontrini', glyph: '🧾' },
  { tab: 'ux_sites', label: 'Prova Siti Web', glyph: '🌐' },
  { tab: 'ux_apps', label: 'Prova Nuove App', glyph: '📱' },
  { tab: 'surveys', label: 'Sondaggi Certificati', glyph: '📋' },
  { tab: 'shopping', label: 'Buoni & Carte', glyph: '🎁' },
  { tab: 'depin', label: 'Nodi e Reti', glyph: '⚡' },
  { tab: 'airdrop', label: 'Airdrop & Bonus Crypto', glyph: '💎' },
  { tab: 'wallet', label: 'Portafoglio & Prelievi', glyph: '👛' },
  { tab: 'profile', label: 'Profilo', glyph: '👤' },
];

export interface CyberNavProps {
  current: CyberTab;
  onSelect: (tab: CyberTab) => void;
  isAdmin?: boolean;
}

export const CyberNav: React.FC<CyberNavProps> = ({ current, onSelect, isAdmin = false }) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const directionRef = useRef<1 | -1>(1);

  const items = isAdmin
    ? [...CYBER_NAV_ITEMS, { tab: 'admin' as CyberTab, label: 'Admin', glyph: '⚙' }]
    : CYBER_NAV_ITEMS;

  // Porta in vista la voce attiva quando cambia pagina.
  useEffect(() => {
    const node = activeRef.current;
    const scroller = scrollerRef.current;
    if (!node || !scroller) return;
    const left = node.offsetLeft - scroller.clientWidth / 2 + node.clientWidth / 2;
    scroller.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [current]);

  // Rotazione automatica fluida della barra (si ferma quando l'utente tocca o passa sopra col mouse)
  useEffect(() => {
    if (isPaused) return;
    const interval = window.setInterval(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      if (maxScroll <= 0) return;

      if (scroller.scrollLeft >= maxScroll - 2) {
        directionRef.current = -1;
      } else if (scroller.scrollLeft <= 2) {
        directionRef.current = 1;
      }

      scroller.scrollLeft += directionRef.current * 1.2;
    }, 30);

    return () => window.clearInterval(interval);
  }, [isPaused]);

  return (
    <nav
      id="cyber-nav"
      aria-label="Navigazione principale"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={() => setIsPaused(true)}
      onTouchEnd={() => {
        window.setTimeout(() => setIsPaused(false), 3500);
      }}
      className="sticky top-0 z-40 w-full border-b border-sky-400/15 bg-[#05080f]/82 backdrop-blur-xl"
    >
      <div
        ref={scrollerRef}
        className="no-scrollbar mx-auto flex max-w-3xl items-center gap-2 overflow-x-auto px-3 py-2"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {items.map((item) => {
          const active = current === item.tab;
          const localizedLabel = t.nav?.[item.tab] || item.label;
          return (
            <button
              key={item.tab}
              ref={active ? activeRef : undefined}
              type="button"
              data-active={active}
              onClick={() => onSelect(item.tab)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-[44px] shrink-0 items-center gap-2 rounded-2xl border px-3.5 text-xs font-black uppercase tracking-wider transition-all active:scale-95 cursor-pointer ${
                active
                  ? 'border-sky-400/60 bg-gradient-to-b from-sky-400/30 to-[#05080f]/90 text-white neon-ring'
                  : 'border-sky-400/15 bg-[#0a1220]/70 text-slate-300 hover:border-sky-400/40 hover:text-white'
              }`}
            >
              <span className={`text-base leading-none ${active ? 'text-sky-300 neon-text' : ''}`}>
                {item.glyph}
              </span>
              <span className="whitespace-nowrap">{localizedLabel}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default CyberNav;

