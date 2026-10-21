// DISTORT — anti-censorship utilities
// Helpers for the "stay online when the internet goes dark" mandate.

export type AntiCensorStatus = {
  level: "safe" | "degraded" | "hostile";
  label: string;
  description: string;
  recommendedProtocol: string;
  recommendedStealth: boolean;
  color: string;
};

// A heuristic snapshot of the local network climate. In a real client this
// would be measured by active probing (RST rates, TLS handshake success, etc.)
export function assessNetworkClimate(ping: number, stealthAvailable: boolean): AntiCensorStatus {
  // If latency is wildly inconsistent / high, assume DPI interference.
  if (ping > 250 || ping === 0) {
    return {
      level: "hostile",
      label: "Hostile — National filtering detected",
      description:
        "Active DPI / SNI blocking observed. Distort will switch to obfuscated transports (Trojan / VMess-WS-TLS) and rotate entry nodes automatically.",
      recommendedProtocol: "trojan",
      recommendedStealth: true,
      color: "#ff4d6d",
    };
  }
  if (ping > 120) {
    return {
      level: "degraded",
      label: "Degraded — Possible throttling",
      description:
        "Latency is elevated. Distort will prefer V2Ray/WS+TLS and keep WireGuard as a fallback. Obfuscation recommended.",
      recommendedProtocol: "v2ray",
      recommendedStealth: true,
      color: "#ffb020",
    };
  }
  return {
    level: "safe",
    label: "Safe — Open internet",
    description:
      "Network is healthy. WireGuard will give you the best speed. Stealth mode can stay on for privacy.",
    recommendedProtocol: "wireguard",
    recommendedStealth: stealthAvailable,
    color: "#10d9a0",
  };
}

// Auto-pick the best server for the user. Prefers stealth + low ping + low load.
export function pickAutoServer<T extends { ping: number; load: number; online: boolean; stealth: boolean; premium: boolean }>(
  servers: T[],
  opts: { stealth: boolean; allowPremium: boolean }
): T | undefined {
  const pool = servers.filter(
    (s) => s.online && (opts.allowPremium || !s.premium) && (!opts.stealth || s.stealth)
  );
  if (!pool.length) return servers.find((s) => s.online);
  return pool.sort((a, b) => {
    const sa = a.ping + a.load * 1.5 + (a.stealth ? 0 : 40);
    const sb = b.ping + b.load * 1.5 + (b.stealth ? 0 : 40);
    return sa - sb;
  })[0];
}

// REAL reachability check using actual TCP connection + TLS handshake.
// On the server (Node.js), this opens a real TCP socket to host:port.
// In the browser, falls back to a fetch-based probe.
//
// NOTE: This is the legacy probe — it only does TCP connect (no TLS handshake).
// For a more accurate "is this config truly usable" check, use
// `probeReachabilityTLS` below, which attempts a TLS handshake after the TCP
// connect (mirrors what xray actually does for VLESS/VMess/Trojan over TLS).
export async function probeReachability(host: string, port: number): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();

  // Server-side: use real TCP socket
  if (typeof window === "undefined") {
    try {
      const net = await import("net");
      return await new Promise((resolve) => {
        const socket = new net.Socket();
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve({ ok: false, latencyMs: Date.now() - start });
        }, 5000);
        socket.setTimeout(5000);
        socket.once("connect", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ ok: true, latencyMs: Date.now() - start });
        });
        socket.once("error", () => {
          clearTimeout(timeout);
          resolve({ ok: false, latencyMs: Date.now() - start });
        });
        socket.connect(port, host);
      });
    } catch {
      // fall through to fetch-based probe
    }
  }

  // Browser-side: use fetch with no-cors (limited but better than nothing)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(`https://${host}:${port}/`, {
      mode: "no-cors",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e: any) {
    // abort = timeout; network error might still mean "reachable but rejected"
    if (e?.name === "AbortError") {
      return { ok: false, latencyMs: Date.now() - start };
    }
    // A network error (ERR_CONNECTION_REFUSED, ERR_CONNECTION_RESET) often means
    // the host IS reachable but doesn't serve HTTP — for VPN purposes, this is OK.
    return { ok: true, latencyMs: Date.now() - start };
  }
}

