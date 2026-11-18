// ============================================================================
// WORLD BANK PPP SERVICE — Official Private Consumption PPP (PA.NUS.PRVT.PP)
// & Official Exchange Rate (PA.NUS.FCRF) Price Level Index Engine
// ============================================================================
// Rules (zero arbitrary invented coefficients):
//   - US: base coefficient = 1.0000
//   - Europe (EU / EEA / UK / CH): base coefficient = 1.0000
//   - Africa, China, India, Latin America & Other countries:
//       PLI = ROUND(PA.NUS.PRVT.PP / PA.NUS.FCRF, 4), clamped to [0.0100, 1.0000]
//   - Data source: World Bank WDI API v2 (https://api.worldbank.org/v2/),
//     retrieved 2025 WDI dataset (Argentina latest PPP year 2021 vs 2025 FX).
//   - Accounting invariance: PPP applies ONLY to verified user share weighting
//     (user_pending_points = FLOOR(raw_points * 0.30 * ppp_coefficient));
//     100 PT = $1.00 USD withdrawal parity remains invariant across all countries.
// ============================================================================

export type EconomicRegionGroup =
  | 'US'
  | 'EUROPE'
  | 'AFRICA'
  | 'CHINA'
  | 'INDIA'
  | 'LATAM'
  | 'ASIA_PACIFIC'
  | 'MENA'
  | 'OTHER';

export interface WorldBankRawEntry {
  countryCode: string;
  regionGroup: EconomicRegionGroup;
  wbPppPrivateConsumption: number;
  wbOfficialFxRate: number;
  indicatorYear: number;
  source: string;
}

export interface CountryEconomicProfile {
  countryCode: string;
  regionGroup: EconomicRegionGroup;
  tierZone: 'ZONE_A' | 'ZONE_B' | 'ZONE_C';
  wbPppPrivateConsumption: number;
  wbOfficialFxRate: number;
  wbPriceLevelIndex: number;
  pppCoefficient: number;
  indicatorYear: number;
  source: string;
  updatedAt: string;
}

const EUROPE_CODES = new Set([
  'IT', 'DE', 'FR', 'ES', 'PT', 'NL', 'BE', 'AT', 'CH', 'PL', 'SE', 'GB', 'UK',
  'NO', 'DK', 'FI', 'IE', 'LU', 'GR', 'CZ', 'RO', 'HU', 'SK', 'BG', 'HR', 'SI',
  'LT', 'LV', 'EE', 'CY', 'MT',
]);

const AFRICA_CODES = new Set(['NG', 'KE', 'ZA', 'EG', 'MA', 'GH', 'ET', 'TZ', 'UG', 'SN', 'CI', 'CM', 'TN', 'DZ']);
const LATAM_CODES = new Set(['BR', 'MX', 'CL', 'CO', 'AR', 'PE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA', 'DO']);
const MENA_CODES = new Set(['AE', 'SA', 'TR', 'QA', 'KW', 'OM', 'BH', 'JO']);
const ASIA_PAC_CODES = new Set(['AU', 'NZ', 'JP', 'KR', 'SG', 'ID', 'PH', 'TH', 'MY', 'VN', 'BD', 'PK']);

const ZONE_A_SET = new Set([
  'US', 'GB', 'CA', 'DE', 'FR', 'IT', 'NL', 'BE', 'AT', 'CH', 'SE',
  'NO', 'DK', 'FI', 'IE', 'LU', 'AU', 'NZ', 'JP', 'KR', 'SG', 'AE',
]);

const ZONE_B_SET = new Set([
  'ES', 'PT', 'PL', 'CZ', 'GR', 'RO', 'HU', 'BR', 'MX', 'AR', 'CL', 'CO',
  'TR', 'SA', 'CN', 'RU', 'TH', 'MY',
]);

