// DISTORT — Emergency Connectivity tests
//
// Unit tests for the state machine + planner + policy + diagnostics modules.
// Run: bun test src/lib/__tests__/emergency-connectivity.test.ts
//
// Pattern: bun:test with mock.module for db/anti-censor, plain test()/expect()
// for the pure helpers. The mock.module registration happens at the top so
// the modules under test pick up the mocks when they're dynamically imported.

import { mock, test, expect, describe, beforeAll, beforeEach } from "bun:test";
import type { ImportedConfig, Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Mocks for db + anti-censor (registered before the SUT is imported)
// ---------------------------------------------------------------------------

// A mutable list of fake ImportedConfig rows. Tests poke this to control what
// `db.importedConfig.findMany` returns.
let fakeConfigs: ImportedConfig[] = [];
// A mutable reachability result. Tests poke this to control what
// `probeReachability` returns.
let fakeProbeResult: { ok: boolean; latencyMs: number } = {
  ok: true,
  latencyMs: 50,
};

mock.module("@/lib/db", () => ({
  db: {
    importedConfig: {
      findMany: async () => fakeConfigs,
    },
  },
}));

mock.module("@/lib/anti-censor", () => ({
  probeReachability: async () => fakeProbeResult,
}));

// ---------------------------------------------------------------------------
// Dynamic imports — these resolve AFTER the mocks above are registered.
// Top-level await is supported in bun's test runner.
// ---------------------------------------------------------------------------

const stateMachine = await import("../emergency-connectivity/state-machine");
const policy = await import("../emergency-connectivity/policy");
const planner = await import("../emergency-connectivity/planner");
const diagnostics = await import("../emergency-connectivity/diagnostics");
const types = await import("../emergency-connectivity/types");

const {
  nextState,
  transition,
  idleStatus,
  appendAttempt,
} = stateMachine;

const {
  computeBackoffMs,
  shouldExhaust,
  validatePolicy,
  mergePolicy,
} = policy;

const {
  buildPlan,
  rankCandidates,
  computeConfidence,
  buildRationale,
} = planner;

const { interpretDiagnosis } = diagnostics;

const { DEFAULT_POLICY } = types;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a minimal fake ImportedConfig row. All fields Prisma would return.
function makeFakeConfig(
  overrides: Partial<ImportedConfig> = {},
): ImportedConfig {
  return {
    id: "cfg_1",
    subscriptionId: null,
    protocol: "vless",
    uri: "vless://uuid@1.2.3.4:443?security=tls#test",
    label: "Test Node",
    host: "1.2.3.4",
    port: 443,
    network: "tcp",
    security: "tls",
    sni: "example.com",
    path: null,
    hostHeader: null,
    flow: null,
    country: "DE",
    score: 80,
    flags: "",
    reach: "unknown",
    latencyMs: 0,
    bucket: "optimized",
    favorite: false,
    checkedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ImportedConfig;
}

// Build a minimal CandidatePath (used by planner pure-helper tests).
function makeCandidate(overrides: Partial<types.CandidatePath> = {}): types.CandidatePath {
  return {
    id: "c1",
    label: "Candidate 1",
    protocol: "vless",
    host: "1.2.3.4",
    port: 443,
    stealth: true,
    antiDpiScore: 70,
    exitCountry: "DE",
    vipOnly: false,
    configUri: "vless://redacted@1.2.3.4:443",
    lastProbe: null,
    successStreak: 0,
    failureStreak: 0,
    lastTriedAt: null,
    ...overrides,
  };
}

// Build a minimal RecoveryAttempt (used by shouldExhaust tests).
function makeAttempt(
  result: "success" | "failure" | "skipped" | "in-progress",
  overrides: Partial<types.RecoveryAttempt> = {},
): types.RecoveryAttempt {
  return {
    planId: "plan_test",
    candidateId: "c1",
    attemptNumber: 1,
    state: "connecting",
    result,
    reason: "",
    latencyMs: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mock state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeConfigs = [];
  fakeProbeResult = { ok: true, latencyMs: 50 };
});

// ===========================================================================
// 1. STATE MACHINE — allowed transitions
// ===========================================================================

describe("state machine: allowed transitions", () => {
  test("idle + start → diagnosing", () => {
    expect(nextState("idle", { type: "start" })).toBe("diagnosing");
  });

  test("diagnosing + diagnosis-complete → selecting", () => {
    expect(nextState("diagnosing", { type: "diagnosis-complete" })).toBe("selecting");
  });

  test("diagnosing + no-base-network → exhausted", () => {
    expect(
      nextState("diagnosing", { type: "no-base-network", reason: "offline" }),
    ).toBe("exhausted");
  });

  test("selecting + candidate-selected → connecting", () => {
    const candidate = makeCandidate();
    expect(
      nextState("selecting", { type: "candidate-selected", candidate }),
    ).toBe("connecting");
  });

  test("selecting + no-candidates-left → exhausted", () => {
    expect(
      nextState("selecting", { type: "no-candidates-left", reason: "empty" }),
    ).toBe("exhausted");
  });

  test("connecting + engine-started → verifying", () => {
    expect(nextState("connecting", { type: "engine-started" })).toBe("verifying");
  });

  test("connecting + engine-failed → recovering", () => {
    expect(
      nextState("connecting", { type: "engine-failed", reason: "spawn" }),
    ).toBe("recovering");
  });

  test("verifying + traffic-verified → connected", () => {
    expect(
      nextState("verifying", {
        type: "traffic-verified",
        exitIp: "5.6.7.8",
        exitCountry: "DE",
      }),
    ).toBe("connected");
  });

  test("verifying + verification-failed → recovering", () => {
    expect(
      nextState("verifying", {
        type: "verification-failed",
        reason: "leak",
      }),
    ).toBe("recovering");
  });

  test("connected + quality-dropped → degraded", () => {
    expect(nextState("connected", { type: "quality-dropped" })).toBe("degraded");
  });

  test("connected + disconnect → idle", () => {
    expect(nextState("connected", { type: "disconnect" })).toBe("idle");
  });

  test("degraded + switch-requested → recovering", () => {
    expect(nextState("degraded", { type: "switch-requested" })).toBe("recovering");
  });

  test("degraded + quality-recovered → connected", () => {
    expect(nextState("degraded", { type: "quality-recovered" })).toBe("connected");
  });

  test("recovering + next-candidate-available → selecting", () => {
    const candidate = makeCandidate();
    expect(
      nextState("recovering", {
        type: "next-candidate-available",
        candidate,
      }),
    ).toBe("selecting");
  });

  test("recovering + no-candidates-left → exhausted", () => {
    expect(
      nextState("recovering", {
        type: "no-candidates-left",
        reason: "none",
      }),
    ).toBe("exhausted");
  });

  test("exhausted + reset → idle", () => {
    expect(nextState("exhausted", { type: "reset" })).toBe("idle");
  });

  test("any non-idle state + abort → idle", () => {
    // Note: `idle` itself does NOT allow `abort` — the state machine treats
    // already-idle + abort as a no-op (returns null). All other states accept
    // abort as a transition back to idle.
    for (const s of [
      "diagnosing",
      "selecting",
      "connecting",
      "verifying",
      "connected",
      "degraded",
      "recovering",
      "exhausted",
    ] as const) {
      expect(nextState(s, { type: "abort" })).toBe("idle");
    }
  });

  test("idle + abort → null (already idle; no-op)", () => {
    expect(nextState("idle", { type: "abort" })).toBeNull();
  });

  test("idle + reset → null (already idle; no-op)", () => {
    expect(nextState("idle", { type: "reset" })).toBeNull();
  });
});

// ===========================================================================
// 2. STATE MACHINE — disallowed transitions (no-op)
// ===========================================================================

describe("state machine: disallowed transitions return null", () => {
  test("idle + diagnosis-complete → null (can't skip diagnosing)", () => {
    expect(nextState("idle", { type: "diagnosis-complete" })).toBeNull();
  });

  test("idle + candidate-selected → null (must diagnose first)", () => {
    expect(
      nextState("idle", { type: "candidate-selected", candidate: makeCandidate() }),
    ).toBeNull();
  });

  test("idle + engine-started → null", () => {
    expect(nextState("idle", { type: "engine-started" })).toBeNull();
  });

  test("verifying + start → null (already past diagnosing)", () => {
    expect(nextState("verifying", { type: "start" })).toBeNull();
  });

  test("connected + start → null (already connected)", () => {
    expect(nextState("connected", { type: "start" })).toBeNull();
  });

  test("exhausted + start → null (must reset first)", () => {
    expect(nextState("exhausted", { type: "start" })).toBeNull();
  });

  test("exhausted + candidate-selected → null (must reset first)", () => {
    expect(
      nextState("exhausted", {
        type: "candidate-selected",
        candidate: makeCandidate(),
      }),
    ).toBeNull();
  });

  test("connected + no-base-network → null (already past diagnosing)", () => {
    expect(
      nextState("connected", { type: "no-base-network", reason: "x" }),
    ).toBeNull();
  });
});

describe("state machine: transition() leaves status unchanged on invalid event", () => {
  test("transition(idle, candidate-selected) is a no-op", () => {
    const status = idleStatus();
    const before = { ...status };
    const after = transition(status, {
      type: "candidate-selected",
      candidate: makeCandidate(),
    });
    expect(after.state).toBe(before.state);
    expect(after.currentCandidate).toBeNull();
  });

  test("transition(exhausted, start) is a no-op", () => {
    const status = idleStatus();
    status.state = "exhausted";
    status.exhaustedReason = "test";
    const after = transition(status, { type: "start" });
    expect(after.state).toBe("exhausted");
    expect(after.exhaustedReason).toBe("test");
  });
});

describe("state machine: side effects on valid transitions", () => {
  test("candidate-selected sets currentCandidate", () => {
    const candidate = makeCandidate({ id: "c_special" });
    const status = idleStatus();
    status.state = "selecting";
    const after = transition(status, {
      type: "candidate-selected",
      candidate,
    });
    expect(after.state).toBe("connecting");
    expect(after.currentCandidate?.id).toBe("c_special");
  });

  test("no-candidates-left sets exhaustedReason + clears candidates", () => {
    const status = idleStatus();
    status.state = "selecting";
    status.currentCandidate = makeCandidate();
    const after = transition(status, {
      type: "no-candidates-left",
      reason: "all probed",
    });
    expect(after.state).toBe("exhausted");
    expect(after.exhaustedReason).toBe("all probed");
    expect(after.currentCandidate).toBeNull();
  });

  test("reset clears attempts + activePlan", () => {
    const status = idleStatus();
    status.state = "exhausted";
    status.attempts = [makeAttempt("failure")];
    status.activePlan = {} as types.RecoveryPlan;
    const after = transition(status, { type: "reset" });
    expect(after.state).toBe("idle");
    expect(after.attempts).toEqual([]);
    expect(after.activePlan).toBeNull();
  });

  test("appendAttempt caps at MAX_ATTEMPTS_HISTORY (50)", () => {
    let status = idleStatus();
    for (let i = 0; i < 60; i++) {
      status = appendAttempt(status, makeAttempt("failure", { attemptNumber: i + 1 }));
    }
    expect(status.attempts.length).toBe(50);
  });
});

// ===========================================================================
// 3. POLICY — backoff exponential + capped
// ===========================================================================

describe("policy: computeBackoffMs", () => {
  const pol = { baseDelayMs: 1000, maxDelayMs: 30000 };

  test("attempt 1 = base", () => {
    expect(computeBackoffMs(1, pol)).toBe(1000);
  });

  test("attempt 2 = 2x base", () => {
    expect(computeBackoffMs(2, pol)).toBe(2000);
  });

  test("attempt 3 = 4x base", () => {
    expect(computeBackoffMs(3, pol)).toBe(4000);
  });

  test("attempt 5 = 16x base", () => {
    expect(computeBackoffMs(5, pol)).toBe(16000);
  });

  test("capped at maxDelayMs (attempt 10: 512s → 30s)", () => {
    expect(computeBackoffMs(10, pol)).toBe(30000);
  });

  test("attempt 0 / negative clamped to attempt 1 (= base)", () => {
    expect(computeBackoffMs(0, pol)).toBe(1000);
    expect(computeBackoffMs(-5, pol)).toBe(1000);
  });

  test("DEFAULT_POLICY values produce expected sequence", () => {
    // base=1500, max=30000
    expect(computeBackoffMs(1, DEFAULT_POLICY)).toBe(1500);
    expect(computeBackoffMs(2, DEFAULT_POLICY)).toBe(3000);
    // Attempt 5: 1500 * 16 = 24000 (under cap)
    expect(computeBackoffMs(5, DEFAULT_POLICY)).toBe(24000);
    // Attempt 6: 1500 * 32 = 48000 → capped to 30000
    expect(computeBackoffMs(6, DEFAULT_POLICY)).toBe(30000);
  });
});

// ===========================================================================
// 4. POLICY — shouldExhaust respects maxAttempts + maxConsecutiveFailures
// ===========================================================================

describe("policy: shouldExhaust", () => {
  const pol = { maxAttempts: 5, maxConsecutiveFailures: 3 };

  test("false when below both limits", () => {
    const status = idleStatus();
    status.attemptsThisCycle = 2;
    status.attempts = [makeAttempt("failure"), makeAttempt("failure")];
    expect(shouldExhaust(status, pol)).toBe(false);
  });

  test("true when attemptsThisCycle >= maxAttempts", () => {
    const status = idleStatus();
    status.attemptsThisCycle = 5;
    status.attempts = [];
    expect(shouldExhaust(status, pol)).toBe(true);
  });

  test("true when consecutive failures >= maxConsecutiveFailures", () => {
    const status = idleStatus();
    status.attemptsThisCycle = 1;
    // Three failures in a row (most recent first).
    status.attempts = [
      makeAttempt("failure"),
      makeAttempt("failure"),
      makeAttempt("failure"),
    ];
    expect(shouldExhaust(status, pol)).toBe(true);
  });

  test("success breaks the failure streak", () => {
    const status = idleStatus();
    status.attemptsThisCycle = 1;
    // newest=success, then 5 older failures — should NOT exhaust.
    status.attempts = [
      makeAttempt("success"),
      makeAttempt("failure"),
      makeAttempt("failure"),
      makeAttempt("failure"),
      makeAttempt("failure"),
      makeAttempt("failure"),
    ];
    expect(shouldExhaust(status, pol)).toBe(false);
  });

  test("skipped attempts do not break the failure streak", () => {
    const status = idleStatus();
    status.attemptsThisCycle = 1;
    // failure, skipped, failure, failure — 3 failures total (streak broken only by success).
    status.attempts = [
      makeAttempt("failure"),
      makeAttempt("skipped"),
      makeAttempt("failure"),
      makeAttempt("failure"),
    ];
    expect(shouldExhaust(status, pol)).toBe(true);
  });
});

// ===========================================================================
// 5. PLANNER — empty candidates when no ImportedConfigs exist
// ===========================================================================

describe("planner: buildPlan with no DB configs", () => {
  beforeAll(async () => {
    // diagnoseServerSide will report "online" because the mocked probeReachability
    // returns ok:true by default. So we'll get past the no-base-network early-return.
  });

  test("returns 0 candidates when DB is empty (and base network is online)", async () => {
    fakeConfigs = [];
    fakeProbeResult = { ok: true, latencyMs: 50 };
    const plan = await buildPlan({ userTier: "free" });
    expect(plan.candidates).toEqual([]);
    expect(plan.confidence).toBe("none");
    expect(plan.rationale).toContain("0 candidate");
  });

  test("returns empty plan with rationale when base network is unknown", async () => {
    // Mock probeReachability to fail everywhere → base network becomes "unknown".
    fakeConfigs = [];
    fakeProbeResult = { ok: false, latencyMs: 0 };
    const plan = await buildPlan({ userTier: "free" });
    expect(plan.candidates).toEqual([]);
    expect(plan.confidence).toBe("none");
    expect(plan.rationale).toContain("No base network detected");
    expect(plan.diagnosis.baseNetwork).toBe("unknown");
  });
});

// ===========================================================================
// 6. PLANNER — filters by preferred country/protocol
// ===========================================================================

describe("planner: filters by preferred country/protocol", () => {
  beforeEach(() => {
    fakeProbeResult = { ok: true, latencyMs: 50 };
  });

  test("preferredCountry filters the candidate list", async () => {
    fakeConfigs = [
      makeFakeConfig({ id: "de1", country: "DE", host: "1.1.1.1" }),
      makeFakeConfig({ id: "nl1", country: "NL", host: "2.2.2.2" }),
      makeFakeConfig({ id: "de2", country: "DE", host: "3.3.3.3" }),
    ];
    const plan = await buildPlan({
      userTier: "free",
      preferredCountry: "DE",
    });
    expect(plan.candidates).toHaveLength(2);
    expect(
      plan.candidates.every((c) => c.exitCountry?.toLowerCase().includes("de")),
    ).toBe(true);
  });

  test("preferredProtocol filters the candidate list", async () => {
    fakeConfigs = [
      makeFakeConfig({ id: "vless1", protocol: "vless" }),
      makeFakeConfig({ id: "trojan1", protocol: "trojan" }),
      makeFakeConfig({ id: "vmess1", protocol: "vmess" }),
    ];
    const plan = await buildPlan({
      userTier: "free",
      preferredProtocol: "trojan",
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].protocol).toBe("trojan");
  });

  test("preferredCountry + preferredProtocol combine (AND)", async () => {
    fakeConfigs = [
      makeFakeConfig({ id: "de-vless", country: "DE", protocol: "vless" }),
      makeFakeConfig({ id: "de-trojan", country: "DE", protocol: "trojan" }),
      makeFakeConfig({ id: "nl-vless", country: "NL", protocol: "vless" }),
    ];
    const plan = await buildPlan({
      userTier: "free",
      preferredCountry: "DE",
      preferredProtocol: "vless",
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].id).toBe("de-vless");
  });

  test("no matches returns empty candidates (still confidence=none)", async () => {
    fakeConfigs = [makeFakeConfig({ country: "DE" })];
    const plan = await buildPlan({
      userTier: "free",
      preferredCountry: "JP",
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.confidence).toBe("none");
  });
});

// ===========================================================================
// 7. PLANNER — satellite stub only for VIP/admin when includeSatellite=true
// ===========================================================================

describe("planner: satellite stub access control", () => {
  beforeEach(() => {
    fakeConfigs = [
      makeFakeConfig({ id: "de1", country: "DE", protocol: "vless" }),
    ];
    fakeProbeResult = { ok: true, latencyMs: 50 };
  });

  test("free user + includeSatellite=true → NO satellite stub", async () => {
    const plan = await buildPlan({
      userTier: "free",
      includeSatellite: true,
    });
    expect(plan.candidates.some((c) => c.protocol === "satellite")).toBe(false);
  });

  test("VIP user + includeSatellite=true → satellite stub present", async () => {
    const plan = await buildPlan({
      userTier: "vip",
      includeSatellite: true,
    });
    const sat = plan.candidates.find((c) => c.protocol === "satellite");
    expect(sat).toBeDefined();
    expect(sat?.vipOnly).toBe(true);
    expect(sat?.id).toBe("satellite-stub-vip");
    expect(sat?.configUri).toBe("satellite://stub");
    expect(sat?.antiDpiScore).toBe(100);
  });

  test("admin user + includeSatellite=true → satellite stub present", async () => {
    const plan = await buildPlan({
      userTier: "admin",
      includeSatellite: true,
    });
    expect(plan.candidates.some((c) => c.protocol === "satellite")).toBe(true);
  });

  test("VIP user + includeSatellite NOT set → no satellite stub", async () => {
    const plan = await buildPlan({
      userTier: "vip",
    });
    expect(plan.candidates.some((c) => c.protocol === "satellite")).toBe(false);
  });

  test("VIP user + includeSatellite=false → no satellite stub", async () => {
    const plan = await buildPlan({
      userTier: "vip",
      includeSatellite: false,
    });
    expect(plan.candidates.some((c) => c.protocol === "satellite")).toBe(false);
  });
});

// ===========================================================================
// 8. PLANNER — confidence levels
// ===========================================================================

describe("planner: computeConfidence", () => {
  const diag: types.NetworkDiagnosis = {
    baseNetwork: "online",
    dnsWorks: true,
    internationalReachable: true,
    domesticReachable: true,
    directLatencyMs: 50,
    summary: "test",
    checkedAt: new Date().toISOString(),
  };

  test("empty candidates → none", () => {
    expect(computeConfidence([], diag)).toBe("none");
  });

  test("1-2 candidates without probes → none (below threshold)", () => {
    expect(computeConfidence([makeCandidate()], diag)).toBe("none");
    expect(computeConfidence([makeCandidate(), makeCandidate()], diag)).toBe("none");
  });

  test("3 candidates without probes → low", () => {
    const cands = [
      makeCandidate({ id: "1" }),
      makeCandidate({ id: "2" }),
      makeCandidate({ id: "3" }),
    ];
    expect(computeConfidence(cands, diag)).toBe("low");
  });

  test("10 candidates without probes → medium", () => {
    const cands = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: String(i) }),
    );
    expect(computeConfidence(cands, diag)).toBe("medium");
  });

  test("5 reachable candidates → medium", () => {
    const cands = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        id: String(i),
        lastProbe: {
          configId: String(i),
          structural: "valid",
          reachability: "reachable",
          tunnel: "not-attempted",
          latencyMs: 50,
          exitIp: null,
          exitCountry: null,
          probedAt: new Date().toISOString(),
          failureReason: null,
        },
      }),
    );
    expect(computeConfidence(cands, diag)).toBe("medium");
  });

  test("3 verified candidates → high", () => {
    const cands = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        id: String(i),
        lastProbe: {
          configId: String(i),
          structural: "valid",
          reachability: "reachable",
          tunnel: "verified",
          latencyMs: 50,
          exitIp: "5.6.7.8",
          exitCountry: "DE",
          probedAt: new Date().toISOString(),
          failureReason: null,
        },
      }),
    );
    expect(computeConfidence(cands, diag)).toBe("high");
  });
});

