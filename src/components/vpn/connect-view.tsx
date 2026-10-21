"use client";

// DISTORT — ConnectView (single hub for everything)
//
// Replaces the legacy "Distort Config" tab + minimal Connect dropdown with
// one unified view:
//   - Default Iran configs (mixed_iran.txt subscription, bucket=optimized)
//   - Personal configs imported via the `+` button (favorite=true OR
//     subscription.kind==="manual")
//   - Live latency badges next to each dropdown item
//   - "Test all" button → POST /api/imported-configs/check (server probes
//     in parallel, returns {results:[{id,host,port,ok,latencyMs}]})
//   - Auto-selects the lowest-latency reachable config after Test all runs
//     (only if the user hasn't manually picked one).
//
// Persian UX requirement honoured:
//   "اگه + زده شد که کانفیگ شخصی کار کنه ، باید یک اجرای فوق العاده داشته باشه"
//   → Import button opens a clean modal (ImportDialog in import-config-dialog.tsx)
//     with live preview + structured-error surfacing via postJSONSoft.
//     No clutter, generous spacing, smooth animations.

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Power,
  Activity,
  RefreshCw,
  ChevronDown,
  Check,
  Download,
  Upload,
  Clock,
  AlertCircle,
  Plus,
  Star,
} from "lucide-react";
import {
  useVpnStore,
  formatRate,
  formatDuration,
  type ServerLite,
} from "@/lib/vpn-store";
import { postJSON, postJSONSoft, useFetch } from "@/hooks/use-fetch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { IpLocationWidget } from "./ip-location-widget";
import { ImportDialog } from "./import-config-dialog";

// Mirrors the ImportedConfig Prisma model joined with its subscription.
// Moved here from the deleted community-mesh-view.tsx.
type ImportedConfig = {
  id: string;
  protocol: string;
  uri: string;
  label: string | null;
  host: string;
  port: number;
  network: string;
  security: string;
  sni: string | null;
  path: string | null;
  flow: string | null;
  country: string | null;
  score: number;
  flags: string;
  reach: string;
  latencyMs: number;
  bucket: string;
  favorite: boolean;
  checkedAt: string | null;
  subscription: { label: string; kind: string } | null;
};

// Latency probe state keyed by config id.
//   - testing: true while a probe is in-flight for this id
//   - ok:     true if the host is reachable in some form (TLS or TCP only)
//   - reach:  3-state granularity for the badge color
//             "ok"   = TLS handshake succeeded (GREEN — truly reachable)
//             "tcp"  = TCP ok, TLS failed (ORANGE — may work via Reality)
//             "fail" = TCP connect failed (ORANGE — xray might still work)
//             "unknown" = no probe yet (GRAY — untested)
//   - ms:     round-trip in milliseconds (null when untested or unreachable)
type LatencyState = {
  ms: number | null;
  ok: boolean;
  testing: boolean;
  reach: "ok" | "tcp" | "fail" | "unknown";
};

// Reachability check API response shape (mirrors /api/imported-configs/check).
type CheckResult = {
  id: string;
  host: string;
  port: number;
  ok: boolean;
  reach: "ok" | "tcp" | "fail";
  latencyMs: number;
  method: "tcp" | "tls" | "fail";
};
type CheckResponse = {
  checked: number;
  ok: number;
  tls: number;
  tcpOnly: number;
  results: CheckResult[];
};

function pingColor(p: number) {
  if (p === 0) return "#8aa0c4";
  if (p < 60) return "#10d9a0";
  if (p < 120) return "#ffb020";
  return "#ff4d6d";
}

// A config is "personal" if EITHER the user favorited it (single-URI imports
// are auto-favorited by /api/imported-configs/import) OR it was attached to
// a manual-source subscription (bulk pastes via the + button).
function isPersonal(c: ImportedConfig): boolean {
  return c.favorite || c.subscription?.kind === "manual";
}

