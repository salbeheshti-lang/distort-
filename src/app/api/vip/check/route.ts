// DISTORT — /api/vip/check
// GET: check if current user (by email) has VIP access
// POST: { email } → check VIP status
//
// VIP rules:
// - tier === "vip" AND (vipUntil is null OR vipUntil > now) → VIP active
// - isAdmin === true → always VIP (admin override)
// - tier === "free" → not VIP, but can still use community configs

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const email = req.headers.get("x-user-email") || new URL(req.url).searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email is required (x-user-email header or ?email=)" }, { status: 400 });
  }

  const user = await db.user.findFirst({ where: { email } });
  if (!user) {
    return NextResponse.json({ vip: false, tier: "none", message: "User not found" });
  }

  const now = new Date();
  const isAdmin = user.isAdmin;
  const isVip = user.tier === "vip" && (user.vipUntil === null || user.vipUntil > now);
  const isVipActive = isAdmin || isVip;

  return NextResponse.json({
    vip: isVipActive,
    tier: isAdmin ? "admin" : user.tier,
    vipUntil: user.vipUntil,
    isAdmin,
    canUsePremiumServers: isVipActive,
    canUseCommunityConfigs: true, // everyone can use community configs
    message: isVipActive
      ? "VIP active — premium servers available"
      : "Free tier — community configs available. Upgrade to VIP for premium servers.",
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = body?.email;
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    const user = await db.user.findFirst({ where: { email } });
    if (!user) {
      return NextResponse.json({ vip: false, tier: "none" });
    }

    const now = new Date();
    const isVipActive = user.isAdmin || (user.tier === "vip" && (user.vipUntil === null || user.vipUntil > now));

    return NextResponse.json({
      vip: isVipActive,
      tier: user.isAdmin ? "admin" : user.tier,
      vipUntil: user.vipUntil,
      isAdmin: user.isAdmin,
    });
  } catch (err) {
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
