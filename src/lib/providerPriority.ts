// ============================================================================
// PROVIDER PRIORITY ENGINE — Classificazione automatica fornitori (7 Criteri)
// ============================================================================
// Ordine deterministico di selezione:
//   0. Esclusioni automatiche fail-closed: QUARANTINE / BANNED / isLocked / GEO incompatibile.
//   1. Fornitori GLOBAL senza requisiti di fascia geografica prima di offerte regionali.
//   2. Completamento immediato / rapido delle attivita' (minuti operativi crescenti).
//   3. Postback di conferma rapidi (Web3/API/Istantaneo > S2S Diretto > Manuale).
//   4. Pagamenti e liquidazioni veloci (Istantaneo > 24h > Settimanale > Net-7 > Net-15).
//   5. Elevata percentuale di completamento (`completion_rate` da interazioni/conferme reali).
//   6. Reputazione ACTIVE e affidabilita' verificabile (`ACTIVE` > `WARNING`, score ed EMA).
//   7. Compatibilita' geografica e disponibilita' economica dell'offerta (CPA USD / PT).
// ============================================================================

import type { VerifiedProviderItem } from '../components/ProviderExecutionModal';
import {
  isNoRestrictionProvider,
  isProviderGeoCompatible,
  normalizeCountryCode,
} from './geoEconomics';
import { resolveCanonicalProviderId } from './affiliate';
import { BANNED_PROVIDER_KEYWORDS } from './verifiedDirectProviders';
import {
  type CycleStreamCategory,
  type SupportedLang,
  filterStepsByCategories,
} from './entryProfile';

export interface ProviderReputationSnapshot {
  provider_id: string;
  status: 'ACTIVE' | 'WARNING' | 'QUARANTINE' | 'BANNED';
  reputation_score: number;
  ema_haircut_ratio?: number;
  total_confirmed_events?: number;
  total_clicks?: number;
  completion_rate?: number;
}

export interface CycleStepCandidate {
  id: string;
  titles: Record<SupportedLang, string>;
  category: CycleStreamCategory;
  activityCategory: string;
  providerId: string;
  providerLabel: string;
  targetUrl: string;
  durationSec: number;
  geoRegion?: string;
  actionDuration?: string;
  modalityBadge?: string;
  payoutInfo?: string;
  currencies?: string;
  userPoints?: number;
  isLocked?: boolean;
}

export interface PrioritizedCycleStep extends CycleStepCandidate {
  canonicalProviderId: string;
  priorityScore: number;
  noRestriction: boolean;
  estimatedMinutes: number;
  completionRate: number;
  reputationStatus: 'ACTIVE' | 'WARNING' | 'UNSCORED';
}

export function resolveProviderCompletionRate(rep?: ProviderReputationSnapshot): number {
  if (!rep) return 1.0;
  if (typeof rep.completion_rate === 'number' && Number.isFinite(rep.completion_rate)) {
    return Math.min(1.0, Math.max(0, rep.completion_rate));
  }
  const confirmed = Number(rep.total_confirmed_events ?? 0);
  const clicks = Number(rep.total_clicks ?? 0);
  if (clicks > 0 && confirmed >= 0) {
    return Math.min(1.0, Math.max(0, confirmed / clicks));
  }
  const ema = Number(rep.ema_haircut_ratio ?? 1.0);
  return Number.isFinite(ema) ? Math.min(1.0, Math.max(0, ema)) : 1.0;
}

export function parseCompletionMinutes(actionDuration?: string): number {
  const raw = String(actionDuration || '').toLowerCase();
  if (!raw) return 15;
  const secMatch = raw.match(/(\d+)\s*(?:s|sec|secondi)/);
  if (secMatch) {
    return Math.max(0.5, Number(secMatch[1]) / 60);
  }
  const minMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:-\s*\d+)?\s*(?:min|m\b)/);
  if (minMatch) {
    return Math.max(1, Number(minMatch[1].replace(',', '.')));
  }
  const hourMatch = raw.match(/(\d+)\s*(?:h|ora|ore)/);
  if (hourMatch) {
    return Number(hourMatch[1]) * 60;
  }
  return 10;
}

export function rankPostbackSpeed(modalityBadge?: string): number {
  const m = String(modalityBadge || '').toLowerCase();
  if (
    m.includes('istantaneo') ||
    m.includes('instant') ||
    m.includes('web3 api') ||
    m.includes('on-chain') ||
    m.includes('lightning') ||
    m.includes('al secondo')
  ) {
    return 1;
  }
  if (m.includes('s2s') || m.includes('api') || m.includes('telegram')) {
    return 2;
  }
  if (m.includes('diretto') || m.includes('direct') || m.includes('browser')) {
    return 3;
  }
  return 4;
}

