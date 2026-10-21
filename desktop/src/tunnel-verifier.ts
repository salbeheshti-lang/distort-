// tunnel-verifier.ts
// ---------------------------------------------------------------------------
// Real tunnel verification logic — extracted out of main.ts so it:
//   1. Actually routes the HTTP request through xray's HTTP proxy inbound
//      (127.0.0.1:10809). The previous implementation relied on
//      process.env.HTTP_PROXY which Node's built-in fetch() silently IGNORES,
//      so verification ALWAYS succeeded even with a broken tunnel.
//   2. Has NO electron dependency so it can be unit-tested with bun:test.
//   3. Compares the exit IP against the device's real IP to detect leaks
//      (when both IPs match, traffic is NOT flowing through the tunnel).
//
// We use `node-fetch` v3 + `https-proxy-agent` — the standard, well-tested
// pattern for proxying HTTPS requests from Node.js. The previous raw SOCKS5
// implementation (manual SOCKS5 handshake + TLS) was failing with ECONNRESET.
//
// IMPORTANT — ESM/CJS interop:
//   Both `node-fetch` v3 and `https-proxy-agent` v9 are ESM-only packages
//   ("type": "module" in their package.json). The desktop project compiles to
//   CommonJS (Electron's main process is CJS), so a top-level
//   `import fetch from "node-fetch"` would compile to a `require()` call
//   that throws ERR_REQUIRE_ESM at runtime.
//
//   To handle this, we load both modules via dynamic `import()` the first
//   time the default fetcher is used. The result is cached so subsequent
//   calls pay no extra cost. This is the official recommendation from the
//   node-fetch maintainers for using v3 from CommonJS.
// ---------------------------------------------------------------------------

import * as https from "https";
import * as http from "http";

// ---------------------------------------------------------------------------
// Constants — xray listens on BOTH:
//   - 10808 (SOCKS5 inbound)
//   - 10809 (HTTP proxy inbound)
// We use the HTTP proxy inbound because node-fetch + https-proxy-agent is the
// most reliable, battle-tested pattern (the raw SOCKS5 implementation had
// ECONNRESET issues, and undici/globals.fetch ignores HTTP_PROXY env vars).
// ---------------------------------------------------------------------------

export const TUNNEL_HTTP_PROXY_URL = "http://127.0.0.1:10809";
export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
export const TRACE_TIMEOUT_MS = 10_000;
export const REAL_IP_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Result type. `leakDetected` is true when the exit IP equals the real IP —
// in that case `verified` is forced to false because the tunnel is NOT
// actually routing traffic (xray is bypassing itself or the proxy returned
// the user's real IP).
// ---------------------------------------------------------------------------

export type VerifyTunnelResult = {
  verified: boolean;
  exitIp: string | null;
  exitCountry: string | null;
  latencyMs: number | null;
  leakDetected: boolean;
  realIp: string | null;
  error?: string;
};

// ---------------------------------------------------------------------------
// Injectable fetcher types. Used by tests to mock network calls without
// touching the real network. Production callers pass nothing — the default
// implementations below use node-fetch + https-proxy-agent for the proxy
// request, and https.get for the direct (real IP) request.
// ---------------------------------------------------------------------------

