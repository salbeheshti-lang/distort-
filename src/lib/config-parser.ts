// DISTORT — config URI parser
// Parses vmess://, vless://, trojan://, ss:// URIs into a normalized shape
// and scores them for "optimization" (TLS / Reality / CDN-fronted / low-latency hints).

export type ParsedConfig = {
  id: string;
  protocol: "vmess" | "vless" | "trojan" | "ss" | "unknown";
  raw: string;
  // network bits
  host: string;
  port: number;
  network: string; // tcp, ws, grpc, etc.
  security: string; // none, tls, reality
  sni?: string;
  path?: string;
  hostHeader?: string;
  flow?: string;
  // meta
  label?: string;
  country?: string;
  score: number; // 0..100 — higher = more optimized
  flags: string[]; // human-readable tags: ["TLS","Reality","CDN","WS","Vision"]
};

function b64decode(s: string): string {
  // vmess uses URL-safe base64 without padding sometimes
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function guessCountry(host: string, sni?: string): string | undefined {
  const h = (host || "").toLowerCase();
  const s = (sni || "").toLowerCase();
  const text = `${h} ${s}`;
  if (text.includes(".ir") || text.includes("iran")) return "Iran";
  if (text.includes(".de") || text.includes("germany") || text.includes("frankfurt")) return "Germany";
  if (text.includes(".nl") || text.includes("netherlands") || text.includes("amsterdam")) return "Netherlands";
  if (text.includes(".fr") || text.includes("france") || text.includes("paris")) return "France";
  if (text.includes(".fi") || text.includes("finland") || text.includes("helsinki")) return "Finland";
  if (text.includes(".us") || text.includes("united") || text.includes("newyork") || text.includes("los")) return "United States";
  if (text.includes(".uk") || text.includes(".gb") || text.includes("london")) return "United Kingdom";
  if (text.includes(".jp") || text.includes("japan") || text.includes("tokyo")) return "Japan";
  if (text.includes(".sg") || text.includes("singapore")) return "Singapore";
  if (text.includes(".tr") || text.includes("turkey") || text.includes("istanbul")) return "Turkey";
  if (text.includes(".ae") || text.includes("dubai") || text.includes("emirates")) return "UAE";
  return undefined;
}

function score(
  security: string,
  network: string,
  hasSni: boolean,
  flow: string,
  hasTls: boolean,
  hasReality: boolean
): { score: number; flags: string[] } {
  let s = 30;
  const flags: string[] = [];
  if (hasReality) {
    s += 35;
    flags.push("Reality");
  } else if (hasTls || security === "tls") {
    s += 25;
    flags.push("TLS");
  } else {
    // plaintext — penalize heavily, likely filtered
    s -= 15;
  }
  if (network === "ws") {
    s += 12;
    flags.push("WS");
  } else if (network === "grpc") {
    s += 14;
    flags.push("gRPC");
  }
  if (hasSni) {
    s += 8;
    flags.push("SNI");
  }
  if (flow && flow.includes("vision")) {
    s += 12;
    flags.push("Vision");
  }
  if (network === "tcp" && (security === "none" || security === "")) {
    // tcp+none is the most-blocked; demote it
    s -= 10;
  }
  return { score: Math.max(0, Math.min(100, s)), flags };
}

export function parseConfigUri(line: string): ParsedConfig | null {
  const raw = (line || "").trim();
  if (!raw) return null;

  try {
    if (raw.startsWith("vmess://")) {
      const json = b64decode(raw.slice("vmess://".length));
      if (!json) return null;
      const obj = JSON.parse(json);
      const host = obj.add || "";
      const port = Number(obj.port || 0);
      const network = obj.net || "tcp";
      const security = obj.tls === "tls" ? "tls" : obj.tls === "reality" ? "reality" : "none";
      const sni = obj.sni || "";
      const path = obj.path || "";
      const hostHeader = obj.host || "";
      const flow = "";
      const hasTls = security === "tls";
      const hasReality = security === "reality";
      const { score: sc, flags } = score(security, network, !!sni, "", hasTls, hasReality);
      return {
        id: uid(),
        protocol: "vmess",
        raw,
        host,
        port,
        network,
        security,
        sni: sni || undefined,
        path: path || undefined,
        hostHeader: hostHeader || undefined,
        flow: undefined,
        label: obj.ps || `vmess-${host}:${port}`,
        country: guessCountry(host, sni),
        score: sc,
        flags,
      };
    }

    if (raw.startsWith("vless://")) {
      // vless://uuid@host:port?query#label
      const noScheme = raw.slice("vless://".length);
      const hashIdx = noScheme.indexOf("#");
      const label = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : undefined;
      const beforeHash = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
      const qIdx = beforeHash.indexOf("?");
      const hostPort = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
      const query = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : "";
      const params = new URLSearchParams(query);
      const at = hostPort.lastIndexOf("@");
      const hostAndPort = at >= 0 ? hostPort.slice(at + 1) : hostPort;
      // split host:port (last colon) — handles IPv4 and bracketed IPv6
      let host = hostAndPort;
      let port = 443;
      if (hostAndPort.startsWith("[")) {
        // IPv6 literal [::1]:port
        const endBracket = hostAndPort.indexOf("]");
        host = hostAndPort.slice(1, endBracket);
        const after = hostAndPort.slice(endBracket + 1);
        const colon = after.indexOf(":");
        if (colon >= 0) port = Number(after.slice(colon + 1)) || port;
      } else {
        const lastColon = hostAndPort.lastIndexOf(":");
        if (lastColon >= 0) {
          host = hostAndPort.slice(0, lastColon);
          port = Number(hostAndPort.slice(lastColon + 1)) || port;
        }
      }
      const network = params.get("type") || "tcp";
      const security = params.get("security") || "none";
      const sni = params.get("sni") || "";
      const path = params.get("path") ? decodeURIComponent(params.get("path")!) : "";
      const hostHeader = params.get("host") || "";
      const flow = params.get("flow") || "";
      const hasTls = security === "tls";
      const hasReality = security === "reality";
      const { score: sc, flags } = score(security, network, !!sni, flow || "", hasTls, hasReality);
      return {
        id: uid(),
        protocol: "vless",
        raw,
        host,
        port,
        network,
        security,
        sni: sni || undefined,
        path: path || undefined,
        hostHeader: hostHeader || undefined,
        flow: flow || undefined,
        label: label || `vless-${host}:${port}`,
        country: guessCountry(host, sni),
        score: sc,
        flags,
      };
    }

    if (raw.startsWith("trojan://")) {
      const u = new URL(raw);
      const host = u.hostname;
      const port = Number(u.port || 443);
      const params = u.searchParams;
      const network = params.get("type") || "tcp";
      const security = params.get("security") || "tls";
      const sni = params.get("sni") || "";
      const path = params.get("path") ? decodeURIComponent(params.get("path")!) : "";
      const hasTls = true; // trojan is always TLS
      const { score: sc, flags } = score(security, network, !!sni, "", hasTls, false);
      return {
        id: uid(),
        protocol: "trojan",
        raw,
        host,
        port,
        network,
        security,
        sni: sni || undefined,
        path: path || undefined,
        hostHeader: undefined,
        flow: undefined,
        label: decodeURIComponent(u.hash.slice(1)) || `trojan-${host}:${port}`,
        country: guessCountry(host, sni),
        score: sc,
        flags,
      };
    }

    if (raw.startsWith("ss://")) {
      // ss://base64(method:pass)@host:port#label  OR  ss://base64(method:pass@host:port)#label
      const noScheme = raw.slice("ss://".length);
      const hashIdx = noScheme.indexOf("#");
      const label = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : undefined;
      const beforeHash = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
      let host = "";
      let port = 0;
      const atIdx = beforeHash.indexOf("@");
      if (atIdx >= 0) {
        const hostPort = beforeHash.slice(atIdx + 1);
        host = hostPort.split(":")[0];
        port = Number(hostPort.split(":")[1] || 0);
      } else {
        const decoded = b64decode(beforeHash);
        const at = decoded.lastIndexOf("@");
        if (at >= 0) {
          const hostPort = decoded.slice(at + 1);
          host = hostPort.split(":")[0];
          port = Number(hostPort.split(":")[1] || 0);
        }
      }
      const security = "none";
      const network = "tcp";
      const { score: sc, flags } = score(security, network, false, "", false, false);
      return {
        id: uid(),
        protocol: "ss",
        raw,
        host,
        port,
        network,
        security,
        label: label || `ss-${host}:${port}`,
        country: guessCountry(host),
        score: sc,
        flags: flags.includes("TLS") ? flags : [...flags, "SS"],
      };
    }
  } catch (e) {
    console.error("[config-parser] parse error for", raw.slice(0, 80), ":", (e as Error)?.message);
    return null;
  }
  return null;
}

export function parseSubscription(text: string): ParsedConfig[] {
  const lines = (text || "").split(/\r?\n/);
  const out: ParsedConfig[] = [];
  for (const line of lines) {
    const parsed = parseConfigUri(line);
    if (parsed) out.push(parsed);
  }
  // de-dup by host+port+protocol
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.protocol}:${c.host}:${c.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Lightweight URI counter — used by the client-side ImportDialog preview.
// Returns counts BY PROTOCOL SCHEME without invoking the full parseConfigUri
// (which uses Buffer for vmess base64 decoding). Browser-safe (no Node APIs).
// A line is counted if it starts with one of the 4 supported schemes.
export function countConfigUris(text: string): { total: number; byProtocol: Record<string, number> } {
  const byProtocol: Record<string, number> = {};
  let total = 0;
  const lines = (text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(vmess|vless|trojan|ss):\/\//i);
    if (m) {
      const proto = m[1].toLowerCase();
      byProtocol[proto] = (byProtocol[proto] || 0) + 1;
      total++;
    }
  }
  return { total, byProtocol };
}

// Pick the most optimized configs: score >= 55 (TLS / Reality / WS / gRPC).
export function pickOptimized(configs: ParsedConfig[], limit = 60): ParsedConfig[] {
  return configs
    .filter((c) => c.score >= 55 && c.host && c.port > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
