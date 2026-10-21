// DISTORT — /api/imported-configs/import
// POST: accept raw text (vmess://, vless://, trojan://, ss:// lines) OR a single URI,
// parse and persist. Body: { raw: string, source?: string }
//
// PROTECTED: Requires authentication if DISTORT_API_KEY is set.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importRawConfigs } from "@/lib/subscription-fetcher";
import { parseConfigUri } from "@/lib/config-parser";
import { checkAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const authFail = checkAuth(req);
  if (authFail) return authFail;
  try {
    const body = await req.json();
    const raw = body?.raw;
    const source = body?.source ?? "manual";

    if (!raw || typeof raw !== "string") {
      return NextResponse.json({ error: "raw (string) is required" }, { status: 400 });
    }

    // Single URI fast-path: if it's one line and looks like a known scheme,
    // import just that one as a favorite.
    const trimmed = raw.trim();
    const lines = trimmed.split(/\r?\n/).filter(Boolean);

    if (lines.length === 1) {
      const parsed = parseConfigUri(lines[0]);
      if (!parsed) {
        // Diagnostic: tell the user WHY parsing failed so they can fix it.
        const line = lines[0];
        let reason = "Unknown scheme or malformed URI";
        const lower = line.toLowerCase();
        if (!lower.startsWith("vmess://") && !lower.startsWith("vless://") && !lower.startsWith("trojan://") && !lower.startsWith("ss://")) {
          reason = `Unsupported scheme — only vmess://, vless://, trojan://, ss:// are recognized. Got: "${line.slice(0, 30)}${line.length > 30 ? "…" : ""}"`;
        } else if (lower.startsWith("vmess://")) {
          reason = "vmess:// URI must be base64-encoded JSON. The base64 payload could not be decoded or did not contain valid JSON. Make sure you copied the full vmess:// link.";
        } else if (lower.startsWith("vless://")) {
          reason = "vless:// URI must be in the form vless://uuid@host:port?params#label. Check that host and port are present.";
        } else if (lower.startsWith("trojan://")) {
          reason = "trojan:// URI must be in the form trojan://password@host:port?params#label. Check that host and port are present.";
        } else if (lower.startsWith("ss://")) {
          reason = "ss:// URI must be either ss://base64(method:pass)@host:port#label or ss://base64(method:pass@host:port)#label. Could not extract host:port.";
        }
        return NextResponse.json({ error: `Could not parse the provided URI: ${reason}` }, { status: 400 });
      }
      // Validate host + port are non-empty (some URIs parse but produce empty host).
      if (!parsed.host || !parsed.port || parsed.port <= 0 || parsed.port > 65535) {
        return NextResponse.json({
          error: `Parsed URI is missing host or port. Got host="${parsed.host}", port=${parsed.port}. The URI format may be incomplete or non-standard.`,
        }, { status: 400 });
      }
      let sub = await db.subscription.findFirst({ where: { kind: "manual", label: source } });
      if (!sub) {
        sub = await db.subscription.create({
          data: { label: source, url: "manual://paste", kind: "manual", intervalMin: 0, enabled: false },
        });
      }
      const created = await db.importedConfig.create({
        data: {
          subscriptionId: sub.id,
          protocol: parsed.protocol,
          uri: parsed.raw,
          label: parsed.label ?? null,
          host: parsed.host,
          port: parsed.port,
          network: parsed.network,
          security: parsed.security,
          sni: parsed.sni ?? null,
          path: parsed.path ?? null,
          hostHeader: parsed.hostHeader ?? null,
          flow: parsed.flow ?? null,
          country: parsed.country ?? null,
          score: parsed.score,
          flags: parsed.flags.join(","),
          bucket: parsed.score >= 55 ? "optimized" : "all",
          favorite: true,
        },
      });
      return NextResponse.json({ ok: true, count: 1, config: created }, { status: 201 });
    }

    // Multi-line: bulk import
    let count: number;
    try {
      count = await importRawConfigs(raw, source);
    } catch (e) {
      // Surface the actual reason (e.g. "No valid configs found in input")
      const msg = (e as Error)?.message ?? "Bulk import failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ ok: true, count }, { status: 201 });
  } catch (err) {
    console.error("[api/imported-configs/import] POST failed", err);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
