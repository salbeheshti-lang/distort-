// DISTORT — /api/emergency/provision
// POST: provision a new VPN path (VIP-only)
//
// Input: ProvisionRequest = { kind, preferredCountry?, userEmail }
// Output: ProvisionResponse
//
// VIP-only: verifies the user is VIP/admin, returns 403 if free.
//
// STUB: For now, returns { ok: false, error: "Provisioning infrastructure
// not yet available" } — this is a Phase 5 feature. The route exists so
// the client can call it and get a clean error instead of 404.
//
// Rate limit: 5 provisions/hour per IP (very strict — provisioning is
// expensive when it eventually lands).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isRateLimited, getClientIp } from "@/lib/emergency-connectivity/rate-limiter";
import type { ProvisionRequest, ProvisionResponse } from "@/lib/emergency-connectivity/types";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const VALID_KINDS = new Set(["wireguard", "vless-reality", "trojan-cdn", "satellite"]);

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = getClientIp(req);
  if (isRateLimited(`provision:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Provisioning rate limit reached. Try again in an hour." },
      { status: 429 }
    );
  }

  // Parse body
  let body: ProvisionRequest;
  try {
    body = (await req.json()) as ProvisionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${Array.from(VALID_KINDS).join(", ")}` },
      { status: 400 }
    );
  }
  if (!body.userEmail || typeof body.userEmail !== "string") {
    return NextResponse.json({ error: "userEmail is required (VIP-only)" }, { status: 400 });
  }

  // Verify VIP
  let isVip = false;
  let isAdmin = false;
  try {
    const user = await db.user.findUnique({
      where: { email: body.userEmail.trim().toLowerCase() },
    });
    if (user) {
      isAdmin = !!user.isAdmin;
      isVip =
        isAdmin ||
        user.tier === "vip" ||
        (!!user.vipUntil && user.vipUntil > new Date());
    }
  } catch {
    // DB lookup failed — fail-closed (deny)
  }

  if (!isVip) {
    return NextResponse.json(
      {
        error:
          "Provisioning is VIP-only. Upgrade to VIP at /account to provision custom paths.",
      },
      { status: 403 }
    );
  }

  // STUB — Phase 5 will implement real provisioning here.
  const resp: ProvisionResponse = {
    ok: false,
    configUri: null,
    summary: `Provisioning for kind=${body.kind}${
      body.preferredCountry ? ` country=${body.preferredCountry}` : ""
    } is reserved for a future release. Your VIP status is verified (${
      isAdmin ? "admin" : "vip"
    }) — when provisioning ships, this endpoint will return a real config URI.`,
    expiresAt: null,
    error: "Provisioning infrastructure not yet available",
  };

  return NextResponse.json(resp, { status: 501 });
}
