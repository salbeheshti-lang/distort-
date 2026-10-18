// DISTORT — Emergency Connectivity planner
//
// The path-selection engine. Given a `PlanRequest`, it:
//   1. Diagnoses the network (server-side estimate; client will re-verify).
//   2. Loads candidate configs from the DB (Community Mesh bucket=optimized).
//   3. Ranks them by a composite score (verified → success streak → failure
//      streak → anti-DPI score → stealth preference in hostile networks).
//   4. Caps at `policy.maxAttempts` and attaches a confidence + rationale.
//
// IMPORTANT: The planner CANNOT verify reachability from the user's device.
// The server's view of the internet is NOT the user's view. The plan is a
// PROPOSAL — the client must probe each candidate before connecting.
//
// SENSITIVITY: Candidate `configUri` fields contain credentials. They are
// never logged, never included in `rationale`, and never serialized into
// telemetry. Only `label`, `host`, `port`, `protocol` are safe to log.

import {
  CandidatePath,
  PlanRequest,
  RecoveryPlan,
  RecoveryPolicy,
  DEFAULT_POLICY,
  NetworkDiagnosis,
  TransportType,
} from "./types";
import { db } from "@/lib/db";
import { diagnoseServerSide } from "./diagnostics";

// ---------------------------------------------------------------------------
// Public: build a recovery plan
// ---------------------------------------------------------------------------

export async function buildPlan(req: PlanRequest): Promise<RecoveryPlan> {
  const policy: RecoveryPolicy = { ...DEFAULT_POLICY, ...req.policyOverrides };

  // 1. Diagnose the network (server-side estimate; client will verify).
  const diagnosis = await diagnoseServerSide();

  // 2. If we have no base network at all, return an empty plan with rationale.
  // The client is expected to re-probe and confirm before declaring exhausted.
  if (
    diagnosis.baseNetwork === "unknown" ||
    diagnosis.baseNetwork === "offline"
  ) {
    return {
      planId: generatePlanId(),
      diagnosis,
      candidates: [],
      policy,
      rationale:
        "No base network detected. Cannot recover without at least local network connectivity. The client should verify this diagnosis — the server's view may differ from the user's device.",
      confidence: "none",
      createdAt: new Date().toISOString(),
      userTier: req.userTier || "free",
    };
  }

  // 3. Load candidate configs from the DB.
  const candidates = await loadCandidates(req);

  // 4. Rank by the planner's composite score.
  const sorted = rankCandidates(candidates, {
    preferredCountry: req.preferredCountry,
    preferredProtocol: req.preferredProtocol,
    diagnosis,
  });

  // 5. Cap at policy.maxAttempts.
  const capped = sorted.slice(0, policy.maxAttempts);

  // 6. Compute confidence + rationale.
  const confidence = computeConfidence(capped, diagnosis);
  const rationale = buildRationale(diagnosis, capped, req);

  return {
    planId: generatePlanId(),
    diagnosis,
    candidates: capped,
    policy,
    rationale,
    confidence,
    createdAt: new Date().toISOString(),
    userTier: req.userTier || "free",
  };
}

// ---------------------------------------------------------------------------
// Candidate loading (from DB + satellite stub)
// ---------------------------------------------------------------------------

