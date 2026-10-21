// verify-tunnel.test.ts
// ---------------------------------------------------------------------------
// Unit tests for the tunnel verifier extracted to ./src/tunnel-verifier.ts.
//
// Run with:
//   cd desktop && bun test src/__tests__/verify-tunnel.test.ts
//
// These tests verify the CRITICAL FIX from VERIFY-TUNNEL-FIX: that
// verifyTunnelTraffic() actually returns verified=false when:
//   1. The proxy returns the SAME IP as the device's real IP (leak detected).
//   2. The proxy fetch throws (tunnel broken / proxy unreachable).
// And verified=true only when the proxy returns a valid trace whose exit IP
// DIFFERS from the device's real IP.
//
// The tests use the injectable `proxyFetcher` and `realIpFetcher` options on
// verifyTunnelTraffic() — no real network calls are made.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "bun:test";
import {
  verifyTunnelTraffic,
  parseCloudflareTrace,
  detectLeak,
  TUNNEL_HTTP_PROXY_URL,
  TRACE_URL,
  type ProxyFetcher,
  type RealIpFetcher,
} from "../tunnel-verifier";

// ---------------------------------------------------------------------------
// Helpers — build mock fetchers that return canned cloudflare-trace responses
// (or throw, to simulate a broken tunnel).
// ---------------------------------------------------------------------------

const FAKE_PROXY_TRACE = (ip: string, loc: string = "DE"): string =>
  `fl=abc123\nh=www.cloudflare.com\nip=${ip}\nts=...\nvisit_scheme=https\nuag=node-fetch\ncolo=FRA\nsliver=\nhttp=http/2\nloc=${loc}\ntls=TLSv1.3\nsni=plaintext\nwarp=off\ngateway=off\nrbi=off\nkex=X25519\n`;

function makeProxyFetcher(opts: {
  ip?: string;
  loc?: string;
  status?: number;
  throwErr?: Error;
  bodyText?: string;
}): ProxyFetcher {
  return async (_url: string, _init?: { timeoutMs?: number; signal?: AbortSignal }) => {
    if (opts.throwErr) throw opts.throwErr;
    const status = opts.status ?? 200;
    const ok = status >= 200 && status < 300;
    const text =
      opts.bodyText ??
      (opts.ip ? FAKE_PROXY_TRACE(opts.ip, opts.loc) : "not a trace");
    return {
      ok,
      status,
      text: async () => text,
    };
  };
}

function makeRealIpFetcher(ip: string | null): RealIpFetcher {
  return async () => ip;
}

// ---------------------------------------------------------------------------
// Pure-function tests — parser + leak detector
// ---------------------------------------------------------------------------

describe("parseCloudflareTrace", () => {
  test("extracts ip + loc from a valid trace", () => {
    const r = parseCloudflareTrace(FAKE_PROXY_TRACE("5.6.7.8", "FR"));
    expect(r.exitIp).toBe("5.6.7.8");
    expect(r.exitCountry).toBe("FR");
  });

  test("returns nulls when trace has no ip=", () => {
    const r = parseCloudflareTrace("fl=abc\nh=www.cloudflare.com\n");
    expect(r.exitIp).toBeNull();
    expect(r.exitCountry).toBeNull();
  });

  test("returns nulls on empty input", () => {
    const r = parseCloudflareTrace("");
    expect(r.exitIp).toBeNull();
    expect(r.exitCountry).toBeNull();
  });
});

