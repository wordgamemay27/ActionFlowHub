// ============================================================================
// API & TELEGRAM SERVICES — Gestione utente e auth header Telegram WebApp
// ============================================================================

import { openAnyUrlSafely, isTelegramUrl, type AdTrackingMeta } from '../utils/navigation';
import {
  UserProfile,
  calculateTonFromLiveRate,
  calculateUsdtEquivalent,
} from '../types';
import {
  readEntryCountry,
  resolveCountryEconomicProfile,
} from '../lib/geoEconomics';

export {
  openAnyUrlSafely,
  isTelegramUrl,
  calculateTonFromLiveRate,
  calculateUsdtEquivalent,
};
export type { AdTrackingMeta };

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name: string;
  username: string;
  language_code: string;
  is_premium: boolean;
  photo_url: string;
};

export const GUEST_FALLBACK_USER: TelegramUser = {
  id: 0,
  first_name: 'Utente Telegram',
  last_name: '',
  username: 'telegram_user',
  language_code: 'it',
  is_premium: false,
  photo_url: '',
};

export function getTelegramInitData(): string {
  try {
    return (window as any)?.Telegram?.WebApp?.initData || '';
  } catch {
    return '';
  }
}

export async function trackAdInteraction(payload: {
  eventType: 'IMPRESSION' | 'CLICK' | 'AUTO_TRIGGER';
  slotId?: string;
  providerKey?: string;
  target_url: string;
  pageContext?: string;
  telegramUserId?: number;
  sessionId?: string;
}): Promise<void> {
  if (payload.eventType === 'IMPRESSION') {
    return;
  }
  try {
    const initData = getTelegramInitData();
    await fetch('/api/affiliate/click', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
      },
      body: JSON.stringify({
        partnerId: payload.providerKey || 'ads_network',
        taskId: payload.slotId || 'ad_slot',
        activityCategory: 'ADS',
        trackingUrl: payload.target_url,
        sessionId: payload.sessionId,
        initData,
      }),
      keepalive: true,
    });
  } catch {
    // Non-blocking
  }
}

export function getTelegramUser(): TelegramUser {
  try {
    const tg = (window as any)?.Telegram?.WebApp;
    const u = tg?.initDataUnsafe?.user;
    if (u && typeof u.id === 'number') {
      return {
        id: u.id,
        first_name: u.first_name || 'User',
        last_name: u.last_name || '',
        username: u.username || `user_${u.id}`,
        language_code: u.language_code || 'it',
        is_premium: Boolean(u.is_premium),
        photo_url: u.photo_url || '',
      };
    }
  } catch {
    // ignore
  }
  return GUEST_FALLBACK_USER;
}

const LOCAL_USER_KEY = 'af_user_profile_v6';
const CLEAN_MEMORY_SCHEMA_KEY = 'af_clean_memory_schema_v6';
const CLEAN_MEMORY_SCHEMA_VALUE = 'CLEAN_SCHEMA_V6_POSTGRES_ONLY';

const LEGACY_STORAGE_KEYS = [
  'af_user_profile_v1',
  'af_user_profile_v2',
  'af_user_profile_v3',
  'af_user_profile_v4',
  'af_user_profile_v5',
  'af_clean_memory_schema_v4',
  'af_clean_memory_schema_v5',
  'actionflow_user_profile',
  'af_real_rewards_v1',
  'actionflow_real_rewards_v1',
  'af_affiliate_clicks_v1',
  'actionflow_ad_watch_history_v1',
  'af_session_id',
  'af_completed_blocks',
  'af_last_reset_day',
  'af_entry_minutes',
];

const PRESERVED_PREF_KEYS = new Set([
  'af_entry_country',
  'af_entry_categories',
  'af_entry_lang',
  'af_product_type',
  'af_product_types_multi',
  'af_user_gender',
  'af_entry_completed',
  'gf_user_lang',
  'gf_user_lang_manual',
  'af_lang_v1',
]);

export function purgeLegacyAppMemory(force = false): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const currentSchema = window.localStorage?.getItem(CLEAN_MEMORY_SCHEMA_KEY);
    if (!force && currentSchema === CLEAN_MEMORY_SCHEMA_VALUE) {
      return false;
    }

    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        window.localStorage?.removeItem(key);
        window.sessionStorage?.removeItem(key);
      } catch {
        // ignore
      }
    }

    if (window.localStorage) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (
          k &&
          k !== CLEAN_MEMORY_SCHEMA_KEY &&
          !PRESERVED_PREF_KEYS.has(k) &&
          (k.startsWith('af_') || k.startsWith('actionflow_') || k.startsWith('gf_'))
        ) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
    }

    if (window.sessionStorage) {
      window.sessionStorage.clear();
    }

    window.localStorage?.setItem(CLEAN_MEMORY_SCHEMA_KEY, CLEAN_MEMORY_SCHEMA_VALUE);
    return true;
  } catch {
    return false;
  }
}

purgeLegacyAppMemory(false);

export function initUserProfile(tgUser: TelegramUser): UserProfile {
  purgeLegacyAppMemory(false);
  let savedWallet = '';
  try {
    const raw = localStorage.getItem(LOCAL_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      if (parsed && typeof parsed.walletAddress === 'string') {
        savedWallet = parsed.walletAddress;
      }
    }
  } catch {
    // ignore
  }

  const savedCountry = readEntryCountry(undefined, 'IT');
  const savedProfile = resolveCountryEconomicProfile(savedCountry);

  const initial: UserProfile = {
    id: `usr_${tgUser.id || 'guest'}`,
    telegramId: tgUser.id || 0,
    username: tgUser.username || 'telegram_user',
    firstName: tgUser.first_name || 'Utente Telegram',
    lastName: tgUser.last_name || '',
    // Saldi rigorosamente a zero fino al fetch autorevole da PostgreSQL (/api/ledger/balance)
    points: 0,
    pendingPoints: 0,
    settledPoints: 0,
    withdrawablePoints: 0,
    reservedPoints: 0,
    marketCountry: savedProfile.countryCode,
    tierZone: savedProfile.tierZone,
    pppCoefficient: savedProfile.pppCoefficient,
    regionGroup: savedProfile.regionGroup,
    payoutSharePercent: 30,
    completedTasksCount: 0,
    walletAddress: savedWallet,
    role: 'user',
  };
  saveUserLocally(initial);
  return initial;
}

export function saveUserLocally(profile: UserProfile): void {
  try {
    const nonFinancialOnly = {
      id: profile.id,
      telegramId: profile.telegramId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      walletAddress: profile.walletAddress,
      marketCountry: profile.marketCountry,
      tierZone: profile.tierZone,
      pppCoefficient: profile.pppCoefficient,
      regionGroup: profile.regionGroup,
    };
    localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(nonFinancialOnly));
  } catch {
    // ignore
  }
}

export async function verifyTelegramInitDataServerSide(
  initData: string
): Promise<{ success: boolean; user?: TelegramUser; error?: string }> {
  try {
    const res = await fetch('/api/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    if (!res.ok) return { success: false };
    return await res.json();
  } catch {
    return { success: false };
  }
}
