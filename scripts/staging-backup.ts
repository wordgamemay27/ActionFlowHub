import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

interface BackupSnapshot {
  createdAt: string;
  pgVersion: string;
  database: string;
  user: string;
  schema: string;
  tables: Record<string, { columns: string[]; rowCount: number; rows: Array<Record<string, unknown>> }>;
  appliedMigrations: Array<Record<string, unknown>>;
  sha256: string;
}

function resolveConnectionString(): string {
  const cs = (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
  if (!cs) {
    throw new Error('DATABASE_URL_UNPOOLED / DATABASE_URL non configurata');
  }
  return cs;
}

async function exportSnapshot(outPath: string) {
  const pool = new Pool({
    connectionString: resolveConnectionString(),
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const meta = await pool.query(`
      SELECT version() AS pg_version,
             current_database() AS db_name,
             current_user AS db_user
    `);
    const tblRes = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'core' AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `);

    const tables: BackupSnapshot['tables'] = {};
    for (const row of tblRes.rows) {
      const tbl = String(row.table_name);
      const colRes = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'core' AND table_name = $1
          ORDER BY ordinal_position`,
        [tbl]
      );
      const cols = colRes.rows.map((c) => String(c.column_name));
      const dataRes = await pool.query(`SELECT * FROM core."${tbl.replace(/"/g, '')}"`);
      tables[tbl] = {
        columns: cols,
        rowCount: dataRes.rows.length,
        rows: dataRes.rows,
      };
    }

    const appliedMigrations = tables.schema_migrations ? tables.schema_migrations.rows : [];
    const payloadWithoutHash = {
      createdAt: new Date().toISOString(),
      pgVersion: String(meta.rows[0].pg_version),
      database: String(meta.rows[0].db_name),
      user: String(meta.rows[0].db_user),
      schema: 'core',
      tables,
      appliedMigrations,
    };
    const sha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(payloadWithoutHash))
      .digest('hex');

    const snapshot: BackupSnapshot = { ...payloadWithoutHash, sha256 };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });

    console.log(
      JSON.stringify(
        {
          ok: true,
          action: 'BACKUP_CREATED',
          outPath: path.relative(process.cwd(), outPath),
          database: snapshot.database,
          tablesCount: Object.keys(tables).length,
          appliedMigrationsCount: appliedMigrations.length,
          totalRowsExported: Object.values(tables).reduce((s, t) => s + t.rowCount, 0),
          sha256,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

async function restoreSnapshot(inPath: string) {
  const raw = fs.readFileSync(inPath, 'utf8');
  const parsed = JSON.parse(raw) as BackupSnapshot;
  const { sha256, ...rest } = parsed;
  const computed = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  if (!sha256 || sha256 !== computed) {
    throw new Error(`BACKUP_CHECKSUM_MISMATCH: expected=${sha256} actual=${computed}`);
  }

  const pool = new Pool({
    connectionString: resolveConnectionString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tblNames = Object.keys(parsed.tables);
    if (tblNames.length > 0) {
      const quoted = tblNames.map((t) => `core."${t.replace(/"/g, '')}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    }
    for (const tbl of tblNames) {
      const info = parsed.tables[tbl];
      if (!info.rows.length || !info.columns.length) continue;
      const colSql = info.columns.map((c) => `"${c.replace(/"/g, '')}"`).join(', ');
      const paramSql = info.columns.map((_, idx) => `$${idx + 1}`).join(', ');
      for (const row of info.rows) {
        const vals = info.columns.map((c) => row[c] ?? null);
        await client.query(
          `INSERT INTO core."${tbl.replace(/"/g, '')}" (${colSql}) VALUES (${paramSql})`,
          vals
        );
      }
    }
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        ok: true,
        action: 'BACKUP_RESTORED',
        source: path.relative(process.cwd(), inPath),
        restoredTables: tblNames.length,
        sha256,
      })
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--restore') {
    if (!args[1]) throw new Error('Specifica il percorso snapshot con --restore <path>');
    await restoreSnapshot(path.resolve(process.cwd(), args[1]));
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultOut = path.resolve(process.cwd(), `.harness/staging-backup-${stamp}.json`);
  const outArg = args[0] ? path.resolve(process.cwd(), args[0]) : defaultOut;
  await exportSnapshot(outArg);
}

main().catch((err) => {
  console.error('[staging-backup] FAILED:', err?.message || err);
  process.exit(1);
});
