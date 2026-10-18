// DISTORT — /api/tunnel/status
// Proxy: forwards to companion API

import { NextResponse } from "next/server";

export async function GET() {
  try {
    const resp = await fetch("http://127.0.0.1:10810/api/tunnel/status", {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json(
      { running: false, error: `Companion API unreachable: ${(e as Error).message}` },
      { status: 503 }
    );
  }
}
