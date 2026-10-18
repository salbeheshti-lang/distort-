// DISTORT — /api/admin/users
// Admin-only: list all users, their tier, VIP status, admin status
// Requires: x-api-key header + x-admin-email header (must be admin in DB)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkAdminSession, getAdminEmailFromSession } from "@/lib/admin-session";

export async function GET(req: NextRequest) {
  // CRITICAL: Use proper admin auth (API key + DB admin check)
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const tierFilter = url.searchParams.get("tier");

    const where: any = {};
    if (tierFilter === "vip") where.tier = "vip";
    else if (tierFilter === "free") where.tier = "free";
    else if (tierFilter === "admin") where.isAdmin = true;

    const users = await db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        vipUntil: true,
        isAdmin: true,
        approvedBy: true,
        createdAt: true,
      },
    });

    // Do NOT expose sensitive fields in response
    return NextResponse.json({
      users,
      count: users.length,
      requestedBy: getAdminEmailFromSession(req),
    });
  } catch (err) {
    console.error("[api/admin/users] GET failed", err);
    return NextResponse.json({ error: "Failed to list users" }, { status: 500 });
  }
}
