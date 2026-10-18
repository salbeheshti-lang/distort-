// DISTORT — /api/tunnel/diagnostic

import { NextResponse } from "next/server";

export async function GET() {
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    checks: {} as Record<string, unknown>,
  };

  // 1. Companion API
  try {
    const resp = await fetch("http://127.0.0.1:10810/api/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json();
      (result.checks as Record<string, unknown>).companionApi = { ok: true, ...data };
    } else {
      (result.checks as Record<string, unknown>).companionApi = { ok: false, error: `HTTP ${resp.status}` };
    }
  } catch (e) {
    (result.checks as Record<string, unknown>).companionApi = {
      ok: false,
      error: `Not running: ${(e as Error).message}`,
      hint: "Desktop companion API (127.0.0.1:10810) is not responding. The Electron app may not have started it.",
    };
  }

  // 2. Tunnel status
  try {
    const resp = await fetch("http://127.0.0.1:10810/api/tunnel/status", {
      signal: AbortSignal.timeout(3000),
    });
    const data = resp.ok ? await resp.json() : { ok: false, error: `HTTP ${resp.status}` };
    (result.checks as Record<string, unknown>).tunnel = data;
  } catch (e) {
    (result.checks as Record<string, unknown>).tunnel = { ok: false, error: (e as Error).message };
  }

  // 3. Database
  try {
    const { db } = await import("@/lib/db");
    (result.checks as Record<string, unknown>).database = {
      ok: true,
      servers: await db.vpnServer.count(),
      configs: await db.importedConfig.count(),
      subscriptions: await db.subscription.count(),
    };
  } catch (e) {
    (result.checks as Record<string, unknown>).database = { ok: false, error: (e as Error).message };
  }

  // 4. Internet
  try {
    const resp = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    const data = resp.ok ? await resp.json() : { ip: null };
    (result.checks as Record<string, unknown>).internet = { ok: resp.ok, ip: data.ip };
  } catch (e) {
    (result.checks as Record<string, unknown>).internet = { ok: false, error: (e as Error).message };
  }

  // Summary
  const checks = result.checks as Record<string, { ok: boolean }>;
  result.overall = Object.values(checks).every((c) => c?.ok) ? "ALL_OK" : "ISSUES_FOUND";

  return NextResponse.json(result);
}
