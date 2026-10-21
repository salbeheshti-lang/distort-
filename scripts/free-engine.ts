// HONEST LIMITATION: This script probes configs from GitHub Actions runners
// (US/EU datacenters). A config that's reachable from GitHub may STILL be
// blocked by Iran's DPI. The in-app connection flow (Quick Connect with
// failover) is the FINAL authority — it tries each config via xray and
// keeps the first one that actually tunnels traffic.
//
// =============================================================================
// DISTORT — Free Engine (scheduled config gatherer + prober)
// =============================================================================
//
// What it does:
//   1. Fetches N public Iran/general config-collector subscriptions.
//   2. Parses ALL lines with `parseSubscription` from src/lib/config-parser.ts
//      (handles vmess/vless/trojan/ss). Dedupes by `protocol:host:port`.
//   3. For each config, does a TCP connect probe (5s timeout) from the GitHub
//      Actions runner. Records `ok`/`fail` + `latencyMs`.
//   4. Sorts by: reachable first, then by latency asc, then by score desc
//      (TLS/Reality/WS configs get higher score).
//   5. Writes `best.txt`  — top 50 reachable configs (one URI per line).
//   6. Writes `all.txt`   — ALL parsed configs, reachable first.
//   7. Writes `status.json` — metadata about this run.
//
// Outputs are written to `public/free-engine/` so the desktop app can fetch
// them via the GitHub raw URL:
//   https://raw.githubusercontent.com/salbeheshti-lang/distort-/main/public/free-engine/best.txt
//
// Run locally:
//   bun run scripts/free-engine.ts
//
// Run in CI: see .github/workflows/free-engine.yml
//
// EXIT CODE: 0 even if some sources fail (partial success is better than no
// update). The desktop app has its own in-app xray connection test that's the
// final authority.

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  parseSubscription,
  type ParsedConfig,
} from "../src/lib/config-parser";

// NOTE: We do NOT import `probeReachability` from src/lib/anti-censor.ts here.
// That function has a hardcoded 5s timeout, which is too long for probing
// 7000+ configs in CI. We define a local `probeOne` with a configurable
// 3s timeout that's plenty for any reachable host's TCP handshake.

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

// Public config-collector subscriptions. Order matters — earlier sources get
// priority when deduping (parseSubscription dedupes within a single batch,
// we dedupe again across sources in this script).
//
// All verified to return HTTP 200 with raw text content of config URIs.
const SOURCES: { url: string; label: string; primary?: boolean }[] = [
  {
    url: "https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt",
    label: "Iran Config Collector (Milad Tahanian)",
    primary: true,
  },
  {
    url: "https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt",
    label: "Epodonios V2Ray Configs (All)",
  },
  {
    url: "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    label: "V2RayAggregator (merged sub)",
  },
];

const FETCH_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 50;
const PROBE_TIMEOUT_MS = 3_000;
// Cap the number of configs probed — keeps total runtime under 8 minutes even
// on a slow GitHub Actions runner. We probe the TOP-scoring configs first
// (TLS/Reality/WS get higher scores), so the most-likely-to-work-in-Iran
// configs are always tested. Lower-scoring configs (e.g., plaintext TCP) are
// unlikely to bypass DPI anyway and are included untested in all.txt as a
// fallback.
const MAX_PROBES = 2000;
const BEST_LIST_LIMIT = 50;

// Output directory. Defaults to <repo-root>/public/free-engine/.
// Can be overridden with the FREE_ENGINE_OUT_DIR env var (used by tests).
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.FREE_ENGINE_OUT_DIR
  ? resolve(process.env.FREE_ENGINE_OUT_DIR)
  : resolve(__dirname, "..", "public", "free-engine");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type SourceResult = {
  url: string;
  label: string;
  fetched: boolean;
  fetchedCount: number; // raw lines fetched
  parsedCount: number; // lines that parsed to a valid config
  error?: string;
  durationMs: number;
};

type ProbeResult = {
  config: ParsedConfig;
  ok: boolean;
  latencyMs: number;
};

type StatusFile = {
  generatedAt: string; // ISO 8601
  generatedAtEpoch: number;
  sources: SourceResult[];
  totalParsed: number;
  totalProbed: number;     // how many we actually TCP-probed (capped at MAX_PROBES)
  totalReachable: number;
  totalUnreachable: number;
  totalUntested: number;   // not probed (low-score, beyond MAX_PROBES cap)
  bestConfigLatencyMs: number | null;
  avgLatencyMs: number | null;
  bestListSize: number;
  allListSize: number;
  note: string;
};

// -----------------------------------------------------------------------------
// Fetchers
// -----------------------------------------------------------------------------

async function fetchSource(url: string, label: string): Promise<SourceResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "DISTORT-Free-Engine/1.0 (+https://distort.app)" },
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        url, label, fetched: false, fetchedCount: 0, parsedCount: 0,
        error: `HTTP ${res.status} ${res.statusText}`,
        durationMs: Date.now() - start,
      };
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const parsed = parseSubscription(text);
    console.log(`[free-engine] ✓ ${label} — ${lines.length} lines, ${parsed.length} parsed`);
    return {
      url, label, fetched: true,
      fetchedCount: lines.length, parsedCount: parsed.length,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(`[free-engine] ✗ ${label} — ${msg}`);
    return {
      url, label, fetched: false, fetchedCount: 0, parsedCount: 0,
      error: msg, durationMs: Date.now() - start,
    };
  }
}