// ===========================================================================
// 9. PLANNER — ranking (pure)
// ===========================================================================

describe("planner: rankCandidates", () => {
  const onlineDiag: types.NetworkDiagnosis = {
    baseNetwork: "online",
    dnsWorks: true,
    internationalReachable: true,
    domesticReachable: true,
    directLatencyMs: 50,
    summary: "online",
    checkedAt: new Date().toISOString(),
  };

  const hostileDiag: types.NetworkDiagnosis = {
    baseNetwork: "online", // domestic up, international DOWN
    dnsWorks: false,
    internationalReachable: false,
    domesticReachable: true,
    directLatencyMs: null,
    summary: "hostile",
    checkedAt: new Date().toISOString(),
  };

  test("verified candidates rank first", () => {
    const cands = [
      makeCandidate({ id: "unverified", antiDpiScore: 99, successStreak: 0 }),
      makeCandidate({
        id: "verified",
        antiDpiScore: 10,
        successStreak: 0,
        lastProbe: {
          configId: "verified",
          structural: "valid",
          reachability: "reachable",
          tunnel: "verified",
          latencyMs: 50,
          exitIp: "1.1.1.1",
          exitCountry: "DE",
          probedAt: new Date().toISOString(),
          failureReason: null,
        },
      }),
    ];
    const ranked = rankCandidates(cands, { diagnosis: onlineDiag });
    expect(ranked[0].id).toBe("verified");
  });

  test("higher success streak ranks first (when no verified)", () => {
    const cands = [
      makeCandidate({ id: "low", successStreak: 1, antiDpiScore: 99 }),
      makeCandidate({ id: "high", successStreak: 10, antiDpiScore: 10 }),
    ];
    const ranked = rankCandidates(cands, { diagnosis: onlineDiag });
    expect(ranked[0].id).toBe("high");
  });

  test("fewer failures rank first (when streaks + scores equal)", () => {
    const cands = [
      makeCandidate({ id: "more-fails", failureStreak: 5 }),
      makeCandidate({ id: "fewer-fails", failureStreak: 0 }),
    ];
    const ranked = rankCandidates(cands, { diagnosis: onlineDiag });
    expect(ranked[0].id).toBe("fewer-fails");
  });

  test("higher anti-DPI score ranks first (when streaks + failures equal)", () => {
    const cands = [
      makeCandidate({ id: "low", antiDpiScore: 30 }),
      makeCandidate({ id: "high", antiDpiScore: 90 }),
    ];
    const ranked = rankCandidates(cands, { diagnosis: onlineDiag });
    expect(ranked[0].id).toBe("high");
  });

  test("stealth preferred in hostile networks (international unreachable)", () => {
    const cands = [
      makeCandidate({ id: "plain", stealth: false, antiDpiScore: 90 }),
      makeCandidate({ id: "stealthy", stealth: true, antiDpiScore: 90 }),
    ];
    const ranked = rankCandidates(cands, { diagnosis: hostileDiag });
    expect(ranked[0].id).toBe("stealthy");
  });

  test("stealth NOT preferred in normal networks (when scores equal, order is stable)", () => {
    const cands = [
      makeCandidate({ id: "plain", stealth: false, antiDpiScore: 90 }),
      makeCandidate({ id: "stealthy", stealth: true, antiDpiScore: 90 }),
    ];
    // Online + international reachable → stealth is NOT a tiebreaker.
    // Order should match insertion order (no swap).
    const ranked = rankCandidates(cands, { diagnosis: onlineDiag });
    expect(ranked[0].id).toBe("plain");
    expect(ranked[1].id).toBe("stealthy");
  });

  test("does not mutate the input array", () => {
    const cands = [
      makeCandidate({ id: "a", antiDpiScore: 10 }),
      makeCandidate({ id: "b", antiDpiScore: 90 }),
    ];
    const snapshot = cands.map((c) => c.id);
    rankCandidates(cands, { diagnosis: onlineDiag });
    expect(cands.map((c) => c.id)).toEqual(snapshot);
  });
});

