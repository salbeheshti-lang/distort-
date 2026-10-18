// DISTORT — /api/vip/revoke
// POST: { email }
// Admin-only: revokes VIP from a user.
// Requires: x-api-key header + x-admin-email header (must be admin in DB)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkAdminSession } from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    const user = await db.user.findFirst({ where: { email } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    await db.user.update({
      where: { id: user.id },
      data: { tier: "free", vipUntil: null },
    });

    return NextResponse.json({
      ok: true,
      email,
      message: "VIP revoked — user is now on free tier",
    });
  } catch (err) {
    return NextResponse.json({ error: "Revoke failed" }, { status: 500 });
  }
}
