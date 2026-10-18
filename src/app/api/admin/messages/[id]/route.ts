// DISTORT — /api/admin/messages/[id]
// PATCH: update message status or reply (admin only)
// DELETE: delete message (admin only)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkAdminSession, getAdminEmailFromSession } from "@/lib/admin-session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const { id } = await params;
    const body = await req.json();
    const { status, reply } = body;
    const adminEmail = getAdminEmailFromSession(req);

    // Get admin user ID for handledBy
    const admin = await db.user.findFirst({ where: { email: adminEmail } });
    if (!admin || !admin.isAdmin) {
      return NextResponse.json({ error: "Admin not found" }, { status: 403 });
    }

    const patch: any = {};
    if (status) patch.status = status;
    if (reply) {
      patch.reply = reply.slice(0, 5000);
      patch.status = "replied";
      patch.repliedAt = new Date();
      patch.handledBy = admin.id;
    }

    const updated = await db.adminMessage.update({
      where: { id },
      data: patch,
    });

    return NextResponse.json({ message: updated });
  } catch (err) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const { id } = await params;

    await db.adminMessage.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
