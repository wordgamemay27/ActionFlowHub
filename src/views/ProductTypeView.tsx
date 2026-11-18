// ============================================================================
// PAGINA 3 INIZIALE (Paese di Riferimento + Genere + Scelta Categorie)
// ============================================================================

import { useEffect, useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { ENTRY_FLOW_TEXT, countryLabel } from '../lib/entryProfile';
import {
  COUNTRIES_CATALOG,
  normalizeCountryCode,
  resolveCountryEconomicZone,
  resolveCountryEconomicProfile,
  getCountryGeoEligibility,
} from '../lib/geoEconomics';
import { CleanAdSlot } from '../components/CleanAdSlot';

export const PRODUCT_TYPES = [
  { id: 'games_mobile', name: 'Giochi Telefono', icon: '🎮', desc: 'Giochi gratuiti per smartphone' },
  { id: 'games_pc', name: 'Giochi PC & Web', icon: '🖥️', desc: 'Giochi su computer e browser' },
  { id: 'soap', name: 'Serie TV Brevi', icon: '🎬', desc: 'Episodi da 1–2 min sul telefono' },
  { id: 'video_clips', name: 'Video Brevi', icon: '📹', desc: 'Guardare video e clip veloci' },
  { id: 'music', name: 'Ascolto Musica', icon: '🎵', desc: 'Ascoltare brani musicali' },
  { id: 'ai_voice', name: 'Registra Voce', icon: '🎙️', desc: 'Leggere brevi frasi al microfono' },
  { id: 'ai_photo', name: 'Scatta Foto', icon: '📸', desc: 'Foto a oggetti comuni dal telefono' },
  { id: 'ocr', name: 'Foto Scontrini', icon: '🧾', desc: 'Fotografare scontrini della spesa' },
  { id: 'ux_sites', name: 'Prova Siti Web', icon: '🌐', desc: 'Navigare su nuovi siti per 2–5 min' },
  { id: 'ux_apps', name: 'Prova Nuove App', icon: '📱', desc: 'Provare nuove app prima che escano' },
  { id: 'surveys', name: 'Sondaggi Certificati', icon: '📋', desc: 'Domande da 2–5 min che pagano sempre' },
];

export interface ProductTypeViewProps {
  initialCountry?: string;
  isCountryLocked?: boolean;
  onSelect: (
    type: string,
    gender?: 'uomo' | 'donna',
    selectedIds?: string[],
    country?: string
  ) => void;
}

export function ProductTypeView({
  initialCountry = 'IT',
  isCountryLocked = false,
  onSelect,
}: ProductTypeViewProps) {
  const { t, lang } = useTranslation();
  const entryText = ENTRY_FLOW_TEXT[lang] || ENTRY_FLOW_TEXT.it;
  const [gender, setGender] = useState<'uomo' | 'donna' | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [country, setCountry] = useState<string>(() => normalizeCountryCode(initialCountry));

  useEffect(() => {
    setCountry(normalizeCountryCode(initialCountry));
  }, [initialCountry]);

  const resolvedProfile = resolveCountryEconomicProfile(country);
  const resolvedZone = resolvedProfile.tierZone || resolveCountryEconomicZone(country);
  const resolvedGeo = getCountryGeoEligibility(country);

  const toggleType = (id: string) => {
    setSelectedTypes((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedTypes.length === PRODUCT_TYPES.length) {
      setSelectedTypes([]);
    } else {
      setSelectedTypes(PRODUCT_TYPES.map((p) => p.id));
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col items-center justify-center p-4 sm:p-6">
      {/* 1. SPAZIO BANNER PAGINA 3 (Solo Immagine Pulita) */}
      <div className="w-full max-w-2xl mb-5">
        <CleanAdSlot page="entry_3" placement="ENTRY_3_TOP" />
      </div>

      <h1 className="text-2xl sm:text-4xl font-black mb-5 tracking-tighter text-center">
        {t.chooseProfileTitle}
      </h1>

      {/* Selezione Paese di Riferimento (persistente su localStorage + PostgreSQL) */}
      <div className="mb-6 w-full max-w-2xl rounded-2xl border border-cyan-400/35 bg-[#070d18] p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="onboarding-country-select"
            className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-cyan-300"
          >
            <Globe className="w-4 h-4 text-cyan-400" />
            <span>{entryText.marketTitle}</span>
          </label>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono font-black">
            <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/40 text-cyan-200">
              {resolvedZone}
            </span>
            <span className="px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-400/40 text-indigo-200">
              PPP: x{resolvedProfile.pppCoefficient.toFixed(4)} ({resolvedProfile.regionGroup})
            </span>
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200">
              GEO: {resolvedGeo}
            </span>
            {isCountryLocked && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-200">
                <Lock className="w-3 h-3" /> LOCKED
              </span>
            )}
          </div>
        </div>

        <select
          id="onboarding-country-select"
          value={country}
          disabled={isCountryLocked}
          onChange={(e) => setCountry(normalizeCountryCode(e.target.value))}
          className="w-full rounded-xl bg-[#040811] border border-cyan-400/40 px-3 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-cyan-300 disabled:opacity-60"
        >
          {COUNTRIES_CATALOG.map((c) => {
            const prof = resolveCountryEconomicProfile(c.code);
            return (
              <option key={c.code} value={c.code}>
                {c.flag} {countryLabel(c.code, lang)} ({c.code} • {c.tierZone} • PPP x{prof.pppCoefficient.toFixed(2)})
              </option>
            );
          })}
        </select>

        <p className="text-[11px] text-slate-400 leading-relaxed">{entryText.marketDesc}</p>
      </div>

      {/* Selezione genere */}
      <div className="mb-6 flex gap-4 sm:gap-6">
        {(['uomo', 'donna'] as const).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGender(g)}
            className={`rounded-full border-2 px-7 py-2.5 text-base sm:text-lg font-black transition-all cursor-pointer ${
              gender === g
                ? 'border-cyan-400 text-cyan-400 shadow-[0_0_15px_rgba(6,182,234,0.6)]'
                : 'border-slate-600/50 text-slate-400 hover:border-cyan-400/50'
            }`}
          >
            {g === 'uomo' ? t.genderMale : t.genderFemale}
          </button>
        ))}
      </div>

      {/* Selezione multipla categorie */}
      <div className="mb-6 w-full max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4 px-1">
          <p className="text-cyan-400 text-xs font-black uppercase tracking-widest">
            {t.chooseActivitiesLabel} ({selectedTypes.length} {t.selectedCountLabel})
          </p>
          <button
            type="button"
            onClick={toggleAll}
            className="text-xs font-black uppercase tracking-wider px-3 py-1 rounded-full border border-cyan-400/50 text-cyan-300 hover:bg-cyan-400/15 cursor-pointer transition-all"
          >
            {selectedTypes.length === PRODUCT_TYPES.length ? t.deselectAllBtn : t.selectAllBtn}
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {PRODUCT_TYPES.map((pt) => {
            const isSelected = selectedTypes.includes(pt.id);
            const localized = t.productTypes?.[pt.id];
            return (
              <button
                key={pt.id}
                type="button"
                onClick={() => toggleType(pt.id)}
                className={`relative rounded-2xl border-2 p-4 text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'border-cyan-400 bg-cyan-950/25 text-cyan-300 shadow-[0_0_15px_rgba(6,182,234,0.5)]'
                    : 'border-slate-700/60 bg-[#0a0a0a] text-slate-300 hover:border-cyan-400/50'
                }`}
              >
                {isSelected && (
                  <span className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-cyan-400 text-black text-xs font-black flex items-center justify-center">
                    ✓
                  </span>
                )}
                <div className="text-2xl sm:text-3xl mb-1.5">{pt.icon}</div>
                <div className="font-black text-sm sm:text-base mb-0.5 leading-tight">
                  {localized ? localized.name : pt.name}
                </div>
                <div className="text-[11px] text-slate-400 leading-snug">
                  {localized ? localized.desc : pt.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Pulsante Conferma */}
      <button
        type="button"
        disabled={!gender || selectedTypes.length === 0}
        onClick={() =>
          selectedTypes.length > 0 &&
          gender &&
          onSelect(selectedTypes.join(','), gender, selectedTypes, country)
        }
        className={`w-full max-w-md py-4 rounded-full border-2 font-black text-lg uppercase tracking-wider transition-all ${
          gender && selectedTypes.length > 0
            ? 'border-cyan-400 bg-black/40 text-cyan-400 hover:bg-cyan-400 hover:text-black shadow-[0_0_20px_rgba(6,182,234,0.4)] cursor-pointer'
            : 'border-slate-800 bg-slate-900/40 text-slate-600 cursor-not-allowed'
        }`}
      >
        {t.continueBtn} ({selectedTypes.length})
      </button>
    </div>
  );
}

export default ProductTypeView;
