// ============================================================================
// NAVIGATION UTILS — Apertura sicura Anti-Ban con oscuramento Referer (noreferrer)
// ============================================================================

export interface AdTrackingMeta {
  pageContext?: string;
  telegramUserId?: number;
  providerKey?: string;
  slotId?: string;
  campaignId?: string;
}

export function isSafeExternalHttpsUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isTelegramUrl(url: string): boolean {
  if (!isSafeExternalHttpsUrl(url)) return false;
  return /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(url.trim());
}

/**
 * Apre l'URL esterno oscurando completamente la provenienza interna (rel="noopener noreferrer")
 * per proteggere la piattaforma da controlli Referer / anti-ban dei fornitori.
 * Blocca qualsiasi protocollo diverso da HTTPS (anti-XSS javascript:/data:).
 */
export function openAnyUrlSafely(url: string, _trackingMeta?: AdTrackingMeta): void {
  if (!url || typeof window === 'undefined') return;
  if (!isSafeExternalHttpsUrl(url)) return;

  try {
    const safeUrl = new URL(url.trim()).toString();
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } } }).Telegram?.WebApp;

    if (isTelegramUrl(safeUrl) && tg?.openTelegramLink) {
      tg.openTelegramLink(safeUrl);
      return;
    }

    if (tg?.openLink) {
      tg.openLink(safeUrl);
      return;
    }

    // Creazione link invisibile con rel="noopener noreferrer" per azzerare l'HTTP Referer
    const anchor = document.createElement('a');
    anchor.href = safeUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } catch {
    // Fallback silenzioso
  }
}