// ===========================================================================
// 10. DIAGNOSTICS — interpretDiagnosis (pure)
// ===========================================================================

describe("diagnostics: interpretDiagnosis", () => {
  test("all-up → online", () => {
    const d = interpretDiagnosis(
      [
        { host: "www.iran.ir", port: 443, ok: true, latencyMs: 30, label: "iran" },
        { host: "1.1.1.1", port: 443, ok: true, latencyMs: 50, label: "cloudflare" },
      ],
      { domesticTargets: ["www.iran.ir"], internationalTargets: ["1.1.1.1"] },
    );
    expect(d.baseNetwork).toBe("online");
    expect(d.dnsWorks).toBe(true);
    expect(d.internationalReachable).toBe(true);
    expect(d.domesticReachable).toBe(true);
    expect(d.directLatencyMs).toBe(30); // min of ok latencies
  });

  test("domestic-up + international-down → still online (domestic wins)", () => {
    const d = interpretDiagnosis(
      [
        { host: "www.iran.ir", port: 443, ok: true, latencyMs: 30, label: "iran" },
        { host: "1.1.1.1", port: 443, ok: false, latencyMs: 0, label: "cloudflare" },
      ],
      { domesticTargets: ["www.iran.ir"], internationalTargets: ["1.1.1.1"] },
    );
    expect(d.baseNetwork).toBe("online");
    expect(d.internationalReachable).toBe(false);
    expect(d.dnsWorks).toBe(false); // simplification: DNS works iff intl reachable
    expect(d.domesticReachable).toBe(true);
  });

  test("all-down + probes collected → local-only", () => {
    const d = interpretDiagnosis(
      [
        { host: "www.iran.ir", port: 443, ok: false, latencyMs: 0, label: "iran" },
        { host: "1.1.1.1", port: 443, ok: false, latencyMs: 0, label: "cloudflare" },
      ],
      { domesticTargets: ["www.iran.ir"], internationalTargets: ["1.1.1.1"] },
    );
    expect(d.baseNetwork).toBe("local-only");
    expect(d.directLatencyMs).toBeNull();
  });

  test("no probes collected → unknown", () => {
    const d = interpretDiagnosis(
      [],
      { domesticTargets: [], internationalTargets: [] },
    );
    expect(d.baseNetwork).toBe("unknown");
  });

  test("summary contains the latency when reachable", () => {
    const d = interpretDiagnosis(
      [{ host: "1.1.1.1", port: 443, ok: true, latencyMs: 42, label: "cf" }],
      { domesticTargets: [], internationalTargets: ["1.1.1.1"] },
    );
    expect(d.summary).toContain("latency=42ms");
  });

  test("summary contains 'unknown' latency when nothing reachable", () => {
    const d = interpretDiagnosis(
      [{ host: "1.1.1.1", port: 443, ok: false, latencyMs: 0, label: "cf" }],
      { domesticTargets: [], internationalTargets: ["1.1.1.1"] },
    );
    expect(d.summary).toContain("latency=unknown");
  });
});

