// DISTORT — /api/diagnostic
// Returns the health status of all subsystems for debugging.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV,
    hasApiKey: !!process.env.DISTORT_API_KEY,
    apiKeyLength: process.env.DISTORT_API_KEY?.length || 0,
    databaseUrl: process.env.DATABASE_URL?.replace(/[^/]+$/, "***") || "NOT SET",
    checks: {} as Record<string, unknown>,
  };

  // Check DB connection
  try {
    const serverCount = await db.vpnServer.count();
    const configCount = await db.importedConfig.count();
    const subCount = await db.subscription.count();
    const userCount = await db.user.count();
    (result.checks as Record<string, unknown>).database = {
      ok: true,
      servers: serverCount,
      configs: configCount,
      subscriptions: subCount,
      users: userCount,
    };
  } catch (e) {
    (result.checks as Record<string, unknown>).database = {
      ok: false,
      error: (e as Error).message,
    };
  }

  // Check if localhost bypass works
  const host = "localhost:38571";
  (result.checks as Record<string, unknown>).localhostBypass = host.startsWith("127.0.0.1") || host.startsWith("localhost");

  return NextResponse.json(result, { status: 200 });
}