// TLS-aware reachability probe — mirrors what xray actually does.
//
// 1. Opens a real TCP socket to host:port (5s timeout — Iran networks have
//    high latency + DPI interference, 3s was too short).
// 2. If TCP succeeds AND the port is likely TLS (443, 8443, 2053, 2083,
//    2087, 2096, or any port where the config has security=tls|reality),
//    attempts a real TLS handshake. This is the crucial test: if TLS succeeds,
//    the host is truly reachable through Iran's DPI. If TCP succeeds but TLS
//    fails, the host is up but DPI is interfering — Reality configs may still
//    work because they look like normal HTTPS to the censor.
// 3. Returns a 3-state result:
//    - "ok"   = TLS handshake succeeded (GREEN — truly reachable)
//    - "tcp"  = TCP succeeded but TLS failed (ORANGE — may work via Reality)
//    - "fail" = TCP connect failed (RED — but xray might still get through)
//
// Server-only (uses Node's `net` + `tls`). Browser falls back to the legacy
// `probeReachability` behavior.
export async function probeReachabilityTLS(
  host: string,
  port: number,
  opts?: { serverName?: string; tryTls?: boolean }
): Promise<{ ok: boolean; latencyMs: number; method: "tcp" | "tls" | "fail" }> {
  const start = Date.now();
  // Default: attempt TLS only if the port looks like a TLS port (443, 8443,
  // Cloudflare HTTPS alt ports). Caller can force-enable via opts.tryTls.
  const looksLikeTlsPort =
    port === 443 ||
    port === 8443 ||
    port === 2053 ||
    port === 2083 ||
    port === 2087 ||
    port === 2096;
  const tryTls = opts?.tryTls ?? looksLikeTlsPort;
  const serverName = opts?.serverName || host;

  // Browser-side fallback: no net/tls modules — defer to legacy probe.
  if (typeof window !== "undefined") {
    const r = await probeReachability(host, port);
    return { ok: r.ok, latencyMs: r.latencyMs, method: r.ok ? "tcp" : "fail" };
  }

  // Server-side: real TCP + TLS handshake.
  try {
    const net = await import("net");
    const tls = await import("tls");

    // Step 1: TCP connect
    const tcpOk = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5000);
      socket.setTimeout(5000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      socket.connect(port, host);
    });

    if (!tcpOk) {
      return { ok: false, latencyMs: Date.now() - start, method: "fail" };
    }

    // TCP succeeded. If we're not attempting TLS, return "tcp" (intermediate
    // state — host is up, but we can't verify TLS-level reachability).
    if (!tryTls) {
      return { ok: true, latencyMs: Date.now() - start, method: "tcp" };
    }

    // Step 2: TLS handshake. Use a fresh socket. servername controls SNI.
    const tlsOk = await new Promise<boolean>((resolve) => {
      const socket = tls.connect({
        host,
        port,
        servername: serverName,
        // Don't validate the cert — VPN hosts often use self-signed or
        // Reality-mimicked certs. We only care whether the handshake completes.
        rejectUnauthorized: false,
        // Short handshake timeout — TCP already succeeded so the host is up;
        // if TLS doesn't complete in 4s, DPI is probably interfering.
        timeout: 4000,
      });
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 4500);
      socket.once("secure", () => {
        clearTimeout(timeout);
        cleanup();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      });
      socket.once("timeout", () => {
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      });
    });

    if (tlsOk) {
      return { ok: true, latencyMs: Date.now() - start, method: "tls" };
    }
    // TCP ok, TLS failed — DPI may be interfering with TLS handshake.
    // Reality configs mimic legitimate TLS so they may still work.
    return { ok: true, latencyMs: Date.now() - start, method: "tcp" };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, method: "fail" };
  }
}
