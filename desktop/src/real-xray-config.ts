// DISTORT — Real xray-core config builder
// Uses REAL credentials from Community Mesh configs (vmess/vless/trojan/ss URIs)
// Adds TUN inbound for system-wide tunneling on Windows (via wintun.dll)
// NO fake/placeholder credentials — only real ones from parsed subscriptions.

import type { ParsedConfig } from "./config-parser";

export type RealServerConfig = {
  // Either a parsed Community Mesh config (real credentials)
  parsed?: ParsedConfig;
  // Or raw connection details
  protocol: string;
  host: string;
  port: number;
  // Protocol-specific real credentials
  uuid?: string;        // vmess/vless
  password?: string;    // trojan/ss
  method?: string;      // ss
  alterId?: number;     // vmess
  network?: string;     // tcp/ws/grpc
  security?: string;    // none/tls/reality
  sni?: string;
  path?: string;
  hostHeader?: string;
  flow?: string;        // xtls-rprx-vision
  pbk?: string;         // reality public key
  sid?: string;         // reality short id
  fp?: string;          // fingerprint (chrome/firefox/safari)
};

/**
 * Parse a raw vmess://, vless://, trojan://, ss:// URI into RealServerConfig.
 * Returns null if the URI can't be parsed.
 */
export function parseUriToRealConfig(uri: string): RealServerConfig | null {
  // Re-use the existing config-parser to do the heavy lifting
  // then extract the real credentials.
  const { parseConfigUri } = require("./config-parser");
  const parsed: any = parseConfigUri(uri);
  if (!parsed) return null;

  const base: RealServerConfig = {
    parsed,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    network: parsed.network,
    security: parsed.security,
    sni: parsed.sni,
    path: parsed.path,
    hostHeader: parsed.hostHeader,
    flow: parsed.flow,
  };

  // Extract protocol-specific credentials from the raw URI
  if (parsed.protocol === "vmess") {
    // vmess://base64(json) — extract uuid from json
    try {
      const b64 = uri.slice("vmess://".length);
      const json = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      const obj = JSON.parse(json);
      base.uuid = obj.id;
      base.alterId = Number(obj.aid || 0);
      base.sni = base.sni || obj.sni;
      base.path = base.path || obj.path;
      base.hostHeader = base.hostHeader || obj.host;
      if (obj.tls === "tls") base.security = "tls";
    } catch {}
  } else if (parsed.protocol === "vless") {
    // vless://uuid@host:port?query#label
    const noScheme = uri.slice("vless://".length);
    const qIdx = noScheme.indexOf("?");
    const hashIdx = noScheme.indexOf("#");
    const beforeHash = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
    const beforeQuery = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
    const at = beforeQuery.lastIndexOf("@");
    if (at >= 0) base.uuid = beforeQuery.slice(0, at);
    // reality params
    const query = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : "";
    const params = new URLSearchParams(query);
    base.pbk = params.get("pbk") || undefined;
    base.sid = params.get("sid") || undefined;
    base.fp = params.get("fp") || "chrome";
  } else if (parsed.protocol === "trojan") {
    // trojan://password@host:port?query#label
    const noScheme = uri.slice("trojan://".length);
    const hashIdx = noScheme.indexOf("#");
    const beforeHash = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
    const at = beforeHash.lastIndexOf("@");
    if (at >= 0) base.password = decodeURIComponent(beforeHash.slice(0, at));
  } else if (parsed.protocol === "ss") {
    // ss://base64(method:pass)@host:port#label OR ss://base64(method:pass@host:port)#label
    const noScheme = uri.slice("ss://".length);
    const hashIdx = noScheme.indexOf("#");
    const beforeHash = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
    let userInfo = "";
    if (beforeHash.includes("@")) {
      userInfo = beforeHash.slice(0, beforeHash.lastIndexOf("@"));
    } else {
      try {
        const decoded = Buffer.from(beforeHash, "base64").toString("utf-8");
        if (decoded.includes("@")) userInfo = decoded.slice(0, decoded.lastIndexOf("@"));
      } catch {}
    }
    if (userInfo.includes(":")) {
      const [method, pass] = userInfo.split(":");
      base.method = method;
      base.password = pass;
    }
  }

  return base;
}

/**
 * Build a real xray-core config JSON for system-wide tunneling.
 *
 * Key difference from the old version:
 * 1. Uses REAL credentials (uuid/password) from the parsed URI — no fakes.
 * 2. Adds a `tun` inbound so xray creates the TUN device itself (Windows wintun).
 *    This makes the VPN system-wide — no manual SOCKS routing needed.
 * 3. Adds a `socks` + `http` inbound for apps that prefer proxy mode.
 */
