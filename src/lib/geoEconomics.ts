// ============================================================================
// GEO ECONOMICS — Paesi di riferimento, zone economiche & PPP Banca Mondiale
// ============================================================================
// Regole ufficiali del sistema internazionale (zero coefficienti arbitrari):
//   - Stati Uniti (`US`): coefficiente base = 1.0000
//   - Europa (UE / SEE / UK / CH): coefficiente base = 1.0000
//   - Africa, Cina, India, America Latina & Altri Paesi:
//       coefficiente PPP per Paese derivato dai dati ufficiali Banca Mondiale
//       Private Consumption PPP (PA.NUS.PRVT.PP) / FX ufficiale (PA.NUS.FCRF).
//   - Scala contabile unica invariante: 100 PT = $1.00 USD (0.01 USD/PT).
//   - Soglia minima prelievo su PostgreSQL: 500 PT ($5.00 USD).
//   - Ripartizione contabile verificata su postback:
//       Utente = FLOOR(raw_points * 0.30 * ppp_coefficient) (max 30%)
//       Margine Piattaforma = raw_points - user_pending_points (>= 70%)
//   - I tassi di conversione/prelievo (TON, SOL, PI live; USDT/USDC/CASH 1:1 USD)
//     restano sempre ancorati a 100 PT = $1.00 USD (mai alterati da PPP).
// ============================================================================

import {
  getCountryEconomicProfile,
  getAllCountryEconomicProfiles,
  type CountryEconomicProfile,
  type EconomicRegionGroup,
} from '../services/worldBankPpp';

export type { CountryEconomicProfile, EconomicRegionGroup };

export type EconomicTierZone = 'ZONE_A' | 'ZONE_B' | 'ZONE_C';
export type ProviderGeoRegion = 'GLOBAL' | 'IT_EU' | 'US_UK_CA';

export interface CountryCatalogItem {
  code: string;
  tierZone: EconomicTierZone;
  geoEligibility: ProviderGeoRegion;
  flag: string;
}

export const ENTRY_COUNTRY_STORAGE_KEY = 'af_entry_country';

export const ACCOUNTING_POINTS_PER_USD = 100;
export const ACCOUNTING_USER_SHARE_PERCENT = 30;
export const ACCOUNTING_PLATFORM_SHARE_PERCENT = 70;
export const ACCOUNTING_MIN_PAYOUT_POINTS = 500;
export const RECOVERED_ZONE_C_PPP_DEFAULT = 0.20;

const EU_IT_COUNTRY_CODES = new Set([
  'IT',
  'DE',
  'FR',
  'ES',
  'NL',
  'BE',
  'AT',
  'PT',
  'PL',
  'SE',
  'FI',
  'DK',
  'IE',
  'GR',
  'CZ',
  'RO',
  'HU',
  'SK',
  'BG',
  'HR',
  'SI',
  'LT',
  'LV',
  'EE',
  'LU',
  'CY',
  'MT',
  'CH',
  'NO',
]);

const US_UK_CA_COUNTRY_CODES = new Set(['US', 'GB', 'UK', 'CA']);

const ZONE_A_CODES = new Set([
  'US',
  'GB',
  'UK',
  'CA',
  'DE',
  'FR',
  'IT',
  'NL',
  'BE',
  'AT',
  'CH',
  'SE',
  'NO',
  'DK',
  'FI',
  'IE',
  'LU',
  'AU',
  'NZ',
  'JP',
  'KR',
  'SG',
  'AE',
]);

const ZONE_B_CODES = new Set([
  'ES',
  'PT',
  'PL',
  'CZ',
  'GR',
  'RO',
  'HU',
  'BR',
  'MX',
  'AR',
  'CL',
  'CO',
  'TR',
  'SA',
  'CN',
  'RU',
  'TH',
  'MY',
]);

