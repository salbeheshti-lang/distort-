// DISTORT — Emergency Connectivity state machine
//
// A pure, deterministic state machine for the recovery engine.
// The state machine itself has no side effects — it just transitions
// based on events. The actual probing, connecting, and verifying happen
// in the client (desktop/android), which reports results back via
// /api/emergency/report.
//
// Allowed transitions (per design §4 state machine):
//
//   idle        → diagnosing (on "start")
//   diagnosing  → selecting  (on "diagnosis-complete")
//   diagnosing  → exhausted  (on "no-base-network" — can't recover without internet)
//   selecting   → connecting (on "candidate-selected")
//   selecting   → exhausted (on "no-candidates-left")
//   connecting   → verifying (on "engine-started")
//   connecting   → recovering (on "engine-failed")
//   verifying   → connected  (on "traffic-verified")
//   verifying   → recovering (on "verification-failed")
//   connected   → degraded  (on "quality-dropped")
//   connected   → idle      (on "disconnect")
//   degraded    → recovering (on "switch-requested")
//   degraded    → connected (on "quality-recovered")
//   recovering  → selecting  (on "next-candidate-available")
//   recovering  → exhausted (on "no-candidates-left" or "max-consecutive-failures")
//   exhausted   → idle      (on "reset")
//
// Any state → idle on "reset".
// Any state → idle on "abort".

import {
  RecoveryState,
  RecoveryStatus,
  RecoveryAttempt,
  CandidatePath,
  RecoveryPlan,
} from "./types";

export type RecoveryEvent =
  | { type: "start" }
  | { type: "diagnosis-complete" }
  | { type: "no-base-network"; reason: string }
  | { type: "candidate-selected"; candidate: CandidatePath }
  | { type: "no-candidates-left"; reason: string }
  | { type: "engine-started" }
  | { type: "engine-failed"; reason: string }
  | { type: "traffic-verified"; exitIp: string | null; exitCountry: string | null }
  | { type: "verification-failed"; reason: string }
  | { type: "quality-dropped" }
  | { type: "quality-recovered" }
  | { type: "switch-requested" }
  | { type: "next-candidate-available"; candidate: CandidatePath }
  | { type: "disconnect" }
  | { type: "reset" }
  | { type: "abort" };

// Returns the new state for a given (current, event) pair, or null if the
// transition is not allowed.
export function nextState(current: RecoveryState, event: RecoveryEvent): RecoveryState | null {
  switch (current) {
    case "idle":
      if (event.type === "start") return "diagnosing";
      return null;

    case "diagnosing":
      if (event.type === "diagnosis-complete") return "selecting";
      if (event.type === "no-base-network") return "exhausted";
      // If the diagnosis reveals that no candidates can be gathered (no local
      // configs + international blocked so the API is unreachable), fail
      // closed immediately rather than getting stuck in "diagnosing".
      if (event.type === "no-candidates-left") return "exhausted";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "selecting":
      if (event.type === "candidate-selected") return "connecting";
      if (event.type === "no-candidates-left") return "exhausted";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "connecting":
      if (event.type === "engine-started") return "verifying";
      if (event.type === "engine-failed") return "recovering";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "verifying":
      if (event.type === "traffic-verified") return "connected";
      if (event.type === "verification-failed") return "recovering";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "connected":
      if (event.type === "quality-dropped") return "degraded";
      if (event.type === "disconnect") return "idle";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "degraded":
      if (event.type === "switch-requested") return "recovering";
      if (event.type === "quality-recovered") return "connected";
      if (event.type === "disconnect") return "idle";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "recovering":
      if (event.type === "next-candidate-available") return "selecting";
      if (event.type === "no-candidates-left") return "exhausted";
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    case "exhausted":
      if (event.type === "reset" || event.type === "abort") return "idle";
      return null;

    default:
      return null;
  }
}

// Helper: produce a fresh idle status
export function idleStatus(): RecoveryStatus {
  return {
    state: "idle",
    activePlan: null,
    attempts: [],
    currentCandidate: null,
    nextCandidate: null,
    attemptsThisCycle: 0,
    lastStateChangeAt: new Date().toISOString(),
    exhaustedReason: null,
  };
}

// Helper: append an attempt, capped at MAX_ATTEMPTS_HISTORY
export const MAX_ATTEMPTS_HISTORY = 50;
export function appendAttempt(status: RecoveryStatus, attempt: RecoveryAttempt): RecoveryStatus {
  const attempts = [attempt, ...status.attempts].slice(0, MAX_ATTEMPTS_HISTORY);
  return { ...status, attempts };
}

// Helper: transition a status to a new state with a new timestamp
export function transition(status: RecoveryStatus, event: RecoveryEvent): RecoveryStatus {
  const next = nextState(status.state, event);
  if (next === null) {
    // Invalid transition — ignore (no-op)
    return status;
  }

  let newStatus: RecoveryStatus = {
    ...status,
    state: next,
    lastStateChangeAt: new Date().toISOString(),
  };

  // Side effects on specific transitions
  if (event.type === "candidate-selected") {
    newStatus.currentCandidate = event.candidate;
  }
  if (event.type === "next-candidate-available") {
    newStatus.currentCandidate = event.candidate;
  }
  if (event.type === "no-candidates-left") {
    newStatus.exhaustedReason = event.reason;
    newStatus.currentCandidate = null;
    newStatus.nextCandidate = null;
  }
  if (event.type === "no-base-network") {
    newStatus.exhaustedReason = event.reason;
    newStatus.currentCandidate = null;
    newStatus.nextCandidate = null;
  }
  if (event.type === "disconnect" || event.type === "reset" || event.type === "abort") {
    newStatus.currentCandidate = null;
    newStatus.nextCandidate = null;
    newStatus.exhaustedReason = null;
    newStatus.attemptsThisCycle = 0;
    if (event.type === "reset") {
      newStatus.activePlan = null;
      newStatus.attempts = [];
    }
  }
  if (event.type === "traffic-verified") {
    newStatus.exhaustedReason = null;
  }

  return newStatus;
}

// Helper: compute the next candidate from a plan, given the current attempt count
export function computeNextCandidate(plan: RecoveryPlan | null, attemptNumber: number): CandidatePath | null {
  if (!plan) return null;
  if (attemptNumber >= plan.candidates.length) return null;
  return plan.candidates[attemptNumber];
}

// Helper: compute exponential backoff delay
export function computeBackoff(attemptNumber: number, policy: { baseDelayMs: number; maxDelayMs: number }): number {
  // Exponential backoff: base * 2^(attempt-1), capped at max
  const delay = policy.baseDelayMs * Math.pow(2, Math.max(0, attemptNumber - 1));
  return Math.min(delay, policy.maxDelayMs);
}

// Helper: should we declare exhaustion based on attempts + policy?
export function shouldExhaust(status: RecoveryStatus, policy: { maxAttempts: number; maxConsecutiveFailures: number }): boolean {
  if (status.attemptsThisCycle >= policy.maxAttempts) return true;
  // Count consecutive failures (most recent first)
  let consecutiveFailures = 0;
  for (const attempt of status.attempts) {
    if (attempt.result === "failure") {
      consecutiveFailures++;
    } else if (attempt.result === "success") {
      break;
    } else {
      // skipped/in-progress — don't break the streak
    }
  }
  return consecutiveFailures >= policy.maxConsecutiveFailures;
}
