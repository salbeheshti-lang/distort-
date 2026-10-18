// DISTORT — /api/emergency/configs/validate
// POST: validate a config URI (structural + optional reachability probe)
//
// Input: ValidateConfigRequest = { input: string, probeReachability?: boolean }
// Output: ValidateConfigResponse — the three independent states
//   (structural / reachability / tunnel). tunnel is always "not-attempted"
//   here (real verification requires the client to spawn xray + send a
//   request through the proxy — that's not done by this endpoint).
//
// Uses the existing parseConfigUri from src/lib/config-parser.ts for parsing,
// and parseUriToRealConfig from src/lib/real-xray-config.ts for credential
// extraction (without persisting them).
//
// SSRF protection: if probeReachability=true, the host is validated via
// isPrivateHost() before any TCP connection is opened.
//
// Rate limit: 20 validations/minute per IP.

import { NextRequest, NextResponse } from "next/server";
import { parseConfigUri } from "@/lib/config-parser";
import { parseUriToRealConfig } from "@/lib/real-xray-config";
import { probeReachability } from "@/lib/anti-censor";
import { isPrivateHost, checkSsrfSafe } from "@/lib/emergency-connectivity/ssrf-guard";
import { isRateLimited, getClientIp } from "@/lib/emergency-connectivity/rate-limiter";
import type {
  StructuralValidity,
  ServerReachability,
  TunnelVerification,
  TransportType,
  ValidateConfigRequest,
  ValidateConfigResponse,
} from "@/lib/emergency-connectivity/types";

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Determine whether a parsed config has the credentials it needs for the
 * protocol to actually authenticate.
 */
function hasRequiredCredentials(protocol: string, real: any): boolean {
  if (protocol === "vmess" || protocol === "vless") {
    return !!real?.uuid;
  }
  if (protocol === "trojan") {
    return !!real?.password;
  }
  if (protocol === "ss") {
    return !!real?.password && !!real?.method;
  }
  // Unknown protocol — be conservative
  return false;
}

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = getClientIp(req);
  if (isRateLimited(`validate:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many validate requests. Try again in a minute." },
      { status: 429 }
    );
  }

  // Parse body
  let body: ValidateConfigRequest;
  try {
    body = (await req.json()) as ValidateConfigRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  if (!body.input || typeof body.input !== "string") {
    return NextResponse.json({ error: "input (string) is required" }, { status: 400 });
  }
  const input = body.input;
  const probe = body.probeReachability === true;

  // Defaults
  let structural: StructuralValidity = "invalid-syntax";
  let reachability: ServerReachability = "not-probed";
  const tunnel: TunnelVerification = "not-attempted";
  let latencyMs: number | null = null;
  const warnings: string[] = [];

  // Step 1: parse the URI
  const parsed = parseConfigUri(input);

  if (!parsed) {
    // Could be a completely unknown scheme or invalid syntax
    const trimmed = input.trim().toLowerCase();
    if (
      trimmed.startsWith("vless://") ||
      trimmed.startsWith("vmess://") ||
      trimmed.startsWith("trojan://") ||
      trimmed.startsWith("ss://")
    ) {
      structural = "invalid-syntax";
    } else {
      structural = "unsupported-protocol";
    }
    return NextResponse.json<ValidateConfigResponse>({
      structural,
      reachability,
      tunnel,
      parsed: null,
      latencyMs: null,
      summary: `Could not parse input as a vless/vmess/trojan/ss URI.`,
      warnings,
    });
  }

  // Step 2: extract real credentials (without persisting them)
  const real = parseUriToRealConfig(input);
  const hasCreds = hasRequiredCredentials(parsed.protocol, real);

  // Step 3: structural validity
  if (!parsed.host || !parsed.port || parsed.port <= 0) {
    structural = "missing-fields";
  } else if (!hasCreds) {
    structural = "missing-fields";
  } else {
    structural = "valid";
  }

  // Sanity warnings
  if (parsed.security === "none" || parsed.security === "") {
    warnings.push("Plaintext transport — likely filtered by DPI in restrictive networks.");
  }
  if (parsed.protocol === "ss" && parsed.security === "none") {
    warnings.push("Shadowsocks without plugin is detectable by GFW/QoS.");
  }
  if (parsed.protocol === "vmess" && parsed.security !== "tls" && parsed.security !== "reality") {
    warnings.push("VMess without TLS — easily fingerprinted.");
  }

  // Step 4: optional reachability probe
  if (probe && structural === "valid" && parsed.host && parsed.port > 0) {
    // SSRF check — refuse to probe private/loopback/link-local addresses.
    // Per user review issue #6: do BOTH string check AND DNS resolution check
    // to prevent DNS rebinding attacks (where "evil.com" resolves to 127.0.0.1).
    const ssrfCheck = await checkSsrfSafe(parsed.host);
    if (!ssrfCheck.ok) {
      warnings.push(ssrfCheck.reason);
      reachability = "unreachable";
    } else {
      try {
        const r = await probeReachability(parsed.host, parsed.port);
        reachability = r.ok ? "reachable" : "unreachable";
        latencyMs = r.latencyMs;
        if (!r.ok) {
          warnings.push(
            `TCP connect to ${parsed.host}:${parsed.port} failed/timed out (${r.latencyMs}ms).`
          );
        }
      } catch {
        reachability = "unreachable";
        warnings.push(`Reachability probe threw — host may be unreachable.`);
      }
    }
  } else if (probe && structural !== "valid") {
    warnings.push("Skipped reachability probe because structural validity is not 'valid'.");
  }

  // Step 5: build the response — NO credentials are returned.
  const summaryParts: string[] = [];
  summaryParts.push(`Protocol: ${parsed.protocol}.`);
  summaryParts.push(`Host: ${parsed.host || "(missing)"}:${parsed.port || "?"}.`);
  summaryParts.push(`Security: ${parsed.security}.`);
  summaryParts.push(`Network: ${parsed.network}.`);
  if (parsed.sni) summaryParts.push(`SNI: ${parsed.sni}.`);
  summaryParts.push(
    hasCreds ? "Credentials present." : "Missing required credentials."
  );
  if (probe) {
    if (reachability === "reachable") {
      summaryParts.push(`Reachable (${latencyMs}ms).`);
    } else if (reachability === "unreachable") {
      summaryParts.push("Not reachable.");
    }
  }
  summaryParts.push("Tunnel verification requires the client to spawn xray + send real traffic — not done by this endpoint.");

  return NextResponse.json<ValidateConfigResponse>({
    structural,
    reachability,
    tunnel,
    parsed: {
      protocol: parsed.protocol as TransportType,
      host: parsed.host || null,
      port: parsed.port || null,
      network: parsed.network || null,
      security: parsed.security || null,
      sni: parsed.sni || null,
      hasRequiredCredentials: hasCreds,
      antiDpiScore: parsed.score,
      flags: parsed.flags,
    },
    latencyMs,
    summary: summaryParts.join(" "),
    warnings,
  });
}
