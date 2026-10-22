"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDatabase = initDatabase;
const sql_js_1 = __importDefault(require("sql.js"));
const fs_1 = require("fs");
const path_1 = require("path");
const electron_1 = require("electron");
const electron_log_1 = __importDefault(require("electron-log"));
const MODULE_NAME = "[db-init]";
// Load the wasm binary from node_modules/sql.js/dist/sql-wasm.wasm
// In production (packaged), it's in node_modules/sql.js/dist/sql-wasm.wasm
function getWasmPath() {
    const isDev = !!process.env.DISTORT_DEV;
    const candidates = isDev
        ? [
            (0, path_1.join)(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
            (0, path_1.join)(electron_1.app.getAppPath(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        ]
        : [
            (0, path_1.join)(process.resourcesPath, "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
            (0, path_1.join)(process.resourcesPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
            (0, path_1.join)(__dirname, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
        ];
    for (const candidate of candidates) {
        if ((0, fs_1.existsSync)(candidate))
            return candidate;
    }
    throw new Error("Could not find sql-wasm.wasm");
}
async function initDatabase(dbPath) {
    electron_log_1.default.info(`${MODULE_NAME} Initializing database at ${dbPath}`);
    // Ensure the directory exists
    const dbDir = (0, path_1.dirname)(dbPath);
    if (!(0, fs_1.existsSync)(dbDir)) {
        try {
            (0, fs_1.mkdirSync)(dbDir, { recursive: true });
        }
        catch { }
    }
    // If the DB already exists, skip (don't overwrite user data)
    if ((0, fs_1.existsSync)(dbPath)) {
        electron_log_1.default.info(`${MODULE_NAME} Database already exists — skipping initialization`);
        return;
    }
    // Load sql.js (WASM-based SQLite)
    const wasmPath = getWasmPath();
    electron_log_1.default.info(`${MODULE_NAME} Loading sql.js WASM from ${wasmPath}`);
    const wasmBinary = (0, fs_1.readFileSync)(wasmPath);
    const SQL = await (0, sql_js_1.default)({ wasmBinary });
    const db = new SQL.Database();
    try {
        // Create the schema (creates tables)
        const schemaPath = getResourcePath("schema.sql");
        if (!schemaPath) {
            throw new Error("Could not find schema.sql resource");
        }
        electron_log_1.default.info(`${MODULE_NAME} Loading schema from ${schemaPath}`);
        const schemaSql = (0, fs_1.readFileSync)(schemaPath, "utf-8");
        db.run(schemaSql);
        electron_log_1.default.info(`${MODULE_NAME} Schema created successfully`);
        // Insert seed data (30 servers + admin user + subscription)
        const seedPath = getResourcePath("seed.sql");
        if (seedPath) {
            electron_log_1.default.info(`${MODULE_NAME} Loading seed data from ${seedPath}`);
            const seedSql = (0, fs_1.readFileSync)(seedPath, "utf-8");
            db.run(seedSql);
            electron_log_1.default.info(`${MODULE_NAME} Seed data inserted (30 servers + admin user + subscription)`);
        }
        else {
            electron_log_1.default.warn(`${MODULE_NAME} seed.sql not found — skipping seed data`);
        }
        // Write the database to disk
        const data = db.export();
        (0, fs_1.writeFileSync)(dbPath, Buffer.from(data));
        electron_log_1.default.info(`${MODULE_NAME} Database written to ${dbPath} (${(data.length / 1024).toFixed(1)} KB)`);
    }
    catch (e) {
        electron_log_1.default.error(`${MODULE_NAME} Failed to initialize database: ${e.message}`);
        throw e;
    }
    finally {
        db.close();
    }
}
function getResourcePath(filename) {
    // In development: desktop/resources/db/{filename}
    // In production (packaged): resources/db/{filename} (under process.resourcesPath)
    const isDev = !!process.env.DISTORT_DEV;
    const candidates = isDev
        ? [
            (0, path_1.join)(__dirname, "..", "resources", "db", filename),
            (0, path_1.join)(electron_1.app.getAppPath(), "resources", "db", filename),
        ]
        : [
            (0, path_1.join)(process.resourcesPath, "db", filename),
            (0, path_1.join)(process.resourcesPath, "app", "resources", "db", filename),
        ];
    for (const candidate of candidates) {
        try {
            (0, fs_1.readFileSync)(candidate, { flag: "r" });
            return candidate;
        }
        catch {
            // try next
        }
    }
    return null;
}
