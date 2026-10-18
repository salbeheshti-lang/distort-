// DISTORT — /api/admin/grant-admin
// POST: { email } — grant admin privileges to a user
// Requires: x-api-key header + x-admin-email header (must be admin in DB)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkAdminSession, getAdminEmailFromSession } from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const body = await req.json();
    const { email } = body;
    const adminEmail = getAdminEmailFromSession(req);

    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    // Get admin user
    const admin = await db.user.findFirst({ where: { email: adminEmail } });
    if (!admin || !admin.isAdmin) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    // Find or create user
    let user = await db.user.findFirst({ where: { email } });
    if (!user) {
      user = await db.user.create({ data: { email, isAdmin: true, approvedBy: admin.id } });
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: { isAdmin: true, approvedBy: admin.id },
    });

    return NextResponse.json({
      ok: true,
      email: updated.email,
      isAdmin: updated.isAdmin,
      approvedBy: admin.email,
      message: `${email} is now an admin (approved by ${adminEmail})`,
    });
  } catch (err) {
    return NextResponse.json({ error: "Grant admin failed" }, { status: 500 });
  }
}
