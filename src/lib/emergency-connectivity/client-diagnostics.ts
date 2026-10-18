// DISTORT — Client-side network diagnostics
//
// The server CANNOT know if the user's device has internet. This module
// runs REAL probes from the browser to determine the actual network state.
//
// What it does (honestly):
//   1. Checks if navigator.onLine is true (browser thinks it's online)
//   2. Tries to fetch a domestic destination (iran.ir / aparat.com)
//   3. Tries to fetch an international destination (cloudflare / google)
//   4. Tries to fetch a known-good IP (1.1.1.1) to check if DNS resolves
//   5. Measures latency via fetch timing
//
// What it CANNOT do (browser limitation):
//   - Cannot do raw TCP connect (no socket API in browsers)
//   - Cannot bypass CORS — uses no-cors mode which limits response inspection
//   - Cannot detect DPI specifically — only infers from reachability + latency
//
// For real TCP probing + DPI detection, the desktop / Android companion
// does its own diagnosis and reports back.

import type { NetworkDiagnosis, BaseNetworkStatus } from "./types";

// Well-known probe targets.
// Domestic = Iranian sites (if reachable, national internet is up).
// International = global anycast (if reachable, international routing works).
// DNS canary = a domain that should always resolve (cloudflare.com).

const DOMESTIC_TARGETS = [
  "https://www.iran.ir",
  "https://www.aparat.com",
];

const INTERNATIONAL_TARGETS = [
  "https://1.1.1.1/cdn-cgi/trace",  // Cloudflare anycast — returns text
  "https://www.google.com/generate_204",  // Returns 204 No Content
  "https://cloudflare.com/cdn-cgi/trace",
];

const DNS_CANARY = "https://dns.cloudflare.com/";

type RawProbe = {
  url: string;
  state: "ok" | "timeout" | "unknown";
  latencyMs: number;
  // 'domestic' | 'international' | 'dns-canary'
  category: "domestic" | "international" | "dns-canary";
};

// Fetch a URL with a timeout. Returns one of three states:
//   - "ok" — fetch succeeded (got any HTTP response, even opaque)
//   - "timeout" — request timed out
//   - "unknown" — fetch threw but we can't tell if it's CORS, network error, or DNS
//
// CRITICAL FIX (per user review issue #5): the previous logic treated any
// fetch error with latency > 50ms as "reachable". This was wrong — a DNS
// resolution failure can take >50ms, and a connection-refused can too.
// We now return "unknown" for ambiguous errors instead of falsely
// claiming "reachable".
async function probeUrl(url: string, timeoutMs = 5000): Promise<{ state: "ok" | "timeout" | "unknown"; latencyMs: number }> {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      mode: "no-cors", // we don't need the body, just connectivity
      cache: "no-store",
      signal: controller.signal,
      // Don't send credentials — avoid confusing auth-required endpoints
      credentials: "omit",
      redirect: "manual", // don't follow redirects — we just want "did it respond"
    });
    clearTimeout(timeout);
    // If fetch resolved without throwing, the server responded (even if
    // the response is an opaque CORS-blocked one). This is a real reach.
    return { state: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (e: unknown) {
    clearTimeout(timeout);
    const err = e as { name?: string };
    const latency = Math.round(performance.now() - start);

    // Timeout — server did not respond in time. Definitively unreachable.
    if (err?.name === "AbortError") {
      return { state: "timeout", latencyMs: timeoutMs };
    }

    // If navigator says offline, it's a real failure
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return { state: "timeout", latencyMs: latency };
    }

    // Ambiguous error: could be CORS (server responded), DNS failure
    // (no response), connection refused (server down), or network error.
    // We CANNOT determine which from the browser. Return "unknown" so the
    // caller can decide based on multiple probes.
    return { state: "unknown", latencyMs: latency };
  }
}

async function probeAll(targets: string[], category: RawProbe["category"], timeoutMs = 5000): Promise<RawProbe[]> {
  const results = await Promise.all(
    targets.map(async (url) => {
      const r = await probeUrl(url, timeoutMs);
      return { url, state: r.state, latencyMs: r.latencyMs, category };
    })
  );
  return results;
}

