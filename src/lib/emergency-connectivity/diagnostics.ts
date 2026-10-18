// DISTORT — Emergency Connectivity diagnostics
//
// Network diagnostics module. Provides:
//   1. `diagnoseServerSide()` — a HEURISTIC server-side probe of well-known
//      destinations to ESTIMATE the network climate. The server cannot see
//      the user's device, so this view is explicitly caveated — the client
//      MUST do its own probe to know the user's real network state.
//   2. `interpretDiagnosis()` — a PURE function that takes raw probe results
//      (collected by the client) and produces a `NetworkDiagnosis` object.
//
// CORE PRINCIPLE: Never trust the server's view of the user's network.
// The server might be able to reach Google while the user is dark.

import { NetworkDiagnosis, BaseNetworkStatus } from "./types";
import { probeReachability } from "@/lib/anti-censor";

// ---------------------------------------------------------------------------
// Well-known probe targets
// ---------------------------------------------------------------------------

// Domestic (Iran) targets — used to detect "online but domestic-only" state.
const WELL_KNOWN_DOMESTIC: Array<{ host: string; port: number; label: string }> = [
  { host: "www.iran.ir", port: 443, label: "Iran gov portal" },
  { host: "www.aparat.com", port: 443, label: "Aparat (domestic)" },
];

// International targets — used to detect filtering + measure latency.
const WELL_KNOWN_INTERNATIONAL: Array<{ host: string; port: number; label: string }> = [
  { host: "1.1.1.1", port: 443, label: "Cloudflare DNS" },
  { host: "8.8.8.8", port: 443, label: "Google DNS" },
  { host: "www.google.com", port: 443, label: "Google" },
];

// ---------------------------------------------------------------------------
// Server-side diagnosis (HEURISTIC — see caveat in returned summary)
// ---------------------------------------------------------------------------

export async function diagnoseServerSide(): Promise<NetworkDiagnosis> {
  // Probe domestic destinations in parallel.
  const domesticResults = await Promise.all(
    WELL_KNOWN_DOMESTIC.map(async (target) => ({
      ...target,
      result: await probeReachability(target.host, target.port),
    })),
  );
  const domesticReachable = domesticResults.some((r) => r.result.ok);

  // Probe international destinations in parallel.
  const intlResults = await Promise.all(
    WELL_KNOWN_INTERNATIONAL.map(async (target) => ({
      ...target,
      result: await probeReachability(target.host, target.port),
    })),
  );
  const internationalReachable = intlResults.some((r) => r.result.ok);

  // Simplification: DNS "works" if any international destination was reachable.
  // (If a remote hostname resolved + TCP connected, the resolver is alive.)
  const dnsWorks = internationalReachable;

  // Latency: take the minimum of successful international probes.
  // Null if none were reachable.
  const latencies = intlResults
    .filter((r) => r.result.ok)
    .map((r) => r.result.latencyMs);
  const directLatencyMs = latencies.length > 0 ? Math.min(...latencies) : null;

  // Base network state from the server's perspective.
  // Note: the server cannot tell "local-only" from "online" — it only sees
  // its own outbound connectivity. So we collapse local-only/offline into
  // either "online" (something reachable) or "unknown" (nothing reachable).
  let baseNetwork: BaseNetworkStatus;
  if (domesticReachable || internationalReachable) {
    baseNetwork = "online";
  } else {
    baseNetwork = "unknown";
  }

  // IMPORTANT: The summary is what surfaces to operators + the user (via API).
  // It explicitly states that this is the SERVER's view, NOT the user's.
  const summary = `Server-side estimate: domestic=${
    domesticReachable ? "up" : "down"
  }, international=${
    internationalReachable ? "up" : "down"
  }, DNS=${dnsWorks ? "ok" : "broken"}. NOTE: this is the server's view, NOT the user's device. The client must do its own probe to know the user's real network state.`;

  return {
    baseNetwork,
    dnsWorks,
    internationalReachable,
    domesticReachable,
    directLatencyMs,
    summary,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure client-side interpreter
// ---------------------------------------------------------------------------

// Input shape for a single probe — what the client collects locally.
export type ClientProbe = {
  host: string;
  port: number;
  ok: boolean;
  latencyMs: number;
  label: string;
};

// Interpret a batch of client-collected probes into a NetworkDiagnosis.
//
// `opts.domesticTargets` and `opts.internationalTargets` are lists of host
// strings — the client tells us which of its probed hosts fall into each
// category, so we can compute the per-category reachability flags.
//
// This function is PURE — same inputs always produce structurally identical
// output (modulo the checkedAt timestamp, which is current-time).
export function interpretDiagnosis(
  probes: ClientProbe[],
  opts: {
    domesticTargets: string[];
    internationalTargets: string[];
  },
): NetworkDiagnosis {
  const domesticReachable = probes.some(
    (p) => opts.domesticTargets.includes(p.host) && p.ok,
  );
  const internationalReachable = probes.some(
    (p) => opts.internationalTargets.includes(p.host) && p.ok,
  );
  // Simplification: if any international host resolved + connected, DNS works.
  const dnsWorks = internationalReachable;

  const okLatencies = probes.filter((p) => p.ok).map((p) => p.latencyMs);
  const directLatencyMs =
    okLatencies.length > 0 ? Math.min(...okLatencies) : null;

  // Client can distinguish local-only (tried to probe, none worked) from
  // unknown (no probes collected at all — e.g. permission denied).
  let baseNetwork: BaseNetworkStatus;
  if (domesticReachable || internationalReachable) {
    baseNetwork = "online";
  } else if (probes.length > 0) {
    // Tried to probe but none worked — assume local-only.
    // (Local link layer is presumably up, otherwise the client couldn't
    // even attempt a TCP connect.)
    baseNetwork = "local-only";
  } else {
    baseNetwork = "unknown";
  }

  const summary = `Client-side: domestic=${
    domesticReachable ? "up" : "down"
  }, international=${
    internationalReachable ? "up" : "down"
  }, DNS=${dnsWorks ? "ok" : "broken"}, latency=${
    directLatencyMs ?? "unknown"
  }ms`;

  return {
    baseNetwork,
    dnsWorks,
    internationalReachable,
    domesticReachable,
    directLatencyMs,
    summary,
    checkedAt: new Date().toISOString(),
  };
}
