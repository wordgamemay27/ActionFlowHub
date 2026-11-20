import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  COUNTRIES_CATALOG,
  ACCOUNTING_POINTS_PER_USD,
  ACCOUNTING_USER_SHARE_PERCENT,
  ACCOUNTING_PLATFORM_SHARE_PERCENT,
  ACCOUNTING_MIN_PAYOUT_POINTS,
  RECOVERED_ZONE_C_PPP_DEFAULT,
  ENTRY_COUNTRY_STORAGE_KEY,
  normalizeCountryCode,
  resolveCountryEconomicZone,
  resolveCountryEconomicProfile,
  getCountryPppCoefficient,
  listCountryEconomicProfiles,
  computeVerifiedPppRewardBreakdown,
  getCountryGeoEligibility,
  isProviderGeoCompatible,
  persistEntryCountry,
  readEntryCountry,
} from '../src/lib/geoEconomics';
import {
  sortProvidersByPriority,
  buildPrioritizedAutoCycleSteps,
  type CycleStepCandidate,
  type ProviderReputationSnapshot,
} from '../src/lib/providerPriority';
import { purgeLegacyAppMemory } from '../src/services/api';
import { computeVerifiedUserSharePoints } from '../src/lib/entryProfile';
import { calculateUserRewardFromGrossUsdt, calculateUsdtEquivalent } from '../src/types';
import type { VerifiedProviderItem } from '../src/components/ProviderExecutionModal';
import {
  VERIFIED_EXCHANGE_TON_PROVIDERS,
  isProviderAllowedByBlacklist,
} from '../src/lib/verifiedDirectProviders';
import { createExpressApp } from '../src/server';
import { dbPool } from '../src/db/ledgerService';
import { workers } from '../src/workers';

