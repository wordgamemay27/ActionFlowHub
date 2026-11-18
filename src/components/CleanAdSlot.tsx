// ============================================================================
// CLEAN AD SLOT — Banner Fotografico Pulito a Rotazione Automatica
// Mostra SOLO il banner con immagine reale (zero bottoni o scritte sovrapposte).
// Toccando il banner si apre direttamente l'indirizzo / link collegato.
// ============================================================================

import React, { useState, useEffect } from 'react';
import { openTrackedLink } from '../lib/affiliate';

export type AdPageContext =
  | 'home'
  | 'tasks'
  | 'games'
  | 'micro_drama'
  | 'music'
  | 'ai_work'
  | 'receipts'
  | 'telegram_bots'
  | 'airdrop'
  | 'wallet'
  | 'profile'
  | 'matrix'
  | 'entry'
  | 'entry_1'
  | 'entry_2'
  | 'entry_3';

export interface CleanAdSlotProps {
  page: AdPageContext | string;
  placement: string;
  telegramUserId?: number;
}

interface CleanPhotoBannerItem {
  id: string;
  photoUrl: string;
  alt: string;
  directUrl: string;
}

const FALLBACK_PHOTO = '/assets/ads/fallback-banner.jpg';

const AIRDROP_NODE_PHOTO_POOL: CleanPhotoBannerItem[] = [
  { id: 'stonfi_ton', photoUrl: '/assets/ads/stonfi.jpg', alt: 'STON.fi TON', directUrl: 'https://app.ston.fi/' },
  { id: 'dedust_ton', photoUrl: '/assets/ads/dedust.jpg', alt: 'DeDust.io TON', directUrl: 'https://dedust.io/' },
  { id: 'storm_trade_ton', photoUrl: '/assets/ads/stormtrade.jpg', alt: 'Storm Trade', directUrl: 'https://t.me/StormTradeBot' },
  { id: 'taskon_usdt', photoUrl: '/assets/ads/taskon.jpg', alt: 'TaskOn', directUrl: 'https://taskon.xyz/' },
  { id: 'layer3_quests', photoUrl: '/assets/ads/layer3.jpg', alt: 'Layer3', directUrl: 'https://app.layer3.xyz/' },
  { id: 'pawns_node', photoUrl: '/assets/ads/pawns.jpg', alt: 'Pawns.app', directUrl: 'https://pawns.app/' },
  { id: 'honeygain_node', photoUrl: '/assets/ads/honeygain.jpg', alt: 'Honeygain', directUrl: 'https://www.honeygain.com/' },
];

const CARD_BONUS_PHOTO_POOL: CleanPhotoBannerItem[] = [
  { id: 'redotpay_card', photoUrl: '/assets/ads/redotpay.jpg', alt: 'RedotPay Card', directUrl: 'https://www.redotpay.com/' },
  { id: 'bybit_card', photoUrl: '/assets/ads/bybit.jpg', alt: 'Bybit Card', directUrl: 'https://www.bybit.com/en/card' },
  { id: 'tangem_card', photoUrl: '/assets/ads/tangem.jpg', alt: 'Tangem AG Swiss Wallet', directUrl: 'https://tangem.com/' },
  { id: 'mtpelerin_card', photoUrl: '/assets/ads/mtpelerin.jpg', alt: 'Mt Pelerin Swiss Ramp', directUrl: 'https://www.mtpelerin.com/' },
  { id: 'binance_pay_card', photoUrl: '/assets/ads/binance.jpg', alt: 'Binance Pay', directUrl: 'https://www.binance.com/en/binancepay' },
  { id: 'ledger_card', photoUrl: '/assets/ads/ledger.jpg', alt: 'Ledger Official', directUrl: 'https://www.ledger.com/' },
];

export const CleanAdSlot: React.FC<CleanAdSlotProps> = ({
  page,
  placement,
  telegramUserId = 0,
}) => {
  const isAirdropOrEntryOrWalletPage =
    page === 'entry' ||
    page === 'entry_1' ||
    page === 'entry_2' ||
    page === 'entry_3' ||
    page === 'wallet' ||
    page === 'airdrop' ||
    page === 'depin' ||
    page === 'telegram_bots' ||
    page === 'matrix';

  const activePool = isAirdropOrEntryOrWalletPage
    ? AIRDROP_NODE_PHOTO_POOL
    : CARD_BONUS_PHOTO_POOL;

  const isLarge = placement === 'BOTTOM_LARGE' || placement.endsWith('_BOTTOM');

  const initialIndex = React.useMemo(() => {
    const sum = (page + placement).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return sum % activePool.length;
  }, [page, placement, activePool.length]);

  const [currentIndex, setCurrentIndex] = useState<number>(initialIndex);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % activePool.length);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [activePool.length]);

  const item = activePool[currentIndex % activePool.length] || activePool[0];

  const handleBannerClick = () => {
    openTrackedLink(item.directUrl, {
      partnerId: `banner_${item.id}`,
      taskId: `ad_${placement.toLowerCase()}_u${telegramUserId}`,
      activityCategory: 'ADS',
      telegramId: telegramUserId,
      kind: 'TASK',
    });
  };

  return (
    <div
      data-ad-page={page}
      data-ad-placement={placement}
      data-telegram-uid={telegramUserId}
      onClick={handleBannerClick}
      className={`relative w-full rounded-2xl border border-cyan-400/30 overflow-hidden shadow-md cursor-pointer active:scale-[0.99] transition-all ${
        isLarge ? 'h-24 sm:h-28' : 'h-16 sm:h-20'
      }`}
    >
      <img
        src={item.photoUrl}
        alt={item.alt}
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_PHOTO; }}
        className="w-full h-full object-cover object-center block"
      />
    </div>
  );
};

export default CleanAdSlot;