describe("detectLeak", () => {
  test("detects leak when exit IP equals real IP", () => {
    expect(detectLeak("1.2.3.4", "1.2.3.4")).toBe(true);
  });

  test("no leak when IPs differ", () => {
    expect(detectLeak("1.2.3.4", "5.6.7.8")).toBe(false);
  });

  test("no leak when either IP is null (can't prove)", () => {
    expect(detectLeak(null, "1.2.3.4")).toBe(false);
    expect(detectLeak("1.2.3.4", null)).toBe(false);
    expect(detectLeak(null, null)).toBe(false);
  });

  test("normalises whitespace + case", () => {
    expect(detectLeak("  1.2.3.4  ", "1.2.3.4")).toBe(true);
    // IPv6 is case-insensitive
    expect(detectLeak("2001:DB8::1", "2001:db8::1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — verifyTunnelTraffic with mocked fetchers
// ---------------------------------------------------------------------------

describe("verifyTunnelTraffic", () => {
  test("returns verified=true when exit IP differs from real IP", async () => {
    // Proxy says exit is 5.6.7.8 (somewhere in France), real IP is 1.2.3.4
    // (the user's real ISP). Tunnel is working.
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "5.6.7.8", loc: "FR" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    expect(result.verified).toBe(true);
    expect(result.exitIp).toBe("5.6.7.8");
    expect(result.exitCountry).toBe("FR");
    expect(result.realIp).toBe("1.2.3.4");
    expect(result.leakDetected).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).not.toBeNull();
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns verified=false when exit IP matches real IP (LEAK)", async () => {
    // CRITICAL test: this is the bug we're guarding against. If the proxy
    // returns the user's real IP, the tunnel is NOT actually routing
    // traffic — xray is bypassing itself. The OLD verifyTunnelTraffic would
    // have reported verified=true here because it never compared IPs.
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "1.2.3.4", loc: "US" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    expect(result.verified).toBe(false);
    expect(result.exitIp).toBe("1.2.3.4"); // exitIp is still reported
    expect(result.realIp).toBe("1.2.3.4");
    expect(result.leakDetected).toBe(true);
    expect(result.error).toMatch(/leak/i);
  });

  test("returns verified=false when proxy fetch throws (tunnel broken)", async () => {
    // Simulate xray not listening, or the proxy returning ECONNREFUSED, or
    // a TLS handshake timeout, etc.
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({
        throwErr: new Error("connect ECONNREFUSED 127.0.0.1:10809"),
      }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    expect(result.verified).toBe(false);
    expect(result.exitIp).toBeNull();
    expect(result.realIp).toBe("1.2.3.4");
    expect(result.leakDetected).toBe(false); // can't leak if no exit IP
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  test("returns verified=false on non-2xx HTTP status from proxy", async () => {
    // xray might return a 502/503 if the upstream VPN server is down.
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ status: 502 }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    expect(result.verified).toBe(false);
    expect(result.exitIp).toBeNull();
    expect(result.leakDetected).toBe(false);
    expect(result.error).toMatch(/502/);
  });

  test("returns verified=false when proxy response body has no ip= field", async () => {
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ bodyText: "<html>not a trace</html>" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    expect(result.verified).toBe(false);
    expect(result.exitIp).toBeNull();
    expect(result.leakDetected).toBe(false);
    expect(result.error).toMatch(/no valid trace/);
  });

  test("returns verified=true when real IP fetch fails (can't prove a leak)", async () => {
    // If the direct (non-proxied) fetch fails (e.g. captive portal, no
    // direct internet), we can't prove a leak — but the proxy fetch itself
    // succeeded, so we mark verified=true. This is the conservative choice
    // that avoids false negatives when the user's network is partially
    // blocked.
    const result = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "5.6.7.8", loc: "FR" }),
      realIpFetcher: makeRealIpFetcher(null),
    });

    expect(result.verified).toBe(true);
    expect(result.exitIp).toBe("5.6.7.8");
    expect(result.realIp).toBeNull();
    expect(result.leakDetected).toBe(false);
  });

  test("proxy fetcher is called with the cloudflare trace URL", async () => {
    // Confirms the verifier is fetching from cloudflare, not some other
    // endpoint that might bypass the proxy.
    let capturedUrl: string | null = null;
    const proxyFetcher: ProxyFetcher = async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => FAKE_PROXY_TRACE("5.6.7.8", "FR"),
      };
    };
    await verifyTunnelTraffic({
      proxyFetcher,
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    expect(capturedUrl).toBe(TRACE_URL);
  });

  test("constants are the expected xray proxy + cloudflare trace URL", () => {
    // Guards against accidental refactor that would re-introduce the bug
    // (e.g. swapping the URL back to localhost:something-direct).
    expect(TUNNEL_HTTP_PROXY_URL).toBe("http://127.0.0.1:10809");
    expect(TRACE_URL).toBe("https://www.cloudflare.com/cdn-cgi/trace");
  });

  test("latencyMs is a non-negative number on all outcomes", async () => {
    // Even on failure, the latency field should be populated (callers may
    // surface it as "time-to-failure" in the UI).
    const ok = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "5.6.7.8", loc: "FR" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    const leak = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ ip: "1.2.3.4", loc: "US" }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });
    const err = await verifyTunnelTraffic({
      proxyFetcher: makeProxyFetcher({ throwErr: new Error("boom") }),
      realIpFetcher: makeRealIpFetcher("1.2.3.4"),
    });

    for (const r of [ok, leak, err]) {
      expect(r.latencyMs).not.toBeNull();
      expect(typeof r.latencyMs).toBe("number");
      expect((r.latencyMs as number) >= 0).toBe(true);
    }
  });
});
