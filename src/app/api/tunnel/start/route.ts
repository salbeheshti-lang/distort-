// DISTORT — /api/tunnel/start
// Proxy: forwards to companion API at 127.0.0.1:10810
// This avoids CORS issues — browser talks to Next.js, Next.js talks to companion

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const configUri = body.configUri;

    if (!configUri || typeof configUri !== "string") {
      return NextResponse.json({ ok: false, error: "configUri is required" }, { status: 400 });
    }

    const resp = await fetch("http://127.0.0.1:10810/api/tunnel/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configUri }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Companion API unreachable: ${(e as Error).message}. Is the desktop app running?` },
      { status: 503 }
    );
  }
}
