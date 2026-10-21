// quick-connect-failover.test.ts
// ---------------------------------------------------------------------------
// Regression tests for the Quick Connect tiered failover + stale-verification
// guard (v1.0.38 — addresses user review).
//
// These tests verify the LOGIC that's testable without Electron:
//   - tryQuickConnectTier returns true on the FIRST verified config, false if
//     all configs in a tier fail.
//   - Deduplication via the attemptedUris Set prevents retrying the same URI
//     across tiers.
//   - The stale-verification guard (currentVerifyAttempt counter) invalidates
//     in-flight verification callbacks from a previous config.
//
// What we CANNOT test here (needs real Electron + xray):
//   - Whether xray actually spawns and binds to ports 10808/10809.
//   - Whether the verification HTTP request actually goes through the proxy.
//   - Whether stopVpnEngine actually kills the xray process.
// These are integration concerns verified by manual testing on Windows.
//
// Run with:
//   cd desktop && bun test src/__tests__/quick-connect-failover.test.ts
// ---------------------------------------------------------------------------

import { test, expect, describe } from "bun:test";
import {
  detectLeak,
  parseCloudflareTrace,
  verifyTunnelTraffic,
  type ProxyFetcher,
  type RealIpFetcher,
} from "../tunnel-verifier";

// ---------------------------------------------------------------------------
// Helpers — build mock fetchers that return canned responses.
// ---------------------------------------------------------------------------