export type ProxyFetcher = (
  url: string,
  init?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type RealIpFetcher = () => Promise<string | null>;

// ---------------------------------------------------------------------------
// Parse cloudflare's /cdn-cgi/trace response. Returns null on malformed input.
// Trace format:
//   fl=abc123
//   h=www.cloudflare.com
//   ip=1.2.3.4
//   ts=...
//   visit_scheme=https
//   uag=...
//   colo=FRA
//   sliver=...
//   http=http/2
//   loc=DE
//   tls=TLSv1.3
//   sni=plaintext
//   warp=off
//   gateway=off
//   rbi=off
//   kex=X25519
// ---------------------------------------------------------------------------

export function parseCloudflareTrace(text: string): {
  exitIp: string | null;
  exitCountry: string | null;
} {
  if (!text || !text.includes("ip=")) {
    return { exitIp: null, exitCountry: null };
  }
  const exitIp = text.match(/ip=([^\r\n]+)/)?.[1]?.trim() || null;
  const exitCountry = text.match(/loc=([^\r\n]+)/)?.[1]?.trim() || null;
  return { exitIp, exitCountry };
}

// ---------------------------------------------------------------------------
// Leak detection — if the exit IP equals the real IP, traffic is NOT going
// through the tunnel. We treat null/unknown real IP as "not a leak" because
// we can't prove a leak happened (the direct fetch may have failed for
// unrelated reasons — captive portal, no internet, etc.).
// ---------------------------------------------------------------------------

export function detectLeak(
  exitIp: string | null,
  realIp: string | null
): boolean {
  if (!exitIp || !realIp) return false;
  // Normalise — trim whitespace and lowercase (IPv6 addresses are
  // case-insensitive in text form, and trailing whitespace from cloudflare's
  // newline-terminated responses could cause false negatives).
  const a = exitIp.trim().toLowerCase();
  const b = realIp.trim().toLowerCase();
  return a.length > 0 && a === b;
}

// ---------------------------------------------------------------------------
// Lazy loader for the ESM-only `node-fetch` + `https-proxy-agent` modules.
//
// Both packages are ESM-only ("type": "module"). The desktop project compiles
// to CommonJS, so we can't use a top-level `import` — that would compile to
// `require()` and throw ERR_REQUIRE_ESM. Instead, we use dynamic `import()`
// which Node's CJS-ESM interop handles correctly.
//
// The promise is cached so subsequent calls reuse the already-loaded modules.
// ---------------------------------------------------------------------------

type LoadedDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  HttpsProxyAgent: new (proxy: string | URL) => any;
};

let _depsPromise: Promise<LoadedDeps> | null = null;

async function loadProxyDeps(): Promise<LoadedDeps> {
  if (_depsPromise) return _depsPromise;
  _depsPromise = (async () => {
    const [fetchMod, agentMod] = await Promise.all([
      import("node-fetch"),
      import("https-proxy-agent"),
    ]);
    return {
      // node-fetch's default export is the fetch function
      fetch: (fetchMod as any).default || (fetchMod as any).fetch,
      HttpsProxyAgent: (agentMod as any).HttpsProxyAgent,
    };
  })();
  return _depsPromise;
}

// ---------------------------------------------------------------------------
// Default proxy fetcher — uses node-fetch + https-proxy-agent to force the
// request through xray's HTTP proxy inbound at 127.0.0.1:10809.
//
// This is the FIX for the critical bug: Node's built-in fetch() (undici)
// silently ignores HTTP_PROXY/HTTPS_PROXY env vars, so the previous
// implementation was making a DIRECT (non-proxied) request to cloudflare and
// reporting "connected" even when xray was completely broken.
// ---------------------------------------------------------------------------

export const defaultProxyFetcher: ProxyFetcher = async (url, init) => {
  const timeoutMs = init?.timeoutMs ?? TRACE_TIMEOUT_MS;
  // AbortController gives us a portable timeout that works across Node
  // versions (AbortSignal.timeout is also fine, but AbortController is
  // universally supported and lets the caller pass their own signal too).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (init?.signal) {
    // Bubble up external abort too.
    init.signal.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true }
    );
  }
  try {
    const { fetch, HttpsProxyAgent } = await loadProxyDeps();
    const agent = new HttpsProxyAgent(TUNNEL_HTTP_PROXY_URL);
    const resp = await fetch(url, {
      agent,
      signal: controller.signal,
      // node-fetch v3 honours the agent option for HTTPS URLs.
      // Disable compression to keep the trace body tiny and avoid zlib
      // edge-cases on some platforms.
      compress: false,
    });
    return {
      ok: resp.ok as boolean,
      status: resp.status as number,
      text: async () => (await resp.text()) as string,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Default real-IP fetcher — direct (non-proxied) HTTPS GET to cloudflare.
// We can't reuse node-fetch here because that would route through the
// proxy agent. Instead we use Node's built-in https.get which is hard-coded
// to NOT use a proxy (Node's http/https modules do NOT honour HTTP_PROXY
// env vars either — only `request` agents do, which we don't set).
// ---------------------------------------------------------------------------

export const defaultRealIpFetcher: RealIpFetcher = () =>
  new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = https.get(
      TRACE_URL,
      { timeout: REAL_IP_TIMEOUT_MS },
      (res: http.IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const parsed = parseCloudflareTrace(data);
          finish(parsed.exitIp);
        });
      }
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
  });

