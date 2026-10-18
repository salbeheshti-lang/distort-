// DISTORT — Local config store
//
// Stores imported configs in the browser so the Emergency engine can use
// them offline (e.g. national internet scenario where the Distort API
// is unreachable but the user has previously imported configs).
//
// SECURITY: configs contain credentials (UUIDs, passwords, keys). We do
// NOT encrypt them with a user password (that would require a master
// password UX). Instead:
//   - Store in IndexedDB (more persistent than localStorage, larger quota)
//   - Never expose the raw configUri in logs (use scrubSensitive before logging)
//   - Provide a "wipe all" function for privacy
//   - Mark each config with import timestamp for expiry rotation
//
// For the desktop / Android apps, configs should be stored in the OS
// keychain (Windows Credential Manager, Android Keystore) — that's a
// Phase 3 concern.

const DB_NAME = "distort-emergency";
const DB_VERSION = 1;
const STORE_NAME = "configs";

export type StoredConfig = {
  // Unique id (generated client-side)
  id: string;
  // The raw URI (vless://, vmess://, trojan://, ss://) — contains credentials
  uri: string;
  // Display label (from parser or user-provided)
  label: string;
  // Protocol (vless/vmess/trojan/ss)
  protocol: string;
  // Host + port (for display — NO credentials)
  host: string;
  port: number;
  // Anti-DPI score (0..100)
  score: number;
  // Flags (e.g. ["Reality", "gRPC", "SNI"])
  flags: string[];
  // Country (if known)
  country: string | null;
  // Whether this config has been verified to work (client-side probe result)
  lastVerifiedAt: string | null; // ISO
  // Success streak (consecutive successful verifications)
  successStreak: number;
  // Failure streak (consecutive failures — resets on success)
  failureStreak: number;
  // When this config was imported
  importedAt: string; // ISO
  // Whether the user marked it as favorite
  favorite: boolean;
};

// Open the IndexedDB. Returns a promise.
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("protocol", "protocol", { unique: false });
        store.createIndex("favorite", "favorite", { unique: false });
        store.createIndex("importedAt", "importedAt", { unique: false });
      }
    };
  });
}

function genId(): string {
  return `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Add a config to the store. Deduplicates by URI.
export async function addConfig(config: Omit<StoredConfig, "id" | "importedAt" | "successStreak" | "failureStreak" | "lastVerifiedAt" | "favorite"> & { favorite?: boolean }): Promise<StoredConfig> {
  const db = await openDB();
  // Check for existing config with same URI
  const existing = await getAllConfigs();
  const dup = existing.find((c) => c.uri === config.uri);
  if (dup) {
    // Update the existing one instead of duplicating
    return dup;
  }
  const now = new Date().toISOString();
  const stored: StoredConfig = {
    id: genId(),
    uri: config.uri,
    label: config.label,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    score: config.score,
    flags: config.flags,
    country: config.country,
    lastVerifiedAt: null,
    successStreak: 0,
    failureStreak: 0,
    importedAt: now,
    favorite: config.favorite ?? false,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(stored);
    req.onsuccess = () => resolve(stored);
    req.onerror = () => reject(req.error);
  });
}

// Get all stored configs.
export async function getAllConfigs(): Promise<StoredConfig[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as StoredConfig[]);
    req.onerror = () => reject(req.error);
  });
}

// Get favorite configs only.
export async function getFavoriteConfigs(): Promise<StoredConfig[]> {
  const all = await getAllConfigs();
  return all.filter((c) => c.favorite);
}

// Update a config (e.g. after probing — update successStreak, lastVerifiedAt).
export async function updateConfig(id: string, patch: Partial<StoredConfig>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredConfig | undefined;
      if (!existing) {
        reject(new Error("Config not found"));
        return;
      }
      const updated = { ...existing, ...patch };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// Mark a config as verified (success) — increments streak, sets timestamp.
export async function markVerified(id: string): Promise<void> {
  const all = await getAllConfigs();
  const cfg = all.find((c) => c.id === id);
  if (!cfg) return;
  await updateConfig(id, {
    lastVerifiedAt: new Date().toISOString(),
    successStreak: cfg.successStreak + 1,
    failureStreak: 0, // reset
  });
}

// Mark a config as failed — increments failure streak.
export async function markFailed(id: string): Promise<void> {
  const all = await getAllConfigs();
  const cfg = all.find((c) => c.id === id);
  if (!cfg) return;
  await updateConfig(id, {
    failureStreak: cfg.failureStreak + 1,
  });
}

// Toggle favorite.
export async function toggleFavorite(id: string): Promise<void> {
  const all = await getAllConfigs();
  const cfg = all.find((c) => c.id === id);
  if (!cfg) return;
  await updateConfig(id, { favorite: !cfg.favorite });
}

// Delete a config.
export async function deleteConfig(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Wipe ALL stored configs (privacy / reset).
export async function wipeAllConfigs(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Convert a StoredConfig to a CandidatePath (for the recovery engine).
// This is the bridge between local storage and the planner.
export function toCandidate(cfg: StoredConfig): {
  id: string;
  label: string;
  protocol: string;
  host: string;
  port: number;
  stealth: boolean;
  antiDpiScore: number;
  exitCountry: string | null;
  vipOnly: boolean;
  configUri: string;
  successStreak: number;
  failureStreak: number;
  lastTriedAt: string | null;
} {
  const stealth = cfg.flags.some((f) =>
    ["Reality", "TLS", "SNI", "Vision"].includes(f)
  );
  return {
    id: cfg.id,
    label: cfg.label,
    protocol: cfg.protocol,
    host: cfg.host,
    port: cfg.port,
    stealth,
    antiDpiScore: cfg.score,
    exitCountry: cfg.country,
    vipOnly: false,
    configUri: cfg.uri,
    successStreak: cfg.successStreak,
    failureStreak: cfg.failureStreak,
    lastTriedAt: cfg.lastVerifiedAt,
  };
}
