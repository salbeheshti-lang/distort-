import { PrismaClient } from '@prisma/client'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

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

export async function ensureMigrated(): Promise<void> {
  if (_migrated) return;
  _migrated = true;

  try {
    // Check if tables exist
    const tableExists = await db.$executeRawUnsafe(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='VpnServer' LIMIT 1`
    ).then(() => true).catch(() => false);

    if (tableExists) {
      const count = await db.vpnServer.count().catch(() => 0);
      if (count > 0) {
        console.log('[db] Already migrated —', count, 'servers');
        return;
      }
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
      console.warn('[db] schema.sql not found in any of:', possiblePaths);
      return;
    }
    console.log('[db] Found schema.sql at:', foundPath);

    // Execute each statement
    const schemaStatements = parseSql(schemaSql);
    console.log('[db] Schema statements:', schemaStatements.length);
    for (const stmt of schemaStatements) {
      try {
        await db.$executeRawUnsafe(stmt);
      } catch (e) {
        // Table might already exist — ignore
      }
    }
    console.log('[db] Schema created');

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
      console.log('[db] Seed statements:', seedStatements.length);
      for (const stmt of seedStatements) {
        try {
          await db.$executeRawUnsafe(stmt);
        } catch (e) {
          // Row might already exist — ignore
        }
      }
      console.log('[db] Seed data inserted');
    }

    // Verify
    const serverCount = await db.vpnServer.count();
    console.log('[db] Migration complete —', serverCount, 'servers in DB');
  } catch (e) {
    console.error('[db] Auto-migration failed:', (e as Error).message);
  }
}

// Run migration on module load (non-blocking)
ensureMigrated().catch(() => {});