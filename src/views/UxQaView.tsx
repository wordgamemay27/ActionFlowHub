// ============================================================================
// UX & QA TESTING VIEW — Ricerche Serie (0 Squalifiche) + QA App & Bug Testing
// Ogni fornitore ha foto cliccabile che apre le istruzioni interne e modalità.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ArrowLeft, ShieldCheck, Globe, Search } from 'lucide-react';
import { CleanAdSlot } from '../components/CleanAdSlot';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import { VERIFIED_UX_QA_PROVIDERS, VERIFIED_OCR_PROVIDERS } from '../lib/verifiedDirectProviders';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation } from '../lib/i18n';
import { UserProfile } from '../types';
import { isProviderGeoCompatible, normalizeCountryCode } from '../lib/geoEconomics';
import { sortProvidersByPriority } from '../lib/providerPriority';

interface UxQaViewProps {
  user: UserProfile;
  userCountry?: string;
  subCategory?: 'sites' | 'apps' | 'surveys' | 'all';
  onBack: () => void;
  onBalanceUpdated?: () => void;
}

const SITES_IDS = new Set([
  'qa-hackenproof-web3',
  'ux-coingecko-singapore',
  'ux-hotjar-pingpong',
  'ux-userinterviews-direct',
  'ux-uxarmy-direct',
  'ux-stackernews-lightning',
  'ux-enroll-direct',
  'ux-playbookux-direct',
  'ux-userfeel-direct',
  'ux-usertesting-direct',
  'qa-userlytics-direct',
  'ux-testingtime-eu',
  'ux-trymata-direct',
  'ux-userbrain-direct',
]);

const APPS_IDS = new Set([
  'ux-blink-elsalvador',
  'ux-warpcast-farcaster',
  'qa-hackenproof-web3',
  'ux-userinterviews-direct',
  'ux-uxarmy-direct',
  'qa-betatesting-direct',
  'qa-testlio-direct',
  'qa-testbirds-direct',
  'qa-testio-direct',
  'qa-utest-direct',
  'qa-playtestcloud-direct',
  'qa-ferpection-mobile',
]);

const SURVEYS_IDS = new Set([
  'ux-blink-elsalvador',
  'ux-coingecko-singapore',
  'ux-stackernews-lightning',
  'ux-primal-nostr',
  'ux-warpcast-farcaster',
  'ux-yougov-direct',
  'ux-ipsos-isay-direct',
  'ux-norstatpanel-eu',
  'ocr-google-rewards-eu',
  'ux-prolific-direct',
  'ux-testableminds-direct',
  'ux-respondent-direct',
]);

export const UxQaView: React.FC<UxQaViewProps> = ({
  user,
  userCountry = 'IT',
  subCategory = 'all',
  onBack,
  onBalanceUpdated,
}) => {
  const { t } = useTranslation();
  const [selectedProvider, setSelectedProvider] = useState<VerifiedProviderItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [geoMode, setGeoMode] = useState<'AUTO_USER' | 'ALL'>('AUTO_USER');

  const normalizedCountry = normalizeCountryCode(userCountry);

  const filteredProviders = useMemo(() => {
    const googleRewards = VERIFIED_OCR_PROVIDERS.find((p) => p.id === 'ocr-google-rewards-eu');
    const combinedList = googleRewards
      ? [...VERIFIED_UX_QA_PROVIDERS, googleRewards]
      : VERIFIED_UX_QA_PROVIDERS;

    const categoryFiltered =
      subCategory === 'sites'
        ? combinedList.filter((p) => SITES_IDS.has(p.id))
        : subCategory === 'apps'
        ? combinedList.filter((p) => APPS_IDS.has(p.id))
        : subCategory === 'surveys'
        ? combinedList.filter((p) => SURVEYS_IDS.has(p.id))
        : VERIFIED_UX_QA_PROVIDERS;

    const searched = categoryFiltered.filter((p) => {
      if (geoMode === 'AUTO_USER' && !isProviderGeoCompatible(p.geoRegion, normalizedCountry)) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.categoryLabel.toLowerCase().includes(q) ||
        p.shortDescription.toLowerCase().includes(q)
      );
    });

    return sortProvidersByPriority(searched, normalizedCountry, undefined, {
      excludeIncompatibleGeo: geoMode === 'AUTO_USER',
      activityCategory: subCategory === 'surveys' ? 'SURVEY' : 'UX_QA',
    });
  }, [geoMode, normalizedCountry, searchQuery, subCategory]);

  const titleText =
    subCategory === 'sites'
      ? `🌐 ${t.nav.ux_sites}`
      : subCategory === 'apps'
      ? `📱 ${t.nav.ux_apps}`
      : subCategory === 'surveys'
      ? `📋 ${t.nav.surveys}`
      : `📱 ${t.nav.ux_qa}`;

  const descText =
    subCategory === 'sites'
      ? t.ui.uxSitesDesc
      : subCategory === 'apps'
      ? t.ui.uxAppsDesc
      : subCategory === 'surveys'
      ? t.ui.surveysDesc
      : t.ui.uxAllDesc;

  const handleExecuteProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: provider.id,
      activityCategory: subCategory === 'surveys' ? 'SURVEY' : 'UX_QA',
      telegramId: user.telegramId,
      kind: 'TASK',
    });
    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="ux_qa" placement="UX_QA_TOP" telegramUserId={user?.telegramId} />

      {/* HEADER */}
      <div className="rounded-2xl border border-sky-400/25 bg-[#071122]/90 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onBack}
              className="p-2.5 rounded-xl bg-[#0098EA] text-white hover:bg-cyan-400 hover:text-slate-950 border-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-md"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center gap-1.5 text-xs font-mono font-black uppercase tracking-wider text-emerald-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>{titleText}</span>
              </div>
              <h2 className="text-base font-black text-white mt-0.5">
                {filteredProviders.length} {t.ui.officialAppsReady}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setGeoMode((m) => (m === 'AUTO_USER' ? 'ALL' : 'AUTO_USER'))}
            className="shrink-0 px-2.5 py-1.5 rounded-xl bg-sky-500/15 border border-sky-400/35 text-[10px] font-mono font-black text-sky-300 flex items-center gap-1 cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-amber-400" />
            <span>{geoMode === 'AUTO_USER' ? `${t.ui.countryLabel}: ${userCountry}` : t.ui.allCountriesLabel}</span>
          </button>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {descText}{' '}
          <strong className="text-amber-300">{t.ui.tapPhotoHint}</strong>
        </p>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.ui.searchPlaceholder}
            className="w-full rounded-xl bg-[#050b16] border border-sky-400/25 pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
          />
        </div>
      </div>

      {/* GRIGLIA FORNITORI CON FOTO CLICCABILE */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredProviders.map((provider) => (
          <ProviderCardWithPhoto
            key={provider.id}
            provider={provider}
            onOpenInstructions={(p) => setSelectedProvider(p)}
            onExecuteDirect={handleExecuteProvider}
          />
        ))}
      </div>

      {/* MODALE ISTRUZIONI INTERNE QUANDO CLICCHI LA FOTO */}
      <ProviderExecutionModal
        provider={selectedProvider}
        onClose={() => setSelectedProvider(null)}
        onExecute={handleExecuteProvider}
      />
    </div>
  );
};

export default UxQaView;

