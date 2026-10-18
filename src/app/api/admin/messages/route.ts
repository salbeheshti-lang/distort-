// DISTORT — /api/admin/messages
// GET: list all messages (admin only — requires API key + admin email)
// POST: create a new message (PUBLIC — no auth, this is the contact form)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkAdminSession, getAdminEmailFromSession } from "@/lib/admin-session";

// GET — admin only
export async function GET(req: NextRequest) {
  const authFail = await checkAdminSession(req);
  if (authFail) return authFail;

  try {
    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("status");

    const where: any = {};
    if (typeFilter) where.type = typeFilter;
    if (statusFilter) where.status = statusFilter;

    const messages = await db.adminMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      messages,
      count: messages.length,
      requestedBy: getAdminEmailFromSession(req),
    });
  } catch (err) {
    console.error("[api/admin/messages] GET failed", err);
    return NextResponse.json({ error: "Failed to list messages" }, { status: 500 });
  }
}

// POST — PUBLIC endpoint for contact form (no auth needed)
// This is how users send messages to the admin panel
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, name, email, subject, message } = body;

    if (!name || !email || !message) {
      return NextResponse.json({ error: "name, email and message are required" }, { status: 400 });
    }

    // Validate and sanitize input
    const validTypes = ["vip_request", "collaboration", "support", "bug_report"];
    const messageType = validTypes.includes(type) ? type : "support";

    // Rate limit: max 5 messages per email per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentMessages = await db.adminMessage.count({
      where: { email, createdAt: { gte: oneHourAgo } },
    });
    if (recentMessages >= 5) {
      return NextResponse.json({ error: "Rate limit exceeded. Max 5 messages per hour." }, { status: 429 });
    }

    // Sanitize: limit message length
    const sanitizedMessage = message.slice(0, 5000);
    const sanitizedSubject = (subject || "(no subject)").slice(0, 200);
    const sanitizedName = name.slice(0, 100);
    const sanitizedEmail = email.slice(0, 200).toLowerCase();

    const msg = await db.adminMessage.create({
      data: {
        type: messageType,
        name: sanitizedName,
        email: sanitizedEmail,
        subject: sanitizedSubject,
        message: sanitizedMessage,
      },
    });

    return NextResponse.json({ ok: true, id: msg.id }, { status: 201 });
  } catch (err) {
    console.error("[api/admin/messages] POST failed", err);
    // Don't leak internal errors to public endpoint
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
