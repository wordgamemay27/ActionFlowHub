// ============================================================================
// SHOPPING & CARTE CRYPTO DIRETTE — Vetrina Visiva & Interattiva
// Legge esclusivamente dal registro unico VERIFIED_SHOPPING_SERVICE_PROVIDERS
// e dai 34 Brand Ufficiali (0 PT all'utente, 100% commissione alla piattaforma).
// ============================================================================

import React, { useState, useMemo } from 'react';
import { ShoppingBag, CreditCard, Sparkles, ExternalLink, Search } from 'lucide-react';
import {
  MASTER_INVENTORY_DATA,
  EXTENDED_INVENTORY_DATA,
  InventoryItem,
} from '../lib/catalogMasterData';
import { BrandLogo } from '../components/GlassMedia';
import { CleanAdSlot } from '../components/CleanAdSlot';
import { openTrackedLink } from '../lib/affiliate';
import {
  ProviderCardWithPhoto,
  ProviderExecutionModal,
  VerifiedProviderItem,
} from '../components/ProviderExecutionModal';
import {
  VERIFIED_SHOPPING_SERVICE_PROVIDERS,
  isProviderAllowedByBlacklist,
} from '../lib/verifiedDirectProviders';
import { useTranslation } from '../lib/i18n';
import { localizeInventoryItem } from '../lib/providerLocalization';
import { UserProfile } from '../types';

interface ShoppingViewProps {
  user: UserProfile;
}

export const ShoppingView: React.FC<ShoppingViewProps> = ({ user }) => {
  const { t, lang } = useTranslation();
  const [selectedServiceProvider, setSelectedServiceProvider] =
    useState<VerifiedProviderItem | null>(null);
  const [activeSection, setActiveSection] = useState<'CARDS' | 'BRANDS'>('CARDS');
  const [searchQuery, setSearchQuery] = useState('');

  const directCryptoCards = useMemo(() => {
    const clean = VERIFIED_SHOPPING_SERVICE_PROVIDERS.filter(isProviderAllowedByBlacklist);
    if (!searchQuery.trim()) return clean;
    const q = searchQuery.toLowerCase();
    return clean.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.currencies.toLowerCase().includes(q) ||
        p.categoryLabel.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const allBrandVouchers = useMemo<InventoryItem[]>(() => {
    const all = [
      ...MASTER_INVENTORY_DATA.brands,
      ...MASTER_INVENTORY_DATA.gamingPlaytime,
      ...EXTENDED_INVENTORY_DATA.mediaVideo,
      ...EXTENDED_INVENTORY_DATA.taskNetworks,
      ...EXTENDED_INVENTORY_DATA.aiWork,
      ...EXTENDED_INVENTORY_DATA.nftGifts,
      ...EXTENDED_INVENTORY_DATA.airdropEcosystem,
    ].map((item) => localizeInventoryItem(item, lang));
    if (!searchQuery.trim()) return all;
    const q = searchQuery.toLowerCase();
    return all.filter(
      (b) => b.name.toLowerCase().includes(q) || b.category.toLowerCase().includes(q)
    );
  }, [searchQuery, lang]);

  const handleOpenServiceProvider = (provider: VerifiedProviderItem) => {
    openTrackedLink(provider.directUrl, {
      partnerId: provider.id,
      taskId: `shop_service_${provider.id}`,
      activityCategory: 'SHOPPING',
      telegramId: user.telegramId,
      kind: 'SIGNUP',
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-3 pb-12 animate-fade-in select-none">
      <CleanAdSlot page="shopping" placement="SHOPPING_TOP" telegramUserId={user?.telegramId} />

      {/* BARRA INTERATTIVA COMPATTA */}
      <div className="rounded-2xl bg-[#071122]/95 border border-sky-400/25 p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center shrink-0">
              <ShoppingBag className="w-4 h-4 text-amber-300" />
            </div>
            <div>
              <h2 className="text-sm font-black uppercase tracking-wider text-white">
                {t.nav.shopping}
              </h2>
              <div className="text-[10px] font-mono text-amber-300">
                {t.ui.shoppingSubtitle}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-[#040a14] p-1 rounded-xl border border-sky-400/25">
            <button
              type="button"
              onClick={() => setActiveSection('CARDS')}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-mono font-black uppercase flex items-center gap-1 cursor-pointer transition-all ${
                activeSection === 'CARDS'
                  ? 'bg-amber-400 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>{t.ui.cryptoCardsTab} ({directCryptoCards.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('BRANDS')}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-mono font-black uppercase flex items-center gap-1 cursor-pointer transition-all ${
                activeSection === 'BRANDS'
                  ? 'bg-sky-400 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t.ui.brandsTab} ({allBrandVouchers.length})</span>
            </button>
          </div>
        </div>

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

      {/* SEZIONE 1: CARTE CRYPTO & SERVIZI DIRETTI (DAL REGISTRO UNICO) */}
      {activeSection === 'CARDS' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {directCryptoCards.map((provider) => (
            <ProviderCardWithPhoto
              key={provider.id}
              provider={provider}
              onOpenInstructions={(p) => setSelectedServiceProvider(p)}
              onExecuteDirect={handleOpenServiceProvider}
            />
          ))}
        </div>
      )}

      {/* SEZIONE 2: GRIGLIA VISIVA 34 BRAND UFFICIALI */}
      {activeSection === 'BRANDS' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {allBrandVouchers.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() =>
                openTrackedLink(item.link, {
                  partnerId: item.id,
                  taskId: `brand_direct_${item.id}`,
                  activityCategory: 'SHOPPING',
                  telegramId: user.telegramId,
                  kind: 'SIGNUP',
                })
              }
              className="rounded-2xl bg-[#091324]/95 border border-sky-400/25 p-3 flex flex-col items-center text-center gap-2 hover:border-sky-400/60 active:scale-95 transition-all cursor-pointer"
            >
              <div className="w-12 h-12 rounded-xl bg-[#050b16] border border-sky-400/20 flex items-center justify-center p-2">
                <BrandLogo brand={item.id} src={item.logo} size={32} />
              </div>
              <div className="w-full min-w-0">
                <div className="text-xs font-black text-white truncate">{item.name}</div>
                <div className="text-[10px] font-mono text-sky-300 truncate">{item.badge}</div>
              </div>
              <span className="w-full py-1 rounded-lg bg-amber-500/15 border border-amber-400/35 text-[10px] font-mono font-black text-amber-300 uppercase flex items-center justify-center gap-1">
                <span>{t.ui.openStoreBtn}</span>
                <ExternalLink className="w-3 h-3" />
              </span>
            </button>
          ))}
        </div>
      )}

      <ProviderExecutionModal
        provider={selectedServiceProvider}
        onClose={() => setSelectedServiceProvider(null)}
        onExecute={handleOpenServiceProvider}
      />
    </div>
  );
};

export default ShoppingView;
