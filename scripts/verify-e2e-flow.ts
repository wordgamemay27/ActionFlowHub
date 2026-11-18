import assert from 'node:assert/strict';
import { SUPPORTED_LANGS } from '../src/lib/i18n';
import { UNIFIED_SESSION_MODE, computeVerifiedUserSharePoints } from '../src/lib/entryProfile';
import { PROJECTS_CATALOG, GLOBAL_CRYPTO_BRAND_CARDS } from '../src/lib/catalogData';
import { resolveCanonicalProviderId } from '../src/lib/affiliate';

assert.equal(SUPPORTED_LANGS.length, 14, `Expected 14 languages, found ${SUPPORTED_LANGS.length}`);
assert.equal(UNIFIED_SESSION_MODE, 'UNIFIED_AUTO');
assert.equal(computeVerifiedUserSharePoints(1.0), 30);
assert.equal(resolveCanonicalProviderId('soap-reelshort', 'MICRO_DRAMA'), 'reelshort');
assert.equal(resolveCanonicalProviderId('internal_relay', 'OTHER'), 'internal_relay');
assert.ok(PROJECTS_CATALOG.length > 0);
assert.ok(GLOBAL_CRYPTO_BRAND_CARDS.length > 0);

console.log(
  `[verify-e2e-flow] OK — ${SUPPORTED_LANGS.length} lingue, sessione ${UNIFIED_SESSION_MODE}, ${PROJECTS_CATALOG.length} progetti catalogo, ${GLOBAL_CRYPTO_BRAND_CARDS.length} crypto brand cards.`
);
