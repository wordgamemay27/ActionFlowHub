// ============================================================================
// HOME VIEW — Schermata principale con nucleo geometrico, card illustrate,
// 34 loghi brand ufficiali e sessione automatizzata unica
// ============================================================================

import React, { useState, useMemo, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { UserProfile } from '../types';
import { GeoCore } from '../components/GeoCore';
import { CleanAdSlot } from '../components/CleanAdSlot';
import { AutoInteractiveCycleEngine } from '../components/AutoInteractiveCycleEngine';
import { VideoStreamSection } from '../components/VideoStreamSection';
import { BrandLogo, GlassPanel } from '../components/GlassMedia';
import { CYBER_NAV_ITEMS } from '../components/CyberNav';
import { openTrackedLink } from '../lib/affiliate';
import { useTranslation, getCatalogLang } from '../lib/i18n';
import { localizeInventoryItem } from '../lib/providerLocalization';
import {
  PROJECTS_CATALOG,
  ProjectCardData,
  ProjectActionItem,
  DurationBucket,
  getDirectProviderRelayUrl,
} from '../lib/catalogData';
import {
  MASTER_INVENTORY_DATA,
  EXTENDED_INVENTORY_DATA,
  InventoryItem,
} from '../lib/catalogMasterData';
import {
  GLASS_COVER_FAST,
  GLASS_COVER_MEDIUM,
  GLASS_COVER_LONG,
} from '../lib/glassPlaceholder';

const COVER_PHOTO_FAST = GLASS_COVER_FAST;
const COVER_PHOTO_MEDIUM = GLASS_COVER_MEDIUM;
const COVER_PHOTO_LONG = GLASS_COVER_LONG;

interface HomeViewProps {
  user: UserProfile;
  userCountry?: string;
  onOpenAdPlayer: () => void;
  onOpenPartnerModal: (partnerKey: string) => void;
  onNavigateTab: (tab: string) => void;
  onOpenTonkeeperGuide: () => void;
  onBalanceUpdated?: () => void;
  autoSessionTriggerKey?: number;
  selectedCategories?: string[];
}

interface DailyThresholdTaskSlot {
  slotId: string;
  cleanTitle: string;
  project: ProjectCardData;
  action: ProjectActionItem;
  actionIdx: number;
  basePoints1x: number;
  brandKey: string;
}

export const HomeView: React.FC<HomeViewProps> = ({
  user,
  userCountry,
  onNavigateTab,
  onBalanceUpdated,
  autoSessionTriggerKey,
  selectedCategories,
}) => {
  const { t, lang } = useTranslation();
  const cLang = getCatalogLang(lang);
  const brandHalfCardsScrollRef = useRef<HTMLDivElement | null>(null);

  const [expandedThresholdCard, setExpandedThresholdCard] = useState<DurationBucket | null>('FAST');
  const [showVideoStream, setShowVideoStream] = useState<boolean>(false);
  const [coreMenuOpen, setCoreMenuOpen] = useState<boolean>(false);

  // Tutti i 35 Partner / Brand Ufficiali con logo SVG verificato in /logos/*.svg
  const allOfficialBrands: InventoryItem[] = useMemo(
    () => [
      ...MASTER_INVENTORY_DATA.brands,
      ...MASTER_INVENTORY_DATA.gamingPlaytime,
      ...EXTENDED_INVENTORY_DATA.mediaVideo,
      ...EXTENDED_INVENTORY_DATA.taskNetworks,
      ...EXTENDED_INVENTORY_DATA.aiWork,
      ...EXTENDED_INVENTORY_DATA.nftGifts,
      ...EXTENDED_INVENTORY_DATA.airdropEcosystem,
    ],
    []
  );

  const stripProjectCode = (rawTitle: string): string => {
    const parts = rawTitle.split('—');
    return parts.length > 1 ? parts.slice(1).join('—').trim() : rawTitle.trim();
  };

  const daySeed = useMemo(() => {
    const d = new Date();
    return d.getFullYear() * 366 + (d.getMonth() + 1) * 31 + d.getDate();
  }, []);

  // ============================================================================
  // LE 3 CARD FOTO IN HOME (REGOLA UNICA 30% SU CONFERMA FORNITORE S2S)
  // ============================================================================
  const dailyThreeThresholdCards = useMemo(() => {
    const buildPureCategoryCardSlots = (
      bucket: DurationBucket,
      actionPoints30Percent: number
    ): DailyThresholdTaskSlot[] => {
      const pureCategoryPool =
        bucket === 'FAST'
          ? PROJECTS_CATALOG.filter(
              (p) => p.pageId === 'page_games_ladder' || p.pageId === 'page_playtime'
            )
          : bucket === 'MEDIUM'
          ? PROJECTS_CATALOG.filter(
              (p) =>
                p.id === 'proj-voice-3phrases' ||
                p.id === 'proj-voice-15phrases' ||
                p.id === 'proj-receipt-photo' ||
                p.pageId === 'page_bots_youtuber'
            )
          : PROJECTS_CATALOG.filter(
              (p) =>
                p.id === 'proj-video-object-1m' ||
                p.id === 'proj-home-chores-8m' ||
                p.id === 'proj-home-session-1h' ||
                p.id === 'proj-saas-cloud-trial' ||
                p.id === 'proj-app-test-full'
            );

      const allActionsInPurePool = pureCategoryPool.flatMap((proj) =>
        proj.actions.map((act, actIdx) => ({ proj, act, actIdx }))
      );

      const fallbackProj = PROJECTS_CATALOG[0];
      const fallbackAct = fallbackProj?.actions[0];

      const pickedItems = [0, 1, 2, 3, 4, 5].map((i) => {
        const item = allActionsInPurePool[i % Math.max(1, allActionsInPurePool.length)];
        return item || { proj: fallbackProj, act: fallbackAct, actIdx: 0 };
      });

      const defaultLogos =
        bucket === 'FAST'
          ? ['steam', 'playstation', 'epicgames', 'roblox', 'googleplay', 'apple']
          : bucket === 'MEDIUM'
          ? ['telegram', 'amazon', 'spotify', 'youtube', 'paypal', 'zalando']
          : ['tiktok', 'instagram', 'discord', 'ton', 'binance', 'netflix'];

      return pickedItems
        .filter((item) => item.proj && item.act)
        .map((item, i) => ({
          slotId: `${bucket}_${item.proj.id}_${item.actIdx}_${i}`,
          cleanTitle: stripProjectCode(item.proj.title[cLang] || item.proj.title.it),
          project: item.proj,
          action: item.act,
          actionIdx: item.actIdx,
          basePoints1x: actionPoints30Percent,
          brandKey: defaultLogos[i % defaultLogos.length],
        }));
    };

    const fastSlots = buildPureCategoryCardSlots('FAST', 15);
    const mediumSlots = buildPureCategoryCardSlots('MEDIUM', 30);
    const longSlots = buildPureCategoryCardSlots('LONG', 60);

    return [
      {
        bucket: 'FAST' as DurationBucket,
        title: t.fastTasksTitle,
        shortCategoryDesc: `${t.ui.creditPerTaskPrefix}15 ${t.ui.creditPerTaskSuffix}`,
        thresholdPoints: 15,
        coverPhoto: COVER_PHOTO_FAST,
        brandKey: 'steam',
        overlayGradient: 'from-[#061814]/85 via-transparent to-[#061814]/50',
        pointsColor: 'text-emerald-300',
        badgeClass: 'bg-emerald-500 text-slate-950',
        slots: fastSlots,
      },
      {
        bucket: 'MEDIUM' as DurationBucket,
        title: t.mediumTasksTitle,
        shortCategoryDesc: `${t.ui.creditPerTaskPrefix}30 ${t.ui.creditPerTaskSuffix}`,
        thresholdPoints: 30,
        coverPhoto: COVER_PHOTO_MEDIUM,
        brandKey: 'telegram',
        overlayGradient: 'from-[#081526]/85 via-transparent to-[#081526]/50',
        pointsColor: 'text-sky-300',
        badgeClass: 'bg-cyan-400 text-slate-950',
        slots: mediumSlots,
      },
      {
        bucket: 'LONG' as DurationBucket,
        title: t.longTasksTitle,
        shortCategoryDesc: `${t.ui.creditPerTaskPrefix}60 ${t.ui.creditPerTaskSuffix}`,
        thresholdPoints: 60,
        coverPhoto: COVER_PHOTO_LONG,
        brandKey: 'youtube',
        overlayGradient: 'from-[#1C1006]/85 via-transparent to-[#1C1006]/50',
        pointsColor: 'text-amber-300',
        badgeClass: 'bg-amber-400 text-slate-950',
        slots: longSlots,
      },
    ];
  }, [daySeed, cLang, t]);

  const handleCardClick = (bucket: DurationBucket) => {
    setExpandedThresholdCard((prev) => (prev === bucket ? null : bucket));
  };

  const handleOpenProviderAction = (
    project: ProjectCardData,
    _action: ProjectActionItem,
    actionIdx: number,
    _overrideBasePoints1x?: number
  ) => {
    const publisherUrl = getDirectProviderRelayUrl(project, actionIdx);
    const activityCategory =
      project.pageId === 'page_games_ladder' || project.pageId === 'page_playtime'
        ? 'GAME'
        : project.pageId === 'page_bots_youtuber'
        ? 'VIDEO'
        : 'AI_TASK';

    if (publisherUrl) {
      openTrackedLink(publisherUrl, {
        partnerId: `task_${project.id}`,
        taskId: `${project.id}_${actionIdx}`,
        activityCategory,
        telegramId: user.telegramId,
        kind: 'TASK',
      });
    }

    const isBotTask = !!(project.unlocksHalfStep || project.pageId === 'page_bots_youtuber');
    if (isBotTask) {
      window.dispatchEvent(new Event('gf-trigger-bot-interaction'));
    }

    if (onBalanceUpdated) {
      setTimeout(() => onBalanceUpdated(), 1200);
    }
  };

  if (showVideoStream) {
    return (
      <VideoStreamSection
        autoSessionTriggerKey={autoSessionTriggerKey}
        telegramUserId={user.telegramId}
        userCountry={userCountry || user.marketCountry || 'IT'}
        tierZone={user.tierZone}
        onBack={() => setShowVideoStream(false)}
        onBalanceUpdated={onBalanceUpdated}
        selectedCategories={selectedCategories}
      />
    );
  }

  return (
    <div id="home-view-screen" className="space-y-4 pb-4 pt-0.5 select-none">
      {/* BANNER SPONSOR SUPERIORE CON LOGHI UFFICIALI */}
      <CleanAdSlot page="home" placement="TOP_SMALL" telegramUserId={user.telegramId} />

      {/* MOTORE SESSIONE AUTOMATIZZATA UNICA */}
      <AutoInteractiveCycleEngine
        autoStartTriggerKey={autoSessionTriggerKey}
        selectedCategories={selectedCategories}
        telegramUserId={user.telegramId}
        userCountry={userCountry || user.marketCountry || 'IT'}
        tierZone={user.tierZone}
        onBalanceUpdated={onBalanceUpdated}
      />

      {/* ===================================================================== */}
      {/* LE 3 CARD SOGLIA CON IMMAGINE DI COPERTINA E LOGHI UFFICIALI VISIBILI */}
      {/* ===================================================================== */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {dailyThreeThresholdCards.map((card) => {
          const isExpanded = expandedThresholdCard === card.bucket;
          return (
            <div key={card.bucket} className="space-y-2">
              <div
                onClick={() => handleCardClick(card.bucket)}
                className="glass-card glass-neon-edge relative rounded-2xl overflow-hidden p-3 cursor-pointer active:scale-[0.98] transition-all"
              >
                {/* IMMAGINE DI COPERTINA VISIBILE */}
                <div className="relative w-full h-36 rounded-xl overflow-hidden mb-2.5 bg-[#071022]">
                  <img
                    src={card.coverPhoto}
                    alt={card.title}
                    className="w-full h-full object-cover object-center"
                  />
                  <div className={`absolute inset-0 bg-gradient-to-t ${card.overlayGradient}`} />
                  <div className="absolute top-2 left-2 w-10 h-10 rounded-xl bg-[#050a14]/90 border border-sky-400/30 flex items-center justify-center p-1.5">
                    <BrandLogo brand={card.brandKey} size={28} />
                  </div>
                  <span
                    className={`absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-black uppercase ${card.badgeClass}`}
                  >
                    +{card.thresholdPoints} PT
                  </span>
                </div>

                <div className="relative z-10 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-black text-white">{card.title}</h3>
                    <p className="text-[11px] text-slate-300">{card.shortCategoryDesc}</p>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono text-base font-black ${card.pointsColor}`}>
                      +{card.thresholdPoints} PT
                    </div>
                    <span className="text-[10px] font-mono text-sky-300">
                      {isExpanded ? t.ui.closeTasksLabel : t.ui.openTasksLabel}
                    </span>
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="space-y-2 pl-1">
                  {card.slots.map((slot) => (
                    <div
                      key={slot.slotId}
                      onClick={() =>
                        handleOpenProviderAction(
                          slot.project,
                          slot.action,
                          slot.actionIdx,
                          slot.basePoints1x
                        )
                      }
                      className="glass-card rounded-xl p-2.5 flex items-center justify-between gap-2.5 cursor-pointer hover:border-sky-400/40"
                    >
                      <div className="w-10 h-10 rounded-xl bg-[#0a1324] border border-sky-400/20 flex items-center justify-center p-1.5 shrink-0">
                        <BrandLogo brand={slot.brandKey} size={28} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-black text-white truncate">{slot.cleanTitle}</div>
                        <div className="text-[11px] text-slate-300 truncate">
                          {slot.action.label[cLang] || slot.action.label.it}
                        </div>
                      </div>
                      <span className="shrink-0 px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-400/35 font-mono text-xs font-black text-emerald-300">
                        +{slot.basePoints1x} PT
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ===================================================================== */}
      {/* VETRINA 34 LOGHI BRAND & PREMI UFFICIALI (CATALOGO GIFT CARD)         */}
      {/* ===================================================================== */}
      <GlassPanel className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-mono font-black uppercase tracking-wider text-amber-300">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span>{t.ui.catalogBadge}</span>
            </div>
            <h3 className="text-base font-black text-white mt-0.5">
              {t.ui.catalogTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('wallet')}
            className="px-3 py-1.5 rounded-xl bg-sky-500/20 border border-sky-400/35 text-xs font-black uppercase text-sky-300 cursor-pointer active:scale-95 shrink-0"
          >
            {t.ui.convertInWalletBtn} ({allOfficialBrands.length})
          </button>
        </div>

        {/* CAROSELLO SCORREVOLE CON TUTTI I LOGHI UFFICIALI */}
        <div
          ref={brandHalfCardsScrollRef}
          className="flex items-center gap-2.5 overflow-x-auto pb-2 pt-1"
        >
          {allOfficialBrands.map((rawItem) => {
            const item = localizeInventoryItem(rawItem, lang);
            return (
              <button
                key={`carousel_${item.id}`}
                type="button"
                onClick={() =>
                  openTrackedLink(item.link, {
                    partnerId: `home_brand_${item.id}`,
                    taskId: item.id,
                    activityCategory: 'ADS',
                    telegramId: user.telegramId,
                    kind: 'TASK',
                  })
                }
                className="shrink-0 w-28 rounded-2xl bg-[#0a1324]/90 border border-sky-400/25 p-2.5 flex flex-col items-center gap-1.5 hover:border-sky-400/60 active:scale-95 transition-all cursor-pointer"
              >
                <div className="w-12 h-12 rounded-xl bg-[#060d1a] border border-sky-400/15 flex items-center justify-center p-2">
                  <BrandLogo
                    brand={item.id}
                    src={item.logo}
                    size={36}
                    className="w-9 h-9 object-contain"
                  />
                </div>
                <span className="w-full truncate text-center text-[11px] font-black text-white">
                  {item.name}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 font-mono text-[9px] font-black text-amber-300">
                  {t.ui.serviceBadge}
                </span>
              </button>
            );
          })}
        </div>
      </GlassPanel>

      {/* NUCLEO GEOMETRICO CENTRALE */}
      <div className="glass-panel glass-neon-edge rounded-2xl p-4 flex flex-col items-center gap-3">
        <GeoCore
          menuOpen={coreMenuOpen}
          onToggleMenu={() => setCoreMenuOpen((prev) => !prev)}
          size={112}
          label={t.ui.coreLabel}
        />
        {coreMenuOpen && (
          <div className="w-full grid grid-cols-2 gap-2 pt-2">
            {CYBER_NAV_ITEMS.map((item) => (
              <button
                key={item.tab}
                type="button"
                onClick={() => {
                  setCoreMenuOpen(false);
                  onNavigateTab(item.tab);
                }}
                className="flex min-h-[42px] items-center gap-2 rounded-xl border border-sky-400/20 bg-[#0a1220]/80 px-3 text-left text-xs font-black uppercase tracking-wider text-slate-200 active:scale-95 cursor-pointer"
              >
                <span className="text-base text-sky-300">{item.glyph}</span>
                <span className="truncate">{t.nav?.[item.tab] || item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <CleanAdSlot page="home" placement="BOTTOM_LARGE" telegramUserId={user.telegramId} />
    </div>
  );
};

export default HomeView;