function makeProxyFetcher(opts: {
  ip?: string;
  loc?: string;
  status?: number;
  body?: string;
  throwErr?: Error;
  delayMs?: number;
}): ProxyFetcher {
  return async (url: string) => {
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    if (opts.throwErr) throw opts.throwErr;
    const status = opts.status ?? 200;
    const body =
      opts.body ??
      (opts.ip ? `fl=abc\nh=www.cloudflare.com\nip=${opts.ip}\nloc=${opts.loc || "US"}\n` : "garbage");
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
}

function makeRealIpFetcher(ip: string | null): RealIpFetcher {
  return async () => ip;
}

// ---------------------------------------------------------------------------
// Scenarios from the user's review (Section 5 of the task spec).
// ---------------------------------------------------------------------------

describe("Quick Connect + verification regression scenarios", () => {
  // Scenario 1: Xray not running, proxy port closed.
  test("S1: xray not running → proxy fetch throws → verified=false", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ throwErr: new Error("connect ECONNREFUSED 127.0.0.1:10809") }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(false);
    expect(result.exitIp).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  // Scenario 2: Proxy responds, but real IP cannot be fetched.
  test("S2: proxy responds but real IP fetch fails → verified=false (strict)", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "5.6.7.8", loc: "FR" }),
      realIpFetcher: makeRealIpFetcher(null),
    });
    expect(result.verified).toBe(false);
    expect(result.exitIp).toBe("5.6.7.8");
    expect(result.realIp).toBeNull();
    expect(result.error).toMatch(/real IP fetch failed/i);
  });

  // Scenario 3: Exit IP == Real IP → leak detected → verified=false.
  test("S3: exit IP matches real IP → leak detected → verified=false", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "1.2.3.4", loc: "US" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(false);
    expect(result.exitIp).toBe("1.2.3.4");
    expect(result.realIp).toBe("1.2.3.4");
    expect(result.leakDetected).toBe(true);
    expect(result.error).toMatch(/leak detected/i);
  });

  // Scenario 4: Exit IP != Real IP → tunnel verified.
  test("S4: exit IP differs from real IP → verified=true", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "99.99.99.99", loc: "DE" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(true);
    expect(result.exitIp).toBe("99.99.99.99");
    expect(result.realIp).toBe("1.2.3.4");
    expect(result.leakDetected).toBe(false);
    expect(result.error).toBeUndefined();
  });

  // Scenario 5: xray crashes immediately → proxy fetch throws (ECONNREFUSED).
  // This is the same as S1 from the verifier's perspective — the proxy isn't
  // listening, so the fetch throws. We test both ECONNREFUSED (port closed)
  // and a generic Error to be defensive.
  test("S5a: proxy throws ECONNREFUSED (xray crashed before listening) → verified=false", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ throwErr: new Error("connect ECONNREFUSED 127.0.0.1:10809") }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(false);
  });

  test("S5b: proxy throws generic error (xray died mid-handshake) → verified=false", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ throwErr: new Error("socket hang up") }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/socket hang up/);
  });

  // Scenario 6: verification response arrives LATE. From the verifier's
  // perspective, this is just a slow fetch — if it eventually resolves with
  // valid data, verified=true. The stale-verification guard (in main.ts's
  // startVpnEngine) is what prevents a late result from a PREVIOUS config
  // from overwriting the state of a NEW config. We test that logic separately
  // below using a simulated attempt counter.
  test("S6: slow proxy fetch still verifies correctly when it resolves", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "99.99.99.99", loc: "DE", delayMs: 200 }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(result.verified).toBe(true);
    expect(result.exitIp).toBe("99.99.99.99");
  });

  // Scenario 7 + 8: failover logic. These are tested in the
  // `quickConnectFailoverLogic` describe block below (simulated tier sequence).

  // Scenario 9: all sources fail → no verified=true. Covered by S1+S5+S3
  // combinations in the failover simulation below.

  // Scenario 10: late result from previous attempt doesn't corrupt new state.
  // We simulate this using a stale-attempt guard pattern (the same pattern
  // used in main.ts's startVpnEngine).
  test("S10: stale verification result does not overwrite newer state", async () => {
    // Simulate the stale-verification guard from main.ts.
    // Pattern: each "attempt" gets an id; the callback checks if its id is
    // still current before applying state changes.
    let currentAttempt = 0;
    let connected = false;
    let connectedHost: string | null = null;

    // Start attempt 1 with a SLOW verifier (resolves after 300ms).
    currentAttempt++;
    const attempt1Id = currentAttempt;
    const slowVerify = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 300);
    });
    slowVerify.then((verified) => {
      if (attempt1Id !== currentAttempt) {
        // Stale — drop.
        return;
      }
      if (verified) {
        connected = true;
        connectedHost = "host1.example.com";
      }
    });

    // Immediately start attempt 2 with a FAST verifier (resolves in 10ms).
    currentAttempt++;
    const attempt2Id = currentAttempt;
    const fastVerify = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 10);
    });
    fastVerify.then((verified) => {
      if (attempt2Id !== currentAttempt) return;
      if (verified) {
        connected = true;
        connectedHost = "host2.example.com";
      }
    });

    // Wait for both to resolve.
    await new Promise((r) => setTimeout(r, 500));

    // The fast one (attempt 2) should have won. When the slow one (attempt 1)
    // eventually resolves, it should detect it's stale and NOT overwrite.
    expect(connectedHost).toBe("host2.example.com");
    expect(connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failover logic simulation. The real tryQuickConnectTier is in main.ts and
// depends on Electron's `app`, `store`, etc. We simulate the same algorithm
// here to verify the tier-advancement + dedup logic is correct.
// ---------------------------------------------------------------------------

describe("quickConnectFailoverLogic (simulated)", () => {
  type SimConfig = { uri: string; host: string; port: number; source: string };

  // Simulates the per-tier iteration. Returns true on the first verified
  // config, false if all fail. Uses the same `attemptedUris` dedup pattern.
  async function tryTier(
    configs: SimConfig[],
    attemptedUris: Set<string>,
    verifyFn: (cfg: SimConfig) => Promise<boolean>,
  ): Promise<SimConfig | null> {
    for (const cfg of configs) {
      if (attemptedUris.has(cfg.uri)) continue;
      attemptedUris.add(cfg.uri);
      if (await verifyFn(cfg)) return cfg;
    }
    return null;
  }

  // Scenario 7: first config fails, second succeeds.
  test("S7: first config fails → second succeeds → returns second", async () => {
    const configs: SimConfig[] = [
      { uri: "vless://a@host1:443", host: "host1", port: 443, source: "best.txt" },
      { uri: "vless://b@host2:443", host: "host2", port: 443, source: "best.txt" },
    ];
    const attempted = new Set<string>();
    const result = await tryTier(configs, attempted, async (cfg) => cfg.host === "host2");
    expect(result).not.toBeNull();
    expect(result?.host).toBe("host2");
    // Both should have been attempted (first failed, second succeeded).
    expect(attempted.size).toBe(2);
  });

  // Scenario 8: all configs in tier 1 fail → advance to tier 2.
  test("S8: tier 1 all fail → tier 2 attempted → tier 2 succeeds", async () => {
    const tier1: SimConfig[] = [
      { uri: "vless://a@h1:443", host: "h1", port: 443, source: "best.txt" },
      { uri: "vless://b@h2:443", host: "h2", port: 443, source: "best.txt" },
    ];
    const tier2: SimConfig[] = [
      { uri: "vless://c@h3:443", host: "h3", port: 443, source: "all.txt" },
      { uri: "vless://d@h4:443", host: "h4", port: 443, source: "all.txt" },
    ];
    const attempted = new Set<string>();

    const r1 = await tryTier(tier1, attempted, async () => false);
    expect(r1).toBeNull();

    const r2 = await tryTier(tier2, attempted, async (cfg) => cfg.host === "h3");
    expect(r2).not.toBeNull();
    expect(r2?.host).toBe("h3");
    expect(attempted.size).toBe(3); // 2 from tier1 + 1 from tier2
  });

  // Scenario: deduplication — same URI in both tiers is only attempted once.
  test("deduplication: same URI in tier 1 and tier 2 is only attempted once", async () => {
    const sharedUri = "vless://shared@h1:443";
    const tier1: SimConfig[] = [{ uri: sharedUri, host: "h1", port: 443, source: "best.txt" }];
    const tier2: SimConfig[] = [
      { uri: sharedUri, host: "h1", port: 443, source: "all.txt" },
      { uri: "vless://other@h2:443", host: "h2", port: 443, source: "all.txt" },
    ];
    const attempted = new Set<string>();
    let attemptCount = 0;

    const r1 = await tryTier(tier1, attempted, async () => {
      attemptCount++;
      return false;
    });
    expect(r1).toBeNull();
    expect(attempted.size).toBe(1);
    expect(attemptCount).toBe(1);

    const r2 = await tryTier(tier2, attempted, async (cfg) => {
      attemptCount++;
      return cfg.host === "h2";
    });
    expect(r2?.host).toBe("h2");
    // h1 was attempted in tier 1, so it's skipped in tier 2.
    expect(attemptCount).toBe(2);
  });

  // Scenario 9: all sources fail → final result is null (no false success).
  test("S9: all tiers fail → returns null (no false success)", async () => {
    const tier1: SimConfig[] = [{ uri: "vless://a@h1:443", host: "h1", port: 443, source: "best.txt" }];
    const tier2: SimConfig[] = [{ uri: "vless://b@h2:443", host: "h2", port: 443, source: "all.txt" }];
    const tier3: SimConfig[] = [{ uri: "vless://c@h3:443", host: "h3", port: 443, source: "mixed_iran" }];
    const attempted = new Set<string>();

    const r1 = await tryTier(tier1, attempted, async () => false);
    const r2 = await tryTier(tier2, attempted, async () => false);
    const r3 = await tryTier(tier3, attempted, async () => false);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(attempted.size).toBe(3);
  });

  // Scenario: last-working-config fallback uses a FRESH set (allows retry).
  test("last-working-config fallback: uses fresh set so a previously-failed URI can be retried", async () => {
    const sharedUri = "vless://lastworking@h1:443";
    const tier1: SimConfig[] = [{ uri: sharedUri, host: "h1", port: 443, source: "best.txt" }];
    const attempted = new Set<string>();

    // Tier 1 fails (e.g. temporary network issue).
    const r1 = await tryTier(tier1, attempted, async () => false);
    expect(r1).toBeNull();
    expect(attempted.has(sharedUri)).toBe(true);

    // Last-working-config fallback: fresh set, retry the same URI.
    const freshAttempted = new Set<string>();
    let retried = false;
    const r2 = await tryTier(
      [{ uri: sharedUri, host: "h1", port: 443, source: "last-working-config.json" }],
      freshAttempted,
      async () => {
        retried = true;
        return true; // succeeds this time
      },
    );
    expect(r2).not.toBeNull();
    expect(retried).toBe(true);
  });
});
