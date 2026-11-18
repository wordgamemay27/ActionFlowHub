// ============================================================================
// RECEIPT OCR VIEW — Scontrini GEO (Filtro Automatico Paese IT/UE vs USA/UK/CA)
// Nessun mock OCR lato client, nessun accredito client-side: esegue sui partner
// verificati con tracciamento interazione PostgreSQL & postback S2S.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, Globe, ShieldCheck } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_OCR_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { getCountryGeoEligibility, normalizeCountryCode } from '../lib/geoEconomics';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface ReceiptOcrViewProps {
  user: UserProfile;
  userCountry?: string;
  onBalanceUpdated?: () => void;
  onBack: () => void;
}

export const ReceiptOcrView: React.FC<ReceiptOcrViewProps> = ({
  user,
  userCountry = 'IT',
  onBalanceUpdated,
  onBack,
}) => {
  const { t } = useTranslation();
  const normalizedCountry = normalizeCountryCode(userCountry);
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const [geoFilter, setGeoFilter] = useState<'GLOBAL' | 'IT_EU' | 'US_UK_CA'>(() =>
    getCountryGeoEligibility(normalizedCountry)
  );

  const filteredOcrProviders = useMemo(() => {
    const matched = VERIFIED_OCR_PROVIDERS.filter((p) => {
      if (geoFilter === 'GLOBAL') return !p.geoRegion || p.geoRegion === 'GLOBAL';
      return p.geoRegion === 'GLOBAL' || p.geoRegion === geoFilter;
    });
    return sortProvidersByPriority(matched, normalizedCountry, undefined, {
      activityCategory: 'RECEIPT',
    });
  }, [geoFilter, normalizedCountry]);

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: 'RECEIPT',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="receipts" placement="RECEIPTS_TOP" telegramUserId={user?.telegramId} />

      <div className="rounded-2xl border border-sky-400/25 bg-[#071122]/90 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
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
                <Globe className="w-4 h-4 text-emerald-300" />
                <span>🧾 {t.nav.ocr}</span>
              </div>
              <h2 className="text-base font-black text-white mt-0.5">
                {t.ui.ocrActiveApps} ({filteredOcrProviders.length})
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-[#040a14] p-1 rounded-xl border border-sky-400/25">
            <button
              type="button"
              onClick={() => setGeoFilter('GLOBAL')}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-mono font-black uppercase transition-all cursor-pointer ${
                geoFilter === 'GLOBAL'
                  ? 'bg-sky-400 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              🌍 Global
            </button>
            <button
              type="button"
              onClick={() => setGeoFilter('IT_EU')}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-mono font-black uppercase transition-all cursor-pointer ${
                geoFilter === 'IT_EU'
                  ? 'bg-emerald-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              🇪🇺 EU / IT
            </button>
            <button
              type="button"
              onClick={() => setGeoFilter('US_UK_CA')}
              className={`px-2 py-1.5 rounded-lg text-[10px] font-mono font-black uppercase transition-all cursor-pointer ${
                geoFilter === 'US_UK_CA'
                  ? 'bg-amber-400 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              🇺🇸 USA / UK / CA
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {t.ui.ocrDesc}{' '}
          <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
        </p>

        <div className="rounded-xl bg-[#050b16] border border-emerald-400/25 px-3 py-2 flex items-center gap-2 text-[11px] font-mono text-emerald-300">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>
            Verifica scontrini gestita direttamente dai partner S2S certificati (nessun accredito locale simulato).
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredOcrProviders.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteProvider}
          />
        ))}
      </div>

      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default ReceiptOcrView;