function testCountryZonesAndGeoSeparation() {
  // Germania -> ZONE_A, Europe PPP = 1.0000, area fornitori IT_EU
  assert.equal(normalizeCountryCode('de'), 'DE');
  assert.equal(resolveCountryEconomicZone('DE'), 'ZONE_A');
  assert.equal(getCountryGeoEligibility('DE'), 'IT_EU');
  const profDE = resolveCountryEconomicProfile('DE');
  assert.equal(profDE.pppCoefficient, 1.0);
  assert.equal(profDE.regionGroup, 'EUROPE');

  // Stati Uniti -> ZONE_A, US PPP = 1.0000, area fornitori US_UK_CA
  assert.equal(normalizeCountryCode('UK'), 'GB');
  assert.equal(resolveCountryEconomicZone('US'), 'ZONE_A');
  assert.equal(getCountryGeoEligibility('US'), 'US_UK_CA');
  const profUS = resolveCountryEconomicProfile('US');
  assert.equal(profUS.pppCoefficient, 1.0);
  assert.equal(profUS.regionGroup, 'US');
  assert.equal(resolveCountryEconomicZone('GB'), 'ZONE_A');
  assert.equal(getCountryGeoEligibility('GB'), 'US_UK_CA');
  assert.equal(getCountryPppCoefficient('GB'), 1.0);

  // Paesi intermedi & grandi mercati (Brasile / Cina / Turchia) -> ZONE_B, World Bank PPP
  assert.equal(resolveCountryEconomicZone('BR'), 'ZONE_B');
  assert.equal(getCountryGeoEligibility('BR'), 'GLOBAL');
  const profBR = resolveCountryEconomicProfile('BR');
  assert.equal(profBR.pppCoefficient, 0.4620);
  assert.equal(profBR.regionGroup, 'LATAM');

  assert.equal(resolveCountryEconomicZone('CN'), 'ZONE_B');
  assert.equal(getCountryGeoEligibility('CN'), 'GLOBAL');
  const profCN = resolveCountryEconomicProfile('CN');
  assert.equal(profCN.pppCoefficient, 0.4812);
  assert.equal(profCN.regionGroup, 'CHINA');

  assert.equal(resolveCountryEconomicZone('TR'), 'ZONE_B');
  assert.equal(getCountryGeoEligibility('TR'), 'GLOBAL');

  // India & Paesi africani (Nigeria / Kenya) -> ZONE_C, World Bank PPP
  assert.equal(resolveCountryEconomicZone('IN'), 'ZONE_C');
  assert.equal(getCountryGeoEligibility('IN'), 'GLOBAL');
  const profIN = resolveCountryEconomicProfile('IN');
  assert.equal(profIN.pppCoefficient, 0.2276);
  assert.equal(profIN.regionGroup, 'INDIA');

  assert.equal(resolveCountryEconomicZone('NG'), 'ZONE_C');
  assert.equal(getCountryGeoEligibility('NG'), 'GLOBAL');
  const profNG = resolveCountryEconomicProfile('NG');
  assert.equal(profNG.pppCoefficient, 0.2095);
  assert.equal(profNG.regionGroup, 'AFRICA');

  assert.equal(resolveCountryEconomicZone('KE'), 'ZONE_C');
  assert.equal(getCountryGeoEligibility('KE'), 'GLOBAL');
  const profKE = resolveCountryEconomicProfile('KE');
  assert.equal(profKE.pppCoefficient, 0.3479);
  assert.equal(profKE.regionGroup, 'AFRICA');

  const profOther = resolveCountryEconomicProfile('OTHER');
  assert.equal(profOther.pppCoefficient, 0.3078);
  assert.equal(profOther.tierZone, 'ZONE_C');

  // Compatibilita' offerte: mai forzare offerte regionali incompatibili
  assert.equal(isProviderGeoCompatible('GLOBAL', 'DE'), true);
  assert.equal(isProviderGeoCompatible('IT_EU', 'DE'), true);
  assert.equal(isProviderGeoCompatible('US_UK_CA', 'DE'), false);

  assert.equal(isProviderGeoCompatible('GLOBAL', 'BR'), true);
  assert.equal(isProviderGeoCompatible('IT_EU', 'BR'), false);
  assert.equal(isProviderGeoCompatible('US_UK_CA', 'BR'), false);

  assert.equal(isProviderGeoCompatible('GLOBAL', 'NG'), true);
  assert.equal(isProviderGeoCompatible('IT_EU', 'NG'), false);
  assert.equal(isProviderGeoCompatible('US_UK_CA', 'NG'), false);

  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'DE'));
  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'BR'));
  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'CN'));
  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'IN'));
  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'NG'));
  assert.ok(COUNTRIES_CATALOG.some((c) => c.code === 'KE'));
  assert.ok(listCountryEconomicProfiles().length >= 36);
}

function testPersistentCountryAcrossPurge() {
  const store = new Map<string, string>();
  const mockStorage = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      store.set(k, v);
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    },
  };

  persistEntryCountry('de', mockStorage);
  mockStorage.setItem('af_entry_categories', JSON.stringify(['videos', 'games']));
  mockStorage.setItem('af_entry_completed', '1');
  mockStorage.setItem('gf_user_lang_manual', 'de');
  mockStorage.setItem('af_user_profile_v1', 'legacy_junk');
  mockStorage.setItem('af_session_id', 'legacy_session');

  const prevWindow = (globalThis as any).window;
  (globalThis as any).window = {
    localStorage: mockStorage,
    sessionStorage: { clear: () => {} },
  };
  try {
    const purged = purgeLegacyAppMemory(true);
    assert.equal(purged, true);
    assert.equal(mockStorage.getItem(ENTRY_COUNTRY_STORAGE_KEY), 'DE');
    assert.equal(readEntryCountry(mockStorage, 'IT'), 'DE');
    assert.equal(mockStorage.getItem('af_entry_completed'), '1');
    assert.equal(mockStorage.getItem('gf_user_lang_manual'), 'de');
    assert.equal(mockStorage.getItem('af_user_profile_v1'), null);
    assert.equal(mockStorage.getItem('af_session_id'), null);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
}