export function ConnectView({ onPickServer }: { onPickServer: () => void }) {
  const { state, currentServer, live, settings, connect, disconnect } =
    useVpnStore();
  const [now, setNow] = useState(Date.now());
  const [showConfigList, setShowConfigList] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<ImportedConfig | null>(
    null
  );
  const [connecting, setConnecting] = useState(false);
  // Live latency probes, populated by "Test all" (POST /api/imported-configs/check).
  const [latencies, setLatencies] = useState<Record<string, LatencyState>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Tracks whether the user has manually picked a config — used to suppress
  // the "auto-switch to best after Test all" effect.
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);

  // Fetch BOTH default Iran configs (bucket=optimized) AND personal favorites
  // (favorite=true) AND manual-source imports — all in one shot. The backend
  // sorts by favorite DESC, score DESC, host ASC — so favorites bubble to the
  // top of the response array already.
  const {
    data: configData,
    loading: configsLoading,
    refetch: refetchConfigs,
  } = useFetch<{ configs: ImportedConfig[] }>(
    "/api/imported-configs?limit=80"
  );

  // Auto-update
  const {
    status: updateStatus,
    version: updateVersion,
    checkNow,
    isDesktop,
  } = useAutoUpdate();

  useEffect(() => {
    if (state !== "connected") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  const elapsed = live.connectedSince
    ? Math.floor((now - live.connectedSince) / 1000)
    : 0;
  const isConnected = state === "connected";
  const isConnecting = state === "connecting" || connecting;

  // ---- Sorted configs ----
  // Sort order (per the SUBIMPORT-PING-FIX spec):
  //   1. Personal configs first (favorite=true OR subscription.kind="manual")
  //   2. Within each tier (personal/default), sort:
  //      a. Reachable configs (reach="ok"|"tcp" with a latency) by ms ascending
  //      b. Untested + failed configs MIXED IN by score desc
  //         (failed configs aren't pushed to the bottom — they might still
  //          work via xray Reality, so they stay visible alongside untested ones)
  const sortedConfigs = useMemo(() => {
    const list = configData?.configs ?? [];
    const score = (c: ImportedConfig): number => {
      const lat = latencies[c.id];
      const personalBoost = isPersonal(c) ? 0 : 1_000_000;
      if (lat?.testing) {
        // testing → mid-low priority so the list doesn't reorder wildly mid-probe
        return personalBoost + 8_000_000;
      }
      if (lat?.ok && lat.ms != null) {
        // reachable (TLS or TCP) — sort by ms ascending
        return personalBoost + lat.ms;
      }
      // Both "fail" (TCP failed) and "unknown" (untested) configs sort by
      // score desc here. Mixing them in keeps failed configs visible instead
      // of pushing them all to the bottom of the list.
      return personalBoost + 4_000_000 - c.score;
    };
    return [...list].sort((a, b) => score(a) - score(b));
  }, [configData, latencies]);

  // Initial auto-select — only runs if no config is selected AND the user
  // hasn't manually picked one yet. Picks the first reachable (by latency) or
  // falls back to sortedConfigs[0] if nothing has been probed yet.
  useEffect(() => {
    if (userSelectedId) return;
    if (selectedConfig) return;
    if (!sortedConfigs.length) return;
    const reachable = sortedConfigs.find((c) => {
      const lat = latencies[c.id];
      // Prefer "ok" (TLS reachable) — orange configs (tcp/fail) may work
      // but aren't a guaranteed-good default.
      return lat?.reach === "ok" && lat.ms != null;
    });
    setSelectedConfig(reachable || sortedConfigs[0]);
  }, [sortedConfigs, latencies, userSelectedId, selectedConfig]);

  // Auto-switch to the best reachable config after Test all completes —
  // only if the user hasn't manually picked one. Prefers "ok" (TLS) over
  // "tcp" (TLS-failed but TCP ok).
  useEffect(() => {
    if (userSelectedId) return;
    if (testingAll) return;
    const tlsOk = sortedConfigs.find((c) => {
      const lat = latencies[c.id];
      return lat?.reach === "ok" && lat.ms != null;
    });
    const anyReachable = tlsOk || sortedConfigs.find((c) => {
      const lat = latencies[c.id];
      return lat?.ok && lat.ms != null;
    });
    if (anyReachable && anyReachable.id !== selectedConfig?.id) {
      setSelectedConfig(anyReachable);
    }
  }, [testingAll, sortedConfigs, latencies, userSelectedId, selectedConfig]);

  // ---- Test all configs (calls /api/imported-configs/check) ----
  // Single API call → server probes ALL configs (not just optimized) in
  // parallel via Promise.all. Returns a results array with {id, host, port,
  // ok, reach, latencyMs, method} per config. The new endpoint uses
  // probeReachabilityTLS which does TCP connect + TLS handshake, returning
  // a 3-state reach value: "ok" (TLS ok), "tcp" (TCP ok, TLS failed),
  // "fail" (TCP failed).
  const testAllConfigs = useCallback(async () => {
    const list = configData?.configs ?? [];
    if (!list.length) {
      toast.info("No configs to test", {
        description: "Refresh or import configs first.",
      });
      return;
    }
    setTestingAll(true);
    // Mark every config as testing so the UI shows the gray spinner badge.
    setLatencies((prev) => {
      const next = { ...prev };
      for (const c of list) {
        next[c.id] = { ms: null, ok: false, testing: true, reach: "unknown" };
      }
      return next;
    });

    try {
      const r = await postJSONSoft<CheckResponse>(
        "/api/imported-configs/check",
        { limit: 80 }
      );
      if (!r.ok || !r.data) {
        toast.error("Test failed", {
          description: r.error ?? "Unknown error",
        });
        // Reset testing flags on failure
        setLatencies((prev) => {
          const next = { ...prev };
          for (const c of list) {
            if (next[c.id]?.testing) {
              next[c.id] = {
                ms: null,
                ok: false,
                testing: false,
                reach: "unknown",
              };
            }
          }
          return next;
        });
        return;
      }
      const resultsMap = new Map<string, CheckResult>();
      for (const res of r.data.results) resultsMap.set(res.id, res);
      setLatencies((prev) => {
        const next = { ...prev };
        for (const c of list) {
          const found = resultsMap.get(c.id);
          if (found) {
            next[c.id] = {
              ms: found.latencyMs,
              ok: found.ok,
              testing: false,
              reach: found.reach,
            };
          } else {
            // Config wasn't probed (e.g. beyond the limit) — fall back to the
            // server-side reach value from the GET /api/imported-configs
            // response so the badge is still accurate.
            const reachVal =
              c.reach === "ok"
                ? "ok"
                : c.reach === "tcp"
                ? "tcp"
                : c.reach === "fail"
                ? "fail"
                : "unknown";
            next[c.id] = {
              ms: c.latencyMs || null,
              ok: reachVal === "ok" || reachVal === "tcp",
              testing: false,
              reach: reachVal,
            };
          }
        }
        return next;
      });
      const okCount = r.data.ok;
      const tlsCount = r.data.tls;
      const total = r.data.checked;
      toast.success("Reachability test done", {
        description: `${okCount}/${total} reachable · ${tlsCount} via TLS${
          okCount > 0 ? " · best latency auto-selected" : ""
        }`,
      });
    } catch (e) {
      toast.error("Test failed", { description: (e as Error).message });
    } finally {
      setTestingAll(false);
    }
  }, [configData]);

  // ---- Connect / disconnect handler ----
  // (Unchanged from the previous version — only types + protocols array fix.)
  const handleToggle = async () => {
    if (state === "disconnected" || state === "error") {
      if (!selectedConfig) {
        toast.error("No config selected", {
          description: "Refresh configs and try again.",
        });
        return;
      }

      setConnecting(true);
      try {
        // Step 1: fetch the config URI
        const uriResp = await fetch(
          `/api/emergency/candidates/${selectedConfig.id}/uri`,
          { method: "POST" }
        );
        if (!uriResp.ok) {
          throw new Error(`Failed to fetch config URI (${uriResp.status})`);
        }
        const uriData = await uriResp.json();
        const configUri = uriData.uri;

        // Step 2: start xray via companion API
        const companionResp = await fetch("/api/tunnel/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ configUri }),
        });

        if (companionResp.ok) {
          const result = await companionResp.json();
          if (result.ok) {
            toast.info("Starting tunnel…", {
              description: `${selectedConfig.protocol} → ${selectedConfig.host}:${selectedConfig.port}`,
            });
            await new Promise((r) => setTimeout(r, 3000));

            const statusResp = await fetch("/api/tunnel/status");
            if (statusResp.ok) {
              const statusData = await statusResp.json();
              if (statusData.running) {
                const verifyResp = await fetch("/api/tunnel/verify", {
                  method: "POST",
                });
                if (verifyResp.ok) {
                  const verifyData = await verifyResp.json();
                  if (verifyData.trafficVerified) {
                    connect(
                      {
                        id: selectedConfig.id,
                        code: selectedConfig.host,
                        country: selectedConfig.country || "Iran",
                        countryCode: "",
                        city: selectedConfig.host,
                        flag: "🇮🇷",
                        host: selectedConfig.host,
                        port: selectedConfig.port,
                        protocols: [selectedConfig.protocol],
                        load: 0,
                        ping: verifyData.latencyMs || 50,
                        upMbps: 1000,
                        downMbps: 1000,
                        online: true,
                        premium: false,
                        stealth: true,
                        note: selectedConfig.flags,
                      } as ServerLite,
                      selectedConfig.protocol
                    );
                    toast.success("Connected!", {
                      description: `Exit IP: ${verifyData.exitIp}`,
                    });
                  } else {
                    throw new Error(
                      `Tunnel started but traffic verification failed: ${
                        verifyData.error || "unknown"
                      }`
                    );
                  }
                } else {
                  throw new Error(
                    "Tunnel started but verification endpoint failed"
                  );
                }
              } else {
                throw new Error("xray crashed after starting — check logs");
              }
            } else {
              throw new Error("Cannot check tunnel status");
            }
          } else {
            throw new Error(result.error || "Tunnel failed to start");
          }
        } else {
          let errorMsg = "Companion API not reachable";
          try {
            const errData = await companionResp.json();
            errorMsg = errData.error || errorMsg;
          } catch {}
          throw new Error(`Connection failed: ${errorMsg}`);
        }

        // Best-effort session record
        try {
          await postJSON("/api/connect", {
            serverId: selectedConfig.id,
            protocol: selectedConfig.protocol,
            action: "connect",
          });
        } catch {}
      } catch (e) {
        toast.error("Connection failed", {
          description: (e as Error).message,
        });
      } finally {
        setConnecting(false);
      }
    } else if (state === "connected") {
      disconnect();
      try {
        await fetch("/api/tunnel/stop", { method: "POST" });
      } catch {}
      try {
        await postJSON("/api/connect", {
          serverId: selectedConfig?.id || "",
          protocol: selectedConfig?.protocol || "wireguard",
          action: "disconnect",
        });
      } catch {}
    }
  };

  const handleRefresh = async () => {
    toast.info("Refreshing configs…");
    try {
      const resp = await fetch("/api/subscriptions", { method: "GET" });
      if (resp.ok) {
        const data = await resp.json();
        const subs = data.subscriptions || [];
        for (const sub of subs) {
          await fetch(`/api/subscriptions/${sub.id}/refresh`, {
            method: "POST",
          });
        }
      }
      refetchConfigs();
      toast.success("Configs refreshed", {
        description: "Latest configs loaded.",
      });
    } catch {
      toast.error("Refresh failed");
    }
  };

  const handleCheckUpdate = async () => {
    toast.info("Checking for updates…");
    const r = await checkNow();
    if (r.ok) {
      toast.success("Check complete", {
        description:
          updateStatus === "available"
            ? `Update v${updateVersion} available!`
            : "You're up to date.",
      });
    } else {
      toast.error("Update check failed", { description: r.error });
    }
  };

  // Testing progress text — "Testing 12" (how many probes are in-flight).
  const testingCount = useMemo(
    () => Object.values(latencies).filter((l) => l.testing).length,
    [latencies]
  );
  const totalConfigs = configData?.configs?.length ?? 0;
  const reachableCount = useMemo(
    () => Object.values(latencies).filter((l) => l.ok && l.ms != null).length,
    [latencies]
  );

  return (
    <div className="space-y-6 pb-8">
      {/* --- Header: Test all + version + refresh --- */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">Connect</h2>
          <p className="text-xs text-muted-foreground mt-1 font-tech uppercase tracking-wider">
            One tap to freedom
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Test all — probes ALL configs (TCP + TLS handshake) in parallel server-side */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={testAllConfigs}
                disabled={testingAll || configsLoading || totalConfigs === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 hover:border-[#10d9a0]/40 transition-colors text-xs text-muted-foreground hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testingAll ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin text-[#10d9a0]" />
                    <span className="text-[#10d9a0] font-tech">
                      Testing{testingCount ? ` ${testingCount}` : "…"}
                    </span>
                  </>
                ) : (
                  <>
                    <Activity className="w-3 h-3 text-[#10d9a0]" />
                    <span className="font-tech">Test all</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-[280px] bg-[#0d1426] border border-[#00f0ff]/20 text-[#c8d8ff] text-[11px] font-sans normal-case tracking-normal shadow-[0_0_18px_rgba(0,240,255,0.15)]"
            >
              <span>
                Probes TCP+TLS reachability.{" "}
                <span className="text-[#ffb020]">Orange ?</span> means the host
                may be DPI-blocked but could still work via xray Reality.
              </span>
            </TooltipContent>
          </Tooltip>

          {/* Version + update button */}
          <button
            onClick={handleCheckUpdate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 hover:border-[#00f0ff]/30 transition-colors text-xs text-muted-foreground hover:text-white"
            title="Check for updates"
          >
            {updateStatus === "available" ? (
              <>
                <Download className="w-3 h-3 text-[#10d9a0] animate-pulse" />
                <span className="text-[#10d9a0] font-tech">
                  v{updateVersion} ready
                </span>
              </>
            ) : updateStatus === "downloading" ? (
              <>
                <RefreshCw className="w-3 h-3 animate-spin text-[#00f0ff]" />
                <span className="text-[#00f0ff] font-tech">Downloading…</span>
              </>
            ) : (
              <>
                <RefreshCw className="w-3 h-3" />
                <span className="font-tech">Check updates</span>
              </>
            )}
          </button>

          {/* Refresh configs button */}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 hover:border-[#00f0ff]/30 transition-colors text-xs text-muted-foreground hover:text-white"
            title="Refresh configs"
          >
            <RefreshCw
              className={`w-3 h-3 ${configsLoading ? "animate-spin" : ""}`}
            />
            <span className="font-tech">Refresh</span>
          </button>
        </div>
      </div>

      {/* --- Big Connect button --- */}
      <div className="flex justify-center py-8">
        <motion.button
          onClick={handleToggle}
          whileTap={{ scale: 0.95 }}
          className={`relative w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-300 ${
            isConnected
              ? "bg-gradient-to-br from-[#10d9a0] to-[#0d7a6d] shadow-[0_0_60px_rgba(16,217,160,0.4)]"
              : isConnecting
              ? "bg-gradient-to-br from-[#ffb020] to-[#d4880f] shadow-[0_0_40px_rgba(255,176,32,0.3)]"
              : "bg-card border border-white/10 hover:border-[#00f0ff]/50 shadow-[0_0_30px_rgba(0,240,255,0.1)]"
          }`}
          aria-label={isConnected ? "Disconnect VPN" : "Connect VPN"}
        >
          {isConnected && (
            <>
              <div className="absolute inset-0 rounded-full border-2 border-[#10d9a0] animate-ping opacity-20" />
              <div className="absolute -inset-2 rounded-full border border-[#10d9a0]/30 animate-pulse" />
            </>
          )}
          <Power
            className={`w-12 h-12 ${
              isConnected ? "text-[#02131a]" : "text-[#00f0ff]"
            }`}
            strokeWidth={2.2}
          />
          <span
            className={`font-tech uppercase tracking-[0.3em] text-xs mt-2 ${
              isConnected
                ? "text-[#02131a]"
                : isConnecting
                ? "text-[#02131a]"
                : "text-muted-foreground"
            }`}
          >
            {isConnected
              ? "Connected"
              : isConnecting
              ? "Connecting…"
              : "Tap to Connect"}
          </span>
        </motion.button>
      </div>

      {/* --- Selected server card + Import button + Change button --- */}
      <div className="bg-card border border-white/5 rounded-xl p-4">
        <div className="flex items-center justify-between gap-2">
          {selectedConfig ? (
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded-lg bg-[#00f0ff]/10 flex items-center justify-center flex-shrink-0">
                <span className="text-lg">🇮🇷</span>
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white flex items-center gap-2 flex-wrap">
                  <span className="font-mono uppercase">
                    {selectedConfig.protocol}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="truncate">
                    {selectedConfig.host}:{selectedConfig.port}
                  </span>
                  {isPersonal(selectedConfig) && (
                    <Star
                      className="w-3.5 h-3.5 fill-[#ffb020] text-[#ffb020] flex-shrink-0"
                      aria-label="Personal config"
                    />
                  )}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                  {selectedConfig.flags && (
                    <Badge
                      variant="outline"
                      className="text-[9px] py-0 px-1.5 border-[#8b5cf6]/30 text-[#8b5cf6]"
                    >
                      {selectedConfig.flags.split(",")[0]}
                    </Badge>
                  )}
                  <span>Score: {selectedConfig.score}</span>
                  {(() => {
                    const lat = latencies[selectedConfig.id];
                    if (lat?.testing)
                      return (
                        <span className="text-muted-foreground">testing…</span>
                      );
                    // GREEN — TLS reachable
                    if (lat?.reach === "ok" && lat.ms != null)
                      return (
                        <span style={{ color: pingColor(lat.ms) }}>
                          {lat.ms}ms
                        </span>
                      );
                    // ORANGE — TCP ok, TLS failed
                    if (lat?.reach === "tcp" && lat.ms != null)
                      return (
                        <span className="text-[#ffb020]">
                          {lat.ms}ms? · maybe blocked
                        </span>
                      );
                    // ORANGE — TCP failed (xray might still work)
                    if (lat?.reach === "fail")
                      return (
                        <span className="text-[#ffb020]">
                          ? · try via xray
                        </span>
                      );
                    // Fall back to server-side reach if no client probe exists
                    if (
                      selectedConfig.reach === "ok" &&
                      selectedConfig.latencyMs > 0
                    )
                      return (
                        <span
                          style={{
                            color: pingColor(selectedConfig.latencyMs),
                          }}
                        >
                          {selectedConfig.latencyMs}ms
                        </span>
                      );
                    if (selectedConfig.reach === "tcp")
                      return (
                        <span className="text-[#ffb020]">
                          {selectedConfig.latencyMs > 0
                            ? `${selectedConfig.latencyMs}ms?`
                            : "? · maybe blocked"}
                        </span>
                      );
                    if (selectedConfig.reach === "fail")
                      return (
                        <span className="text-[#ffb020]">? · try via xray</span>
                      );
                    return (
                      <span className="text-muted-foreground/60">untested</span>
                    );
                  })()}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground flex-1">
              {configsLoading ? "Loading configs…" : "No config selected"}
            </div>
          )}

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* + Import button — opens the ImportDialog modal */}
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-brand-gradient text-[#02131a] hover:opacity-90 text-xs font-tech uppercase tracking-wider transition-opacity shadow-[0_0_18px_rgba(0,240,255,0.25)]"
              title="Import a personal config (paste a vmess/vless/trojan/ss URI)"
              aria-label="Import personal config"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
              <span className="hidden sm:inline">Import</span>
            </button>
            <button
              onClick={() => setShowConfigList(!showConfigList)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] text-xs text-muted-foreground hover:text-white transition-colors"
            >
              {selectedConfig ? "Change" : "Select"}
              <ChevronDown
                className={`w-3 h-3 transition-transform ${
                  showConfigList ? "rotate-180" : ""
                }`}
              />
            </button>
          </div>
        </div>

        {/* Config dropdown */}
        <AnimatePresence>
          {showConfigList && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-3 pt-3 border-t border-white/5 space-y-1">
                {/* Status row */}
                <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-tech uppercase tracking-wider text-muted-foreground/70">
                  <span>
                    {totalConfigs} configs · {reachableCount} reachable
                  </span>
                  {testingAll && (
                    <span className="text-[#10d9a0]">
                      testing {testingCount}…
                    </span>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto pr-1 -mr-1 space-y-1 custom-scroll">
                  {sortedConfigs.map((cfg) => {
                    const lat = latencies[cfg.id];
                    const personal = isPersonal(cfg);
                    const isSelected = selectedConfig?.id === cfg.id;
                    return (
                      <button
                        key={cfg.id}
                        onClick={() => {
                          setSelectedConfig(cfg);
                          setUserSelectedId(cfg.id);
                          setShowConfigList(false);
                        }}
                        className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors text-left ${
                          isSelected
                            ? "bg-[#00f0ff]/10 border border-[#00f0ff]/20"
                            : "hover:bg-white/[0.03] border border-transparent"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {/* Personal indicator: ⭐ for personal, hollow dot for default */}
                          {personal ? (
                            <Star
                              className="w-4 h-4 fill-[#ffb020] text-[#ffb020] flex-shrink-0"
                              aria-label="Personal config"
                            />
                          ) : (
                            <div className="w-4 h-4 rounded-full border border-white/10 flex-shrink-0" />
                          )}
                          <div className="text-xs font-mono text-[#5cf2ff] uppercase flex-shrink-0">
                            {cfg.protocol}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm text-white truncate">
                              {cfg.label || `${cfg.host}:${cfg.port}`}
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono truncate">
                              {cfg.host}:{cfg.port}
                              {cfg.flags && (
                                <span className="text-muted-foreground/60">
                                  {" "}
                                  ·{" "}
                                  {cfg.flags
                                    .split(",")
                                    .slice(0, 2)
                                    .join(",")}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {/* Latency badge */}
                          <LatencyBadge
                            state={lat}
                            fallbackMs={cfg.latencyMs}
                            fallbackReach={cfg.reach}
                          />
                          {isSelected && (
                            <Check className="w-4 h-4 text-[#00f0ff]" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                  {sortedConfigs.length === 0 && (
                    <div className="text-center text-sm text-muted-foreground py-6">
                      No configs available.
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleRefresh}
                          className="h-7 text-[10px]"
                        >
                          <RefreshCw
                            className={`w-3 h-3 mr-1 ${
                              configsLoading ? "animate-spin" : ""
                            }`}
                          />
                          Refresh
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setShowImport(true)}
                          className="h-7 text-[10px] bg-brand-gradient text-[#02131a] hover:opacity-90"
                        >
                          <Plus className="w-3 h-3 mr-1" strokeWidth={2.5} />
                          Import
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* --- Live metrics (when connected) --- */}
      {isConnected && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          <MetricCard
            icon={<Download className="w-4 h-4" />}
            label="Download"
            value={formatRate(live.downBps)}
            color="#10d9a0"
          />
          <MetricCard
            icon={<Upload className="w-4 h-4" />}
            label="Upload"
            value={formatRate(live.upBps)}
            color="#00f0ff"
          />
          <MetricCard
            icon={<Activity className="w-4 h-4" />}
            label="Ping"
            value={`${live.ping}ms`}
            color="#ffb020"
          />
          <MetricCard
            icon={<Clock className="w-4 h-4" />}
            label="Session"
            value={formatDuration(elapsed)}
            color="#8b5cf6"
          />
        </motion.div>
      )}

      {/* --- Quick toggles --- */}
      <div className="flex flex-wrap gap-2">
        {settings.killSwitch && (
          <Badge
            variant="outline"
            className="border-[#ff4d6d]/30 text-[#ff4d6d] text-xs"
          >
            Kill Switch
          </Badge>
        )}
        {settings.stealthMode && (
          <Badge
            variant="outline"
            className="border-[#8b5cf6]/30 text-[#8b5cf6] text-xs"
          >
            Stealth
          </Badge>
        )}
        {settings.blockTrackers && (
          <Badge
            variant="outline"
            className="border-[#10d9a0]/30 text-[#10d9a0] text-xs"
          >
            No Trackers
          </Badge>
        )}
      </div>

      {/* --- IP location widget (real IP vs VPN IP) --- */}
      <IpLocationWidget isConnected={isConnected} />

      {/* --- Desktop companion status --- */}
      {!isDesktop && (
        <div className="flex items-center gap-2 text-xs text-[#ffb020] bg-[#ffb020]/5 border border-[#ffb020]/10 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            Desktop companion not detected. Real VPN tunneling requires the
            desktop app. Connection will fail until the companion API is
            running.
          </span>
        </div>
      )}

      {/* --- Import dialog (personal config paste) --- */}
      <ImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onDone={() => {
          refetchConfigs();
          toast.success("Personal config ready", {
            description: "Now visible in your dropdown with a ⭐ badge.",
          });
        }}
      />
    </div>
  );
}

// Latency badge — color-coded by reach state with 4 visible states:
//   - testing: gray spinner + "…"
//   - reach="ok" (TLS reachable): GREEN badge with ms (color varies by ms)
//   - reach="tcp" (TCP ok, TLS failed): ORANGE badge with "ms?" — may work via Reality
//   - reach="fail" (TCP failed): ORANGE badge with "?" — xray might still work
//   - untested: gray "—" badge (no probe has run)
//
// Design decision: we DON'T show a hard red ✗ for "fail" anymore. Iran DPI
// injects RST packets on bare TCP connects, so a "fail" config can still work
// through xray Reality/WS-TLS transport. Orange ? communicates "host may be
// blocked but worth trying" instead of "definitely dead". A real failure only
// surfaces when the user actually clicks Connect and the tunnel fails to
// verify (we'd need to track that separately — for now, all probe-state
// results are advisory).
function LatencyBadge({
  state,
  fallbackMs,
  fallbackReach,
}: {
  state?: LatencyState;
  fallbackMs: number;
  fallbackReach: string;
}) {
  // Testing state — gray spinner, no result yet.
  if (state?.testing) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/10 text-muted-foreground">
        <RefreshCw className="w-2.5 h-2.5 animate-spin" />
      </span>
    );
  }

  // Compute the effective reach — prefer client-side probe, fall back to
  // server-side reach value (initial DB state) when no probe has run yet.
  const reach: "ok" | "tcp" | "fail" | "unknown" =
    state?.reach ??
    (fallbackReach === "ok"
      ? "ok"
      : fallbackReach === "tcp"
      ? "tcp"
      : fallbackReach === "fail"
      ? "fail"
      : "unknown");
  const ms = state?.ms ?? (fallbackMs > 0 ? fallbackMs : null);

  // GREEN — TLS handshake succeeded (truly reachable through DPI).
  if (reach === "ok" && ms != null) {
    const color =
      ms <= 60 ? "#10d9a0" : ms <= 150 ? "#ffb020" : "#ff4d6d";
    const bg =
      ms <= 60
        ? "rgba(16,217,160,0.1)"
        : ms <= 150
        ? "rgba(255,176,32,0.1)"
        : "rgba(255,77,109,0.1)";
    const border =
      ms <= 60
        ? "rgba(16,217,160,0.3)"
        : ms <= 150
        ? "rgba(255,176,32,0.3)"
        : "rgba(255,77,109,0.3)";
    return (
      <span
        className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border"
        style={{ color, background: bg, borderColor: border }}
        title="TLS reachable — host is truly online through DPI"
      >
        {ms}ms
      </span>
    );
  }

  // ORANGE — TCP ok, TLS failed. May work via Reality (looks like normal HTTPS).
  if (reach === "tcp" && ms != null) {
    return (
      <span
        className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border border-[#ffb020]/30 text-[#ffb020] bg-[#ffb020]/5"
        title="TCP ok, TLS handshake failed — DPI may be interfering. May still work via Reality."
      >
        {ms}ms?
      </span>
    );
  }

  // ORANGE — TCP failed. xray might still get through (Reality mimics legit
  // TLS, so DPI might not block the actual tunnel even though our probe failed).
  if (reach === "fail") {
    return (
      <span
        className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border border-[#ffb020]/30 text-[#ffb020] bg-[#ffb020]/5"
        title="TCP probe failed — but xray might still connect via Reality/WS. Try connecting to see if it actually works."
      >
        ?
      </span>
    );
  }

  // GRAY — no probe data yet. Show "—".
  return (
    <span
      className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/10 text-muted-foreground/60"
      title="Untested — click Test all to probe this config"
    >
      —
    </span>
  );
}

function MetricCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-card border border-white/5 rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <span style={{ color }}>{icon}</span>
        <span className="text-[10px] font-tech uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-sm font-mono font-semibold text-white">{value}</div>
    </div>
  );
}