async function loadCandidates(req: PlanRequest): Promise<CandidatePath[]> {
  // Load optimized ImportedConfigs from the DB (the Community Mesh configs).
  // Sorted by score desc so the DB does the first pass of ranking.
  const configs = await db.importedConfig.findMany({
    where: { bucket: "optimized" },
    take: 100,
    orderBy: { score: "desc" },
    include: { subscription: { select: { label: true, kind: true } } },
  });

  const candidates: CandidatePath[] = configs.map((c) => ({
    id: c.id,
    label: c.label || `${c.protocol} ${c.host}:${c.port}`,
    protocol: c.protocol as TransportType,
    host: c.host,
    port: c.port,
    // Stealth = TLS/Reality/WS/any-SNI present. These are the configs most
    // likely to survive hostile filtering (e.g. GFI in Iran).
    stealth:
      c.security === "tls" || c.security === "reality" || !!c.sni,
    antiDpiScore: c.score,
    exitCountry: c.country,
    vipOnly: false, // Community Mesh configs are free for all users.
    // CRITICAL: configUri is NEVER included in the plan response. It contains
    // credentials (UUIDs, passwords, keys). The client must fetch it
    // separately via POST /api/emergency/candidates/[id]/uri, which is
    // rate-limited and (in production) requires authentication.
    configUri: "", // empty string = "fetch via secure endpoint"
    lastProbe: null, // Populated by the client after probing.
    successStreak: 0,
    failureStreak: 0,
    lastTriedAt: null,
  }));

  // Filter by preferred country (substring match — country codes or names).
  let filtered = candidates;
  if (req.preferredCountry) {
    const q = req.preferredCountry.toLowerCase();
    filtered = filtered.filter(
      (c) => c.exitCountry != null && c.exitCountry.toLowerCase().includes(q),
    );
  }
  if (req.preferredProtocol) {
    filtered = filtered.filter((c) => c.protocol === req.preferredProtocol);
  }

  // If satellite paths are requested AND the user is VIP/admin, push a stub.
  // Real satellite provisioning requires infrastructure not yet built —
  // the client will recognize "satellite://stub" and request real provisioning
  // via the /api/emergency/provision endpoint. If provisioning fails, the
  // candidate is silently skipped.
  if (
    req.includeSatellite &&
    (req.userTier === "vip" || req.userTier === "admin")
  ) {
    filtered.push({
      id: "satellite-stub-vip",
      label: "🛰️ Satellite (Starlink) — VIP",
      protocol: "satellite",
      host: "satellite.distort.app", // stub — real host returned by /provision
      port: 8443,
      stealth: true, // Satellite bypasses all terrestrial filtering.
      antiDpiScore: 100, // Highest possible — by design.
      exitCountry: null, // Unknown until connected.
      vipOnly: true,
      configUri: "satellite://stub", // Client recognizes this and requests provisioning.
      lastProbe: null,
      successStreak: 0,
      failureStreak: 0,
      lastTriedAt: null,
    });
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Ranking (pure — exported for unit tests)
// ---------------------------------------------------------------------------

export type RankOptions = {
  preferredCountry?: string;
  preferredProtocol?: TransportType;
  diagnosis: NetworkDiagnosis;
};

export function rankCandidates(
  candidates: CandidatePath[],
  opts: RankOptions,
): CandidatePath[] {
  return [...candidates].sort((a, b) => {
    // 1. Verified tunnels first (lastProbe.tunnel === "verified").
    const aVerified = a.lastProbe?.tunnel === "verified" ? 1 : 0;
    const bVerified = b.lastProbe?.tunnel === "verified" ? 1 : 0;
    if (aVerified !== bVerified) return bVerified - aVerified;

    // 2. Success streak — more recent successes first.
    if (a.successStreak !== b.successStreak)
      return b.successStreak - a.successStreak;

    // 3. Failure streak — fewer failures first.
    if (a.failureStreak !== b.failureStreak)
      return a.failureStreak - b.failureStreak;

    // 4. Anti-DPI score — higher first.
    if (a.antiDpiScore !== b.antiDpiScore)
      return b.antiDpiScore - a.antiDpiScore;

    // 5. Stealth preferred — especially in hostile networks where the base
    //    network is up but international destinations are unreachable
    //    (the classic "domestic-only" GFI pattern).
    if (
      opts.diagnosis.baseNetwork === "online" &&
      !opts.diagnosis.internationalReachable
    ) {
      if (a.stealth !== b.stealth) return a.stealth ? -1 : 1;
    }

    return 0;
  });
}

// ---------------------------------------------------------------------------
// Confidence (pure — exported for unit tests)
// ---------------------------------------------------------------------------

export function computeConfidence(
  candidates: CandidatePath[],
  _diagnosis: NetworkDiagnosis,
): "high" | "medium" | "low" | "none" {
  if (candidates.length === 0) return "none";
  const verified = candidates.filter(
    (c) => c.lastProbe?.tunnel === "verified",
  ).length;
  const reachable = candidates.filter(
    (c) => c.lastProbe?.reachability === "reachable",
  ).length;

  if (verified >= 3) return "high";
  if (reachable >= 5 || candidates.length >= 10) return "medium";
  if (candidates.length >= 3) return "low";
  return "none";
}

// ---------------------------------------------------------------------------
// Rationale builder (pure — exported for unit tests)
// ---------------------------------------------------------------------------

export function buildRationale(
  diagnosis: NetworkDiagnosis,
  candidates: CandidatePath[],
  req: PlanRequest,
): string {
  const parts: string[] = [];
  parts.push(`Base network: ${diagnosis.baseNetwork}.`);
  parts.push(
    `International reachable (server-side estimate): ${
      diagnosis.internationalReachable ? "yes" : "no"
    }.`,
  );
  parts.push(
    `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} loaded.`,
  );
  if (req.preferredCountry)
    parts.push(`Filtered by preferred country: ${req.preferredCountry}.`);
  if (req.preferredProtocol)
    parts.push(`Filtered by preferred protocol: ${req.preferredProtocol}.`);
  if (
    req.includeSatellite &&
    (req.userTier === "vip" || req.userTier === "admin")
  ) {
    parts.push("Satellite (Starlink) path included — VIP only.");
  }
  parts.push(
    "NOTE: server cannot verify reachability from the user's device. The client must probe each candidate.",
  );
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generatePlanId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
