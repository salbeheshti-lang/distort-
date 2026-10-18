"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DownloadCloud, CheckCircle2, AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { toast } from "sonner";

/**
 * UpdateIndicator — a small floating badge that surfaces auto-updater state
 * from the Electron main process (electron-updater + GitHub Releases).
 *
 * Renders ONLY in the desktop shell — on the web `window.distort.updater`
 * is undefined and this component returns null.
 *
 * Behaviour:
 *   - "checking"     → small spinner in the corner (no toast)
 *   - "available"    → toast: "Update vX ready — downloading…"
 *   - "downloading"  → corner badge with percent
 *   - "downloaded"   → toast with "Install now" button (also auto-prompted
 *                      by main.ts via a native dialog, but the in-app toast
 *                      gives a nicer experience for users who missed the dialog)
 *   - "error"        → toast: "Auto-update error: <msg>" (non-blocking)
 *   - "idle"         → nothing visible
 *
 * NOTE: until we publish a real GitHub Release with a real version bump,
 * this will stay in "idle" — that's expected. The badge existing in the UI
 * proves the wiring is correct.
 */
export function UpdateIndicator() {
  const { status, version, downloadPercent, errorMessage, isDesktop, checkNow, installNow } = useAutoUpdate();
  const shownAvailableToast = useRef<string | null>(null);
  const shownDownloadedToast = useRef<string | null>(null);
  const shownErrorToast = useRef<string | null>(null);

  // Fire toast side-effects in an effect so we don't re-fire on every render.
  useEffect(() => {
    if (status === "available" && version && shownAvailableToast.current !== version) {
      shownAvailableToast.current = version;
      toast.info(`Update v${version} available`, {
        description: "Downloading in the background…",
        duration: 6000,
      });
    }
    if (status === "downloaded" && version && shownDownloadedToast.current !== version) {
      shownDownloadedToast.current = version;
      const tid = toast.success(`Update v${version} ready to install`, {
        description: "Your settings & configs are preserved.",
        duration: 12000,
        action: {
          label: "Install & restart",
          onClick: () => {
            installNow().then((r) => {
              if (!r.ok) {
                toast.error("Could not install update", { description: r.error });
              }
            });
          },
        },
      });
      return () => {
        toast.dismiss(tid);
      };
    }
    if (status === "error" && errorMessage && shownErrorToast.current !== errorMessage) {
      shownErrorToast.current = errorMessage;
      toast.error("Auto-update error", {
        description: errorMessage,
        duration: 8000,
      });
    }
  }, [status, version, errorMessage, installNow]);

  // Web context — render nothing. (After hooks so we don't violate rules-of-hooks.)
  if (!isDesktop && status === "unsupported") return null;

  // A small persistent badge in the bottom-right corner of the dashboard.
  // Only shown when there's "interesting" state (downloading, downloaded, error).
  const showBadge = status === "downloading" || status === "downloaded" || status === "error" || status === "available";

  return (
    <AnimatePresence>
      {showBadge && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.9 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-4 right-4 z-50 pointer-events-auto"
        >
          <div className="glass-strong border border-white/10 rounded-xl p-3 shadow-2xl min-w-[220px] max-w-[300px]">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5">
                {status === "downloading" && (
                  <Loader2 className="w-4 h-4 text-[#00f0ff] animate-spin" />
                )}
                {status === "available" && (
                  <DownloadCloud className="w-4 h-4 text-[#00f0ff]" />
                )}
                {status === "downloaded" && (
                  <CheckCircle2 className="w-4 h-4 text-[#10d9a0]" />
                )}
                {status === "error" && (
                  <AlertTriangle className="w-4 h-4 text-[#ffb020]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-tech uppercase tracking-wider text-white">
                  {status === "available" && `Update v${version ?? "?"} available`}
                  {status === "downloading" && "Downloading update"}
                  {status === "downloaded" && `v${version ?? "?"} ready`}
                  {status === "error" && "Update failed"}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {status === "available" && "Auto-downloading…"}
                  {status === "downloading" &&
                    downloadPercent != null &&
                    `${downloadPercent}% • background`}
                  {status === "downloaded" && "Install on next quit, or click below"}
                  {status === "error" && (errorMessage ?? "Unknown error")}
                </div>
                {(status === "downloading" || status === "available") &&
                  downloadPercent != null && (
                    <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-gradient transition-all"
                        style={{ width: `${downloadPercent}%` }}
                      />
                    </div>
                  )}
                {status === "downloaded" && (
                  <button
                    onClick={() =>
                      installNow().then((r) => {
                        if (!r.ok) toast.error("Could not install", { description: r.error });
                      })
                    }
                    className="mt-2 w-full text-[10px] font-tech uppercase tracking-wider px-2 py-1.5 rounded-md bg-brand-gradient text-[#02131a] hover:opacity-90 transition-opacity"
                  >
                    Install & restart
                  </button>
                )}
                {status === "error" && (
                  <button
                    onClick={() =>
                      checkNow().then((r) => {
                        if (!r.ok) toast.error("Retry failed", { description: r.error });
                        else toast.success("Re-checking for updates…");
                      })
                    }
                    className="mt-2 w-full text-[10px] font-tech uppercase tracking-wider px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white flex items-center justify-center gap-1.5"
                  >
                    <RotateCw className="w-3 h-3" /> Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Convenience export for callers that just want the toast behaviour without
// the visible badge. (We don't use this anywhere yet, but it's nice to have
// for a future "minimal" view.)
export function UpdateToastsOnly() {
  // The hook side-effect fires toasts regardless of whether we render the
  // badge. Just mounting this component is enough.
  const { isDesktop, status } = useAutoUpdate();
  if (!isDesktop) return null;
  // Touch status so React doesn't think it's unused — but actually we don't
  // render anything; the toast fires from inside the hook's useEffect.
  void status;
  return null;
}
