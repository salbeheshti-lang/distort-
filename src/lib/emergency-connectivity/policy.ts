// DISTORT — Emergency Connectivity policy helpers
//
// Pure functions that compute backoff delays, decide when to declare
// exhaustion, validate user-supplied policy overrides, and merge them
// with defaults. No side effects, no I/O — safe to unit-test and safe
// to call from both server + client.
//
// NOTE on backoff: the delay is computed by `computeBackoffMs`, which uses
// exponential growth capped at `policy.maxDelayMs`. There is NO jitter here
// because the planner may run multiple candidates in parallel and we want
// determinism for testing. Jitter (if needed) should be added by the caller.

import { RecoveryPolicy, RecoveryStatus, DEFAULT_POLICY } from "./types";

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

// Compute the delay before the next attempt, using exponential backoff.
// Returns milliseconds.
//
// Formula: base * 2^(max(0, attemptNumber - 1)), capped at maxDelayMs.
// attemptNumber is 1-based: attempt 1 → base, attempt 2 → 2*base, etc.
export function computeBackoffMs(
  attemptNumber: number,
  policy: Pick<RecoveryPolicy, "baseDelayMs" | "maxDelayMs">,
): number {
  const base = policy.baseDelayMs;
  const delay = base * Math.pow(2, Math.max(0, attemptNumber - 1));
  return Math.min(delay, policy.maxDelayMs);
}

// ---------------------------------------------------------------------------
// Exhaustion decisions
// ---------------------------------------------------------------------------

// Should we declare exhaustion?
// True if EITHER:
//   - We've hit `maxAttempts` for this cycle, OR
//   - We've had `maxConsecutiveFailures` failures in a row (most-recent-first).
export function shouldExhaust(
  status: RecoveryStatus,
  policy: Pick<RecoveryPolicy, "maxAttempts" | "maxConsecutiveFailures">,
): boolean {
  if (status.attemptsThisCycle >= policy.maxAttempts) return true;

  // Count consecutive failures (most recent first — attempts array is
  // prepended-to on append, so index 0 is newest).
  let consecutiveFailures = 0;
  for (const attempt of status.attempts) {
    if (attempt.result === "failure") {
      consecutiveFailures++;
    } else if (attempt.result === "success") {
      break;
    }
    // "skipped" / "in-progress" don't break the streak.
  }
  return consecutiveFailures >= policy.maxConsecutiveFailures;
}

// Should we auto-retry after exhaustion?
// Default: NO — user must manually recover (matches DEFAULT_POLICY).
export function shouldAutoRetry(
  status: RecoveryStatus,
  policy: RecoveryPolicy,
): boolean {
  if (!policy.autoRetryAfterExhaustion) return false;
  if (status.state !== "exhausted") return false;
  // Only auto-retry if we haven't already tried too many times recently.
  return status.attemptsThisCycle < policy.maxAttempts * 2;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Validate that a policy is sane. Returns a list of human-readable error
// strings (empty array = valid). Used by API endpoints to reject bad input
// before it reaches the planner.
export function validatePolicy(policy: RecoveryPolicy): string[] {
  const errors: string[] = [];
  if (policy.maxAttempts < 1 || policy.maxAttempts > 50) {
    errors.push("maxAttempts must be between 1 and 50");
  }
  if (policy.verifyTimeoutMs < 1000 || policy.verifyTimeoutMs > 60000) {
    errors.push("verifyTimeoutMs must be between 1000 and 60000");
  }
  if (policy.baseDelayMs < 100 || policy.baseDelayMs > 60000) {
    errors.push("baseDelayMs must be between 100 and 60000");
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    errors.push("maxDelayMs must be >= baseDelayMs");
  }
  if (policy.maxConsecutiveFailures < 1 || policy.maxConsecutiveFailures > 20) {
    errors.push("maxConsecutiveFailures must be between 1 and 20");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

// Merge user-provided overrides with defaults.
//
// Uses the standard spread idiom: `{ ...DEFAULT_POLICY, ...overrides }`.
// Note: this copies ALL enumerable own properties from `overrides` — including
// any unknown keys. Downstream consumers destructure only the known
// RecoveryPolicy fields, so unknown keys are harmless.
export function mergePolicy(overrides?: Partial<RecoveryPolicy>): RecoveryPolicy {
  if (!overrides) return { ...DEFAULT_POLICY };
  return { ...DEFAULT_POLICY, ...overrides };
}
