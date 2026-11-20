// ============================================================================
// AFFILIATE TRACKING — REGISTRAZIONE ATOMICA CLICK & SINGOLA INTERAZIONE
// ============================================================================
// Nessun accredito lato client, nessun localStorage af_real_rewards_v1 / clicks,
// nessun POST /api/rewards/record.
// Ogni click viene registrato su PostgreSQL via POST /api/affiliate/click
// in stato CLICK_REGISTERED (0 PT accreditati) in attesa di postback partner.
// ============================================================================

import { openAnyUrlSafely } from '../utils/navigation';

export type AffiliateActionKind = 'TASK' | 'SIGNUP' | 'REFERRAL';

export interface AffiliateClickPayload {
  partnerId: string;
  taskId: string;
  activityCategory?: string;
  kind: AffiliateActionKind;
  clickId: string;
  interactionId?: string;
  sessionId?: string;
  trackingUrl: string;
  expectedGrossUsd?: number;
}

export interface RegisteredInteractionResponse {
  ok: boolean;
  sessionId?: string;
  interactionId?: string;
  clickId?: string;
  status?: string;
  error?: string;
}

export function getTelegramInitDataHeader(): string {
  try {
    return (window as any)?.Telegram?.WebApp?.initData || '';
  } catch {
    return '';
  }
}

export function newClickId(): string {
  return `clk_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

export function newInteractionId(): string {
  return `int_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

export function buildAffiliateUrl(
  baseUrl: string,
  params: { clickId: string; partnerId?: string; subId?: string; sub2?: string }
): string {
  if (!baseUrl) return baseUrl;
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  const sep = baseUrl.includes('?') ? '&' : '?';
  const query: string[] = [`click_id=${encodeURIComponent(params.clickId)}`];
  if (params.partnerId) query.push(`partner_id=${encodeURIComponent(params.partnerId)}`);
  if (params.subId) query.push(`sub_id=${encodeURIComponent(params.subId)}`);
  if (params.sub2) query.push(`sub2=${encodeURIComponent(params.sub2)}`);
  return `${baseUrl}${sep}${query.join('&')}`;
}

/**
 * Registra l'interazione reale sul backend PostgreSQL (0 punti aggiunti al click).
 */
export async function trackAffiliateClick(
  payload: AffiliateClickPayload
): Promise<RegisteredInteractionResponse> {
  try {
    const initData = getTelegramInitDataHeader();
    const res = await fetch('/api/affiliate/click', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
      },
      body: JSON.stringify({
        partnerId: payload.partnerId,
        taskId: payload.taskId,
        activityCategory: payload.activityCategory || 'OTHER',
        clickId: payload.clickId,
        interactionId: payload.interactionId || newInteractionId(),
        sessionId: payload.sessionId,
        trackingUrl: payload.trackingUrl,
        expectedGrossUsd: payload.expectedGrossUsd || 0,
        initData,
      }),
      keepalive: true,
    });
    return await res.json();
  } catch (err: any) {
    return { ok: false, error: err?.message || 'NETWORK_ERROR' };
  }
}

const REGISTERED_PROVIDERS = new Set([
  'reelshort',
  'dramabox',
  'shorttv',
  'kalostv',
  'plarium',
  'wargaming',
  'gaijin',
  'submithub',
  'fountain',
  'prolific',
  'outlier',
  'premise',
  'mysterium',
  'honeygain',
  'video_stream',
  'ads_network',
  'music_player',
  'ton_onchain_partner',
  'sol_onchain_partner',
]);

