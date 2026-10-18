// DISTORT — /api/admin/login
// POST: { email, password } → sets HttpOnly session cookie
// This is the ONLY public admin endpoint — all others require the session cookie.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, setSessionCookie } from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const user = await db.user.findFirst({ where: { email: email.toLowerCase() } });
    if (!user || !user.isAdmin) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    if (!user.passwordHash) {
      return NextResponse.json({ error: "No password set. Contact the server administrator." }, { status: 403 });
    }

    if (!verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Create response with session cookie
    const res = NextResponse.json({
      ok: true,
      email: user.email,
      isAdmin: true,
      message: "Login successful",
    });

    setSessionCookie(res, user.id, user.email);

    return res;
  } catch (err) {
    console.error("[api/admin/login] failed", err);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