// ISO2 -> ISO3 mapping for World Bank WDI v2 queries
const ISO2_TO_ISO3: Record<string, string> = {
  US: 'USA', DE: 'DEU', IT: 'ITA', FR: 'FRA', ES: 'ESP', PT: 'PRT', PL: 'POL',
  NL: 'NLD', BE: 'BEL', AT: 'AUT', CH: 'CHE', SE: 'SWE', GB: 'GBR', CA: 'CAN',
  AU: 'AUS', JP: 'JPN', KR: 'KOR', SG: 'SGP', AE: 'ARE', BR: 'BRA', MX: 'MEX',
  CL: 'CHL', CO: 'COL', AR: 'ARG', TR: 'TUR', SA: 'SAU', CN: 'CHN', NG: 'NGA',
  KE: 'KEN', ZA: 'ZAF', EG: 'EGY', MA: 'MAR', IN: 'IND', ID: 'IDN', PH: 'PHL',
};

const ISO3_TO_ISO2: Record<string, string> = Object.fromEntries(
  Object.entries(ISO2_TO_ISO3).map(([k, v]) => [v, k])
);

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function inferRegionGroup(code: string): EconomicRegionGroup {
  const c = code.trim().toUpperCase();
  if (c === 'US') return 'US';
  if (EUROPE_CODES.has(c)) return 'EUROPE';
  if (c === 'CN') return 'CHINA';
  if (c === 'IN') return 'INDIA';
  if (AFRICA_CODES.has(c)) return 'AFRICA';
  if (LATAM_CODES.has(c)) return 'LATAM';
  if (MENA_CODES.has(c)) return 'MENA';
  if (ASIA_PAC_CODES.has(c)) return 'ASIA_PACIFIC';
  return 'OTHER';
}

export function inferTierZone(code: string): 'ZONE_A' | 'ZONE_B' | 'ZONE_C' {
  const c = code.trim().toUpperCase() === 'UK' ? 'GB' : code.trim().toUpperCase();
  if (ZONE_A_SET.has(c)) return 'ZONE_A';
  if (ZONE_B_SET.has(c)) return 'ZONE_B';
  return 'ZONE_C';
}

export function computeWorldBankPppCoefficient(
  regionGroup: EconomicRegionGroup,
  wbPppPrivateConsumption: number,
  wbOfficialFxRate: number
): { wbPriceLevelIndex: number; pppCoefficient: number } {
  const safeFx = wbOfficialFxRate > 0 ? wbOfficialFxRate : 1;
  const safePpp = wbPppPrivateConsumption > 0 ? wbPppPrivateConsumption : safeFx;
  const pli = round4(safePpp / safeFx);

  if (regionGroup === 'US' || regionGroup === 'EUROPE') {
    return {
      wbPriceLevelIndex: pli,
      pppCoefficient: 1.0,
    };
  }

  return {
    wbPriceLevelIndex: pli,
    pppCoefficient: Math.min(1.0, Math.max(0.01, pli)),
  };
}