function testSevenCriteriaProviderPriority() {
  const baseMock = (overrides: Partial<VerifiedProviderItem>): VerifiedProviderItem => ({
    id: 'mock',
    name: 'Mock Provider',
    brandKey: 'ton',
    categoryLabel: 'Test',
    shortDescription: 'Desc',
    userPoints: 20,
    currencies: 'USDT',
    payoutInfo: 'Min $1.00 • Settimanale',
    modalityBadge: 'S2S Diretto',
    geoRegion: 'GLOBAL',
    actionDuration: '5 min',
    directUrl: 'https://example.com',
    executionSteps: ['Step 1'],
    executionRuleNote: 'Test rule note',
    ...overrides,
  });

  const candidates: VerifiedProviderItem[] = [
    baseMock({
      id: 'locked-paypal',
      name: 'Locked PayPal',
      isLocked: true,
      geoRegion: 'GLOBAL',
      actionDuration: '1 min',
      payoutInfo: 'Istantaneo ($0 min)',
      userPoints: 500,
    }),
    baseMock({
      id: 'banned-rep',
      name: 'Banned Provider',
      geoRegion: 'GLOBAL',
      actionDuration: '1 min',
      modalityBadge: 'Web3 API Istantaneo',
      payoutInfo: 'Istantaneo ($0 min)',
      userPoints: 300,
    }),
    baseMock({
      id: 'us-only',
      name: 'US Only Provider',
      geoRegion: 'US_UK_CA',
      actionDuration: '1 min',
    }),
    baseMock({
      id: 'eu-regional-fast',
      name: 'EU Regional Fast',
      geoRegion: 'IT_EU',
      actionDuration: '1 min',
      modalityBadge: 'Web3 API Istantaneo',
      payoutInfo: 'Istantaneo ($0 min) • $20',
      userPoints: 200,
    }),
    baseMock({
      id: 'global-slow-net15',
      name: 'Global Slow Net-15',
      geoRegion: 'GLOBAL',
      actionDuration: '10 min',
      modalityBadge: 'Partner Diretto',
      payoutInfo: 'Net-15 • $5',
      userPoints: 50,
    }),
    baseMock({
      id: 'global-fast-low-completion',
      name: 'Global Fast Lower Completion',
      geoRegion: 'GLOBAL',
      actionDuration: '2 min',
      modalityBadge: 'Web3 API Istantaneo',
      payoutInfo: 'Istantaneo ($0 min) • Crypto $10',
      userPoints: 150,
    }),
    baseMock({
      id: 'global-fast-instant',
      name: 'Global Fast Instant',
      geoRegion: 'GLOBAL',
      actionDuration: '2 min',
      modalityBadge: 'Web3 API Istantaneo',
      payoutInfo: 'Istantaneo ($0 min) • Crypto $10',
      userPoints: 100,
    }),
  ];

  const reputationMap: Record<string, ProviderReputationSnapshot> = {
    'banned-rep': {
      provider_id: 'banned-rep',
      status: 'QUARANTINE',
      reputation_score: 10,
    },
    'global-fast-instant': {
      provider_id: 'global-fast-instant',
      status: 'ACTIVE',
      reputation_score: 98,
      ema_haircut_ratio: 0.99,
      completion_rate: 0.96,
      total_clicks: 250,
    },
    'global-fast-low-completion': {
      provider_id: 'global-fast-low-completion',
      status: 'WARNING',
      reputation_score: 70,
      ema_haircut_ratio: 0.85,
      completion_rate: 0.65,
      total_clicks: 120,
    },
  };

  // Utente in Germania (DE): esclude BANNED e US_UK_CA, priorita' ai GLOBAL con completion rate e ACTIVE piu alti
  const rankedDE = sortProvidersByPriority(candidates, 'DE', reputationMap, {
    excludeIncompatibleGeo: true,
  });
  assert.deepEqual(
    rankedDE.map((p) => p.id),
    [
      'global-fast-instant',
      'global-fast-low-completion',
      'global-slow-net15',
      'eu-regional-fast',
      'locked-paypal',
    ]
  );

  // Utente in Africa (NG): ottiene solo GLOBAL compatibili (mai IT_EU o US_UK_CA)
  const rankedNG = sortProvidersByPriority(candidates, 'NG', reputationMap, {
    excludeIncompatibleGeo: true,
  });
  assert.deepEqual(
    rankedNG.map((p) => p.id),
    [
      'global-fast-instant',
      'global-fast-low-completion',
      'global-slow-net15',
      'locked-paypal',
    ]
  );

  // Verifica buildPrioritizedAutoCycleSteps (esclude locked, quarantined, geo-incompatibili e popola completionRate)
  const makeTitle = (t: string) => ({
    it: t, en: t, es: t, fr: t, de: t, pt: t, ru: t, ar: t, tr: t, hi: t, zh: t, id: t, ja: t, ko: t,
  });
  const cycleCandidates: CycleStepCandidate[] = [
    {
      id: 'c_locked',
      titles: makeTitle('Locked'),
      category: 'MUSIC_HIT',
      activityCategory: 'MUSIC',
      providerId: 'locked-paypal',
      providerLabel: 'Locked',
      targetUrl: 'https://example.com/1',
      durationSec: 45,
      geoRegion: 'GLOBAL',
      isLocked: true,
    },
    {
      id: 'c_eu',
      titles: makeTitle('EU Only'),
      category: 'HIGH_PAY_VIDEO',
      activityCategory: 'VIDEO',
      providerId: 'eu-regional-fast',
      providerLabel: 'EU',
      targetUrl: 'https://example.com/eu',
      durationSec: 60,
      geoRegion: 'IT_EU',
      actionDuration: '2 min',
      modalityBadge: 'S2S Diretto',
      payoutInfo: '24 ore • $5',
      userPoints: 50,
    },
    {
      id: 'c_global_instant',
      titles: makeTitle('Global Instant'),
      category: 'HIGH_PAY_VIDEO',
      activityCategory: 'VIDEO',
      providerId: 'global-fast-instant',
      providerLabel: 'Global',
      targetUrl: 'https://example.com/global',
      durationSec: 60,
      geoRegion: 'GLOBAL',
      actionDuration: '2 min',
      modalityBadge: 'Web3 API Istantaneo',
      payoutInfo: 'Istantaneo ($0 min) • $10',
      userPoints: 100,
    },
  ];

  const playlistDE = buildPrioritizedAutoCycleSteps(cycleCandidates, ['videos'], 'DE', reputationMap);
  assert.equal(playlistDE.length, 2);
  assert.equal(playlistDE[0].id, 'c_global_instant');
  assert.equal(playlistDE[0].completionRate, 0.96);
  assert.equal(playlistDE[1].id, 'c_eu');

  const playlistNG = buildPrioritizedAutoCycleSteps(cycleCandidates, ['videos'], 'NG', reputationMap);
  assert.equal(playlistNG.length, 1);
  assert.equal(playlistNG[0].id, 'c_global_instant');

  // Nessun fallback deve mai includere provider in QUARANTINE/BANNED o in blacklist (cpx/prolific)
  const fallbackPoisoned: CycleStepCandidate[] = [
    ...cycleCandidates,
    {
      id: 'c_quarantined',
      titles: makeTitle('Quarantined'),
      category: 'HIGH_PAY_VIDEO',
      activityCategory: 'VIDEO',
      providerId: 'banned-rep',
      providerLabel: 'Quarantined Provider',
      targetUrl: 'https://example.com/q',
      durationSec: 45,
      geoRegion: 'GLOBAL',
    },
    {
      id: 'c_blacklisted_cpx',
      titles: makeTitle('Banned CPX'),
      category: 'INTERACTIVE_ACTION',
      activityCategory: 'SURVEY',
      providerId: 'cpx',
      providerLabel: 'CPX Research',
      targetUrl: 'https://www.prolific.com/',
      durationSec: 45,
      geoRegion: 'GLOBAL',
    },
  ];
  const strictReputation: Record<string, ProviderReputationSnapshot> = {
    ...reputationMap,
    'global-fast-instant': { provider_id: 'global-fast-instant', status: 'QUARANTINE', reputation_score: 0 },
  };
  const fallbackNG = buildPrioritizedAutoCycleSteps(fallbackPoisoned, ['videos'], 'NG', strictReputation);
  assert.equal(fallbackNG.some((s) => s.providerId === 'banned-rep'), false);
  assert.equal(fallbackNG.some((s) => s.providerId === 'cpx'), false);

  // Airdrop providers: NG esclude IT_EU (ex-swissborg-direct), DE li include
  const cleanAirdrops = VERIFIED_EXCHANGE_TON_PROVIDERS.filter(isProviderAllowedByBlacklist);
  const airdropsNG = sortProvidersByPriority(cleanAirdrops, 'NG', undefined, {
    excludeIncompatibleGeo: true,
    activityCategory: 'AIRDROP',
  });
  const airdropsDE = sortProvidersByPriority(cleanAirdrops, 'DE', undefined, {
    excludeIncompatibleGeo: true,
    activityCategory: 'AIRDROP',
  });
  assert.equal(airdropsNG.some((p) => p.geoRegion === 'IT_EU'), false);
  assert.ok(airdropsDE.some((p) => p.id === 'ex-swissborg-direct'));
}

