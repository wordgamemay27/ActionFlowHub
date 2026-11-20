import assert from 'node:assert/strict';
import {
  inspectMigrationFiles,
  verifyAppliedMigrationChecksums,
} from '../src/db/ledgerService';

function main() {
  const manifest = inspectMigrationFiles();
  assert.equal(manifest.ok, true, `Manifest invalid: ${manifest.errors.join(', ')}`);
  assert.ok(manifest.files.length >= 19, `Expected >= 19 migrations, found ${manifest.files.length}`);

  // Verify strict monotonic ordering
  for (let i = 1; i < manifest.files.length; i++) {
    assert.ok(
      manifest.files[i].prefixNum > manifest.files[i - 1].prefixNum,
      `Non-monotonic migration sequence: ${manifest.files[i - 1].filename} -> ${manifest.files[i].filename}`
    );
  }

  // Verify legacy NULL checksum backfill & tamper detection
  const firstTwo = manifest.files.slice(0, 2);
  const planBackfill = verifyAppliedMigrationChecksums(
    [
      { filename: firstTwo[0].filename, checksum_sha256: firstTwo[0].sha256 },
      { filename: firstTwo[1].filename, checksum_sha256: null },
    ],
    manifest.files
  );
  assert.equal(planBackfill.skipped.length, 2);
  assert.equal(planBackfill.toBackfillChecksum.length, 1);
  assert.equal(planBackfill.toBackfillChecksum[0].filename, firstTwo[1].filename);
  assert.equal(planBackfill.toApply.length, manifest.files.length - 2);

  assert.throws(
    () =>
      verifyAppliedMigrationChecksums(
        [{ filename: firstTwo[0].filename, checksum_sha256: '0'.repeat(64) }],
        manifest.files
      ),
    /MIGRATION_CHECKSUM_MISMATCH/,
    'Tampered migration checksum must throw MIGRATION_CHECKSUM_MISMATCH'
  );

  console.log(
    JSON.stringify({
      ok: true,
      totalMigrations: manifest.files.length,
      range: `${manifest.files[0].migrationId}-${manifest.files[manifest.files.length - 1].migrationId}`,
      files: manifest.files.map((f) => ({
        id: f.migrationId,
        filename: f.filename,
        sha256: f.sha256,
        transactional: f.hasTransactionWrapper,
        bytes: f.bytes,
      })),
    }, null, 2)
  );
}

main();