export function resolveCanonicalProviderId(
  rawPartnerId: string,
  activityCategory?: string
): string {
  const clean = String(rawPartnerId || '').trim().toLowerCase();
  if (!clean) return 'ads_network';
  if (clean === 'internal_relay') return 'internal_relay';
  if (REGISTERED_PROVIDERS.has(clean)) return clean;

  if (clean.includes('reelshort')) return 'reelshort';
  if (clean.includes('dramabox')) return 'dramabox';
  if (clean.includes('shorttv')) return 'shorttv';
  if (clean.includes('kalostv') || clean.includes('kalos')) return 'kalostv';
  if (clean.includes('plarium')) return 'plarium';
  if (clean.includes('wargaming')) return 'wargaming';
  if (clean.includes('gaijin')) return 'gaijin';
  if (clean.includes('submithub')) return 'submithub';
  if (clean.includes('fountain')) return 'fountain';
  if (clean.includes('prolific')) return 'prolific';
  if (clean.includes('outlier')) return 'outlier';
  if (clean.includes('premise')) return 'premise';
  if (clean.includes('mysterium')) return 'mysterium';
  if (clean.includes('honeygain')) return 'honeygain';
  if (clean.includes('stonfi') || clean.includes('dedust') || clean.includes('ton')) {
    return clean.startsWith('banner_') || clean.startsWith('withdraw_') ? 'ads_network' : 'ton_onchain_partner';
  }

  const cat = String(activityCategory || '').toUpperCase();
  if (cat === 'MICRO_DRAMA') return 'reelshort';
  if (cat === 'VIDEO') return 'video_stream';
  if (cat === 'MUSIC') return 'music_player';
  if (cat === 'GAME') return 'plarium';
  if (cat === 'SURVEY') return 'ads_network';
  if (cat === 'UX_QA') return 'prolific';
  if (cat === 'AI_TASK') return 'outlier';
  if (cat === 'RECEIPT') return 'premise';
  if (cat === 'DEPIN') return 'mysterium';

  if (clean.startsWith('soap-')) return 'reelshort';
  if (clean.startsWith('game-')) return 'plarium';
  if (clean.startsWith('music-') || clean.startsWith('audio-')) return 'music_player';
  if (clean.startsWith('ai-')) return 'outlier';
  if (clean.startsWith('ux-') || clean.startsWith('qa-')) return 'prolific';
  if (clean.startsWith('ocr-')) return 'premise';
  if (clean.startsWith('depin-')) return 'mysterium';

  return 'ads_network';
}

export function openTrackedLink(
  url: string,
  meta: {
    partnerId: string;
    taskId?: string;
    activityCategory?: string;
    sessionId?: string;
    telegramId?: number;
    kind?: AffiliateActionKind;
    expectedGrossUsd?: number;
  }
): { clickId: string; interactionId: string; trackedUrl: string } {
  const clickId = newClickId();
  const interactionId = newInteractionId();
  const canonicalPartnerId = resolveCanonicalProviderId(meta.partnerId, meta.activityCategory);
  const baseTaskId = meta.taskId || `task_${meta.partnerId}`;
  const taskId =
    canonicalPartnerId !== meta.partnerId.toLowerCase() && !baseTaskId.includes(meta.partnerId)
      ? `${meta.partnerId}:${baseTaskId}`
      : baseTaskId;
  const trackedUrl = buildAffiliateUrl(url, {
    clickId,
    partnerId: canonicalPartnerId,
    subId: meta.telegramId ? String(meta.telegramId) : undefined,
    sub2: meta.sessionId || interactionId,
  });

  void trackAffiliateClick({
    partnerId: canonicalPartnerId,
    taskId,
    activityCategory: meta.activityCategory || 'OTHER',
    kind: meta.kind || 'TASK',
    clickId,
    interactionId,
    sessionId: meta.sessionId,
    trackingUrl: trackedUrl,
    expectedGrossUsd: meta.expectedGrossUsd || 0,
  });

  openAnyUrlSafely(trackedUrl, {
    slotId: taskId,
    providerKey: canonicalPartnerId,
    campaignId: clickId,
    pageContext: meta.activityCategory || 'affiliate',
  });

  return { clickId, interactionId, trackedUrl };
}
