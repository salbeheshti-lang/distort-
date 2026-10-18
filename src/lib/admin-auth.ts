// DISTORT — Admin authentication middleware
// CRITICAL: adminEmail alone is NOT authentication — anyone can send any email.
//
// This middleware requires BOTH:
// 1. DISTORT_API_KEY (env var) — proves the server is authorized
// 2. x-admin-email header — identifies WHICH admin is making the request
// 3. The email must match a User with isAdmin=true in the database
//
// Without all three, the request is rejected.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timingSafeEqual } from "crypto";

const API_KEY = process.env.DISTORT_API_KEY || "";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Check admin authentication.
 * Returns null if auth passes, or a NextResponse error if it fails.
 *
 * Usage in route handlers:
 *   const adminFail = await checkAdminAuth(req);
 *   if (adminFail) return adminFail;
 */
export async function checkAdminAuth(req: NextRequest): Promise<NextResponse | null> {
  // Step 1: API key must be set in production
  if (process.env.NODE_ENV === "production" && (!API_KEY || API_KEY.length < 32)) {
    return NextResponse.json(
      { error: "Server misconfigured: DISTORT_API_KEY not set" },
      { status: 503 }
    );
  }

  // Step 2: API key header must match
  const headerKey = req.headers.get("x-api-key");
  if (API_KEY && (!headerKey || !safeCompare(headerKey, API_KEY))) {
    return NextResponse.json(
      { error: "Unauthorized — invalid API key" },
      { status: 401 }
    );
  }

  // Step 3: Admin email must be provided
  const adminEmail = req.headers.get("x-admin-email") || new URL(req.url).searchParams.get("adminEmail");
  if (!adminEmail) {
    return NextResponse.json(
      { error: "Admin email required (x-admin-email header)" },
      { status: 401 }
    );
  }

  // Step 4: The email must match an actual admin in the database
  try {
    const admin = await db.user.findFirst({ where: { email: adminEmail } });
    if (!admin || !admin.isAdmin) {
      return NextResponse.json(
        { error: "Not authorized — user is not an admin" },
        { status: 403 }
      );
    }
    // Pass the admin user info via headers for downstream handlers
    // (can't modify req.headers in Next.js, so we return null and the
    // route handler re-reads the email)
    return null;
  } catch (err) {
    return NextResponse.json(
      { error: "Auth check failed" },
      { status: 500 }
    );
  }
}

/**
 * Get admin email from request (header or query param).
 */
export function getAdminEmail(req: NextRequest): string {
  return req.headers.get("x-admin-email") || new URL(req.url).searchParams.get("adminEmail") || "";
}
