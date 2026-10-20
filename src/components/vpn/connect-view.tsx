"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Power, Shield, Zap, Activity, Radio, RefreshCw,
  ChevronDown, Check, Download, Upload, Clock, Wifi,
  AlertCircle, Settings2, Crown
} from "lucide-react";
import { useVpnStore, formatRate, formatBytes, formatDuration, type ServerLite } from "@/lib/vpn-store";
import { postJSON, useFetch } from "@/hooks/use-fetch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { IpLocationWidget } from "./ip-location-widget";

type IranConfig = {
  id: string;
  protocol: string;
  host: string;
  port: number;
  score: number;
  flags: string;
  label: string | null;
  country: string | null;
  reach: string;
  latencyMs: number;
};

function pingColor(p: number) {
  if (p === 0) return "#8aa0c4";
  if (p < 60) return "#10d9a0";
  if (p < 120) return "#ffb020";
  return "#ff4d6d";
}

export function ConnectView({ onPickServer }: { onPickServer: () => void }) {
  const { state, currentServer, live, settings, connect, disconnect } = useVpnStore();
  const [now, setNow] = useState(Date.now());
  const [showConfigList, setShowConfigList] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<IranConfig | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Fetch Iran configs
  const { data: configData, loading: configsLoading, refetch: refetchConfigs } = useFetch<{ configs: IranConfig[] }>(
    "/api/imported-configs?bucket=optimized&limit=10"
  );

  // Auto-update
  const { status: updateStatus, version: updateVersion, checkNow, isDesktop } = useAutoUpdate();

  useEffect(() => {
    if (state !== "connected") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  const elapsed = live.connectedSince ? Math.floor((now - live.connectedSince) / 1000) : 0;
  const isConnected = state === "connected";
  const isConnecting = state === "connecting" || connecting;

  // Auto-select first config
  useEffect(() => {
    if (!selectedConfig && configData?.configs?.length) {
      const firstReachable = configData.configs.find(c => c.reach === "ok") || configData.configs[0];
      setSelectedConfig(firstReachable);
    }
  }, [configData, selectedConfig]);

  const handleToggle = async () => {
    if (state === "disconnected" || state === "error") {
      if (!selectedConfig) {
        toast.error("No config selected", { description: "Refresh configs and try again." });
        return;
      }

      // Try real connection via companion API
      setConnecting(true);
      try {
        // First, fetch the config URI
        const uriResp = await fetch(`/api/emergency/candidates/${selectedConfig.id}/uri`, { method: "POST" });
        if (!uriResp.ok) {
          throw new Error(`Failed to fetch config URI (${uriResp.status})`);
        }
        const uriData = await uriResp.json();
        const configUri = uriData.uri;

        // Try to start tunnel via companion API
        const companionResp = await fetch("/api/tunnel/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ configUri }),
        });

        if (companionResp.ok) {
          const result = await companionResp.json();
          if (result.ok) {
            connect({
              id: selectedConfig.id,
              code: selectedConfig.host,
              country: selectedConfig.country || "Iran",
              city: selectedConfig.host,
              flag: "🇮🇷",
              host: selectedConfig.host,
              port: selectedConfig.port,
              protocols: selectedConfig.protocol,
              load: 0,
              ping: selectedConfig.latencyMs || 50,
              upMbps: 1000,
              downMbps: 1000,
              online: true,
              premium: false,
              stealth: true,
              note: selectedConfig.flags,
            } as ServerLite, selectedConfig.protocol);
            toast.success("Connecting…", { description: `${selectedConfig.protocol} → ${selectedConfig.host}:${selectedConfig.port}` });
          } else {
            throw new Error(result.error || "Tunnel failed to start");
          }
        } else {
          // Companion API not available — DON'T fall back to demo mode.
          // Show the real error so the user knows what's wrong.
          let errorMsg = "Companion API not reachable";
          try {
            const errData = await companionResp.json();
            errorMsg = errData.error || errorMsg;
          } catch {}
          throw new Error(`Connection failed: ${errorMsg}. Check Help tab → Run Diagnostic.`);
        }

        // Create session record
        try {
          await postJSON("/api/connect", {
            serverId: selectedConfig.id,
            protocol: selectedConfig.protocol,
            action: "connect",
          });
        } catch {}
      } catch (e) {
        toast.error("Connection failed", { description: (e as Error).message });
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
      // Trigger subscription refresh
      const resp = await fetch("/api/subscriptions", { method: "GET" });
      if (resp.ok) {
        const data = await resp.json();
        const subs = data.subscriptions || [];
        for (const sub of subs) {
          await fetch(`/api/subscriptions/${sub.id}/refresh`, { method: "POST" });
        }
      }
      refetchConfigs();
      toast.success("Configs refreshed", { description: "Latest Iran configs loaded." });
    } catch {
      toast.error("Refresh failed");
    }
  };

  const handleCheckUpdate = async () => {
    toast.info("Checking for updates…");
    const r = await checkNow();
    if (r.ok) {
      toast.success("Check complete", { description: updateStatus === "available" ? `Update v${updateVersion} available!` : "You're up to date." });
    } else {
      toast.error("Update check failed", { description: r.error });
    }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* --- Header: version + update status --- */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Connect</h2>
          <p className="text-xs text-muted-foreground mt-1 font-tech uppercase tracking-wider">
            One tap to freedom
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Version + update button */}
          <button
            onClick={handleCheckUpdate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5 hover:border-[#00f0ff]/30 transition-colors text-xs text-muted-foreground hover:text-white"
            title="Check for updates"
          >
            {updateStatus === "available" ? (
              <>
                <Download className="w-3 h-3 text-[#10d9a0] animate-pulse" />
                <span className="text-[#10d9a0] font-tech">v{updateVersion} ready</span>
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
            title="Refresh Iran configs"
          >
            <RefreshCw className={`w-3 h-3 ${configsLoading ? "animate-spin" : ""}`} />
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
          {/* Pulse rings when connected */}
          {isConnected && (
            <>
              <div className="absolute inset-0 rounded-full border-2 border-[#10d9a0] animate-ping opacity-20" />
              <div className="absolute -inset-2 rounded-full border border-[#10d9a0]/30 animate-pulse" />
            </>
          )}

          <Power
            className={`w-12 h-12 ${isConnected ? "text-[#02131a]" : "text-[#00f0ff]"}`}
            strokeWidth={2.2}
          />
          <span className={`font-tech uppercase tracking-[0.3em] text-xs mt-2 ${
            isConnected ? "text-[#02131a]" : isConnecting ? "text-[#02131a]" : "text-muted-foreground"
          }`}>
            {isConnected ? "Connected" : isConnecting ? "Connecting…" : "Tap to Connect"}
          </span>
        </motion.button>
      </div>

      {/* --- Selected server card --- */}
      <div className="bg-card border border-white/5 rounded-xl p-4">
        {selectedConfig ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#00f0ff]/10 flex items-center justify-center">
                <span className="text-lg">🇮🇷</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-white">
                  {selectedConfig.protocol.toUpperCase()} · {selectedConfig.host}:{selectedConfig.port}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                  {selectedConfig.flags && (
                    <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-[#8b5cf6]/30 text-[#8b5cf6]">
                      {selectedConfig.flags.split(",")[0]}
                    </Badge>
                  )}
                  <span>Score: {selectedConfig.score}</span>
                  {selectedConfig.reach === "ok" && (
                    <span className="text-[#10d9a0]">✓ reachable</span>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={() => setShowConfigList(!showConfigList)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] text-xs text-muted-foreground hover:text-white transition-colors"
            >
              Change
              <ChevronDown className={`w-3 h-3 transition-transform ${showConfigList ? "rotate-180" : ""}`} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {configsLoading ? "Loading configs…" : "No config selected"}
            </div>
            <button
              onClick={() => setShowConfigList(!showConfigList)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] text-xs text-muted-foreground hover:text-white transition-colors"
            >
              Select config
              <ChevronDown className={`w-3 h-3 transition-transform ${showConfigList ? "rotate-180" : ""}`} />
            </button>
          </div>
        )}

        {/* Config dropdown */}
        <AnimatePresence>
          {showConfigList && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-3 pt-3 border-t border-white/5 space-y-1 max-h-64 overflow-y-auto">
                {configData?.configs?.map((cfg) => (
                  <button
                    key={cfg.id}
                    onClick={() => {
                      setSelectedConfig(cfg);
                      setShowConfigList(false);
                    }}
                    className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors text-left ${
                      selectedConfig?.id === cfg.id
                        ? "bg-[#00f0ff]/10 border border-[#00f0ff]/20"
                        : "hover:bg-white/[0.03] border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-xs font-mono text-[#5cf2ff] uppercase">{cfg.protocol}</div>
                      <div>
                        <div className="text-sm text-white">{cfg.host}:{cfg.port}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {cfg.flags || "no flags"} · score {cfg.score}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {cfg.reach === "ok" && (
                        <span className="text-[10px] text-[#10d9a0]">✓</span>
                      )}
                      {selectedConfig?.id === cfg.id && (
                        <Check className="w-4 h-4 text-[#00f0ff]" />
                      )}
                    </div>
                  </button>
                ))}
                {configData?.configs?.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-4">
                    No configs available. Click "Refresh" to fetch Iran configs.
                  </div>
                )}
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
          <MetricCard icon={<Download className="w-4 h-4" />} label="Download" value={formatRate(live.downBps)} color="#10d9a0" />
          <MetricCard icon={<Upload className="w-4 h-4" />} label="Upload" value={formatRate(live.upBps)} color="#00f0ff" />
          <MetricCard icon={<Activity className="w-4 h-4" />} label="Ping" value={`${live.ping}ms`} color="#ffb020" />
          <MetricCard icon={<Clock className="w-4 h-4" />} label="Session" value={formatDuration(elapsed)} color="#8b5cf6" />
        </motion.div>
      )}

      {/* --- Quick toggles --- */}
      <div className="flex flex-wrap gap-2">
        {settings.killSwitch && (
          <Badge variant="outline" className="border-[#ff4d6d]/30 text-[#ff4d6d] text-xs">Kill Switch</Badge>
        )}
        {settings.stealthMode && (
          <Badge variant="outline" className="border-[#8b5cf6]/30 text-[#8b5cf6] text-xs">Stealth</Badge>
        )}
        {settings.blockTrackers && (
          <Badge variant="outline" className="border-[#10d9a0]/30 text-[#10d9a0] text-xs">No Trackers</Badge>
        )}
      </div>

      {/* --- IP location widget (real IP vs VPN IP) --- */}
      <IpLocationWidget isConnected={isConnected} />

      {/* --- Desktop companion status --- */}
      {!isDesktop && (
        <div className="flex items-center gap-2 text-xs text-[#ffb020] bg-[#ffb020]/5 border border-[#ffb020]/10 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            Desktop companion not detected. Real VPN tunneling requires the desktop app.
            Connection will fail until the companion API is running.
          </span>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="bg-card border border-white/5 rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1">
        <span style={{ color }}>{icon}</span>
        <span className="text-[10px] font-tech uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm font-mono font-semibold text-white">{value}</div>
    </div>
  );
}
