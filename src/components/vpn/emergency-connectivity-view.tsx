'use client';

// DISTORT — Emergency Connectivity UI view (engine-driven rewrite)
//
// This view is the HONEST surface for the Distort recovery engine. It does NOT
// just render a server-built plan — it actually drives the real client-side
// `RecoveryEngine` (from src/lib/emergency-connectivity/recovery-engine.ts):
//
//   1. On mount: detects whether the Distort Desktop companion is running at
//      127.0.0.1:10810, loads local configs from IndexedDB, and runs an initial
//      client-side network diagnosis (real probes to 1.1.1.1 / cloudflare / iran.ir).
//   2. When the user clicks "Recover Connection", we instantiate a RecoveryEngine
//      with an `onStatusChange` callback that mirrors the engine's status into
//      React state. Every state-machine transition (idle → diagnosing → selecting
//      → connecting → verifying → connected | recovering | exhausted) and every
//      attempt log fires the callback, so the UI updates LIVE.
//   3. The "Connected" state is ONLY shown when the engine's real verification
//      succeeded — exit IP differs from real IP. We never fake it.
//   4. Browser-only engine honesty: if no desktop companion is detected, the
//      engine reports "browser-only" and every candidate attempt fails with a
//      clear "Install the Desktop app" reason. The diagnosis + config validation
//      still work, so when the user installs the companion, the engine knows
//      which paths to use first.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Globe,
  Radio,
  ShieldCheck,
  RefreshCw,
  Upload,
  RotateCcw,
  Wifi,
  Network,
  Zap,
  Power,
  Ban,
  Trash2,
  XCircle,
  MonitorSmartphone,
} from "lucide-react";
import { toast } from "sonner";
import { postJSON } from "@/hooks/use-fetch";

import { RecoveryEngine, detectCompanion } from "@/lib/emergency-connectivity/recovery-engine";
import { diagnoseClientSide } from "@/lib/emergency-connectivity/client-diagnostics";
import {
  getAllConfigs,
  addConfig,
  deleteConfig,
  wipeAllConfigs,
  type StoredConfig,
} from "@/lib/emergency-connectivity/local-config-store";
import { idleStatus } from "@/lib/emergency-connectivity/state-machine";
import type {
  RecoveryStatus,
  RecoveryState,
  CandidatePath,
  RecoveryAttempt,
  NetworkDiagnosis,
  BaseNetworkStatus,
  StructuralValidity,
  ServerReachability,
  TunnelVerification,
  TransportType,
  ValidateConfigResponse,
} from "@/lib/emergency-connectivity/types";
import { RECOVERY_STATE_LABELS } from "@/lib/emergency-connectivity/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROTOCOL_LABEL: Record<TransportType, string> = {
  wireguard: "WireGuard",
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "Shadowsocks",
  ssh: "SSH",
  satellite: "Satellite",
};

function protocolColor(p: TransportType): string {
  switch (p) {
    case "wireguard":
      return "#10d9a0";
    case "vless":
      return "#00f0ff";
    case "vmess":
      return "#2962ff";
    case "trojan":
      return "#8b5cf6";
    case "shadowsocks":
      return "#ffb020";
    case "ssh":
      return "#5cf2ff";
    case "satellite":
      return "#a78bfa";
    default:
      return "#8aa0c4";
  }
}

function structuralBadge(s: StructuralValidity): { label: string; color: string } {
  switch (s) {
    case "valid":
      return { label: "STRUCT", color: "#10d9a0" };
    case "invalid-syntax":
    case "unsupported-protocol":
      return { label: "STRUCT", color: "#ff4d6d" };
    case "missing-fields":
      return { label: "STRUCT", color: "#ffb020" };
    default:
      return { label: "STRUCT", color: "#8aa0c4" };
  }
}

function reachabilityBadge(r: ServerReachability): { label: string; color: string } {
  switch (r) {
    case "reachable":
      return { label: "REACH", color: "#10d9a0" };
    case "unreachable":
      return { label: "REACH", color: "#ff4d6d" };
    case "not-probed":
    default:
      return { label: "REACH", color: "#8aa0c4" };
  }
}

