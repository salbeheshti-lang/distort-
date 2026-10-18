// DISTORT — API authentication middleware
// Protects sensitive endpoints from unauthenticated access.
//
// HOW IT WORKS:
// - DISTORT_API_KEY env var MUST be set (otherwise the server refuses to start
//   in production — see the startup check below).
// - All protected endpoints require an `x-api-key` header matching it.
// - Query-param (?key=) is NOT supported (to avoid logging keys in URLs).
//
// SECURITY:
// - Key is compared in constant time to prevent timing attacks.
// - If key is not set in production (NODE_ENV=production), the server
//   refuses to serve protected endpoints and returns 503.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

const API_KEY = process.env.DISTORT_API_KEY || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function isAuthConfigured(): boolean {
  return API_KEY.length >= 32; // require at least 32 chars
}

export function checkAuth(req: NextRequest): NextResponse | null {
  // DESKTOP MODE: if the request comes from localhost (the bundled desktop
  // app's Next.js server), bypass auth entirely. The desktop app runs on
  // the user's machine and there's no remote attacker to protect against.
  const host = req.headers.get("host") || "";
  const isLocalhost = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("::1");
  if (isLocalhost) {
    // Localhost = desktop app — allow all requests regardless of API key
    return null;
  }

  // In production (remote deployment), API key MUST be set. If not, refuse to serve.
  if (IS_PRODUCTION && !isAuthConfigured()) {
    return NextResponse.json(
      {
        error: "Server misconfigured: DISTORT_API_KEY not set or too short (min 32 chars).",
        hint: "Set DISTORT_API_KEY env var to a strong random string (at least 32 characters).",
      },
      { status: 503 }
    );
  }

  // If no key configured (dev mode), endpoints are open — but we add a WARNING header.
  if (!isAuthConfigured()) {
    const response = NextResponse.next();
    response.headers.set("X-Distort-Warning", "DEV MODE: API authentication not configured. Do NOT expose to the internet.");
    console.warn("[auth] DEV MODE: DISTORT_API_KEY not set. Protected endpoints are OPEN. Do NOT expose to internet.");
    return null;
  }

  // Key MUST come from header — NOT query param (to avoid logging).
  const headerKey = req.headers.get("x-api-key");
  if (headerKey && safeCompare(headerKey, API_KEY)) {
    return null;
  }

  return NextResponse.json(
    {
      error: "Unauthorized — valid API key required",
      hint: "Send your API key in the x-api-key header.",
    },
    { status: 401 }
  );
}

// Log a warning at module load if auth is not configured.
if (!isAuthConfigured()) {
  console.warn("⚠️  DISTORT SECURITY WARNING: DISTORT_API_KEY is not set or too short.");
  console.warn("⚠️  All protected API endpoints are OPEN (no authentication).");
  console.warn("⚠️  This is OK for local development but DANGEROUS if exposed to the internet.");
  console.warn("⚠️  Set DISTORT_API_KEY=<32+ char random string> in your environment.");
}

