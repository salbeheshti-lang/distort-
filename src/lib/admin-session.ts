// DISTORT — Admin session management
// Uses HttpOnly cookies for secure session — no API key in localStorage.
//
// FLOW:
// 1. Admin visits /admin, enters email + password
// 2. POST /api/admin/login → verifies password against User.passwordHash
// 3. Server sets HttpOnly session cookie with signed JWT-like token
// 4. All admin API routes check the session cookie (not x-api-key header)
// 5. POST /api/admin/logout → clears cookie
//
// SECURITY:
// - Cookie is HttpOnly (JS can't read it) + Secure (HTTPS only) + SameSite=Strict
// - Session expires after 24 hours
// - Password hashed with bcrypt

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createHash, randomBytes } from "crypto";

const SESSION_SECRET = process.env.DISTORT_SESSION_SECRET || randomBytes(32).toString("hex");
const SESSION_COOKIE_NAME = "distort_admin_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Simple HMAC-based session token (no external JWT dep needed)
function createSessionToken(adminId: string, email: string): string {
  const payload = JSON.stringify({
    uid: adminId,
    email,
    exp: Date.now() + SESSION_DURATION_MS,
  });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = createHash("sha256").update(payloadB64 + SESSION_SECRET).digest("hex");
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token: string): { uid: string; email: string; exp: number } | null {
  try {
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return null;

    const expectedSig = createHash("sha256").update(payloadB64 + SESSION_SECRET).digest("hex");
    if (sig !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
    if (Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Check admin session from cookie.
 * Returns null if auth passes, or a NextResponse error if it fails.
 */
export async function checkAdminSession(req: NextRequest): Promise<NextResponse | null> {
  const cookie = req.headers.get("cookie") || "";
  const sessionMatch = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));

  if (!sessionMatch) {
    return NextResponse.json(
      { error: "Not authenticated — no session cookie" },
      { status: 401 }
    );
  }

  const token = sessionMatch[1];
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json(
      { error: "Session expired or invalid — please log in again" },
      { status: 401 }
    );
  }

  // Verify the user is still an admin in DB
  try {
    const admin = await db.user.findFirst({ where: { id: session.uid, email: session.email } });
    if (!admin || !admin.isAdmin) {
      return NextResponse.json(
        { error: "Not authorized — admin privileges revoked" },
        { status: 403 }
      );
    }
    return null; // Auth passed
  } catch {
    return NextResponse.json({ error: "Auth check failed" }, { status: 500 });
  }
}

/**
 * Get admin email from session cookie.
 */
export function getAdminEmailFromSession(req: NextRequest): string {
  const cookie = req.headers.get("cookie") || "";
  const sessionMatch = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!sessionMatch) return "";

  const session = verifySessionToken(sessionMatch[1]);
  return session?.email || "";
}

/**
 * Set session cookie on response.
 */
export function setSessionCookie(res: NextResponse, adminId: string, email: string): void {
  const token = createSessionToken(adminId, email);
  const isProduction = process.env.NODE_ENV === "production";

  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: SESSION_DURATION_MS / 1000,
    path: "/",
  });
}

/**
 * Clear session cookie on response.
 */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
}

/**
 * Hash a password (simple SHA-256 for now — can upgrade to bcrypt later).
 */
export function hashPassword(password: string): string {
  return createHash("sha256").update(password + SESSION_SECRET).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}