export const COUNTRIES_CATALOG: CountryCatalogItem[] = [
  { code: 'IT', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇮🇹' },
  { code: 'DE', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇩🇪' },
  { code: 'FR', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇫🇷' },
  { code: 'ES', tierZone: 'ZONE_B', geoEligibility: 'IT_EU', flag: '🇪🇸' },
  { code: 'PT', tierZone: 'ZONE_B', geoEligibility: 'IT_EU', flag: '🇵🇹' },
  { code: 'NL', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇳🇱' },
  { code: 'BE', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇧🇪' },
  { code: 'AT', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇦🇹' },
  { code: 'CH', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇨🇭' },
  { code: 'PL', tierZone: 'ZONE_B', geoEligibility: 'IT_EU', flag: '🇵🇱' },
  { code: 'SE', tierZone: 'ZONE_A', geoEligibility: 'IT_EU', flag: '🇸🇪' },
  { code: 'GB', tierZone: 'ZONE_A', geoEligibility: 'US_UK_CA', flag: '🇬🇧' },
  { code: 'US', tierZone: 'ZONE_A', geoEligibility: 'US_UK_CA', flag: '🇺🇸' },
  { code: 'CA', tierZone: 'ZONE_A', geoEligibility: 'US_UK_CA', flag: '🇨🇦' },
  { code: 'AU', tierZone: 'ZONE_A', geoEligibility: 'GLOBAL', flag: '🇦🇺' },
  { code: 'JP', tierZone: 'ZONE_A', geoEligibility: 'GLOBAL', flag: '🇯🇵' },
  { code: 'KR', tierZone: 'ZONE_A', geoEligibility: 'GLOBAL', flag: '🇰🇷' },
  { code: 'SG', tierZone: 'ZONE_A', geoEligibility: 'GLOBAL', flag: '🇸🇬' },
  { code: 'AE', tierZone: 'ZONE_A', geoEligibility: 'GLOBAL', flag: '🇦🇪' },
  { code: 'BR', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇧🇷' },
  { code: 'MX', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇲🇽' },
  { code: 'CL', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇨🇱' },
  { code: 'CO', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇨🇴' },
  { code: 'AR', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇦🇷' },
  { code: 'TR', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇹🇷' },
  { code: 'SA', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇸🇦' },
  { code: 'CN', tierZone: 'ZONE_B', geoEligibility: 'GLOBAL', flag: '🇨🇳' },
  { code: 'NG', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇳🇬' },
  { code: 'KE', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇰🇪' },
  { code: 'ZA', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇿🇦' },
  { code: 'EG', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇪🇬' },
  { code: 'MA', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇲🇦' },
  { code: 'IN', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇮🇳' },
  { code: 'ID', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇮🇩' },
  { code: 'PH', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🇵🇭' },
  { code: 'OTHER', tierZone: 'ZONE_C', geoEligibility: 'GLOBAL', flag: '🌍' },
];

const SUPPORTED_COUNTRY_CODES = new Set(COUNTRIES_CATALOG.map((c) => c.code));

export function normalizeCountryCode(raw: unknown): string {
  const clean = String(raw || '').trim().toUpperCase();
  if (!clean || clean === 'OTHER') return 'OTHER';
  if (clean === 'UK') return 'GB';
  if (SUPPORTED_COUNTRY_CODES.has(clean)) return clean;
  if (/^[A-Z]{2}$/.test(clean)) return clean;
  return 'OTHER';
}

/**
 * Associa il Paese alla fascia economica (ZONE_A / ZONE_B / ZONE_C).
 * Nota: non confondere questa fascia con `geoRegion` dei fornitori.
 */
export function resolveCountryEconomicZone(rawCountry?: string | null): EconomicTierZone {
  const code = normalizeCountryCode(rawCountry);
  if (ZONE_A_CODES.has(code)) return 'ZONE_A';
  if (ZONE_B_CODES.has(code)) return 'ZONE_B';
  return 'ZONE_C';
}

/**
 * Restituisce il profilo economico completo Banca Mondiale per il Paese indicato
 * (`US = 1.0`, `EUROPE = 1.0`, Africa/Cina/India/LatAm/Other da `PA.NUS.PRVT.PP / PA.NUS.FCRF`).
 */
export function resolveCountryEconomicProfile(rawCountry?: string | null): CountryEconomicProfile {
  return getCountryEconomicProfile(normalizeCountryCode(rawCountry));
}

/**
 * Restituisce il coefficiente PPP (0.0100 .. 1.0000) ufficiale per il Paese.
 */
export function getCountryPppCoefficient(rawCountry?: string | null): number {
  return resolveCountryEconomicProfile(rawCountry).pppCoefficient;
}

/**
 * Restituisce l'intero catalogo ordinato dei profili economici Banca Mondiale caricati.
 */
export function listCountryEconomicProfiles(): CountryEconomicProfile[] {
  return getAllCountryEconomicProfiles();
}

export interface VerifiedPppRewardBreakdown {
  grossUsd: number;
  rawPoints: number;
  pppCoefficient: number;
  userPendingPoints: number;
  platformMarginPoints: number;
  userSharePercent: number;
  platformMarginPercent: number;
}

/**
 * Calcola la ripartizione contabile verificata 30% utente / >=70% piattaforma
 * integrando il coefficiente PPP Banca Mondiale senza mai creare PT scoperti
 * e preservando integralmente la somma zero (`userPendingPoints + platformMarginPoints === rawPoints`).
 */
export function computeVerifiedPppRewardBreakdown(
  grossUsd: number,
  countryCodeOrCoef?: string | number | null
): VerifiedPppRewardBreakdown {
  const safeGross = Math.max(0, Number(grossUsd) || 0);
  const rawPoints = Math.floor(safeGross * ACCOUNTING_POINTS_PER_USD);
  const pppCoefficient =
    typeof countryCodeOrCoef === 'number' && Number.isFinite(countryCodeOrCoef)
      ? Math.min(1.0, Math.max(0.01, Math.round(countryCodeOrCoef * 10000) / 10000))
      : getCountryPppCoefficient(typeof countryCodeOrCoef === 'string' ? countryCodeOrCoef : 'US');

  const userPendingPoints = Math.floor(rawPoints * 0.30 * pppCoefficient);
  const platformMarginPoints = Math.max(0, rawPoints - userPendingPoints);

  return {
    grossUsd: safeGross,
    rawPoints,
    pppCoefficient,
    userPendingPoints,
    platformMarginPoints,
    userSharePercent: rawPoints > 0 ? Number(((userPendingPoints / rawPoints) * 100).toFixed(2)) : 0,
    platformMarginPercent: rawPoints > 0 ? Number(((platformMarginPoints / rawPoints) * 100).toFixed(2)) : 0,
  };
}

/**
 * Restituisce l'area geografica operativa del Paese rispetto ai filtri dei fornitori
 * (`IT_EU`, `US_UK_CA` oppure `GLOBAL`).
 * Paesi al di fuori di UE e US/UK/CA (es. Africa, LatAm, Asia) ricevono solo `GLOBAL`.
 */
export function getCountryGeoEligibility(rawCountry?: string | null): ProviderGeoRegion {
  const code = normalizeCountryCode(rawCountry);
  if (US_UK_CA_COUNTRY_CODES.has(code)) return 'US_UK_CA';
  if (EU_IT_COUNTRY_CODES.has(code)) return 'IT_EU';
  return 'GLOBAL';
}

export function isNoRestrictionProvider(providerGeoRegion?: string | null): boolean {
  const geo = String(providerGeoRegion || 'GLOBAL').trim().toUpperCase();
  return !geo || geo === 'GLOBAL';
}

/**
 * Determina se un fornitore e' compatibile con il Paese selezionato dall'utente.
 * Non forza mai offerte regionali incompatibili (es. IT_EU su utente NG/BR o US_UK_CA su DE).
 */
export function isProviderGeoCompatible(
  providerGeoRegion?: string | null,
  userCountry?: string | null
): boolean {
  const geo = String(providerGeoRegion || 'GLOBAL').trim().toUpperCase();
  if (!geo || geo === 'GLOBAL') return true;
  const userEligibility = getCountryGeoEligibility(userCountry);
  return geo === userEligibility;
}

export interface SimpleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getSafeStorage(): SimpleStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function persistEntryCountry(
  countryCode: string,
  storage: SimpleStorage | null = getSafeStorage()
): string {
  const normalized = normalizeCountryCode(countryCode);
  if (!storage) return normalized;
  try {
    storage.setItem(ENTRY_COUNTRY_STORAGE_KEY, normalized);
  } catch {
    // ignore storage quota errors
  }
  return normalized;
}

export function readEntryCountry(
  storage: SimpleStorage | null = getSafeStorage(),
  fallback = 'IT'
): string {
  if (!storage) return normalizeCountryCode(fallback);
  try {
    const raw = storage.getItem(ENTRY_COUNTRY_STORAGE_KEY);
    if (!raw) return normalizeCountryCode(fallback);
    return normalizeCountryCode(raw);
  } catch {
    return normalizeCountryCode(fallback);
  }
}
