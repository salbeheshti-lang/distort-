// DISTORT — /api/tunnel/stop
// Proxy: forwards to companion API

import { NextResponse } from "next/server";

export async function POST() {
  try {
    const resp = await fetch("http://127.0.0.1:10810/api/tunnel/stop", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Companion API unreachable: ${(e as Error).message}` },
      { status: 503 }
    );
  }
}
