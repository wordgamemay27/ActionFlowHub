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

export function isTelegramUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i.test(url.trim());
}

/**
 * Apre l'URL esterno oscurando completamente la provenienza interna (rel="noopener noreferrer")
 * per proteggere la piattaforma da controlli Referer / anti-ban dei fornitori.
 */
export function assertSafeHttpUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openAnyUrlSafely(url: string, _trackingMeta?: AdTrackingMeta): void {
  if (!url || typeof window === 'undefined') return;
  if (!assertSafeHttpUrl(url)) return;

  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void; openLink?: (u: string) => void } } }).Telegram?.WebApp;

    if (isTelegramUrl(url) && tg?.openTelegramLink) {
      tg.openTelegramLink(url);
      return;
    }

    if (tg?.openLink) {
      tg.openLink(url);
      return;
    }

    // Creazione link invisibile con rel="noopener noreferrer" per azzerare l'HTTP Referer
    const anchor = document.createElement('a');
    anchor.href = url;
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