function tunnelBadge(t: TunnelVerification): { label: string; color: string } {
  switch (t) {
    case "verified":
      return { label: "TUNNEL", color: "#10d9a0" };
    case "traffic-failed":
    case "leak-detected":
      return { label: "TUNNEL", color: "#ff4d6d" };
    case "not-attempted":
    default:
      return { label: "TUNNEL", color: "#8aa0c4" };
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return "#10d9a0";
  if (score >= 60) return "#00f0ff";
  if (score >= 40) return "#ffb020";
  return "#8aa0c4";
}

function baseNetworkColor(s: BaseNetworkStatus): string {
  switch (s) {
    case "online":
      return "#10d9a0";
    case "local-only":
      return "#ffb020";
    case "offline":
      return "#ff4d6d";
    default:
      return "#8aa0c4";
  }
}

function baseNetworkLabel(s: BaseNetworkStatus): string {
  switch (s) {
    case "online":
      return "online";
    case "local-only":
      return "local-only";
    case "offline":
      return "offline";
    default:
      return "unknown";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Local StoredConfig ids are generated with the "cfg_" prefix in local-config-store.ts.
// Remote candidates from /api/imported-configs use UUIDs.
function isLocalCandidate(id: string): boolean {
  return id.startsWith("cfg_");
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EmergencyConnectivityView() {
  // Engine + companion detection
  const engineRef = useRef<RecoveryEngine | null>(null);
  const [enginePlatform, setEnginePlatform] = useState<
    "browser-only" | "browser-with-companion" | "detecting"
  >("detecting");
  const [companionDetected, setCompanionDetected] = useState(false);

  // Live engine status — mirrored from onStatusChange
  const [status, setStatus] = useState<RecoveryStatus>(() => idleStatus());

  // Independent client-side diagnosis (not tied to the engine — user can re-probe)
  const [diagnosis, setDiagnosis] = useState<NetworkDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  // Local config store (IndexedDB)
  const [localConfigs, setLocalConfigs] = useState<StoredConfig[]>([]);

  // Recovery cycle running flag (separate from engine state — gives UI a hard
  // "engine.recover() hasn't resolved yet" signal even if state goes idle in
  // between)
  const [cycleRunning, setCycleRunning] = useState(false);

  // Import dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [importUri, setImportUri] = useState("");
  const [importProbe, setImportProbe] = useState(true);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidateConfigResponse | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Wipe-all confirmation
  const [wipeConfirming, setWipeConfirming] = useState(false);

  // -------------------------------------------------------------------------
  // On mount: detect companion, load local configs, run initial diagnosis
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      // 1. Detect desktop companion (controls whether real tunneling is available)
      try {
        const up = await detectCompanion(2000);
        if (cancelled) return;
        setCompanionDetected(up);
        setEnginePlatform(up ? "browser-with-companion" : "browser-only");
      } catch {
        if (cancelled) return;
        setCompanionDetected(false);
        setEnginePlatform("browser-only");
      }

      // 2. Load local configs from IndexedDB (offline-available)
      try {
        const cfgs = await getAllConfigs();
        if (cancelled) return;
        setLocalConfigs(cfgs);
      } catch {
        // IndexedDB not available — local configs just won't show
      }

      // 3. Run an initial client-side diagnosis so the user sees something real
      // immediately, without having to click Recover first.
      runDiagnose();
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh local config list helper (called after add/delete/wipe)
  const refreshLocalConfigs = useCallback(async () => {
    try {
      const cfgs = await getAllConfigs();
      setLocalConfigs(cfgs);
    } catch {
      setLocalConfigs([]);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Diagnose network (real client-side probes)
  // -------------------------------------------------------------------------
  const runDiagnose = useCallback(async () => {
    setDiagnosing(true);
    try {
      const d = await diagnoseClientSide();
      setDiagnosis(d);
    } catch (e) {
      toast.error("Diagnosis failed", {
        description: (e as Error).message || "Could not probe the network from the browser.",
      });
    } finally {
      setDiagnosing(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Recover Connection — drive the real engine
  // -------------------------------------------------------------------------
  const handleRecover = useCallback(async () => {
    if (cycleRunning) return;
    setCycleRunning(true);

    try {
      // Create a fresh engine instance for this cycle (the previous one may
      // have stopped monitoring). Wire onStatusChange to mirror into React.
      const engine = new RecoveryEngine({
        onStatusChange: (next) => {
          setStatus(next);
        },
      });
      engineRef.current = engine;

      await engine.init();
      // After init, the engine has picked BrowserOnly or BrowserWithCompanion.
      // We don't read it directly (private field), but the attempts' reason
      // string will reveal it. We already detected the companion on mount, so
      // our `enginePlatform` state is the source of truth for the badge.

      await engine.recover();

      const finalStatus = engine.getStatus();
      setStatus(finalStatus);

      if (finalStatus.state === "connected") {
        toast.success("Tunnel verified", {
          description: "Traffic is flowing through the tunnel — exit IP differs from real IP.",
        });
      } else if (finalStatus.state === "exhausted") {
        toast.error("All paths exhausted", {
          description:
            finalStatus.exhaustedReason ||
            "No candidate produced a verified tunnel. See the recovery log for details.",
        });
      } else {
        // Aborted / reset mid-cycle
        toast.info("Recovery cycle ended", {
          description: `Final state: ${RECOVERY_STATE_LABELS[finalStatus.state].label}.`,
        });
      }

      // Refresh local configs (success/failure streaks updated by the engine)
      await refreshLocalConfigs();
    } catch (e) {
      toast.error("Recovery engine crashed", {
        description: (e as Error).message || "Unexpected error during recovery.",
      });
    } finally {
      setCycleRunning(false);
    }
  }, [cycleRunning, refreshLocalConfigs]);

  // -------------------------------------------------------------------------
  // Manual controls
  // -------------------------------------------------------------------------
  const handleAbort = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.abort();
    setStatus(engine.getStatus());
    setCycleRunning(false);
    toast.info("Recovery aborted", {
      description: "Engine stopped. Click Recover Connection to start a new cycle.",
    });
  }, []);

  const handleDisconnect = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.disconnect();
    setStatus(engine.getStatus());
    toast.info("Tunnel disconnected", {
      description: "Health monitoring stopped. Engine returned to idle.",
    });
  }, []);

  const handleReset = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      engine.reset();
    } else {
      engineRef.current = null;
    }
    setStatus(idleStatus());
    setCycleRunning(false);
    toast.info("Engine reset", {
      description: "All state, attempts, and the active plan have been cleared.",
    });
  }, []);

  const handleWipeAll = useCallback(async () => {
    try {
      await wipeAllConfigs();
      await refreshLocalConfigs();
      setWipeConfirming(false);
      toast.success("All local configs wiped", {
        description: "IndexedDB store cleared. The engine has no local candidates now.",
      });
    } catch (e) {
      toast.error("Wipe failed", {
        description: (e as Error).message || "Could not clear the local config store.",
      });
    }
  }, [refreshLocalConfigs]);

  const handleDeleteConfig = useCallback(
    async (id: string) => {
      try {
        await deleteConfig(id);
        await refreshLocalConfigs();
        toast.success("Config removed", {
          description: "Deleted from local IndexedDB store.",
        });
      } catch (e) {
        toast.error("Delete failed", {
          description: (e as Error).message || "Could not remove the config.",
        });
      }
    },
    [refreshLocalConfigs]
  );

  // -------------------------------------------------------------------------
  // Import dialog actions (validate + add-to-favorites → local store)
  // -------------------------------------------------------------------------
  const handleValidate = useCallback(async () => {
    if (!importUri.trim()) {
      setValidationError("Paste a config URI first");
      return;
    }
    setValidationError(null);
    setValidating(true);
    setValidation(null);
    try {
      const r = await postJSON<ValidateConfigResponse>(
        "/api/emergency/configs/validate",
        { input: importUri.trim(), probeReachability: importProbe }
      );
      setValidation(r);
    } catch (e) {
      const msg = (e as Error).message || "Validation request failed";
      setValidationError(msg);
    } finally {
      setValidating(false);
    }
  }, [importUri, importProbe]);

  const handleAddFavorite = useCallback(async () => {
    if (!validation?.parsed) return;
    const p = validation.parsed;
    if (!p.host || !p.port) {
      toast.error("Cannot save — host or port missing");
      return;
    }
    try {
      await addConfig({
        uri: importUri.trim(),
        label: `${PROTOCOL_LABEL[p.protocol as TransportType] ?? p.protocol} · ${p.host}:${p.port}`,
        protocol: p.protocol as string,
        host: p.host,
        port: p.port,
        score: p.antiDpiScore,
        flags: p.flags,
        country: null,
        favorite: true,
      });
      await refreshLocalConfigs();
      toast.success("Config saved locally", {
        description:
          "Available for emergency recovery offline. The engine will try it first next time.",
      });
      // Close the dialog so the user sees the new candidate in the list
      closeImport();
    } catch (e) {
      toast.error("Could not save config", {
        description: (e as Error).message || "IndexedDB write failed.",
      });
    }
  }, [validation, importUri, refreshLocalConfigs]);

  const closeImport = useCallback(() => {
    setImportOpen(false);
    setImportUri("");
    setValidation(null);
    setValidationError(null);
  }, []);

  // -------------------------------------------------------------------------
  // Derived display data
  // -------------------------------------------------------------------------
  const stateMeta = RECOVERY_STATE_LABELS[status.state];
  const activePlan = status.activePlan;
  const candidates: CandidatePath[] = activePlan?.candidates ?? [];
  const attempts = status.attempts;
  const currentCandidate = status.currentCandidate;
  const canRecover =
    !cycleRunning &&
    status.state !== "diagnosing" &&
    status.state !== "selecting" &&
    status.state !== "connecting" &&
    status.state !== "verifying";
  const canAbort =
    cycleRunning &&
    (status.state === "diagnosing" ||
      status.state === "selecting" ||
      status.state === "connecting" ||
      status.state === "verifying" ||
      status.state === "recovering");
  const canDisconnect = status.state === "connected" || status.state === "degraded";

  return (
    <div className="space-y-4">
      {/* Engine platform badge */}
      <Card className="glass border-white/5">
        <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border"
              style={{
                background: companionDetected
                  ? "rgba(16,217,160,0.10)"
                  : "rgba(255,77,109,0.08)",
                borderColor: companionDetected
                  ? "rgba(16,217,160,0.35)"
                  : "rgba(255,77,109,0.30)",
                color: companionDetected ? "#10d9a0" : "#ff4d6d",
              }}
            >
              <MonitorSmartphone className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white flex items-center gap-2 flex-wrap">
                Engine:
                <span
                  className="font-mono text-xs px-2 py-0.5 rounded border"
                  style={{
                    color: companionDetected ? "#10d9a0" : "#ff4d6d",
                    borderColor: companionDetected
                      ? "rgba(16,217,160,0.35)"
                      : "rgba(255,77,109,0.35)",
                    background: companionDetected
                      ? "rgba(16,217,160,0.06)"
                      : "rgba(255,77,109,0.05)",
                  }}
                >
                  {enginePlatform === "detecting"
                    ? "detecting…"
                    : enginePlatform}
                </span>
                <Badge
                  variant="outline"
                  className="text-[9px] font-tech uppercase tracking-wider h-4 border-white/10 text-muted-foreground"
                >
                  {localConfigs.length} local config{localConfigs.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {companionDetected
                  ? "Desktop companion detected at 127.0.0.1:10810 — real tunneling available. The engine will start xray via the companion control API and verify tunnel traffic through the local SOCKS5 proxy."
                  : "No desktop companion — browser can diagnose but cannot connect. Install the Distort Desktop app for real connectivity."}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runDiagnose}
              disabled={diagnosing}
              className="border-white/10 text-muted-foreground hover:text-white font-tech uppercase tracking-wider text-[10px] h-8"
            >
              <RefreshCw className={`w-3 h-3 mr-1.5 ${diagnosing ? "animate-spin" : ""}`} />
              Re-diagnose
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Honesty banner */}
      <Alert className="border-[#ffb020]/30 bg-[#ffb020]/[0.06] text-[#ffb020]">
        <AlertTriangle className="w-4 h-4" />
        <AlertTitle className="font-tech uppercase tracking-wider text-xs">
          Web dashboard = diagnosis + validation only
        </AlertTitle>
        <AlertDescription className="text-[#eaf2ff]/80">
          The web dashboard can diagnose your network and validate configs. To
          actually establish a VPN tunnel, install the{" "}
          <span className="text-[#5cf2ff]">Distort Desktop</span> app (which
          exposes a local control API at 127.0.0.1:10810) or the Android app.
          The engine will still try each candidate and report which ones have
          valid structure + reachable servers, so when you install the desktop
          app, it knows which to use.
        </AlertDescription>
      </Alert>

      {/* Action bar */}
      <Card className="glass border-white/5">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleRecover}
              disabled={!canRecover}
              className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider text-xs h-9"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 mr-1.5 ${cycleRunning ? "animate-spin" : ""}`}
              />
              {cycleRunning ? "Recovering…" : "Recover Connection"}
            </Button>
            {canAbort && (
              <Button
                type="button"
                onClick={handleAbort}
                variant="outline"
                className="border-[#ffb020]/30 text-[#ffb020] hover:bg-[#ffb020]/10 font-tech uppercase tracking-wider text-xs h-9"
              >
                <Ban className="w-3.5 h-3.5 mr-1.5" /> Abort
              </Button>
            )}
            {canDisconnect && (
              <Button
                type="button"
                onClick={handleDisconnect}
                variant="outline"
                className="border-[#ff4d6d]/30 text-[#ff4d6d] hover:bg-[#ff4d6d]/10 font-tech uppercase tracking-wider text-xs h-9"
              >
                <Power className="w-3.5 h-3.5 mr-1.5" /> Disconnect
              </Button>
            )}
            <Button
              type="button"
              onClick={() => setImportOpen(true)}
              variant="outline"
              className="border-[#00f0ff]/30 text-[#5cf2ff] hover:bg-[#00f0ff]/10 font-tech uppercase tracking-wider text-xs h-9"
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" /> Import Config
            </Button>
            <Button
              type="button"
              onClick={handleReset}
              variant="outline"
              disabled={status.state === "idle" && !activePlan && !attempts.length}
              className="border-white/10 text-muted-foreground hover:text-white font-tech uppercase tracking-wider text-xs h-9"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reset
            </Button>
            <div className="ml-auto flex items-center gap-2 text-[10px] font-tech uppercase tracking-wider text-muted-foreground">
              <Cpu className="w-3 h-3 text-[#00f0ff]" />
              State:
              <span style={{ color: stateMeta.color }} className="font-mono">
                {stateMeta.label}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top grid: diagnosis + recovery state */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NetworkDiagnosisCard
          diagnosis={diagnosis}
          diagnosing={diagnosing}
          onReDiagnose={runDiagnose}
        />
        <RecoveryStateCard
          status={status}
          stateMeta={stateMeta}
          currentCandidate={currentCandidate}
        />
      </div>

      {/* Candidate paths */}
      <CandidatePathsCard
        candidates={candidates}
        currentCandidateId={currentCandidate?.id ?? null}
        attempts={attempts}
        onDeleteConfig={handleDeleteConfig}
      />

      {/* Recovery log */}
      <RecoveryLogCard attempts={attempts} />

      {/* Danger zone */}
      <Card className="glass border-[#ff4d6d]/20">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2 text-[#ff4d6d]">
            <Trash2 className="w-4 h-4" /> Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-xs text-muted-foreground max-w-xl">
            Wipe all stored VPN configs from your browser&apos;s IndexedDB. This
            is irreversible. The engine will lose its offline candidates and
            fall back to remote-only (requires internet).
          </div>
          {wipeConfirming ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={handleWipeAll}
                className="bg-[#ff4d6d] text-white hover:bg-[#ff4d6d]/90 font-tech uppercase tracking-wider text-xs h-9"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Confirm wipe
              </Button>
              <Button
                type="button"
                onClick={() => setWipeConfirming(false)}
                variant="outline"
                className="border-white/10 text-muted-foreground hover:text-white font-tech uppercase tracking-wider text-xs h-9"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => setWipeConfirming(true)}
              variant="outline"
              disabled={localConfigs.length === 0}
              className="border-[#ff4d6d]/30 text-[#ff4d6d] hover:bg-[#ff4d6d]/10 font-tech uppercase tracking-wider text-xs h-9"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Wipe all local configs
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Import dialog */}
      <Dialog
        open={importOpen}
        onOpenChange={(o) => (o ? setImportOpen(true) : closeImport())}
      >
        <DialogContent className="sm:max-w-xl bg-[#0d1426] border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="font-display tracking-wider text-lg flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#00f0ff]" />
              Import Config
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Paste a VLESS / VMess / Trojan / Shadowsocks URI. The Distort
              parser checks structure, optionally probes reachability, and shows
              the three independent states. Saving stores the config in your
              browser&apos;s IndexedDB so the recovery engine can use it
              offline. Credentials are never logged.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground mb-1.5">
                Config URI
              </Label>
              <Textarea
                value={importUri}
                onChange={(e) => setImportUri(e.target.value)}
                placeholder="vless://[UUID]@host:443?security=reality&sni=…"
                className="bg-white/[0.03] border-white/10 focus-visible:border-[#00f0ff]/50 font-mono text-xs min-h-[96px]"
                spellCheck={false}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
              <Label
                htmlFor="probe-toggle"
                className="text-xs font-tech uppercase tracking-wider text-muted-foreground cursor-pointer"
              >
                Also probe reachability (TCP connect)
              </Label>
              <Switch
                id="probe-toggle"
                checked={importProbe}
                onCheckedChange={setImportProbe}
              />
            </div>

            {validationError && (
              <div className="text-xs text-[#ff4d6d] font-mono">
                ⚠ {validationError}
              </div>
            )}

            {validation && (
              <ValidationResult v={validation} onAddFavorite={handleAddFavorite} />
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                className="font-tech uppercase tracking-wider text-xs h-9"
              >
                Close
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={handleValidate}
              disabled={validating}
              className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider text-xs h-9"
            >
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
              {validating ? "Validating…" : "Validate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NetworkDiagnosisCard({
  diagnosis,
  diagnosing,
  onReDiagnose,
}: {
  diagnosis: NetworkDiagnosis | null;
  diagnosing: boolean;
  onReDiagnose: () => void;
}) {
  return (
    <Card className="glass border-white/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
            <Globe className="w-4 h-4 text-[#00f0ff]" /> Network Diagnosis
            <span className="text-xs text-muted-foreground font-tech">
              · real client probes
            </span>
          </CardTitle>
          <Badge
            variant="outline"
            className={`text-[9px] font-tech uppercase tracking-wider h-4 ${
              diagnosis
                ? "border-[#10d9a0]/30 text-[#10d9a0]"
                : "border-white/10 text-muted-foreground"
            }`}
          >
            {diagnosing ? "probing…" : diagnosis ? "live" : "no probe yet"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {diagnosis ? (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <DiagRow
                icon={<Wifi className="w-3 h-3" />}
                label="Base network"
                value={baseNetworkLabel(diagnosis.baseNetwork)}
                color={baseNetworkColor(diagnosis.baseNetwork)}
              />
              <DiagRow
                icon={<Globe className="w-3 h-3" />}
                label="DNS"
                value={diagnosis.dnsWorks ? "works" : "broken"}
                color={diagnosis.dnsWorks ? "#10d9a0" : "#ff4d6d"}
              />
              <DiagRow
                icon={<Network className="w-3 h-3" />}
                label="International"
                value={diagnosis.internationalReachable ? "reachable" : "blocked"}
                color={diagnosis.internationalReachable ? "#10d9a0" : "#ff4d6d"}
              />
              <DiagRow
                icon={<Globe className="w-3 h-3" />}
                label="Domestic (Iran)"
                value={diagnosis.domesticReachable ? "reachable" : "blocked"}
                color={diagnosis.domesticReachable ? "#10d9a0" : "#ff4d6d"}
              />
              <DiagRow
                icon={<Zap className="w-3 h-3" />}
                label="Direct latency"
                value={
                  diagnosis.directLatencyMs === null
                    ? "unreachable"
                    : `${diagnosis.directLatencyMs}ms`
                }
                color={
                  diagnosis.directLatencyMs === null
                    ? "#ff4d6d"
                    : diagnosis.directLatencyMs < 200
                    ? "#10d9a0"
                    : "#ffb020"
                }
              />
              <DiagRow
                icon={<Clock className="w-3 h-3" />}
                label="Checked"
                value={formatTime(diagnosis.checkedAt)}
                color="#8aa0c4"
              />
            </div>
            <div className="text-[11px] text-muted-foreground pt-1.5 border-t border-white/5">
              {diagnosis.summary}
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            <div className="h-3 rounded bg-white/5 animate-pulse" />
            <div className="h-3 rounded bg-white/5 animate-pulse w-3/4" />
            <div className="h-3 rounded bg-white/5 animate-pulse w-1/2" />
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReDiagnose}
          disabled={diagnosing}
          className="w-full border-white/10 text-muted-foreground hover:text-white font-tech uppercase tracking-wider text-[10px] h-8"
        >
          <RefreshCw className={`w-3 h-3 mr-1.5 ${diagnosing ? "animate-spin" : ""}`} />
          {diagnosing ? "Probing…" : "Re-diagnose"}
        </Button>
      </CardContent>
    </Card>
  );
}

function RecoveryStateCard({
  status,
  stateMeta,
  currentCandidate,
}: {
  status: RecoveryStatus;
  stateMeta: { label: string; color: string; description: string };
  currentCandidate: CandidatePath | null;
}) {
  const state = status.state;
  const activePlan = status.activePlan;
  return (
    <Card className="glass border-white/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00f0ff]" /> Recovery State
          </CardTitle>
          <span className="text-[10px] text-muted-foreground font-tech uppercase tracking-wider flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {formatTime(status.lastStateChangeAt)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor: `${stateMeta.color}40`,
            background: `${stateMeta.color}10`,
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{
                background: stateMeta.color,
                boxShadow:
                  state !== "idle" ? `0 0 12px ${stateMeta.color}` : "none",
              }}
            />
            <span
              className="font-display font-bold text-lg"
              style={{ color: stateMeta.color }}
            >
              {stateMeta.label}
            </span>
            {state === "exhausted" && (
              <XCircle className="w-4 h-4 text-[#ff4d6d] ml-auto" />
            )}
            {state === "connected" && (
              <CheckCircle2 className="w-4 h-4 text-[#10d9a0] ml-auto" />
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {stateMeta.description}
          </p>
          {status.exhaustedReason && state === "exhausted" && (
            <div className="mt-2 text-[11px] text-[#ff4d6d]/90 font-mono pl-2 border-l-2 border-[#ff4d6d]/40">
              {status.exhaustedReason}
            </div>
          )}
          {currentCandidate && state !== "idle" && state !== "exhausted" && (
            <div className="mt-2 text-[11px] text-[#5cf2ff]/90 font-mono pl-2 border-l-2 border-[#00f0ff]/40">
              Trying: {currentCandidate.label} · {currentCandidate.host}:{currentCandidate.port}
            </div>
          )}
        </div>

        {activePlan && (
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-tech uppercase tracking-wider text-muted-foreground">
                Plan
              </span>
              <Badge
                variant="outline"
                className="text-[9px] font-mono border-white/10 text-muted-foreground"
              >
                {activePlan.planId.slice(0, 10)}
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <PlanStat label="Candidates" value={`${activePlan.candidates.length}`} />
              <PlanStat label="Attempts" value={`${status.attemptsThisCycle}`} />
              <PlanStat label="Max" value={`${activePlan.policy.maxAttempts}`} />
            </div>
            {activePlan.rationale && (
              <div className="text-[11px] text-muted-foreground pt-1.5 mt-1.5 border-t border-white/5">
                {activePlan.rationale}
              </div>
            )}
          </div>
        )}

        {/* Mini state map */}
        <div className="flex items-center gap-1 flex-wrap text-[9px] font-tech uppercase tracking-wider">
          {(
            [
              "idle",
              "diagnosing",
              "selecting",
              "connecting",
              "verifying",
              "connected",
              "degraded",
              "recovering",
              "exhausted",
            ] as RecoveryState[]
          ).map((s, i, arr) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  state === s ? "border-current" : "border-white/10 text-muted-foreground/60"
                }`}
                style={state === s ? { color: RECOVERY_STATE_LABELS[s].color } : undefined}
              >
                {RECOVERY_STATE_LABELS[s].label}
              </span>
              {i < arr.length - 1 && (
                <span className="text-muted-foreground/30">→</span>
              )}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CandidatePathsCard({
  candidates,
  currentCandidateId,
  attempts,
  onDeleteConfig,
}: {
  candidates: CandidatePath[];
  currentCandidateId: string | null;
  attempts: RecoveryAttempt[];
  onDeleteConfig: (id: string) => void;
}) {
  // Build a per-candidate attempt lookup so we can show real-time result badges
  // next to each candidate as the engine tries it.
  const attemptByCandidate = new Map<string, RecoveryAttempt>();
  for (const a of attempts) {
    // attempts are most-recent-first; only set if not already present (first
    // occurrence is the latest attempt for that candidate)
    if (!attemptByCandidate.has(a.candidateId)) {
      attemptByCandidate.set(a.candidateId, a);
    }
  }

  return (
    <Card className="glass border-white/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
            <Radio className="w-4 h-4 text-[#8b5cf6]" /> Candidate Paths
            <span className="text-xs text-muted-foreground font-tech">
              · {candidates.length}
            </span>
          </CardTitle>
          <span className="text-[10px] text-muted-foreground font-tech uppercase tracking-wider">
            local + remote · best first
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {candidates.length === 0 ? (
          <div className="text-center py-10">
            <Radio className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No candidates yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Click <span className="text-[#5cf2ff]">Recover Connection</span> to
              gather local + remote candidates, or import a config to seed the
              local store.
            </p>
          </div>
        ) : (
          <div className="max-h-[560px] overflow-y-auto pr-1 -mr-1 space-y-2 custom-scroll">
            {candidates.map((c, i) => {
              const lastAttempt = attemptByCandidate.get(c.id) ?? null;
              return (
                <CandidateRow
                  key={c.id}
                  c={c}
                  index={i}
                  isLocal={isLocalCandidate(c.id)}
                  isCurrent={currentCandidateId === c.id}
                  lastAttempt={lastAttempt}
                  onDeleteConfig={onDeleteConfig}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CandidateRow({
  c,
  index,
  isLocal,
  isCurrent,
  lastAttempt,
  onDeleteConfig,
}: {
  c: CandidatePath;
  index: number;
  isLocal: boolean;
  isCurrent: boolean;
  lastAttempt: RecoveryAttempt | null;
  onDeleteConfig: (id: string) => void;
}) {
  const protoColor = protocolColor(c.protocol);
  const struct = structuralBadge(c.lastProbe?.structural ?? "valid");
  const reach = reachabilityBadge(c.lastProbe?.reachability ?? "not-probed");
  const tunnel = tunnelBadge(c.lastProbe?.tunnel ?? "not-attempted");
  const notProbed = !c.lastProbe;

  // Reflect the engine's most recent attempt at this candidate, if any
  const attemptColor =
    lastAttempt?.result === "success"
      ? "#10d9a0"
      : lastAttempt?.result === "failure"
      ? "#ff4d6d"
      : lastAttempt?.result === "in-progress"
      ? "#00f0ff"
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.4) }}
      className={`rounded-xl border p-3 transition-colors ${
        isCurrent
          ? "border-[#00f0ff]/40 bg-[#00f0ff]/[0.04]"
          : "border-white/5 bg-white/[0.02] hover:border-[#00f0ff]/20 hover:bg-white/[0.04]"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Rank */}
        <div className="w-7 h-7 rounded-md bg-white/[0.03] border border-white/10 flex items-center justify-center shrink-0">
          <span className="text-[11px] font-mono font-bold text-muted-foreground">
            {index + 1}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm truncate">
              {c.label}
            </span>
            <Badge
              variant="outline"
              className="text-[9px] font-tech uppercase tracking-wider h-4"
              style={{ borderColor: `${protoColor}40`, color: protoColor }}
            >
              {PROTOCOL_LABEL[c.protocol]}
            </Badge>
            <Badge
              variant="outline"
              className={`text-[9px] font-tech uppercase tracking-wider h-4 ${
                isLocal
                  ? "border-[#00f0ff]/30 text-[#5cf2ff]"
                  : "border-[#8b5cf6]/30 text-[#a78bfa]"
              }`}
            >
              {isLocal ? "local" : "remote"}
            </Badge>
            {c.stealth && (
              <Badge
                variant="outline"
                className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#8b5cf6]/30 text-[#a78bfa]"
              >
                <ShieldCheck className="w-2.5 h-2.5 mr-0.5" />Stealth
              </Badge>
            )}
            {c.exitCountry && (
              <Badge
                variant="outline"
                className="text-[9px] font-mono uppercase tracking-wider h-4 border-white/10 text-muted-foreground"
              >
                {c.exitCountry}
              </Badge>
            )}
            {attemptColor && (
              <Badge
                variant="outline"
                className="text-[9px] font-tech uppercase tracking-wider h-4"
                style={{ borderColor: `${attemptColor}40`, color: attemptColor }}
              >
                {lastAttempt?.result}
              </Badge>
            )}
            {c.successStreak > 0 && (
              <span className="text-[10px] font-mono text-[#10d9a0]/80">
                ✓{c.successStreak}
              </span>
            )}
            {c.failureStreak > 0 && (
              <span className="text-[10px] font-mono text-[#ff4d6d]/80">
                ✗{c.failureStreak}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
            {c.host}:{c.port}
          </div>
        </div>

        {/* Three independent status badges */}
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge label={struct.label} color={struct.color} dim={notProbed} />
          <StatusBadge
            label={reach.label}
            color={reach.color}
            dim={notProbed || c.lastProbe?.reachability === "not-probed"}
          />
          <StatusBadge
            label={tunnel.label}
            color={tunnel.color}
            dim={notProbed || c.lastProbe?.tunnel === "not-attempted"}
          />
        </div>

        {/* Anti-DPI score */}
        <div className="text-center shrink-0 ml-1">
          <div
            className="font-mono text-sm font-bold"
            style={{ color: scoreColor(c.antiDpiScore) }}
          >
            {c.antiDpiScore}
          </div>
          <div className="text-[9px] text-muted-foreground font-tech uppercase tracking-wider">
            anti-dpi
          </div>
        </div>

        {/* Remove (local only) */}
        {isLocal && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onDeleteConfig(c.id)}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-[#ff4d6d] hover:bg-[#ff4d6d]/10"
            aria-label={`Remove ${c.label}`}
            title="Remove from local store"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {lastAttempt?.reason && (
        <div
          className="mt-2 text-[10px] font-mono pl-10"
          style={{ color: attemptColor ?? "#8aa0c4" }}
        >
          {lastAttempt.reason}
        </div>
      )}
    </motion.div>
  );
}

function StatusBadge({
  label,
  color,
  dim,
}: {
  label: string;
  color: string;
  dim?: boolean;
}) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded border text-[9px] font-tech uppercase tracking-wider ${
        dim ? "opacity-50" : ""
      }`}
      style={{ borderColor: `${color}40`, color }}
    >
      {label}
    </span>
  );
}

function RecoveryLogCard({ attempts }: { attempts: RecoveryAttempt[] }) {
  return (
    <Card className="glass border-white/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#ffb020]" /> Recovery Log
            <span className="text-xs text-muted-foreground font-tech">
              · {attempts.length}
            </span>
          </CardTitle>
          <Badge
            variant="outline"
            className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#10d9a0]/30 text-[#10d9a0]"
          >
            <ShieldCheck className="w-2.5 h-2.5 mr-0.5" /> NO credentials logged
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {attempts.length === 0 ? (
          <div className="text-center py-10">
            <Clock className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              Recovery attempts will appear here as the engine runs.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Each attempt logs: timestamp, candidate label, result, reason,
              latency — never the config URI or credentials.
            </p>
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto pr-1 -mr-1 space-y-1.5 custom-scroll">
            {attempts.map((a, i) => (
              <AttemptRow key={`${a.planId}-${a.candidateId}-${a.attemptNumber}-${i}`} a={a} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AttemptRow({ a }: { a: RecoveryAttempt }) {
  const color =
    a.result === "success"
      ? "#10d9a0"
      : a.result === "failure"
      ? "#ff4d6d"
      : a.result === "in-progress"
      ? "#00f0ff"
      : "#8aa0c4";
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 flex items-start gap-3 text-xs">
      <span
        className="inline-block w-2 h-2 rounded-full mt-1.5 shrink-0"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-muted-foreground text-[10px]">
            {formatTime(a.startedAt)}
          </span>
          <span className="font-mono text-white text-[11px] truncate max-w-[260px]">
            {a.candidateLabel ?? a.candidateId}
          </span>
          <Badge
            variant="outline"
            className="text-[9px] font-tech uppercase tracking-wider h-4"
            style={{ borderColor: `${color}40`, color }}
          >
            {a.result}
          </Badge>
          <Badge
            variant="outline"
            className="text-[9px] font-tech uppercase tracking-wider h-4 border-white/10 text-muted-foreground"
          >
            #{a.attemptNumber}
          </Badge>
          {a.latencyMs !== null && a.latencyMs !== undefined && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {a.latencyMs}ms
            </span>
          )}
        </div>
        {a.reason && (
          <div className="text-[10px] text-muted-foreground mt-1 pl-1 break-words">
            {a.reason}
          </div>
        )}
      </div>
    </div>
  );
}

function ValidationResult({
  v,
  onAddFavorite,
}: {
  v: ValidateConfigResponse;
  onAddFavorite: () => void;
}) {
  const struct = structuralBadge(v.structural);
  const reach = reachabilityBadge(v.reachability);
  const tunnel = tunnelBadge(v.tunnel);
  const parsed = v.parsed;

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <StatusBadge label={struct.label} color={struct.color} />
        <StatusBadge
          label={reach.label}
          color={reach.color}
          dim={v.reachability === "not-probed"}
        />
        <StatusBadge label={tunnel.label} color={tunnel.color} dim />
        {v.latencyMs !== null && v.latencyMs !== undefined && (
          <span className="font-mono text-[10px] text-[#10d9a0] ml-auto">
            {v.latencyMs}ms
          </span>
        )}
      </div>

      {v.summary && <div className="text-[11px] text-muted-foreground">{v.summary}</div>}

      {parsed && (
        <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono">
          {parsed.host && (
            <Field label="host" value={`${parsed.host}:${parsed.port ?? "?"}`} />
          )}
          {parsed.network && <Field label="network" value={parsed.network} />}
          {parsed.security && <Field label="security" value={parsed.security} />}
          {parsed.sni && <Field label="sni" value={parsed.sni} />}
          <Field
            label="creds"
            value={parsed.hasRequiredCredentials ? "present" : "missing"}
            color={parsed.hasRequiredCredentials ? "#10d9a0" : "#ffb020"}
          />
          <Field
            label="anti-dpi"
            value={`${parsed.antiDpiScore}`}
            color={scoreColor(parsed.antiDpiScore)}
          />
        </div>
      )}

      {parsed?.flags && parsed.flags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {parsed.flags.map((f) => (
            <Badge
              key={f}
              variant="outline"
              className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#00f0ff]/30 text-[#5cf2ff]"
            >
              {f}
            </Badge>
          ))}
        </div>
      )}

      {v.warnings.length > 0 && (
        <div className="space-y-1">
          {v.warnings.map((w, i) => (
            <div
              key={i}
              className="text-[10px] text-[#ffb020] font-mono flex items-start gap-1"
            >
              <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1.5 border-t border-white/5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAddFavorite}
          disabled={v.structural !== "valid"}
          className="font-tech uppercase tracking-wider text-[10px] h-7 border-[#00f0ff]/30 text-[#5cf2ff] hover:bg-[#00f0ff]/10"
        >
          <ShieldCheck className="w-3 h-3 mr-1" /> Save to local store
        </Button>
        <span className="text-[10px] text-muted-foreground/70">
          Stored in IndexedDB · available offline
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-muted-foreground/70 text-[9px] uppercase tracking-wider font-tech">
        {label}:
      </span>
      <span className="text-white truncate" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function DiagRow({
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
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground text-[10px] font-tech uppercase tracking-wider flex-1">
        {label}
      </span>
      <span className="font-mono text-xs font-semibold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function PlanStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-[10px] font-tech uppercase tracking-wider">
        {label}
      </span>
      <span className="font-mono text-white">{value}</span>
    </div>
  );
}
