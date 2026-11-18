// ============================================================================
// PRIMITIVE VETRO / CYBER
// ============================================================================
// - GlassPanel / GlassCard : superfici in vetro su fondo metallico scuro
// - GlassButton            : azione con alone neon blu
// - GlassPlaceholder       : contenitore segnaposto per immagini mancanti
//                            (vetro blu trasparente retroilluminato, gia'
//                            dimensionato, pronto a ricevere la foto reale)
// - BrandLogo              : logo ufficiale del brand (mirror locale + URL
//                            ufficiale come fallback) e, in ultima istanza,
//                            segnaposto in vetro
// ============================================================================

import React, { useState } from 'react';
import { resolveBrandLogo } from '../lib/brands';

/* -------------------------------------------------------------------------- */

export interface GlassPanelProps {
  children: React.ReactNode;
  className?: string;
  /** bordo superiore neon */
  neonEdge?: boolean;
  as?: 'div' | 'section' | 'article' | 'aside';
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  children,
  className = '',
  neonEdge = true,
  as: Tag = 'div',
}) => (
  <Tag className={`glass-panel ${neonEdge ? 'glass-neon-edge' : ''} ${className}`}>{children}</Tag>
);

export const GlassCard: React.FC<GlassPanelProps> = ({
  children,
  className = '',
  neonEdge = false,
  as: Tag = 'div',
}) => (
  <Tag className={`glass-card ${neonEdge ? 'glass-neon-edge' : ''} ${className}`}>{children}</Tag>
);

/* -------------------------------------------------------------------------- */

export interface GlassButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  ariaLabel?: string;
}

export const GlassButton: React.FC<GlassButtonProps> = ({
  children,
  onClick,
  className = '',
  disabled,
  type = 'button',
  title,
  ariaLabel,
}) => (
  <button
    type={type}
    title={title}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={onClick}
    className={`relative overflow-hidden rounded-2xl border border-sky-400/25 bg-gradient-to-b from-sky-500/25 to-[#05080f]/90 text-white font-black uppercase tracking-wide active:scale-[0.97] transition-transform disabled:opacity-40 ${className}`}
  >
    <span className="absolute inset-0 bg-gradient-to-b from-white/18 to-transparent pointer-events-none" />
    <span className="relative">{children}</span>
  </button>
);

/* -------------------------------------------------------------------------- */

export interface GlassPlaceholderProps {
  /** Etichetta mostrata dentro il segnaposto (di norma il brand o il tipo). */
  label?: string;
  /** Glifo mostrato al centro (emoji o simbolo). */
  glyph?: string;
  className?: string;
  /** Se true mostra lo shimmer (immagine in arrivo). */
  pending?: boolean;
}

/**
 * Contenitore segnaposto per foto mancanti / loghi non pronti.
 * Stesso ingombro dell'immagine che sostituisce: quando arriva la foto reale
 * basta passare `src` a BrandLogo o sostituire il segnaposto, senza toccare
 * il codice di layout.
 */
export const GlassPlaceholder: React.FC<GlassPlaceholderProps> = ({
  label,
  glyph = '◈',
  className = '',
  pending = true,
}) => (
  <div className={`glass-placeholder ${pending ? 'placeholder-shimmer' : ''} ${className}`}>
    <div className="placeholder-content">
      <div className="placeholder-icon" aria-hidden="true">
        <span className="text-lg leading-none">{glyph}</span>
      </div>
      {label && <span className="placeholder-label">{label}</span>}
    </div>
  </div>
);

/* -------------------------------------------------------------------------- */

export interface BrandLogoProps {
  /** Chiave del marchio (amazon, spotify, ton, ...). */
  brand: string;
  /** URL ufficiale alternativo (es. quello presente nei dati del catalogo). */
  src?: string;
  className?: string;
  /** Dimensione massima del logo in px. */
  size?: number;
}

/**
 * Logo ufficiale del brand.
 * Ordine di tentativi: mirror locale del logo ufficiale -> URL ufficiale
 * (simpleicons / Wikimedia) -> URL presente nei dati -> segnaposto in vetro.
 * Non viene mai mostrata un'immagine inventata.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ brand, src, className = '', size = 40 }) => {
  const spec = resolveBrandLogo(brand);
  const [attempt, setAttempt] = useState(0);

  const candidates: string[] = [];
  const pushUnique = (u?: string) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  if (src && src.startsWith('/')) pushUnique(src);
  if (spec) pushUnique(`/logos/${spec.key}.svg`);
  if (spec) pushUnique(spec.url);
  if (src && (/^https?:\/\//i.test(src) || src.startsWith('data:'))) pushUnique(src);

  const url = candidates[attempt];

  if (!url) {
    return (
      <GlassPlaceholder
        label={size > 44 ? spec?.label || brand : undefined}
        className={className}
        glyph="◈"
        pending={false}
      />
    );
  }

  return (
    <img
      src={url}
      alt={spec?.label || brand}
      loading="eager"
      decoding="async"
      onError={() => setAttempt((i) => i + 1)}
      style={{ maxHeight: size, maxWidth: size, color: spec?.tint }}
      className={`brand-logo ${className}`}
    />
  );
};
