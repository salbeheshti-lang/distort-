"use client";

import { useEffect, useState } from "react";

type State<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

// Lightweight fetch hook (no external dep) — derived loading state to avoid
// synchronous setState inside the effect body (React 19 rule).
export function useFetch<T = unknown>(url: string | null): State<T> {
  const [cache, setCache] = useState<{ url: string | null; data: T | null; error: string | null }>({
    url: null,
    data: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<T>;
      })
      .then((d) => {
        if (!cancelled) setCache({ url, data: d, error: null });
      })
      .catch((e) => {
        if (!cancelled) setCache({ url, data: null, error: e?.message ?? "Network error" });
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const loading = !!url && cache.url !== url && !cache.error;
  const data = cache.url === url ? cache.data : null;
  const error = cache.url === url ? cache.error : null;

  return { data, loading, error, refetch: () => setNonce((n) => n + 1) };
}

// Extract a human-readable error message from a fetch Response.
// Backend endpoints return { error: string } or { message: string } on failure.
// Falls back to `HTTP {status}` if no body or unrecognized shape.
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error.length) return body.error;
    if (typeof body?.message === "string" && body.message.length) return body.message;
    if (typeof body?.warning === "string" && body.warning.length) return body.warning;
  } catch {
    // response wasn't JSON — keep the fallback
  }
  return fallback;
}

export async function postJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await extractError(r, `HTTP ${r.status}`));
  return r.json() as Promise<T>;
}

export async function putJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(await extractError(r, `HTTP ${r.status}`));
  return r.json() as Promise<T>;
}

// Like postJSON but returns the response object so callers can read
// BOTH the success body AND the structured error on failure (no throw).
// Useful for flows that need to show different toasts for different failures.
export async function postJSONSoft<T = unknown>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) {
      const err = await extractError(r, `HTTP ${r.status}`);
      return { ok: false, status: r.status, data: null, error: err };
    }
    const data = (await r.json()) as T;
    return { ok: true, status: r.status, data, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error)?.message ?? "Network error" };
  }
}
