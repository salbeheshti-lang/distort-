// DISTORT — Emergency Connectivity rate limiter
//
// Simple in-memory, per-IP, sliding-window rate limiter with TTL.
// NO external deps (no Redis, no LRU cache). Each bucket is a Map<ip, hits[]>
// where hits[] is an array of timestamps; entries older than `windowMs` are
// pruned on each check. Buckets that go idle for >5 minutes are GC'd to
// prevent memory leaks.
//
// NOTE: This is per-process. In a multi-instance deployment, swap this out
// for a Redis-backed limiter. For a single Next.js standalone server (which
// is what Distort currently ships), this is sufficient.

type Bucket = {
  hits: number[]; // timestamps of each request within the window
};

const BUCKETS = new Map<string, Bucket>();
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// GC pass — drop buckets that have no recent hits.
function gc(now: number) {
  for (const [key, bucket] of BUCKETS) {
    const recent = bucket.hits.filter((t) => now - t < GC_INTERVAL_MS);
    if (recent.length === 0) {
      BUCKETS.delete(key);
    } else {
      bucket.hits = recent;
    }
  }
}

let lastGc = 0;

/**
 * Returns true if the given key has exceeded `max` hits in the last `windowMs`.
 * Side effect: records the current attempt.
 */
export function isRateLimited(
  key: string,
  max: number,
  windowMs: number
): boolean {
  const now = Date.now();

  // GC pass — runs at most once every 30s
  if (now - lastGc > 30_000) {
    gc(now);
    lastGc = now;
  }

  let bucket = BUCKETS.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    BUCKETS.set(key, bucket);
  }

  // Drop hits that fell out of the window
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= max) {
    return true; // rate limited
  }

  // Record this hit
  bucket.hits.push(now);
  return false;
}

/**
 * Extract the client IP from a Next.js Request.
 * Falls back to "unknown" if no forwarding headers are present.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

// Exported for tests only — clears all state.
export function _resetForTests() {
  BUCKETS.clear();
  lastGc = 0;
}
