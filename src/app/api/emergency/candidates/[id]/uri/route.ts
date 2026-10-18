// DISTORT — /api/emergency/candidates/[id]/uri
// POST: fetch the configUri for a single candidate
//
// SECURITY (addresses user review issue P1-الف):
//   The /api/emergency/plan endpoint returns candidate metadata (label, host,
//   port, protocol, score) but NEVER the configUri. This endpoint is the
//   ONLY way to retrieve the URI.
//
// IMPORTANT — why this endpoint is PUBLIC (no x-api-key required):
//   The configs in the Community Mesh bucket come from a PUBLIC subscription
//   (https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt).
//   They are ALREADY publicly available to anyone with a GitHub connection.
//   Requiring an API key here would BLOCK legitimate users from using the
//   Emergency engine in production, WITHOUT adding any real security — the
//   "secrets" are already public.
//
//   What WOULD be a real leak: configs that the user imported privately
//   (paste-their-own). Those are stored in the user's IndexedDB locally and
//   NEVER reach this server-side endpoint. So there's no private data at risk.
//
// Mitigations against mass harvesting:
//   1. Rate-limited (5 URIs/minute per IP — strict, because each call is
//      a candidate the user is actually trying to connect to)
//   2. POST (not GET) so the URI is never cached by browsers or CDNs
//   3. Only returns ONE uri per call (the plan endpoint returns up to 100
//      candidates' metadata, but URIs must be fetched one-at-a-time)
//   4. The plan endpoint's planId is logged for correlation, so we can
//      detect abusive access patterns (one IP requesting 100+ URIs across
//      multiple plans in a short window)
//
// If you later add PRIVATE configs (provisioned to specific VIP users),
// those MUST go through a DIFFERENT endpoint that requires user authentication
// (session cookie, not API key). Don't add private configs to this endpoint.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isRateLimited, getClientIp } from "@/lib/emergency-connectivity/rate-limiter";

const RATE_LIMIT_MAX = 5; // strict — 5 URIs per minute per IP
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limit — strict, because each URI is a real connection attempt
  const ip = getClientIp(req);
  if (isRateLimited(`uri:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      {
        error: "Too many URI requests (5/minute per IP). Wait a moment before retrying.",
        hint: "This rate limit protects the public Community Mesh subscription from mass harvesting.",
      },
      { status: 429 }
    );
  }

  try {
    const { id } = await params;

    // Look up the config in the DB
    const config = await db.importedConfig.findUnique({
      where: { id },
      select: {
        id: true,
        uri: true,
        protocol: true,
        host: true,
        port: true,
      },
    });

    if (!config) {
      return NextResponse.json(
        { error: "Candidate not found" },
        { status: 404 }
      );
    }

    // Return the URI
    // NOTE: We intentionally return the raw URI here — the client needs it
    // to pass to xray-core. We do NOT log it server-side.
    return NextResponse.json({
      id: config.id,
      uri: config.uri,
      protocol: config.protocol,
      host: config.host,
      port: config.port,
    });
  } catch (err) {
    console.error("[api/emergency/candidates/[id]/uri] POST failed", err);
    return NextResponse.json(
      { error: "Failed to fetch candidate URI" },
      { status: 500 }
    );
  }
}
