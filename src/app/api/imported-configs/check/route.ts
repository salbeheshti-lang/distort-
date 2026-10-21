// DISTORT — /api/imported-configs/check
// POST: probe reachability of ALL configs (TCP + TLS handshake).
//
// 3-state reachability:
//   - "ok"   = TLS handshake succeeded (GREEN — truly reachable through DPI)
//   - "tcp"  = TCP succeeded but TLS failed (ORANGE — may work via Reality)
//   - "fail" = TCP connect failed (RED — but xray might still get through)
//
// The previous version only probed bucket="optimized" configs and only did TCP
// connect. Both limitations caused the "all pings red" bug:
//   1. Personal configs (favorite=true) imported via paste that scored < 55
//      were never probed — they appeared in the dropdown with no badge.
//   2. In Iran, DPI injects RST packets on bare TCP connects to VPN hosts.
//      A config that "fails" TCP may STILL WORK through xray's TLS/Reality/WS
//      transport. Reporting it as "fail" misled the user.
//
// Fix: probe ALL configs (sorted by favorite DESC, score DESC), use
// probeReachabilityTLS which does TCP + TLS handshake, and store the 3-state
// result so the UI can show ORANGE for "TCP ok / TLS failed" (not RED).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { probeReachabilityTLS } from "@/lib/anti-censor";

// Detect whether a config wants TLS/Reality based on its parsed fields.
// We pass this hint to the probe so it knows whether to attempt a TLS
// handshake even on non-standard ports (e.g. 8388 with security=tls).
function configWantsTls(c: {
  security: string;
  port: number;
  protocol: string;
}): boolean {
  const sec = (c.security || "").toLowerCase();
  // trojan is always TLS by spec
  if (c.protocol === "trojan") return true;
  if (sec === "tls" || sec === "reality") return true;
  // TLS-likely ports
  return (
    c.port === 443 ||
    c.port === 8443 ||
    c.port === 2053 ||
    c.port === 2083 ||
    c.port === 2087 ||
    c.port === 2096
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body?.limit ?? 50), 200);

    // Probe ALL configs (no bucket filter) — personal configs imported via
    // paste (favorite=true OR subscription.kind="manual") are now included.
    // Sort by favorite DESC + score DESC so the user's "best" configs are
    // always probed first when the limit caps the list.
    const configs = await db.importedConfig.findMany({
      orderBy: [{ favorite: "desc" }, { score: "desc" }],
      take: limit,
      include: { subscription: { select: { label: true, kind: true } } },
    });

    const results = await Promise.all(
      configs.map(async (c) => {
        // Decide whether to attempt TLS handshake for this config.
        const wantsTls = configWantsTls(c);
        // SNI hint: use the config's SNI field if set, else fall back to host.
        const serverName = c.sni || c.host;
        const probe = await probeReachabilityTLS(c.host, c.port, {
          serverName,
          tryTls: wantsTls,
        });

        // Map the probe method to a 3-state reach value stored in the DB:
        //   - method === "tls"  → "ok"   (truly reachable — GREEN)
        //   - method === "tcp"  → "tcp"  (TCP ok, TLS failed — ORANGE)
        //   - method === "fail" → "fail" (likely dead — RED, but try xray)
        const reach =
          probe.method === "tls"
            ? "ok"
            : probe.method === "tcp"
            ? "tcp"
            : "fail";

        await db.importedConfig.update({
          where: { id: c.id },
          data: { reach, latencyMs: probe.latencyMs, checkedAt: new Date() },
        });
        return {
          id: c.id,
          host: c.host,
          port: c.port,
          ok: probe.method === "tls" || probe.method === "tcp",
          reach,
          latencyMs: probe.latencyMs,
          method: probe.method,
        };
      })
    );

    const okCount = results.filter(
      (r) => r.method === "tls" || r.method === "tcp"
    ).length;
    const tlsCount = results.filter((r) => r.method === "tls").length;
    return NextResponse.json({
      checked: results.length,
      ok: okCount,
      tls: tlsCount,
      tcpOnly: okCount - tlsCount,
      results,
    });
  } catch (err) {
    console.error("[api/imported-configs/check] POST failed", err);
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