// ===========================================================================
// 11. POLICY — validatePolicy + mergePolicy
// ===========================================================================

describe("policy: validatePolicy", () => {
  test("DEFAULT_POLICY is valid", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
  });

  test("maxAttempts too low → error", () => {
    const errors = validatePolicy({ ...DEFAULT_POLICY, maxAttempts: 0 });
    expect(errors.some((e) => e.includes("maxAttempts"))).toBe(true);
  });

  test("maxAttempts too high → error", () => {
    const errors = validatePolicy({ ...DEFAULT_POLICY, maxAttempts: 999 });
    expect(errors.some((e) => e.includes("maxAttempts"))).toBe(true);
  });

  test("maxDelayMs < baseDelayMs → error", () => {
    const errors = validatePolicy({
      ...DEFAULT_POLICY,
      baseDelayMs: 5000,
      maxDelayMs: 1000,
    });
    expect(errors.some((e) => e.includes("maxDelayMs"))).toBe(true);
  });

  test("verifyTimeoutMs out of range → error", () => {
    expect(
      validatePolicy({ ...DEFAULT_POLICY, verifyTimeoutMs: 100 })[0],
    ).toContain("verifyTimeoutMs");
  });
});

describe("policy: mergePolicy", () => {
  test("no overrides → returns DEFAULT_POLICY copy", () => {
    const merged = mergePolicy();
    expect(merged).toEqual(DEFAULT_POLICY);
    expect(merged).not.toBe(DEFAULT_POLICY); // different ref
  });

  test("overrides take precedence", () => {
    const merged = mergePolicy({ maxAttempts: 3 });
    expect(merged.maxAttempts).toBe(3);
    // Other fields unchanged.
    expect(merged.verifyTimeoutMs).toBe(DEFAULT_POLICY.verifyTimeoutMs);
  });

  test("overrides spread over defaults (note: spread copies unknown keys too)", () => {
    // The implementation uses `{ ...DEFAULT_POLICY, ...overrides }`, which copies
    // ALL enumerable own properties from overrides — including ones not in
    // RecoveryPolicy. This is intentional: it's the standard JS spread idiom,
    // and any extra keys are simply ignored by downstream consumers (which
    // destructure only the known fields).
    // @ts-expect-error — intentionally passing an unknown key
    const merged = mergePolicy({ maxAttempts: 7, bogus: "nope" });
    expect(merged.maxAttempts).toBe(7);
    // Other fields unchanged.
    expect(merged.verifyTimeoutMs).toBe(DEFAULT_POLICY.verifyTimeoutMs);
    // Unknown key IS preserved by the spread — that's how JS works.
    expect((merged as unknown as { bogus?: string }).bogus).toBe("nope");
  });
});