export function buildRealXrayConfig(cfg: RealServerConfig, opts?: { tun?: boolean; socksPort?: number; httpPort?: number; dnsLeakProtection?: boolean }): object {
  if (!cfg || !cfg.host || !cfg.port) throw new Error("Invalid server config");

  const useTun = opts?.tun !== false; // default true
  const socksPort = opts?.socksPort ?? 10808;
  const httpPort = opts?.httpPort ?? 10809;
  const dnsProtect = opts?.dnsLeakProtection !== false;

  const inbounds: any[] = [];

  // TUN inbound for system-wide VPN (Windows: wintun.dll, Linux: /dev/net/tun)
  // xray-core 1.8+ supports this. Routes all traffic through xray.
  if (useTun) {
    inbounds.push({
      tag: "tun-in",
      listen: "127.0.0.1",
      protocol: "tun",
      settings: {
        ip: "172.19.0.1",
        mtu: 1420,
        routes: ["0.0.0.0/0", "::/0"],
        excludeRoutes: [`${cfg.host}/32`],
        hijackDns: dnsProtect,
        autoRoute: true,
        strictRoute: true,
      },
      sniffing: { enabled: true },
    });
  }

  // SOCKS5 inbound (for proxy-mode apps)
  inbounds.push({
    tag: "socks-in",
    port: socksPort,
    listen: "127.0.0.1",
    protocol: "socks",
    settings: { auth: "noauth", udp: true },
    sniffing: { enabled: true },
  });

  // HTTP proxy inbound
  inbounds.push({
    tag: "http-in",
    port: httpPort,
    listen: "127.0.0.1",
    protocol: "http",
    settings: {},
    sniffing: { enabled: true },
  });

  // Build the outbound with REAL credentials
  const outbound = buildRealOutbound(cfg);
  if (!outbound) throw new Error(`Unsupported protocol: ${cfg.protocol}`);

  return {
    log: {
      loglevel: "warning",
    },
    dns: dnsProtect
      ? {
          servers: [
            "1.1.1.1",
            "9.9.9.9",
          ],
        }
      : undefined,
    inbounds,
    outbounds: [
      outbound,
      { tag: "block", protocol: "blackhole" },
      { tag: "dns-out", protocol: "dns" },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [],
    },
  };
}

function buildRealOutbound(cfg: RealServerConfig): any | null {
  const tag = "distort-out";

  if (cfg.protocol === "vmess") {
    if (!cfg.uuid) throw new Error("VMess requires a real UUID");
    return {
      tag,
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: cfg.host,
            port: cfg.port,
            users: [
              {
                id: cfg.uuid, // REAL UUID
                alterId: cfg.alterId ?? 0,
                security: "auto",
              },
            ],
          },
        ],
      },
      streamSettings: buildStreamSettings(cfg),
      mux: { enabled: cfg.network === "ws", concurrency: 8 },
    };
  }

  if (cfg.protocol === "vless") {
    if (!cfg.uuid) throw new Error("VLESS requires a real UUID");
    const user: any = {
      id: cfg.uuid, // REAL UUID
      encryption: "none",
    };
    if (cfg.flow) user.flow = cfg.flow; // xtls-rprx-vision
    return {
      tag,
      protocol: "vless",
      settings: {
        vnext: [{ address: cfg.host, port: cfg.port, users: [user] }],
      },
      streamSettings: buildStreamSettings(cfg),
    };
  }

  if (cfg.protocol === "trojan") {
    if (!cfg.password) throw new Error("Trojan requires a real password");
    return {
      tag,
      protocol: "trojan",
      settings: {
        servers: [
          {
            address: cfg.host,
            port: cfg.port,
            password: cfg.password, // REAL password
          },
        ],
      },
      streamSettings: buildStreamSettings(cfg),
    };
  }

  if (cfg.protocol === "ss") {
    if (!cfg.password || !cfg.method) throw new Error("Shadowsocks requires real password + method");
    return {
      tag,
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: cfg.host,
            port: cfg.port,
            method: cfg.method, // REAL cipher (chacha20-ietf-poly1305, aes-256-gcm, etc.)
            password: cfg.password, // REAL password
          },
        ],
      },
      streamSettings: buildStreamSettings(cfg),
    };
  }

  return null;
}

function buildStreamSettings(cfg: RealServerConfig): any {
  const ss: any = {
    network: cfg.network || "tcp",
  };

  if (cfg.security === "tls") {
    ss.security = "tls";
    ss.tlsSettings = {
      serverName: cfg.sni || cfg.host,
      allowInsecure: false,
      fingerprint: cfg.fp || "chrome",
    };
  } else if (cfg.security === "reality") {
    ss.security = "reality";
    const realitySettings: any = {
      serverName: cfg.sni || "",
      publicKey: cfg.pbk || "", // REAL reality public key
      shortId: cfg.sid || "",
      fingerprint: cfg.fp || "chrome",
    };
    ss.realitySettings = realitySettings;
  } else {
    ss.security = "none";
  }

  if (cfg.network === "ws") {
    ss.wsSettings = {
      path: cfg.path || "/",
      headers: cfg.hostHeader ? { Host: cfg.hostHeader } : undefined,
    };
  } else if (cfg.network === "grpc") {
    ss.grpcSettings = {
      serviceName: cfg.path || "",
      multiMode: false,
    };
  }

  return ss;
}
