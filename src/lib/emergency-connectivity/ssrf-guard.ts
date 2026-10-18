// DISTORT — SSRF guard for the Emergency Connectivity validate endpoint
//
// Rejects any host that resolves to / looks like a private or loopback
// address before we open a TCP connection to it. This prevents the
// validate endpoint from being abused as an internal port-scanner.
//
// DEFENSES (per user review issue #6):
//   1. String-based private IP/hostname check (fast, catches literal IPs)
//   2. DNS resolution check — resolves the hostname and rejects if ANY
//      resolved IP is private/loopback (catches DNS rebinding attacks
//      where "evil.com" resolves to 127.0.0.1)
//   3. Redirect follow protection — the caller must NOT follow redirects
//      to arbitrary URLs (a public URL could redirect to an internal one)

import { lookup } from "dns";
import { promisify } from "util";

const dnsLookup = promisify(lookup);

/**
 * Returns true if the host string is a private / loopback / link-local / ULA
 * address (or hostname). Conservative: false-positive (rejecting a public
 * hostname that *looks* like an internal one) is fine; false-negative is not.
 */
export function isPrivateHost(host: string): boolean {
  const h = (host || "").toLowerCase().trim();
  if (!h) return true; // empty = treat as private to be safe
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (/^127\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^::1$/.test(h)) return true;
  if (/^fc00:/i.test(h) || /^fd00:/i.test(h)) return true; // ULA
  // .local mDNS
  if (/\.local$/.test(h)) return true;
  // IPv6 bracketed
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    if (inner === "::1" || /^fc00:/i.test(inner) || /^fd00:/i.test(inner)) return true;
  }
  // Block common metadata endpoints (cloud instance metadata)
  if (h === "169.254.169.254") return true; // AWS/GCP/Azure metadata
  if (h === "metadata.google.internal") return true; // GCP metadata
  if (h === "metadata.azure.com") return true; // Azure metadata
  return false;
}

/**
 * Check if a single IP address is private/loopback/etc.
 * Used after DNS resolution to check resolved IPs.
 */
export function isPrivateIp(ip: string): boolean {
  const ipStr = ip.toLowerCase().trim();
  if (!ipStr) return true;
  if (ipStr === "127.0.0.1" || ipStr === "::1" || ipStr === "0.0.0.0") return true;
  if (/^10\./.test(ipStr)) return true;
  if (/^192\.168\./.test(ipStr)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ipStr)) return true;
  if (/^127\./.test(ipStr)) return true;
  if (/^169\.254\./.test(ipStr)) return true;
  if (/^fc00:/i.test(ipStr) || /^fd00:/i.test(ipStr)) return true;
  // IPv6-mapped IPv4 (::ffff:127.0.0.1)
  const v4Mapped = ipStr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    return isPrivateIp(v4Mapped[1]);
  }
  return false;
}

/**
 * Resolve a hostname and check ALL resolved IPs.
 * Returns true if ANY resolved IP is private (DNS rebinding protection).
 *
 * CRITICAL: This is the key defense against DNS rebinding attacks where
 * an attacker sets up "evil.com" to resolve to 127.0.0.1. The string-based
 * isPrivateHost check would miss this (evil.com doesn't look private),
 * but resolving it reveals the private IP.
 *
 * Server-side only (uses Node.js dns module). In the browser, we can't
 * do this — the browser's fetch follows its own DNS resolution.
 */
export async function resolvesToPrivateIp(hostname: string): Promise<boolean> {
  // If it's already an IP literal, use isPrivateIp directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return isPrivateIp(hostname);
  }

  try {
    // Resolve all A + AAAA records
    const result = await dnsLookup(hostname, { all: true, family: 0 });
    if (result.length === 0) {
      // Could not resolve — treat as private (fail-closed)
      return true;
    }
    // If ANY resolved IP is private, reject
    return result.some((r) => isPrivateIp(r.address));
  } catch {
    // DNS resolution failed — fail-closed (treat as private)
    return true;
  }
}

/**
 * Full SSRF check: string check + DNS resolution check.
 * Use this for server-side endpoints that open TCP connections.
 *
 * Returns { ok: boolean, reason: string }.
 */
export async function checkSsrfSafe(hostname: string): Promise<{ ok: boolean; reason: string }> {
  // 1. Fast string check
  if (isPrivateHost(hostname)) {
    return {
      ok: false,
      reason: `Hostname "${hostname}" matches a private/loopback/link-local pattern. SSRF blocked.`,
    };
  }

  // 2. DNS resolution check (catches rebinding)
  const resolvesPrivate = await resolvesToPrivateIp(hostname);
  if (resolvesPrivate) {
    return {
      ok: false,
      reason: `Hostname "${hostname}" resolves to a private or loopback IP. Possible DNS rebinding attack. SSRF blocked.`,
    };
  }

  return { ok: true, reason: "ok" };
}