// Fetch a source AND return its parsed configs (separate from the metadata).
async function fetchSourceConfigs(url: string): Promise<ParsedConfig[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "DISTORT-Free-Engine/1.0 (+https://distort.app)" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return parseSubscription(text);
}

// -----------------------------------------------------------------------------
// Prober (TCP connect only — see HONEST LIMITATION above)
// -----------------------------------------------------------------------------

// Local TCP-connect probe. Uses Node's `net` module (the same primitive as
// src/lib/anti-censor.ts:probeReachability, but with our own 3s timeout).
async function probeOne(config: ParsedConfig): Promise<ProbeResult> {
  if (!config.host || !config.port || config.port <= 0 || config.port > 65535) {
    return { config, ok: false, latencyMs: 0 };
  }
  const start = Date.now();
  try {
    const net = await import("net");
    const ok = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const t = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, PROBE_TIMEOUT_MS);
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(t);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(t);
        resolve(false);
      });
      socket.connect(config.port, config.host);
    });
    return { config, ok, latencyMs: Date.now() - start };
  } catch {
    return { config, ok: false, latencyMs: Date.now() - start };
  }
}

// Probe a list with bounded concurrency. Returns immediately-failed probes
// with latencyMs=0.
async function probeAll(configs: ParsedConfig[]): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(configs.length);
  let cursor = 0;
  let completed = 0;
  const total = configs.length;

  async function worker(workerId: number) {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      results[i] = await probeOne(configs[i]);
      completed++;
      if (completed % 25 === 0 || completed === total) {
        console.log(`[free-engine] probed ${completed}/${total} (worker ${workerId})`);
      }
    }
  }

  const workers = Array.from({ length: PROBE_CONCURRENCY }, (_, k) => worker(k + 1));
  await Promise.all(workers);
  return results;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const runStart = Date.now();
  console.log("[free-engine] ============================================");
  console.log(`[free-engine] run started at ${new Date(runStart).toISOString()}`);
  console.log(`[free-engine] output dir: ${OUT_DIR}`);
  console.log(`[free-engine] sources (${SOURCES.length}):`);
  for (const s of SOURCES) console.log(`[free-engine]   - ${s.label} (${s.url})`);

  // 1. Fetch all sources in parallel.
  console.log("[free-engine] fetching sources in parallel…");
  const sourceResults: SourceResult[] = [];
  const allConfigsBySource: ParsedConfig[][] = [];
  await Promise.all(
    SOURCES.map(async (src) => {
      const meta = await fetchSource(src.url, src.label);
      sourceResults.push(meta);
      if (meta.fetched) {
        try {
          const configs = await fetchSourceConfigs(src.url);
          allConfigsBySource.push(configs);
        } catch (e) {
          // Shouldn't happen — fetchSource already verified the URL. But be defensive.
          console.warn(`[free-engine] re-fetch failed for ${src.label}: ${(e as Error).message}`);
          allConfigsBySource.push([]);
        }
      } else {
        allConfigsBySource.push([]);
      }
    })
  );

  // 2. Merge + cross-source dedupe (parseSubscription already dedupes within
  //    each source by `protocol:host:port` — here we dedupe again across
  //    sources, preferring the FIRST source that produced a given key).
  const seen = new Set<string>();
  const allConfigs: ParsedConfig[] = [];
  for (const configs of allConfigsBySource) {
    for (const c of configs) {
      const k = `${c.protocol}:${c.host}:${c.port}`;
      if (seen.has(k)) continue;
      seen.add(k);
      allConfigs.push(c);
    }
  }
  console.log(`[free-engine] merged ${allConfigs.length} unique configs from ${SOURCES.length} sources`);

  if (allConfigs.length === 0) {
    console.error("[free-engine] FATAL: no configs parsed from any source. Aborting.");
    // Still write a status.json so the desktop app knows the run happened.
    const status: StatusFile = {
      generatedAt: new Date().toISOString(),
      generatedAtEpoch: Date.now(),
      sources: sourceResults,
      totalParsed: 0,
      totalProbed: 0,
      totalReachable: 0,
      totalUnreachable: 0,
      totalUntested: 0,
      bestConfigLatencyMs: null,
      avgLatencyMs: null,
      bestListSize: 0,
      allListSize: 0,
      note: "No configs parsed from any source. All sources failed or returned empty content.",
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2));
    writeFileSync(join(OUT_DIR, "best.txt"), "");
    writeFileSync(join(OUT_DIR, "all.txt"), "");
    console.log("[free-engine] wrote empty best.txt + all.txt + status.json (no configs)");
    // Exit 0 — don't fail the CI workflow. The desktop app's failover chain
    // handles an empty best.txt by falling back to all.txt → DB → mixed_iran.txt.
    process.exit(0);
  }

  // 3. Probe configs (TCP connect only — see HONEST LIMITATION).
  //    Cap the probe at MAX_PROBES (2000) so the script completes in <8 min
  //    even with 7000+ unique configs. Probe the TOP-scoring configs first
  //    (TLS/Reality/WS get higher scores — they're most likely to work in
  //    Iran). Untested configs are still included in all.txt as a fallback.
  const sortedForProbe = [...allConfigs].sort((a, b) => b.score - a.score);
  const toProbe = sortedForProbe.slice(0, MAX_PROBES);
  const skipped = sortedForProbe.slice(MAX_PROBES);
  console.log(
    `[free-engine] probing ${toProbe.length} configs ` +
    `(capped at MAX_PROBES=${MAX_PROBES}, concurrency=${PROBE_CONCURRENCY}, timeout=${PROBE_TIMEOUT_MS}ms) ` +
    `— ${skipped.length} low-score configs skipped (still included untested in all.txt)`
  );
  const probeResults = await probeAll(toProbe);

  // 4. Sort: reachable first, then by latency asc, then by score desc.
  //    Ties broken by protocol preference (vless > vmess > trojan > ss).
  const protoRank: Record<string, number> = { vless: 0, vmess: 1, trojan: 2, ss: 3, unknown: 4 };
  probeResults.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok) {
      // Reachable — sort by latency asc, then score desc.
      if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
      if (b.config.score !== a.config.score) return b.config.score - a.config.score;
    } else {
      // Unreachable — keep the higher-scoring configs first (they're more
      // likely to work via xray Reality even when TCP fails).
      if (b.config.score !== a.config.score) return b.config.score - a.config.score;
    }
    return (protoRank[a.config.protocol] ?? 9) - (protoRank[b.config.protocol] ?? 9);
  });

  // 5. Build output lists.
  const reachable = probeResults.filter((r) => r.ok);
  const unreachable = probeResults.filter((r) => !r.ok);
  console.log(
    `[free-engine] reachable: ${reachable.length}, unreachable: ${unreachable.length} ` +
    `(of ${toProbe.length} probed; ${skipped.length} untested)`
  );

  const bestList = reachable.slice(0, BEST_LIST_LIMIT).map((r) => r.config.raw);
  // all.txt = reachable (sorted) → unreachable (sorted) → untested (sorted by score desc).
  // This way the desktop app's failover loop sees the most-likely-to-work
  // configs first, even if they weren't probed.
  const allList = [
    ...probeResults.map((r) => r.config.raw), // reachable + unreachable, sorted
    ...skipped.map((c) => c.raw),              // untested, sorted by score desc
  ];

  // 6. Build status.json metadata.
  const reachableLatencies = reachable.map((r) => r.latencyMs).filter((ms) => ms > 0);
  const bestLatency = reachable.length > 0 ? reachable[0].latencyMs : null;
  const avgLatency = reachableLatencies.length > 0
    ? Math.round(reachableLatencies.reduce((a, b) => a + b, 0) / reachableLatencies.length)
    : null;

  const status: StatusFile = {
    generatedAt: new Date().toISOString(),
    generatedAtEpoch: Date.now(),
    sources: sourceResults,
    totalParsed: allConfigs.length,
    totalProbed: toProbe.length,
    totalReachable: reachable.length,
    totalUnreachable: unreachable.length,
    totalUntested: skipped.length,
    bestConfigLatencyMs: bestLatency,
    avgLatencyMs: avgLatency,
    bestListSize: bestList.length,
    allListSize: allList.length,
    note: "Generated by GitHub Actions scheduled run. Reachability is probed from GitHub's US/EU datacenters — a config marked reachable here may STILL be blocked by Iran's DPI. The desktop app does its own in-app xray connection test as the final authority.",
  };

  // 7. Write outputs.
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "best.txt"), bestList.join("\n") + (bestList.length > 0 ? "\n" : ""));
  writeFileSync(join(OUT_DIR, "all.txt"), allList.join("\n") + (allList.length > 0 ? "\n" : ""));
  writeFileSync(join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2));

  const elapsedMs = Date.now() - runStart;
  console.log("[free-engine] ============================================");
  console.log(`[free-engine] DONE in ${elapsedMs}ms`);
  console.log(`[free-engine] best.txt:  ${bestList.length} configs`);
  console.log(`[free-engine] all.txt:   ${allList.length} configs`);
  console.log(`[free-engine] status.json written with ${sourceResults.length} source reports`);
  if (bestLatency !== null) {
    console.log(`[free-engine] best config latency: ${bestLatency}ms`);
  }
  if (avgLatency !== null) {
    console.log(`[free-engine] avg latency (reachable): ${avgLatency}ms`);
  }
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

main().catch((e) => {
  console.error("[free-engine] FATAL uncaught error:", e);
  // Don't throw — exit 0 so the CI workflow doesn't fail (the desktop app
  // has fallbacks). But still log the error prominently.
  process.exit(0);
});
