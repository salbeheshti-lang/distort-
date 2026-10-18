// DISTORT — Database initialization script
// Runs on first launch to create the SQLite schema + seed data.
//
// Uses sql.js (pure JavaScript, WASM-based) instead of better-sqlite3
// (native module) to avoid the need for Visual Studio Build Tools on
// the CI runner. sql.js is slower but works everywhere without native
// compilation.
//
// This script is called from desktop/src/main.ts BEFORE spawning the
// Next.js server, so the tables exist by the time Prisma Client tries
// to connect. Prisma Client uses its own native query engine binary
// (libquery_engine-*.node) which we copy separately via
// scripts/copy-standalone.mjs — that binary is prebuilt for each
// platform and does NOT require compilation.

import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { app } from "electron";
import log from "electron-log";

const MODULE_NAME = "[db-init]";

// Load the wasm binary from node_modules/sql.js/dist/sql-wasm.wasm
// In production (packaged), it's in node_modules/sql.js/dist/sql-wasm.wasm
function getWasmPath(): string {
  const isDev = !!process.env.DISTORT_DEV;
  const candidates = isDev
    ? [
        join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        join(app.getAppPath(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      ]
    : [
        join(process.resourcesPath, "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        join(process.resourcesPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        join(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find sql-wasm.wasm");
}

export async function initDatabase(dbPath: string): Promise<void> {
  log.info(`${MODULE_NAME} Initializing database at ${dbPath}`);

  // Ensure the directory exists
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    try { mkdirSync(dbDir, { recursive: true }); } catch {}
  }

  // If the DB already exists, skip (don't overwrite user data)
  if (existsSync(dbPath)) {
    log.info(`${MODULE_NAME} Database already exists — skipping initialization`);
    return;
  }

  // Load sql.js (WASM-based SQLite)
  const wasmPath = getWasmPath();
  log.info(`${MODULE_NAME} Loading sql.js WASM from ${wasmPath}`);
  const wasmBinary = readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();

  try {
    // Create the schema (creates tables)
    const schemaPath = getResourcePath("schema.sql");
    if (!schemaPath) {
      throw new Error("Could not find schema.sql resource");
    }

    log.info(`${MODULE_NAME} Loading schema from ${schemaPath}`);
    const schemaSql = readFileSync(schemaPath, "utf-8");
    db.run(schemaSql);
    log.info(`${MODULE_NAME} Schema created successfully`);

    // Insert seed data (30 servers + admin user + subscription)
    const seedPath = getResourcePath("seed.sql");
    if (seedPath) {
      log.info(`${MODULE_NAME} Loading seed data from ${seedPath}`);
      const seedSql = readFileSync(seedPath, "utf-8");
      db.run(seedSql);
      log.info(`${MODULE_NAME} Seed data inserted (30 servers + admin user + subscription)`);
    } else {
      log.warn(`${MODULE_NAME} seed.sql not found — skipping seed data`);
    }

    // Write the database to disk
    const data = db.export();
    writeFileSync(dbPath, Buffer.from(data));
    log.info(`${MODULE_NAME} Database written to ${dbPath} (${(data.length / 1024).toFixed(1)} KB)`);

  } catch (e) {
    log.error(`${MODULE_NAME} Failed to initialize database: ${(e as Error).message}`);
    throw e;
  } finally {
    db.close();
  }
}

function getResourcePath(filename: string): string | null {
  // In development: desktop/resources/db/{filename}
  // In production (packaged): resources/db/{filename} (under process.resourcesPath)
  const isDev = !!process.env.DISTORT_DEV;

  const candidates = isDev
    ? [
        join(__dirname, "..", "resources", "db", filename),
        join(app.getAppPath(), "resources", "db", filename),
      ]
    : [
        join(process.resourcesPath, "db", filename),
        join(process.resourcesPath, "app", "resources", "db", filename),
      ];

  for (const candidate of candidates) {
    try {
      readFileSync(candidate, { flag: "r" });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}
