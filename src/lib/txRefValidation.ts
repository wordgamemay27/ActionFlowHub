// ============================================================================
// VALIDAZIONE RIFERIMENTI TRANSAZIONE / RICEVUTE REALI (Condivisa Server & UI)
// ============================================================================

const BLOCKED_FAKE_PREFIXES = [
  'sim_',
  'fake_',
  'mock_',
  'test_',
  'demo_',
  ['tx', 'confirmed', ''].join('_'),
  ['tx', 'onchain', ''].join('_'),
];

export function isObviouslyFakeTxReference(value: string, minLength = 8): boolean {
  const clean = String(value || '').trim().toLowerCase();
  if (clean.length < minLength) return true;
  return BLOCKED_FAKE_PREFIXES.some((prefix) => clean.startsWith(prefix));
}
