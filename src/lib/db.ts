import { PrismaClient } from '@prisma/client'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Ensure DATABASE_URL is set (CI/build environments may not have it)
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:/tmp/distort.db'
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---------------------------------------------------------------------------
// Auto-migrate: create tables + seed data if they don't exist.
//
// HONEST ROBUSTNESS CONTRACT:
//   1. We only set the `_migrated` flag once BOTH `VpnServer.count() > 0` AND
//      `UserSetting.count() > 0` are true. If either is zero (e.g. seed.sql
//      was missing, or failed mid-way) we leave `_migrated = false` so the
//      NEXT launch retries the migration from scratch.
//   2. If `schema.sql` is not found at ANY of the candidate paths, we log a
//      clear error and STILL set `_migrated = true` to avoid an infinite
//      retry loop in dev mode (the developer must fix the file layout
//      manually — re-running migration won't help if the file is missing).
//   3. Each SQL statement is wrapped in its own try/catch. Failed statements
//      are logged with the first 80 chars of the statement + the error
//      message so we can diagnose corruption / partial seeds without having
//      to enable Prisma's verbose query log.
// ---------------------------------------------------------------------------

let _migrated = false;

// Strip SQL comments and split into individual statements
function parseSql(sql: string): string[] {
  // Remove single-line comments (-- ...)
  const lines = sql.split('\n').filter(line => !line.trim().startsWith('--'));
  const cleaned = lines.join('\n');
  // Split by semicolon, filter empty
  return cleaned
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

async function runStatements(statements: string[], tag: string): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const stmt of statements) {
    try {
      await db.$executeRawUnsafe(stmt);
      ok++;
    } catch (e) {
      failed++;
      const msg = (e as Error)?.message ?? String(e);
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
      console.error(`[db] ${tag} statement failed: "${preview}…" → ${msg}`);
    }
  }
  return { ok, failed };
}

export async function ensureMigrated(): Promise<void> {
  if (_migrated) return;

  try {
    // Check if tables exist
    const tableExists = await db.$executeRawUnsafe(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='VpnServer' LIMIT 1`
    ).then(() => true).catch(() => false);

    if (tableExists) {
      const count = await db.vpnServer.count().catch(() => 0);
      const userSettingCount = await db.userSetting.count().catch(() => 0);
      if (count > 0 && userSettingCount > 0) {
        console.log(`[db] Already migrated — ${count} servers, ${userSettingCount} settings`);
        _migrated = true;
        return;
      }
      // Tables exist but seed data is incomplete — fall through and try to
      // re-run schema + seed to repair the partial state.
      console.warn(`[db] Tables exist but data incomplete (servers=${count}, settings=${userSettingCount}) — re-running migration`);
    }

    console.log('[db] Running auto-migration...');

    // Find schema.sql
    const possiblePaths = [
      join(process.resourcesPath || '', 'db', 'schema.sql'),
      join(process.resourcesPath || '', 'app', 'resources', 'db', 'schema.sql'),
      join(process.cwd(), 'resources', 'db', 'schema.sql'),
      join(process.cwd(), 'desktop', 'resources', 'db', 'schema.sql'),
      join(__dirname, 'resources', 'db', 'schema.sql'),
      join(__dirname, '..', 'resources', 'db', 'schema.sql'),
    ];

    let schemaSql = '';
    let foundPath = '';
    for (const p of possiblePaths) {
      try {
        if (existsSync(p)) {
          schemaSql = readFileSync(p, 'utf-8');
          foundPath = p;
          break;
        }
      } catch {}
    }

    if (!schemaSql) {
      // IMPORTANT: schema.sql missing — don't retry forever in dev mode.
      // Set _migrated = true to avoid an infinite retry loop on every
      // request that touches the DB. The developer must fix the file layout.
      console.error('[db] schema.sql not found in any of:', possiblePaths);
      console.error('[db] Skipping migration and marking as migrated to avoid retry loop.');
      _migrated = true;
      return;
    }
    console.log('[db] Found schema.sql at:', foundPath);

    // Execute each statement
    const schemaStatements = parseSql(schemaSql);
    console.log(`[db] Schema statements: ${schemaStatements.length}`);
    const schemaResult = await runStatements(schemaStatements, 'schema');
    console.log(`[db] Schema applied — ok=${schemaResult.ok}, failed=${schemaResult.failed}`);

    // Find + execute seed.sql
    const seedPath = foundPath.replace('schema.sql', 'seed.sql');
    let seedSql = '';
    try {
      if (existsSync(seedPath)) {
        seedSql = readFileSync(seedPath, 'utf-8');
        console.log('[db] Found seed.sql at:', seedPath);
      }
    } catch {}

    if (seedSql) {
      const seedStatements = parseSql(seedSql);
      console.log(`[db] Seed statements: ${seedStatements.length}`);
      const seedResult = await runStatements(seedStatements, 'seed');
      console.log(`[db] Seed applied — ok=${seedResult.ok}, failed=${seedResult.failed}`);
    } else {
      console.warn(`[db] seed.sql NOT found at ${seedPath} — DB will have tables but no data`);
    }

    // VERIFY: both VpnServer AND UserSetting must have rows. If either is 0,
    // the migration is incomplete — log the error and DON'T set _migrated so
    // the next launch retries.
    const serverCount = await db.vpnServer.count().catch(() => 0);
    const userSettingCount = await db.userSetting.count().catch(() => 0);

    if (serverCount > 0 && userSettingCount > 0) {
      console.log(`[db] Migration complete — ${serverCount} servers, ${userSettingCount} settings`);
      _migrated = true;
    } else {
      // INCOMPLETE — leave _migrated = false so we retry next launch.
      console.error(
        `[db] Migration INCOMPLETE — VpnServer.count=${serverCount}, UserSetting.count=${userSettingCount}. ` +
        `Leaving _migrated=false so the next launch retries. ` +
        `Check the failed-statement logs above to diagnose.`
      );
    }
  } catch (e) {
    console.error('[db] Auto-migration failed:', (e as Error).message);
    // Don't set _migrated — retry on next launch.
  }
}

// Run migration on module load (non-blocking)
ensureMigrated().catch(() => {});