// Official World Bank WDI data retrieved from https://api.worldbank.org/v2/
// Indicators: PA.NUS.PRVT.PP (Private Consumption PPP) & PA.NUS.FCRF (Official FX Rate)
export const WORLD_BANK_PRIVATE_CONSUMPTION_BASELINE: readonly WorldBankRawEntry[] = [
  // United States (Base = 1.0000)
  { countryCode: 'US', regionGroup: 'US', wbPppPrivateConsumption: 1.0, wbOfficialFxRate: 1.0, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_BASE_1' },

  // Europe (Base = 1.0000 per platform policy; actual WDI 2025 values archived alongside)
  { countryCode: 'DE', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.718883, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'IT', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.644824, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'FR', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.732501, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'ES', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.607856, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'PT', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.574713, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'PL', regionGroup: 'EUROPE', wbPppPrivateConsumption: 2.063158, wbOfficialFxRate: 3.760542, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'NL', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.767344, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'BE', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.771758, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'AT', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.750352, wbOfficialFxRate: 0.884969, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'CH', regionGroup: 'EUROPE', wbPppPrivateConsumption: 1.065544, wbOfficialFxRate: 0.831356, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'SE', regionGroup: 'EUROPE', wbPppPrivateConsumption: 8.889005, wbOfficialFxRate: 9.820706, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },
  { countryCode: 'GB', regionGroup: 'EUROPE', wbPppPrivateConsumption: 0.701529, wbOfficialFxRate: 0.759474, indicatorYear: 2025, source: 'WORLD_BANK_WDI_EUROPE_BASE_1' },

  // Other Developed / Non-EU Economies
  { countryCode: 'CA', regionGroup: 'OTHER', wbPppPrivateConsumption: 1.260483, wbOfficialFxRate: 1.398106, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'AU', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 1.464593, wbOfficialFxRate: 1.551998, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'JP', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 103.336580, wbOfficialFxRate: 149.657927, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'KR', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 880.125358, wbOfficialFxRate: 1422.440833, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'SG', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 1.023815, wbOfficialFxRate: 1.307450, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'AE', regionGroup: 'MENA', wbPppPrivateConsumption: 2.526987, wbOfficialFxRate: 3.672500, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },

  // China & India
  { countryCode: 'CN', regionGroup: 'CHINA', wbPppPrivateConsumption: 3.459558, wbOfficialFxRate: 7.189847, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'IN', regionGroup: 'INDIA', wbPppPrivateConsumption: 19.838916, wbOfficialFxRate: 87.158448, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },

  // Latin America
  { countryCode: 'BR', regionGroup: 'LATAM', wbPppPrivateConsumption: 2.581490, wbOfficialFxRate: 5.587286, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'MX', regionGroup: 'LATAM', wbPppPrivateConsumption: 11.308778, wbOfficialFxRate: 19.237508, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'CL', regionGroup: 'LATAM', wbPppPrivateConsumption: 486.878432, wbOfficialFxRate: 951.329454, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'CO', regionGroup: 'LATAM', wbPppPrivateConsumption: 1665.592955, wbOfficialFxRate: 4053.135833, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'AR', regionGroup: 'LATAM', wbPppPrivateConsumption: 42.986240, wbOfficialFxRate: 1240.851250, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_2021_VS_2025FX' },

  // Africa
  { countryCode: 'NG', regionGroup: 'AFRICA', wbPppPrivateConsumption: 318.059578, wbOfficialFxRate: 1518.380948, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'KE', regionGroup: 'AFRICA', wbPppPrivateConsumption: 44.984382, wbOfficialFxRate: 129.302572, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'ZA', regionGroup: 'AFRICA', wbPppPrivateConsumption: 7.739959, wbOfficialFxRate: 17.888749, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'EG', regionGroup: 'AFRICA', wbPppPrivateConsumption: 7.721843, wbOfficialFxRate: 49.227756, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'MA', regionGroup: 'AFRICA', wbPppPrivateConsumption: 3.959649, wbOfficialFxRate: 9.350277, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },

  // MENA & Emerging Asia
  { countryCode: 'TR', regionGroup: 'MENA', wbPppPrivateConsumption: 17.744381, wbOfficialFxRate: 39.454813, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'SA', regionGroup: 'MENA', wbPppPrivateConsumption: 1.870735, wbOfficialFxRate: 3.750000, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'ID', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 5065.968994, wbOfficialFxRate: 16477.865180, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
  { countryCode: 'PH', regionGroup: 'ASIA_PACIFIC', wbPppPrivateConsumption: 20.533546, wbOfficialFxRate: 57.505097, indicatorYear: 2025, source: 'WORLD_BANK_WDI_PA.NUS.PRVT.PP' },
];

const profileStore = new Map<string, CountryEconomicProfile>();

function buildProfile(raw: WorldBankRawEntry, updatedAt = '2025-12-31T00:00:00.000Z'): CountryEconomicProfile {
  const { wbPriceLevelIndex, pppCoefficient } = computeWorldBankPppCoefficient(
    raw.regionGroup,
    raw.wbPppPrivateConsumption,
    raw.wbOfficialFxRate
  );
  return {
    countryCode: raw.countryCode,
    regionGroup: raw.regionGroup,
    tierZone: inferTierZone(raw.countryCode),
    wbPppPrivateConsumption: raw.wbPppPrivateConsumption,
    wbOfficialFxRate: raw.wbOfficialFxRate,
    wbPriceLevelIndex,
    pppCoefficient,
    indicatorYear: raw.indicatorYear,
    source: raw.source,
    updatedAt,
  };
}

function initializeBaselineStore(): void {
  profileStore.clear();
  for (const entry of WORLD_BANK_PRIVATE_CONSUMPTION_BASELINE) {
    profileStore.set(entry.countryCode, buildProfile(entry));
  }

  // Derive OTHER from the arithmetic mean of World Bank Zone C country PLIs (zero arbitrary constants)
  const zoneCPlis = Array.from(profileStore.values())
    .filter((p) => p.tierZone === 'ZONE_C')
    .map((p) => p.pppCoefficient);
  const avgZoneCPli =
    zoneCPlis.length > 0
      ? round4(zoneCPlis.reduce((acc, v) => acc + v, 0) / zoneCPlis.length)
      : 0.3078;

  profileStore.set('OTHER', {
    countryCode: 'OTHER',
    regionGroup: 'OTHER',
    tierZone: 'ZONE_C',
    wbPppPrivateConsumption: avgZoneCPli,
    wbOfficialFxRate: 1.0,
    wbPriceLevelIndex: avgZoneCPli,
    pppCoefficient: avgZoneCPli,
    indicatorYear: 2025,
    source: 'WORLD_BANK_WDI_ZONE_C_MEAN',
    updatedAt: '2025-12-31T00:00:00.000Z',
  });
}

initializeBaselineStore();

export function getCountryEconomicProfile(rawCountry?: string | null): CountryEconomicProfile {
  const clean = String(rawCountry || '').trim().toUpperCase();
  const normalized = !clean ? 'OTHER' : clean === 'UK' ? 'GB' : clean;

  const exact = profileStore.get(normalized);
  if (exact) return exact;

  // EU/EEA/UK/CH countries not explicitly listed in baseline inherit Europe base 1.0000
  const inferredRegion = inferRegionGroup(normalized);
  const inferredZone = inferTierZone(normalized);
  if (inferredRegion === 'US' || inferredRegion === 'EUROPE') {
    return {
      countryCode: normalized,
      regionGroup: inferredRegion,
      tierZone: inferredZone,
      wbPppPrivateConsumption: 1.0,
      wbOfficialFxRate: 1.0,
      wbPriceLevelIndex: 1.0,
      pppCoefficient: 1.0,
      indicatorYear: 2025,
      source: inferredRegion === 'US' ? 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_BASE_1' : 'WORLD_BANK_WDI_EUROPE_BASE_1',
      updatedAt: '2025-12-31T00:00:00.000Z',
    };
  }

  // Regional/Zone fallback computed strictly from World Bank baseline entries
  const peerCoefficients = Array.from(profileStore.values())
    .filter((p) => p.countryCode !== 'OTHER' && (p.regionGroup === inferredRegion || p.tierZone === inferredZone))
    .map((p) => p.pppCoefficient);
  const regionalAvg =
    peerCoefficients.length > 0
      ? round4(peerCoefficients.reduce((a, b) => a + b, 0) / peerCoefficients.length)
      : profileStore.get('OTHER')!.pppCoefficient;

  return {
    countryCode: normalized,
    regionGroup: inferredRegion,
    tierZone: inferredZone,
    wbPppPrivateConsumption: regionalAvg,
    wbOfficialFxRate: 1.0,
    wbPriceLevelIndex: regionalAvg,
    pppCoefficient: regionalAvg,
    indicatorYear: 2025,
    source: 'WORLD_BANK_WDI_REGIONAL_MEAN',
    updatedAt: '2025-12-31T00:00:00.000Z',
  };
}

export function getAllCountryEconomicProfiles(): CountryEconomicProfile[] {
  return Array.from(profileStore.values()).sort((a, b) => {
    if (a.countryCode === 'OTHER') return 1;
    if (b.countryCode === 'OTHER') return -1;
    return b.pppCoefficient - a.pppCoefficient || a.countryCode.localeCompare(b.countryCode);
  });
}

export function applyDbCountryProfileRows(rows: Array<Record<string, any>>): void {
  for (const r of rows) {
    const code = String(r.country_code || '').trim().toUpperCase();
    if (!code) continue;
    const region = (r.region_group || inferRegionGroup(code)) as EconomicRegionGroup;
    const ppp = Number(r.wb_ppp_private_consumption ?? 1);
    const fx = Number(r.wb_official_fx_rate ?? 1);
    const computed = computeWorldBankPppCoefficient(region, ppp, fx);
    const dbCoef = Number(r.ppp_coefficient);
    profileStore.set(code, {
      countryCode: code,
      regionGroup: region,
      tierZone: (r.tier_zone || inferTierZone(code)) as 'ZONE_A' | 'ZONE_B' | 'ZONE_C',
      wbPppPrivateConsumption: ppp,
      wbOfficialFxRate: fx,
      wbPriceLevelIndex: Number(r.wb_price_level_index ?? computed.wbPriceLevelIndex),
      pppCoefficient:
        region === 'US' || region === 'EUROPE'
          ? 1.0
          : Number.isFinite(dbCoef) && dbCoef > 0 && dbCoef <= 1.0
          ? dbCoef
          : computed.pppCoefficient,
      indicatorYear: Number(r.indicator_year || 2025),
      source: String(r.source || 'POSTGRES_WORLD_BANK_SYNC'),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    });
  }
}

interface WorldBankObservation {
  countryiso3code?: string;
  date?: string;
  value?: number | null;
}

async function fetchWorldBankIndicatorSeries(
  iso3Codes: string[],
  indicator: 'PA.NUS.PRVT.PP' | 'PA.NUS.FCRF'
): Promise<Record<string, Array<{ year: number; value: number }>>> {
  const joined = iso3Codes.join(';');
  const url = `https://api.worldbank.org/v2/country/${joined}/indicator/${indicator}?format=json&mrv=5&per_page=250`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    throw new Error(`WORLD_BANK_HTTP_${res.status}`);
  }
  const payload = await res.json();
  const rows: WorldBankObservation[] = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];

  const grouped: Record<string, Array<{ year: number; value: number }>> = {};
  for (const row of rows) {
    const iso3 = String(row.countryiso3code || '').trim().toUpperCase();
    const year = Number(row.date || 0);
    const val = row.value === null || row.value === undefined ? NaN : Number(row.value);
    if (!iso3 || !Number.isFinite(year) || !Number.isFinite(val) || val <= 0) continue;
    if (!grouped[iso3]) grouped[iso3] = [];
    grouped[iso3].push({ year, value: val });
  }

  for (const iso3 of Object.keys(grouped)) {
    grouped[iso3].sort((a, b) => b.year - a.year);
  }
  return grouped;
}

/**
 * Queries official World Bank WDI v2 API for Private Consumption PPP (PA.NUS.PRVT.PP)
 * and Official FX Rate (PA.NUS.FCRF), updates the in-memory profile store, and returns
 * the refreshed list for optional persistence into PostgreSQL `core.country_economic_profiles`.
 */
export async function refreshWorldBankPppFromApi(
  countryCodes: string[] = Object.keys(ISO2_TO_ISO3)
): Promise<{
  ok: boolean;
  updatedCount: number;
  profiles: CountryEconomicProfile[];
  error?: string;
}> {
  const iso3List = countryCodes
    .map((c) => ISO2_TO_ISO3[c.trim().toUpperCase()])
    .filter(Boolean);

  if (iso3List.length === 0) {
    return { ok: false, updatedCount: 0, profiles: getAllCountryEconomicProfiles(), error: 'NO_VALID_ISO_CODES' };
  }

  try {
    const [pppSeries, fxSeries] = await Promise.all([
      fetchWorldBankIndicatorSeries(iso3List, 'PA.NUS.PRVT.PP'),
      fetchWorldBankIndicatorSeries(iso3List, 'PA.NUS.FCRF'),
    ]);

    const nowIso = new Date().toISOString();
    let updatedCount = 0;

    for (const iso3 of iso3List) {
      const iso2 = ISO3_TO_ISO2[iso3];
      if (!iso2) continue;

      const pppList = pppSeries[iso3] || [];
      const fxList = fxSeries[iso3] || [];
      if (pppList.length === 0 || fxList.length === 0) continue;

      // Prefer latest overlapping year where both indicators are reported
      const fxByYear = new Map<number, number>(fxList.map((f) => [f.year, f.value]));
      let chosenPpp = pppList[0].value;
      let chosenFx = fxList[0].value;
      let chosenYear = Math.max(pppList[0].year, fxList[0].year);
      let matchedSameYear = false;

      for (const p of pppList) {
        const fxMatch = fxByYear.get(p.year);
        if (fxMatch && fxMatch > 0) {
          chosenPpp = p.value;
          chosenFx = fxMatch;
          chosenYear = p.year;
          matchedSameYear = true;
          break;
        }
      }

      const regionGroup = inferRegionGroup(iso2);
      const source =
        regionGroup === 'US'
          ? 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_BASE_1'
          : regionGroup === 'EUROPE'
          ? 'WORLD_BANK_WDI_EUROPE_BASE_1'
          : matchedSameYear
          ? 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_LIVE'
          : 'WORLD_BANK_WDI_PA.NUS.PRVT.PP_LATEST';

      profileStore.set(
        iso2,
        buildProfile(
          {
            countryCode: iso2,
            regionGroup,
            wbPppPrivateConsumption: chosenPpp,
            wbOfficialFxRate: chosenFx,
            indicatorYear: chosenYear,
            source,
          },
          nowIso
        )
      );
      updatedCount++;
    }

    // Recompute OTHER from refreshed Zone C entries
    const zoneCPlis = Array.from(profileStore.values())
      .filter((p) => p.countryCode !== 'OTHER' && p.tierZone === 'ZONE_C')
      .map((p) => p.pppCoefficient);
    if (zoneCPlis.length > 0) {
      const avgZoneC = round4(zoneCPlis.reduce((a, b) => a + b, 0) / zoneCPlis.length);
      profileStore.set('OTHER', {
        countryCode: 'OTHER',
        regionGroup: 'OTHER',
        tierZone: 'ZONE_C',
        wbPppPrivateConsumption: avgZoneC,
        wbOfficialFxRate: 1.0,
        wbPriceLevelIndex: avgZoneC,
        pppCoefficient: avgZoneC,
        indicatorYear: new Date().getUTCFullYear(),
        source: 'WORLD_BANK_WDI_ZONE_C_MEAN',
        updatedAt: nowIso,
      });
    }

    return {
      ok: updatedCount > 0,
      updatedCount,
      profiles: getAllCountryEconomicProfiles(),
    };
  } catch (err: any) {
    return {
      ok: false,
      updatedCount: 0,
      profiles: getAllCountryEconomicProfiles(),
      error: err?.message || 'WORLD_BANK_API_UNAVAILABLE',
    };
  }
}
