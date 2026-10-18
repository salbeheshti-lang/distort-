"use client";

import { useEffect, useState, useCallback } from "react";

/**
 * useAutoUpdate — React hook bridging the desktop shell's electron-updater
 * IPC events into React state.
 *
 * On web (no `window.distort.updater`), this returns a no-op state with
 * `available: false` — so the same components can render on both web and
 * desktop without crashing.
 *
 * Events come from desktop/src/preload.ts (which forwards from main.ts):
 *   - update-checking      → status === "checking"
 *   - update-available     → status === "available", version set
 *   - update-downloading   → status === "downloading", percent set
 *   - update-downloaded    → status === "downloaded", version set
 *   - update-not-available → status === "idle"
 *   - update-error         → status === "error", message set
 *
 * The hook also exposes `checkNow()` and `installNow()` for a UI button.
 */

type UpdaterStatus = "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "unsupported";

type UpdateState = {
  status: UpdaterStatus;
  version: string | null;
  releaseDate: string | null;
  releaseNotes?: unknown;
  downloadPercent: number | null;
  errorMessage: string | null;
  isDesktop: boolean;
};

type DistortUpdater = {
  onChecking: (cb: () => void) => () => void;
  onAvailable: (cb: (info: { version: string | null; releaseDate?: string | null; releaseNotes?: unknown }) => void) => () => void;
  onNotAvailable: (cb: (info: { version: string; dev?: boolean }) => void) => () => void;
  onDownloading: (cb: (progress: { percent: number | null; transferred: number; total: number; bytesPerSecond: number }) => void) => () => void;
  onDownloaded: (cb: (info: { version: string | null; releaseDate?: string | null }) => void) => () => void;
  onError: (cb: (err: { message: string }) => void) => () => void;
  checkNow: () => Promise<{ ok: boolean; error?: string; updateInfo?: { version: string; releaseDate?: string } | null; currentVersion?: string }>;
  installNow: () => Promise<{ ok: boolean; error?: string }>;
};

type DistortGlobal = {
  distort?: {
    updater?: DistortUpdater;
    app?: { version: () => Promise<string>; platform: () => Promise<{ platform: string; arch: string }> };
    capabilities?: { desktopShell?: boolean };
  };
};

function getUpdater(): DistortUpdater | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as DistortGlobal;
  return w.distort?.updater ?? null;
}

// Initial state computed synchronously (no setState-in-effect) so we satisfy
// the react-hooks/set-state-in-effect rule. The Electron preload is injected
// BEFORE the React app boots, so `getUpdater()` is stable on first render.
function computeInitialState(): UpdateState {
  const u = getUpdater();
  return {
    status: u ? "idle" : "unsupported",
    version: null,
    releaseDate: null,
    releaseNotes: undefined,
    downloadPercent: null,
    errorMessage: null,
    isDesktop: !!u,
  };
}

export function useAutoUpdate(): UpdateState & {
  checkNow: () => Promise<{ ok: boolean; error?: string }>;
  installNow: () => Promise<{ ok: boolean; error?: string }>;
} {
  const [state, setState] = useState<UpdateState>(computeInitialState);

  useEffect(() => {
    const updater = getUpdater();
    if (!updater) return; // web context — nothing to subscribe to

    const offChecking = updater.onChecking(() => {
      setState((s) => ({ ...s, status: "checking", errorMessage: null }));
    });
    const offAvailable = updater.onAvailable((info) => {
      setState((s) => ({
        ...s,
        status: "available",
        version: info.version,
        releaseDate: info.releaseDate ?? null,
        releaseNotes: info.releaseNotes,
        downloadPercent: 0,
        errorMessage: null,
      }));
    });
    const offNotAvailable = updater.onNotAvailable((info) => {
      setState((s) => ({ ...s, status: "idle", version: info.version, errorMessage: null }));
    });
    const offDownloading = updater.onDownloading((progress) => {
      setState((s) => ({
        ...s,
        status: "downloading",
        downloadPercent: progress.percent,
      }));
    });
    const offDownloaded = updater.onDownloaded((info) => {
      setState((s) => ({
        ...s,
        status: "downloaded",
        version: info.version,
        releaseDate: info.releaseDate ?? null,
        downloadPercent: 100,
      }));
    });
    const offError = updater.onError((err) => {
      setState((s) => ({ ...s, status: "error", errorMessage: err.message }));
    });

    return () => {
      offChecking();
      offAvailable();
      offNotAvailable();
      offDownloading();
      offDownloaded();
      offError();
    };
  }, []);

  const checkNow = useCallback(async () => {
    const u = getUpdater();
    if (!u) return { ok: false, error: "Not in desktop shell" };
    return u.checkNow();
  }, []);

  const installNow = useCallback(async () => {
    const u = getUpdater();
    if (!u) return { ok: false, error: "Not in desktop shell" };
    return u.installNow();
  }, []);

  return { ...state, checkNow, installNow };
}
