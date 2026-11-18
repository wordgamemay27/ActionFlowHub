import assert from 'node:assert/strict';
import {
  SUPPORTED_LANGS,
  ENTRY_FLOW_TEXT,
  UNIFIED_SESSION_MODE,
  computeVerifiedUserSharePoints,
  localDateKey,
  shouldResetDaily,
} from '../src/lib/entryProfile';

assert.equal(SUPPORTED_LANGS.length, 14, `Expected 14 languages, got ${SUPPORTED_LANGS.length}`);

for (const lang of SUPPORTED_LANGS) {
  assert.ok(
    ENTRY_FLOW_TEXT[lang]?.langTitle && ENTRY_FLOW_TEXT[lang]?.marketTitle,
    `Missing ENTRY_FLOW_TEXT for ${lang}`
  );
}

assert.equal(UNIFIED_SESSION_MODE, 'UNIFIED_AUTO');

assert.equal(computeVerifiedUserSharePoints(1.0), 30);
assert.equal(computeVerifiedUserSharePoints(2.0), 60);
assert.equal(computeVerifiedUserSharePoints(0), 0);

const today = localDateKey(Date.now(), 'Europe/Rome');
assert.equal(shouldResetDaily(null, today), true);

console.log(
  '[verify-entry-profile] OK — 14 lingue, sessione unica UNIFIED_AUTO, quota 30% su scala 100 PT = $1.00 e reset giornaliero verificati.'
);
