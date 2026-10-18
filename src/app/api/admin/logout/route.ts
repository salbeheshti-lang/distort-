// DISTORT — /api/admin/logout
// POST: clears the session cookie

import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/admin-session";

export async function POST() {
  const res = NextResponse.json({ ok: true, message: "Logged out" });
  clearSessionCookie(res);
  return res;
}