export function rankPayoutCycleSpeed(payoutInfo?: string): number {
  const p = String(payoutInfo || '').toLowerCase();
  if (
    p.includes('istantaneo') ||
    p.includes('immediato') ||
    p.includes('tempo reale') ||
    p.includes('al secondo') ||
    p.includes('$0 min') ||
    p.includes('on-chain')
  ) {
    return 1;
  }
  if (p.includes('24 ore') || p.includes('24h') || p.includes('giornaliero')) {
    return 2;
  }
  if (p.includes('settimanale') || p.includes('weekly')) {
    return 3;
  }
  if (p.includes('net-7')) {
    return 4;
  }
  if (p.includes('net-14') || p.includes('net-15')) {
    return 5;
  }
  if (p.includes('net-30') || p.includes('mensile')) {
    return 6;
  }
  return 7;
}

export function parseMaxCpaUsd(payoutInfo?: string, userPoints?: number): number {
  const p = String(payoutInfo || '');
  const matches = Array.from(p.matchAll(/\$(\d+(?:[.,]\d+)?)/g))
    .map((m) => Number(m[1].replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (matches.length > 0) {
    return Math.max(...matches);
  }
  return Math.max(0, (Number(userPoints) || 0) / 100);
}

export function lookupReputation(
  rawId: string,
  activityCategory: string | undefined,
  reputationMap?: Record<string, ProviderReputationSnapshot>
): ProviderReputationSnapshot | undefined {
  if (!reputationMap) return undefined;
  const direct = reputationMap[rawId.toLowerCase()];
  if (direct) return direct;
  const canonical = resolveCanonicalProviderId(rawId, activityCategory);
  return reputationMap[canonical];
}

export function isProviderReputationEligible(
  rep?: ProviderReputationSnapshot
): boolean {
  if (!rep) return true;
  return rep.status !== 'QUARANTINE' && rep.status !== 'BANNED';
}

function isAllowedByBannedKeywords(parts: Array<string | undefined>): boolean {
  const haystack = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!haystack) return true;
  return !BANNED_PROVIDER_KEYWORDS.some((kw) => haystack.includes(kw));
}

export function sortProvidersByPriority<T extends VerifiedProviderItem>(
  providers: T[],
  userCountry?: string | null,
  reputationMap?: Record<string, ProviderReputationSnapshot>,
  options?: { excludeIncompatibleGeo?: boolean; activityCategory?: string }
): T[] {
  const normalizedCountry = normalizeCountryCode(userCountry);
  const excludeIncompatible = Boolean(options?.excludeIncompatibleGeo);

  const filtered = providers.filter((p) => {
    if (!isAllowedByBannedKeywords([p.id, p.name, p.directUrl, p.shortDescription])) {
      return false;
    }
    const rep = lookupReputation(p.id, options?.activityCategory, reputationMap);
    if (!isProviderReputationEligible(rep)) return false;
    if (excludeIncompatible && !isProviderGeoCompatible(p.geoRegion, normalizedCountry)) {
      return false;
    }
    return true;
  });

  return [...filtered].sort((a, b) => {
    // 0. Non bloccati sempre prima dei bloccati
    const lockDiff = Number(Boolean(a.isLocked)) - Number(Boolean(b.isLocked));
    if (lockDiff !== 0) return lockDiff;

    // 1. Compatibilita' GEO & Fornitori GLOBAL senza requisiti geografici per primi
    const compatA = isProviderGeoCompatible(a.geoRegion, normalizedCountry) ? 0 : 1;
    const compatB = isProviderGeoCompatible(b.geoRegion, normalizedCountry) ? 0 : 1;
    if (compatA !== compatB) return compatA - compatB;

    const noRestA = isNoRestrictionProvider(a.geoRegion) ? 0 : 1;
    const noRestB = isNoRestrictionProvider(b.geoRegion) ? 0 : 1;
    if (noRestA !== noRestB) return noRestA - noRestB;

    // 2. Completamento immediato / rapido delle attivita'
    const durA = parseCompletionMinutes(a.actionDuration);
    const durB = parseCompletionMinutes(b.actionDuration);
    if (durA !== durB) return durA - durB;

    // 3. Postback di conferma rapidi
    const pbA = rankPostbackSpeed(a.modalityBadge);
    const pbB = rankPostbackSpeed(b.modalityBadge);
    if (pbA !== pbB) return pbA - pbB;

    // 4. Pagamenti e liquidazioni veloci
    const payA = rankPayoutCycleSpeed(a.payoutInfo);
    const payB = rankPayoutCycleSpeed(b.payoutInfo);
    if (payA !== payB) return payA - payB;

    // 5. Elevata percentuale di completamento (completion rate reale)
    const repA = lookupReputation(a.id, options?.activityCategory, reputationMap);
    const repB = lookupReputation(b.id, options?.activityCategory, reputationMap);
    const compA = resolveProviderCompletionRate(repA);
    const compB = resolveProviderCompletionRate(repB);
    if (Math.abs(compA - compB) > 0.001) return compB - compA;

    // 6. Reputazione ACTIVE e affidabilita' (ACTIVE > WARNING, score ed EMA haircut)
    const statusRankA = repA?.status === 'WARNING' ? 1 : 0;
    const statusRankB = repB?.status === 'WARNING' ? 1 : 0;
    if (statusRankA !== statusRankB) return statusRankA - statusRankB;

    const scoreA = Number(repA?.reputation_score ?? 100);
    const scoreB = Number(repB?.reputation_score ?? 100);
    if (scoreA !== scoreB) return scoreB - scoreA;

    const emaA = Number(repA?.ema_haircut_ratio ?? 1);
    const emaB = Number(repB?.ema_haircut_ratio ?? 1);
    if (Math.abs(emaA - emaB) > 0.001) return emaB - emaA;

    // 7. Compatibilita' geografica e disponibilita' economica dell'offerta (CPA / PT)
    const cpaA = parseMaxCpaUsd(a.payoutInfo, a.userPoints);
    const cpaB = parseMaxCpaUsd(b.payoutInfo, b.userPoints);
    if (cpaA !== cpaB) return cpaB - cpaA;

    return Number(b.userPoints || 0) - Number(a.userPoints || 0);
  });
}

/**
 * Costruisce la playlist prioritizzata per `UNIFIED_AUTO` applicando tutti i 7 criteri:
 * - Esclude offerte bloccate (`isLocked`), `QUARANTINE`/`BANNED` e offerte regionali incompatibili.
 * - Mantiene sempre le categorie scelte dall'utente in onboarding (con fallback completo se vuoto).
 */
export function buildPrioritizedAutoCycleSteps(
  candidates: CycleStepCandidate[],
  selectedCategories: string[] | null | undefined,
  userCountry?: string | null,
  reputationMap?: Record<string, ProviderReputationSnapshot>
): PrioritizedCycleStep[] {
  const normalizedCountry = normalizeCountryCode(userCountry);

  const nonBannedEligible = (step: CycleStepCandidate) => {
    if (step.isLocked) return false;
    if (!isAllowedByBannedKeywords([step.providerId, step.providerLabel, step.targetUrl])) {
      return false;
    }
    const rep = lookupReputation(step.providerId, step.activityCategory, reputationMap);
    return isProviderReputationEligible(rep);
  };

  const eligible = candidates.filter(
    (step) =>
      nonBannedEligible(step) &&
      isProviderGeoCompatible(step.geoRegion || 'GLOBAL', normalizedCountry)
  );

  const pool =
    eligible.length > 0 ? eligible : candidates.filter((s) => nonBannedEligible(s));
  const categoryMatched = filterStepsByCategories(pool, selectedCategories);

  const enriched: PrioritizedCycleStep[] = categoryMatched.map((step) => {
    const canonical = resolveCanonicalProviderId(step.providerId, step.activityCategory);
    const rep = lookupReputation(step.providerId, step.activityCategory, reputationMap);
    const noRestriction = isNoRestrictionProvider(step.geoRegion || 'GLOBAL');
    const estMin = parseCompletionMinutes(step.actionDuration);
    const pbRank = rankPostbackSpeed(step.modalityBadge);
    const payRank = rankPayoutCycleSpeed(step.payoutInfo);
    const completionRate = resolveProviderCompletionRate(rep);
    const repScore = Number(rep?.reputation_score ?? 100);
    const repPenalty = rep?.status === 'WARNING' ? 25 : 0;

    const priorityScore =
      (noRestriction ? 1000 : 700) -
      estMin * 15 -
      pbRank * 20 -
      payRank * 18 +
      completionRate * 120 +
      repScore -
      repPenalty;

    return {
      ...step,
      canonicalProviderId: canonical,
      priorityScore,
      noRestriction,
      estimatedMinutes: estMin,
      completionRate,
      reputationStatus: rep?.status === 'WARNING' ? 'WARNING' : rep ? 'ACTIVE' : 'UNSCORED',
    };
  });

  return enriched.sort((a, b) => {
    // 1. GLOBAL senza requisiti di fascia prima di regionali
    if (a.noRestriction !== b.noRestriction) return a.noRestriction ? -1 : 1;
    // 2. Completamento immediato/rapido
    if (a.estimatedMinutes !== b.estimatedMinutes) return a.estimatedMinutes - b.estimatedMinutes;
    // 3. Postback rapidi
    const pbA = rankPostbackSpeed(a.modalityBadge);
    const pbB = rankPostbackSpeed(b.modalityBadge);
    if (pbA !== pbB) return pbA - pbB;
    // 4. Pagamenti/liquidazioni veloci
    const payA = rankPayoutCycleSpeed(a.payoutInfo);
    const payB = rankPayoutCycleSpeed(b.payoutInfo);
    if (payA !== payB) return payA - payB;
    // 5. Elevata percentuale di completamento
    if (Math.abs(a.completionRate - b.completionRate) > 0.001) {
      return b.completionRate - a.completionRate;
    }
    // 6. Reputazione ACTIVE e affidabilita'
    if (a.reputationStatus !== b.reputationStatus) {
      return a.reputationStatus === 'WARNING' ? 1 : -1;
    }
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    // 7. Compatibilita' geografica & valore offerta
    const cpaA = parseMaxCpaUsd(a.payoutInfo, a.userPoints);
    const cpaB = parseMaxCpaUsd(b.payoutInfo, b.userPoints);
    if (cpaA !== cpaB) return cpaB - cpaA;
    return Number(b.userPoints || 0) - Number(a.userPoints || 0);
  });
}