// Main entry: diagnose the network from the browser.
// Returns a NetworkDiagnosis with honest results.
export async function diagnoseClientSide(): Promise<NetworkDiagnosis> {
  // 1. Check navigator.onLine first (fast, no network)
  const navOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  // 2. If navigator says offline, trust it (no network at all)
  if (!navOnline) {
    return {
      baseNetwork: "offline",
      dnsWorks: false,
      internationalReachable: false,
      domesticReachable: false,
      directLatencyMs: null,
      summary: "Browser reports offline (navigator.onLine=false). No network connectivity detected. The device has no active network interface.",
      checkedAt: new Date().toISOString(),
    };
  }

  // 3. Probe domestic + international + DNS canary in parallel
  const [domestic, international, dns] = await Promise.all([
    probeAll(DOMESTIC_TARGETS, "domestic", 4000),
    probeAll(INTERNATIONAL_TARGETS, "international", 5000),
    probeAll([DNS_CANARY], "dns-canary", 4000),
  ]);

  // COUNT states per category — use multiple probes to distinguish
  // real reachability from ambiguous CORS errors.
  // A category is "reachable" only if at least one probe returned "ok".
  // A category is "unknown" if all probes returned "unknown" (ambiguous).
  const domesticOk = domestic.filter((p) => p.state === "ok").length;
  const domesticUnknown = domestic.filter((p) => p.state === "unknown").length;
  const intlOk = international.filter((p) => p.state === "ok").length;
  const intlUnknown = international.filter((p) => p.state === "unknown").length;
  const dnsOk = dns.filter((p) => p.state === "ok").length;
  const dnsUnknown = dns.filter((p) => p.state === "unknown").length;

  const domesticReachable = domesticOk > 0;
  const internationalReachable = intlOk > 0;
  // DNS works if either the canary responded or any international probe did
  const dnsWorks = dnsOk > 0 || internationalReachable;

  // Confidence: if all probes returned "unknown", we can't be sure.
  const allUnknown = (domesticOk === 0 && domesticUnknown > 0) ||
                     (intlOk === 0 && intlUnknown > 0);

  // Latency: take the minimum successful international probe
  const okLatencies = international
    .filter((p) => p.state === "ok")
    .map((p) => p.latencyMs);
  const directLatencyMs = okLatencies.length > 0 ? Math.min(...okLatencies) : null;

  // Determine base network status
  let baseNetwork: BaseNetworkStatus;
  if (internationalReachable || domesticReachable) {
    baseNetwork = "online";
  } else if (allUnknown && navOnline) {
    // All probes ambiguous — we can't tell if it's online or offline.
    // Honest: report as "unknown" rather than guessing.
    baseNetwork = "unknown";
  } else if (navOnline) {
    // navigator says online but all probes timed out (not unknown)
    baseNetwork = "local-only";
  } else {
    baseNetwork = "offline";
  }

  // Build an honest summary
  const parts: string[] = [];
  parts.push(`Base network: ${baseNetwork}.`);
  parts.push(`Domestic (Iran) reachable: ${domesticReachable ? "yes" : domesticUnknown > 0 ? "unknown" : "no"}.`);
  parts.push(`International reachable: ${internationalReachable ? "yes" : intlUnknown > 0 ? "unknown" : "no"}.`);
  parts.push(`DNS works: ${dnsWorks ? "yes" : dnsUnknown > 0 ? "unknown" : "no"}.`);
  if (directLatencyMs !== null) {
    parts.push(`Direct latency (min): ${directLatencyMs}ms.`);
  } else {
    parts.push(`Direct latency: unreachable.`);
  }
  if (baseNetwork === "online" && !internationalReachable && domesticReachable) {
    parts.push("National-intranet scenario detected: domestic works but international is blocked. VPN tunnel required to reach the open internet.");
  }
  if (baseNetwork === "local-only") {
    parts.push("Local network appears up but no destinations are reachable. DNS may be broken, or the network is captive/filtered.");
  }

  return {
    baseNetwork,
    dnsWorks,
    internationalReachable,
    domesticReachable,
    directLatencyMs,
    summary: parts.join(" "),
    checkedAt: new Date().toISOString(),
  };
}

// Lighter-weight continuous health check — used by the monitoring loop
// after a tunnel is established. Returns just "online" + latency.
// NOTE: returns "unknown" state if the probe was ambiguous — caller should
// treat "unknown" as "possibly still connected, don't trigger recovery yet".
export async function quickHealthCheck(timeoutMs = 3000): Promise<{ online: boolean; unknown: boolean; latencyMs: number | null }> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { online: false, unknown: false, latencyMs: null };
  }
  const r = await probeUrl("https://1.1.1.1/cdn-cgi/trace", timeoutMs);
  if (r.state === "ok") return { online: true, unknown: false, latencyMs: r.latencyMs };
  if (r.state === "unknown") return { online: false, unknown: true, latencyMs: null };
  return { online: false, unknown: false, latencyMs: null };
}

// Detect if the network changed (e.g. Wi-Fi → mobile data).
// Browsers fire online/offline events on navigator.
// Returns a cleanup function to remove the listeners.
export function onNetworkChange(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback();
  window.addEventListener("online", handler);
  window.addEventListener("offline", handler);
  // Some browsers also fire on connection type change
  if ("connection" in navigator) {
    const conn = (navigator as unknown as { connection?: { addEventListener?: (t: string, h: () => void) => void } }).connection;
    conn?.addEventListener?.("change", handler);
  }
  return () => {
    window.removeEventListener("online", handler);
    window.removeEventListener("offline", handler);
    if ("connection" in navigator) {
      const conn = (navigator as unknown as { connection?: { removeEventListener?: (t: string, h: () => void) => void } }).connection;
      conn?.removeEventListener?.("change", handler);
    }
  };
}