// ===========================================================================
// 12. PLANNER — rationale builder (pure)
// ===========================================================================

describe("planner: buildRationale", () => {
  const diag: types.NetworkDiagnosis = {
    baseNetwork: "online",
    dnsWorks: true,
    internationalReachable: true,
    domesticReachable: true,
    directLatencyMs: 50,
    summary: "test",
    checkedAt: new Date().toISOString(),
  };

  test("includes base network + candidate count", () => {
    const r = buildRationale(diag, [makeCandidate()], { userTier: "free" });
    expect(r).toContain("Base network: online");
    expect(r).toContain("1 candidate loaded");
  });

  test("includes preferred country when set", () => {
    const r = buildRationale(diag, [], {
      userTier: "free",
      preferredCountry: "DE",
    });
    expect(r).toContain("preferred country: DE");
  });

  test("includes preferred protocol when set", () => {
    const r = buildRationale(diag, [], {
      userTier: "free",
      preferredProtocol: "vless",
    });
    expect(r).toContain("preferred protocol: vless");
  });

  test("includes satellite note when VIP + includeSatellite", () => {
    const r = buildRationale(diag, [], {
      userTier: "vip",
      includeSatellite: true,
    });
    expect(r).toContain("Satellite");
    expect(r).toContain("VIP");
  });

  test("does NOT include satellite note when free tier", () => {
    const r = buildRationale(diag, [], {
      userTier: "free",
      includeSatellite: true,
    });
    expect(r).not.toContain("Satellite");
  });

  test("always includes the client-must-probe NOTE", () => {
    const r = buildRationale(diag, [], { userTier: "free" });
    expect(r).toContain("client must probe");
  });
});