function testPppRewardsMarginsAndMigrations() {
  assert.equal(ACCOUNTING_POINTS_PER_USD, 100);
  assert.equal(ACCOUNTING_USER_SHARE_PERCENT, 30);
  assert.equal(ACCOUNTING_PLATFORM_SHARE_PERCENT, 70);
  assert.equal(ACCOUNTING_MIN_PAYOUT_POINTS, 500);
  assert.equal(RECOVERED_ZONE_C_PPP_DEFAULT, 0.20);

  // $1.00 USD lordo base (PPP 1.0) -> 30 PT ($0.30) utente + 70 PT ($0.70) piattaforma
  assert.equal(computeVerifiedUserSharePoints(1.0), 30);
  assert.equal(computeVerifiedUserSharePoints(5.0), 150);
  assert.equal(calculateUserRewardFromGrossUsdt(10.0, 1.0).userPoints, 300);
  assert.equal(calculateUserRewardFromGrossUsdt(10.0, 0.2095).userPoints, 62);

  // Verifica ripartizione per i 7 Paesi benchmark su $10.00 lordo (1000 raw PT)
  const expectedBreakdowns: Array<[string, number, number]> = [
    ['DE', 300, 700],
    ['US', 300, 700],
    ['BR', 138, 862],
    ['CN', 144, 856],
    ['IN', 68, 932],
    ['NG', 62, 938],
    ['KE', 104, 896],
  ];

  for (const [country, expUser, expPlatform] of expectedBreakdowns) {
    const bd = computeVerifiedPppRewardBreakdown(10.0, country);
    assert.equal(bd.userPendingPoints, expUser, `${country} userPendingPoints`);
    assert.equal(bd.platformMarginPoints, expPlatform, `${country} platformMarginPoints`);
    assert.equal(bd.userPendingPoints + bd.platformMarginPoints, 1000, `${country} zero-sum identity`);
    assert.ok(bd.platformMarginPoints >= 700, `${country} platform margin >= 70%`);
  }

  // Verifica invariante su tutto il catalogo Paesi Banca Mondiale
  for (const prof of listCountryEconomicProfiles()) {
    const bd = computeVerifiedPppRewardBreakdown(10.0, prof.countryCode);
    assert.equal(bd.userPendingPoints + bd.platformMarginPoints, 1000);
    assert.ok(bd.platformMarginPoints >= 700, `${prof.countryCode} margin must be >= 70%`);
  }

  // Verifica che 100 PT valgano sempre $1.00 USD in prelievo indipendentemente dal Paese
  assert.equal(calculateUsdtEquivalent(500), 5.0);
  assert.equal(calculateUsdtEquivalent(100), 1.0);

  // Audit statico migrazione 011 e 012 (incrementali, mai distruttive)
  const m011 = fs.readFileSync(
    path.join(process.cwd(), 'migrations/011_geo_country_lock_and_provider_ranking.sql'),
    'utf8'
  );
  assert.ok(m011.includes('market_country_locked_at'));
  assert.ok(m011.includes('core.resolve_country_tier_zone'));
  assert.ok(m011.includes('core.v_prioritized_providers'));
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(m011), false);

  const m012 = fs.readFileSync(
    path.join(process.cwd(), 'migrations/012_worldbank_ppp_and_reward_formula.sql'),
    'utf8'
  );
  for (const symbol of [
    'core.country_economic_profiles',
    'core.get_country_ppp_coefficient',
    'FLOOR(v_raw_points * 0.30 * v_ppp_coef)',
    'platform_margin_points',
    'completion_rate',
  ]) {
    assert.ok(m012.includes(symbol), `012 missing required construct: ${symbol}`);
  }
  assert.equal(/DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+VIEW/i.test(m012), false);

  // Verifica rimozione file morti
  for (const deadFile of [
    'src/components/AdPlayerModal.tsx',
    'src/components/ProtocolProductCard.tsx',
    'src/components/Glass.tsx',
    'src/services/relay.ts',
  ]) {
    assert.equal(fs.existsSync(path.join(process.cwd(), deadFile)), false, `${deadFile} must stay deleted`);
  }
}

