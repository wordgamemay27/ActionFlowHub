// ============================================================================
// NUCLEO GEOMETRICO — elemento interattivo al centro della ruota
// ============================================================================
// Sostituisce il vecchio robottino (SVG/illustrazione) con un elemento
// geometrico minimale costruito interamente in CSS:
//  - forma a nucleo (quadrato arrotondato + anelli concentrici);
//  - al tocco si illumina di blu neon elettrico;
//  - gestisce apertura/chiusura del menu.
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';

export interface GeoCoreProps {
  /** Stato del menu (controllato dal genitore). */
  menuOpen: boolean;
  /** Callback: il nucleo richiede l'apertura/chiusura del menu. */
  onToggleMenu: () => void;
  /** Dimensione del nucleo in px. */
  size?: number;
  className?: string;
  label?: string;
}

export const GeoCore: React.FC<GeoCoreProps> = ({
  menuOpen,
  onToggleMenu,
  size = 128,
  className = '',
  label = 'Nucleo',
}) => {
  const [lit, setLit] = useState(false);
  const [pulse, setPulse] = useState(false);

  // Il nucleo resta acceso mentre il menu e' aperto.
  useEffect(() => {
    if (menuOpen) setLit(true);
  }, [menuOpen]);

  const handleTap = useCallback(() => {
    setLit(true);
    setPulse(true);
    onToggleMenu();
    window.setTimeout(() => setPulse(false), 420);
  }, [onToggleMenu]);

  return (
    <button
      type="button"
      onClick={handleTap}
      aria-label={label}
      aria-expanded={menuOpen}
      data-lit={lit ? 'true' : 'false'}
      className={`geo-core ${pulse ? 'neon-pulse' : ''} ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Anelli concentrici geometrici */}
      <span className="geo-ring" style={{ width: size * 0.78, height: size * 0.78 }} />
      <span
        className="geo-ring"
        style={{ width: size * 0.56, height: size * 0.56, borderStyle: 'dashed' }}
      />
      <span
        className="geo-ring"
        style={{
          width: size * 0.34,
          height: size * 0.34,
          background: 'radial-gradient(circle, rgba(120,205,255,0.35), transparent 70%)',
          borderColor: 'rgba(150,215,255,0.6)',
        }}
      />

      {/* Nucleo centrale: losanga stilizzata */}
      <span
        className="relative z-10 block"
        style={{
          width: size * 0.22,
          height: size * 0.22,
          transform: 'rotate(45deg)',
          borderRadius: '22%',
          background: 'linear-gradient(150deg, rgba(190,235,255,0.95), rgba(47,155,255,0.55))',
          boxShadow: '0 0 26px rgba(47,155,255,0.85)',
        }}
      />
    </button>
  );
};

export default GeoCore;