// ---------------------------------------------------------------------------
// Main entry point. Verifies the xray tunnel by:
//   1. Fetching cloudflare/cdn-cgi/trace THROUGH the proxy (default: xray's
//      HTTP inbound at 127.0.0.1:10809).
//   2. Fetching the device's REAL public IP directly (no proxy).
//   3. Comparing the two — if they match, the tunnel is leaking (verified=false).
//
// Both fetches run in parallel — they're independent.
//
// Tests can inject `proxyFetcher` and `realIpFetcher` to avoid touching the
// real network. Production callers should pass neither (or omit opts).
// ---------------------------------------------------------------------------

export async function verifyTunnelTraffic(opts?: {
  proxyFetcher?: ProxyFetcher;
  realIpFetcher?: RealIpFetcher;
}): Promise<VerifyTunnelResult> {
  const proxyFetcher = opts?.proxyFetcher ?? defaultProxyFetcher;
  const realIpFetcher = opts?.realIpFetcher ?? defaultRealIpFetcher;

  const startTime = Date.now();

  try {
    // Run both probes in parallel — the proxy fetch is the primary signal,
    // and the real-IP fetch is the leak-detection comparison.
    const [proxyResult, realIp] = await Promise.all([
      proxyFetcher(TRACE_URL, { timeoutMs: TRACE_TIMEOUT_MS })
        .then((r) => ({ kind: "ok" as const, r }))
        .catch((e: any) => ({ kind: "err" as const, e })),
      realIpFetcher().catch(() => null),
    ]);

    const latencyMs = Date.now() - startTime;

    // Proxy fetch failed entirely (xray not listening, tunnel broken, timeout).
    if (proxyResult.kind === "err") {
      const e = proxyResult.e;
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs,
        leakDetected: false,
        realIp,
        error: e?.message || String(e) || "Proxy fetch failed",
      };
    }

    const { r: resp } = proxyResult;
    if (!resp.ok) {
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs,
        leakDetected: false,
        realIp,
        error: `HTTP ${resp.status} through proxy`,
      };
    }

    // Read the body — this may itself throw if the connection is reset
    // mid-stream, which would also indicate a broken tunnel.
    let text: string;
    try {
      text = await resp.text();
    } catch (e: any) {
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs,
        leakDetected: false,
        realIp,
        error: `Proxy response body read failed: ${e?.message || String(e)}`,
      };
    }

    const { exitIp, exitCountry } = parseCloudflareTrace(text);
    if (!exitIp) {
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs,
        leakDetected: false,
        realIp,
        error: "Proxy responded but no valid trace data",
      };
    }

    // We have an exit IP. Now check for leaks by comparing with the real IP.
    const leakDetected = detectLeak(exitIp, realIp);

    // `verified` requires BOTH a successful proxy fetch AND no leak.
    // If we couldn't fetch the real IP, we can't prove a leak — we still
    // mark verified=true because the proxy fetch itself succeeded.
    // (handleTunnelVerify in main.ts already does this comparison externally
    // as a defence-in-depth check, so this is consistent.)
    const verified = !leakDetected;

    return {
      verified,
      exitIp,
      exitCountry,
      latencyMs,
      leakDetected,
      realIp,
      error: leakDetected
        ? `Leak detected: exit IP (${exitIp}) matches real IP`
        : undefined,
    };
  } catch (e: any) {
    return {
      verified: false,
      exitIp: null,
      exitCountry: null,
      latencyMs: Date.now() - startTime,
      leakDetected: false,
      realIp: null,
      error: e?.message || String(e),
    };
  }
}

// Re-export for callers (main.ts) that want to fetch the real IP directly
// without running the full tunnel verification.
export async function fetchRealIp(): Promise<string | null> {
  return defaultRealIpFetcher();
}

// Convenience helper for callers that just need the proxy URL (e.g. for
// logging / diagnostics).
export function getTunnelProxyUrl(): string {
  return TUNNEL_HTTP_PROXY_URL;
}
