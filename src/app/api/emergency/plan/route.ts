// DISTORT — /api/emergency/plan
// POST: build a recovery plan
//
// Input: PlanRequest (preferred country/protocol, includeSatellite/Vip,
//   policyOverrides, userEmail).
// Output: RecoveryPlan (planId, diagnosis, candidates[], policy, rationale,
//   confidence, userTier).
//
// Server-side tier verification: the client cannot self-declare VIP. We look
// up the user by email and override the request's userTier field with the
// verified value. Free users cannot include satellite paths.
//
// Rate limit: 10 plans/minute per IP (in-memory, sliding window).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildPlan } from "@/lib/emergency-connectivity/planner";
import { isRateLimited, getClientIp } from "@/lib/emergency-connectivity/rate-limiter";
import type { PlanRequest } from "@/lib/emergency-connectivity/types";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = getClientIp(req);
  if (isRateLimited(`plan:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many plan requests. Try again in a minute." },
      { status: 429 }
    );
  }

  // Parse body — tolerate malformed JSON
  let body: Partial<PlanRequest> = {};
  try {
    body = await req.json();
    if (!body || typeof body !== "object") body = {};
  } catch {
    body = {};
  }

  // Verify user tier if email provided
  let userTier: "free" | "vip" | "admin" = "free";
  const email = typeof body.userEmail === "string" ? body.userEmail.trim().toLowerCase() : "";
  if (email) {
    try {
      const user = await db.user.findUnique({ where: { email } });
      if (user?.isAdmin) {
        userTier = "admin";
      } else if (
        user?.tier === "vip" ||
        (user?.vipUntil && user.vipUntil > new Date())
      ) {
        userTier = "vip";
      }
    } catch {
      // DB lookup failed — default to free tier (fail-closed for VIP)
    }
  }

  // Override the request's tier with the verified one
  const planReq: PlanRequest = {
    preferredCountry: body.preferredCountry,
    preferredProtocol: body.preferredProtocol,
    includeSatellite: body.includeSatellite,
    includeVip: body.includeVip,
    policyOverrides: body.policyOverrides,
    userTier,
    userEmail: body.userEmail,
  };

  // Don't allow satellite for non-VIP
  if (planReq.includeSatellite && userTier === "free") {
    planReq.includeSatellite = false;
  }
  // Don't allow VIP nodes for free users either
  if (planReq.includeVip && userTier === "free") {
    planReq.includeVip = false;
  }

  try {
    const plan = await buildPlan(planReq);
    return NextResponse.json(plan);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to build recovery plan", detail: String(err) },
      { status: 500 }
    );
  }
}