async function testMultiAssetFailClosed() {
  for (const asset of ['SOL', 'PI', 'USDT', 'USDC', 'CASH_AIRTM', 'CASH_PAYEER', 'CASH_VOLET'] as const) {
    const res = await workers.multiAssetPayout.dispatchApprovedPayout({
      requestId: `req_test_${asset.toLowerCase()}`,
      cryptoAsset: asset,
      destinationWallet: asset === 'PI' ? 'G' + 'A'.repeat(55) : 'test@example.com',
      amountAsset: 5.0,
      amountUsd: 5.0,
      points: 500,
    });
    assert.equal(res.ok, false, `${asset} dispatch must fail closed without DB/credentials`);
    assert.equal(res.txHash, undefined, `${asset} dispatch must never fabricate txHash`);
  }
  const maStatus = workers.multiAssetPayout.getStatus();
  assert.equal(maStatus.simulatedHashesDisabled, true);
  assert.equal(maStatus.payoutExecutionMode, 'MANUAL_EXTERNAL');
  assert.equal(maStatus.serverKeyCustodyDisabled, true);
  assert.equal(maStatus.perAssetVaultIsolationEnabled, true);
}

async function testEconomicsAndProvidersEndpoints() {
  const prevAdminToken = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'test_econ_admin_secret_12345';

  const app = createExpressApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. /api/economics/countries
    const econRes = await fetch(`${baseUrl}/api/economics/countries`);
    assert.equal(econRes.status, 200);
    const econBody = await econRes.json();
    assert.equal(econBody.ok, true);
    assert.equal(econBody.methodology, 'WORLD_BANK_WDI_PA.NUS.PRVT.PP');
    assert.equal(econBody.rules.US, 1);
    assert.equal(econBody.rules.EUROPE, 1);
    assert.ok(econBody.count >= 36);

    // 2. /api/economics/sync-worldbank auth guard
    const syncNoAuth = await fetch(`${baseUrl}/api/economics/sync-worldbank`, { method: 'POST' });
    assert.equal(syncNoAuth.status, 401);

    // 3. /api/payout/process-all auth & POSTGRES_REQUIRED check
    const procAllNoAuth = await fetch(`${baseUrl}/api/payout/process-all`, { method: 'POST' });
    assert.equal(procAllNoAuth.status, 401);
    const procAllAuth = await fetch(`${baseUrl}/api/payout/process-all`, {
      method: 'POST',
      headers: { 'X-Admin-Token': 'test_econ_admin_secret_12345' },
    });
    assert.equal(procAllAuth.status, dbPool ? 200 : 503);

    // 4. Germania (ZONE_A / EUROPE / PPP 1.0 / IT_EU)
    const resDE = await fetch(`${baseUrl}/api/providers/prioritized?country=DE`);
    assert.equal(resDE.status, 200);
    const bodyDE = await resDE.json();
    assert.equal(bodyDE.ok, true);
    assert.equal(bodyDE.country, 'DE');
    assert.equal(bodyDE.tierZone, 'ZONE_A');
    assert.equal(bodyDE.pppCoefficient, 1.0);
    assert.equal(bodyDE.regionGroup, 'EUROPE');
    assert.equal(bodyDE.geoEligibility, 'IT_EU');
    assert.ok(bodyDE.count > 10);
    assert.equal(
      bodyDE.providers.some((p: any) => p.geoRegion === 'US_UK_CA'),
      false,
      'DE must exclude US_UK_CA providers'
    );
    assert.equal(bodyDE.providers[0].noRestriction, true, 'First ranked provider must have no geo restriction');

    // 5. Stati Uniti (ZONE_A / US / PPP 1.0 / US_UK_CA)
    const resUS = await fetch(`${baseUrl}/api/providers/prioritized?country=US`);
    assert.equal(resUS.status, 200);
    const bodyUS = await resUS.json();
    assert.equal(bodyUS.tierZone, 'ZONE_A');
    assert.equal(bodyUS.pppCoefficient, 1.0);
    assert.equal(bodyUS.regionGroup, 'US');
    assert.equal(bodyUS.geoEligibility, 'US_UK_CA');
    assert.equal(
      bodyUS.providers.some((p: any) => p.geoRegion === 'IT_EU'),
      false,
      'US must exclude IT_EU providers'
    );

    // 6. Brasile, Cina, India, Nigeria, Kenya -> rispettivi PPP Banca Mondiale e solo GLOBAL
    const expectedCountryApi: Array<[string, string, number]> = [
      ['BR', 'ZONE_B', 0.4620],
      ['CN', 'ZONE_B', 0.4812],
      ['IN', 'ZONE_C', 0.2276],
      ['NG', 'ZONE_C', 0.2095],
      ['KE', 'ZONE_C', 0.3479],
    ];
    for (const [country, zone, ppp] of expectedCountryApi) {
      const r = await fetch(`${baseUrl}/api/providers/prioritized?country=${country}`);
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.tierZone, zone);
      assert.equal(b.pppCoefficient, ppp);
      assert.equal(b.geoEligibility, 'GLOBAL');
      assert.ok(b.providers.every((p: any) => p.geoRegion === 'GLOBAL'));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prevAdminToken;
  }
}

async function main() {
  try {
    testCountryZonesAndGeoSeparation();
    testPersistentCountryAcrossPurge();
    testSevenCriteriaProviderPriority();
    testPppRewardsMarginsAndMigrations();
    await testMultiAssetFailClosed();
    await testEconomicsAndProvidersEndpoints();
    console.log(
      '[verify-economics] OK — 7 Paesi benchmark (DE, US, BR, CN, IN, NG, KE), PPP Banca Mondiale, margini >=70%, 7 criteri priorita, multi-asset fail-closed e migrazione 012 verificati.'
    );
  } finally {
    if (dbPool) {
      await dbPool.end();
    }
  }
}

main().catch((err) => {
  console.error('[verify-economics] FAILED:', err);
  process.exit(1);
});
