"use client";

import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Power, Server as ServerIcon, Gauge, BarChart3, Settings as Cog, User, X, ChevronLeft, Shield, Globe2, AlertTriangle, HelpCircle } from "lucide-react";
import { DistortWordmark } from "./distort-logo";
import { ConnectView } from "./connect-view";
import { ServerListView } from "./server-list-view";
import { StatsView } from "./stats-view";
import { SettingsView } from "./settings-view";
import { SpeedTestView } from "./speed-test-view";
import { AccountView } from "./account-view";
import { CommunityMeshView } from "./community-mesh-view";
import { EmergencyConnectivityView } from "./emergency-connectivity-view";
import { UpdateIndicator } from "./update-indicator";
import { useVpnStore } from "@/lib/vpn-store";
import { Button } from "@/components/ui/button";

type View = "connect" | "servers" | "mesh" | "emergency" | "speedtest" | "stats" | "settings" | "account" | "help";

const NAV: Array<{ id: View; label: string; icon: ReactNode; tag?: string }> = [
  { id: "connect", label: "Connect", icon: <Power className="w-4 h-4" /> },
  { id: "servers", label: "Servers", icon: <ServerIcon className="w-4 h-4" /> },
  { id: "mesh", label: "Distort Config", icon: <Globe2 className="w-4 h-4" />, tag: "Iran" },
  { id: "speedtest", label: "Speed Test", icon: <Gauge className="w-4 h-4" /> },
  { id: "stats", label: "Statistics", icon: <BarChart3 className="w-4 h-4" /> },
  { id: "settings", label: "Settings", icon: <Cog className="w-4 h-4" /> },
  { id: "account", label: "Account", icon: <User className="w-4 h-4" /> },
  { id: "help", label: "Help", icon: <HelpCircle className="w-4 h-4" /> },
];

export function Dashboard({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>("connect");
  const { state, currentServer } = useVpnStore();

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-white/5 bg-[#070b16]/80 backdrop-blur-xl sticky top-14 self-start h-[calc(100vh-3.5rem)]">
        <div className="p-4 border-b border-white/5">
          <DistortWordmark size={28} showTagline />
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                view === n.id
                  ? "bg-[#00f0ff]/10 text-[#5cf2ff] border border-[#00f0ff]/30"
                  : "text-muted-foreground hover:text-white hover:bg-white/[0.03] border border-transparent"
              }`}
            >
              {n.icon}
              <span className="font-tech uppercase tracking-wider text-xs flex-1 text-left">{n.label}</span>
              {n.tag && (
                <span className="text-[9px] font-tech uppercase tracking-wider px-1.5 py-0.5 rounded border border-[#8b5cf6]/30 text-[#a78bfa]">
                  {n.tag}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-white/5 space-y-2">
          <StatusPill state={state} server={currentServer?.country} />
          <Button onClick={onClose} variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-white justify-start">
            <ChevronLeft className="w-3.5 h-3.5 mr-1.5" /> Back to home
          </Button>
        </div>
      </aside>

      {/* Mobile top tabs */}
      <div className="md:hidden fixed top-14 left-0 right-0 z-30 bg-[#070b16]/95 backdrop-blur-xl border-b border-white/5">
        <div className="flex items-center justify-between px-2 overflow-x-auto">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 shrink-0 ${
                view === n.id ? "text-[#5cf2ff]" : "text-muted-foreground"
              }`}
            >
              {n.icon}
              <span className="text-[9px] font-tech uppercase tracking-wider">{n.label}</span>
            </button>
          ))}
          <button onClick={onClose} className="px-3 py-2 text-muted-foreground hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 min-w-0 p-4 md:p-6 pt-20 md:pt-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-display text-2xl font-extrabold tracking-wide text-white">
                {NAV.find((n) => n.id === view)?.label}
              </h2>
              <p className="text-xs text-muted-foreground font-tech uppercase tracking-wider mt-0.5">
                {view === "connect" && "One tap to freedom"}
                {view === "servers" && "30+ nodes · stealth-ready"}
                {view === "mesh" && "Community configs · Iran-optimized"}
                {view === "emergency" && "Honest recovery · client-probed"}
                {view === "speedtest" && "Measure real throughput"}
                {view === "stats" && "Your privacy, in numbers"}
                {view === "settings" && "Tune your tunnel"}
                {view === "account" && "Free forever · configs & downloads"}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground font-tech uppercase tracking-wider">
              <Shield className="w-3.5 h-3.5 text-[#10d9a0]" />
              AES-256 · ChaCha20 · Verified
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {view === "connect" && <ConnectView onPickServer={() => setView("servers")} />}
              {view === "servers" && <ServerListView onConnected={() => setView("connect")} />}
              {view === "mesh" && <CommunityMeshView />}
              {view === "emergency" && <EmergencyConnectivityView />}
              {view === "speedtest" && <SpeedTestView />}
              {view === "stats" && <StatsView />}
              {view === "settings" && <SettingsView />}
              {view === "account" && <AccountView />}
              {view === "help" && <HelpView />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Auto-updater badge — only visible in the desktop shell (returns null on web). */}
      <UpdateIndicator />
    </div>
  );
}

function StatusPill({ state, server }: { state: string; server?: string }) {
  const color = state === "connected" ? "#10d9a0" : state === "connecting" ? "#ffb020" : "#8aa0c4";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="dot-live inline-block w-2 h-2 rounded-full" style={{ background: color, color }} />
        <span className="text-[10px] font-tech uppercase tracking-wider text-muted-foreground">Status</span>
      </div>
      <div className="text-sm font-semibold text-white capitalize">{state}</div>
      {server && <div className="text-[11px] text-muted-foreground truncate">via {server}</div>}
    </div>
  );
}

function HelpView() {
  return (
    <div className="space-y-6 pb-8">
      <div>
        <h2 className="text-2xl font-bold text-white">Help & About</h2>
        <p className="text-xs text-muted-foreground mt-1">Version info, updates, and troubleshooting</p>
      </div>

      <div className="bg-card border border-white/5 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#00f0ff] to-[#2962ff] flex items-center justify-center">
            <span className="text-3xl font-bold text-[#050814]">D</span>
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">DISTORT</h3>
            <p className="text-sm text-muted-foreground">Freedom Beyond Borders</p>
            <p className="text-xs text-[#5cf2ff] font-tech mt-1">v1.0.20 · 100% Free · MIT</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-card border border-white/5 rounded-xl p-4">
          <h4 className="text-sm font-tech uppercase tracking-wider text-[#5cf2ff] mb-2">Check for Updates</h4>
          <p className="text-xs text-muted-foreground mb-3">Check if a new version is available.</p>
          <UpdateCheckButton />
        </div>

        <div className="bg-card border border-white/5 rounded-xl p-4">
          <h4 className="text-sm font-tech uppercase tracking-wider text-[#5cf2ff] mb-2">System Status</h4>
          <p className="text-xs text-muted-foreground mb-3">Check if all services are running.</p>
          <SystemStatusButton />
        </div>
      </div>

      <div className="bg-card border border-white/5 rounded-xl p-4">
        <h4 className="text-sm font-tech uppercase tracking-wider text-[#5cf2ff] mb-3">Quick Links</h4>
        <div className="space-y-2">
          <a href="https://github.com/di6tort-bit/distort" target="_blank" rel="noopener noreferrer" className="block text-sm text-muted-foreground hover:text-[#00f0ff] transition-colors">
            → GitHub Repository
          </a>
          <a href="https://github.com/di6tort-bit/distort/releases" target="_blank" rel="noopener noreferrer" className="block text-sm text-muted-foreground hover:text-[#00f0ff] transition-colors">
            → Download Latest Release
          </a>
          <a href="https://github.com/di6tort-bit/distort/issues" target="_blank" rel="noopener noreferrer" className="block text-sm text-muted-foreground hover:text-[#00f0ff] transition-colors">
            → Report a Bug
          </a>
        </div>
      </div>

      <div className="bg-card border border-white/5 rounded-xl p-4">
        <h4 className="text-sm font-tech uppercase tracking-wider text-[#5cf2ff] mb-3">Troubleshooting</h4>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>• If the dashboard doesn't load: wait 15 seconds for the server to start.</p>
          <p>• If connect fails: check that the desktop companion is running (port 10810).</p>
          <p>• If IP shows error: the server may not have internet access.</p>
          <p>• Logs location: <code className="text-[#5cf2ff]">%APPDATA%\DISTORT\logs\main.log</code></p>
        </div>
      </div>
    </div>
  );
}

function UpdateCheckButton() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setResult(null);
    try {
      const w = window as unknown as { distort?: { updater?: { checkNow: () => Promise<{ ok: boolean; error?: string }> } } };
      if (w.distort?.updater?.checkNow) {
        const r = await w.distort.updater.checkNow();
        setResult(r.ok ? "Check complete — see notification" : `Error: ${r.error}`);
      } else {
        setResult("Auto-update not available in this build. Check GitHub releases manually.");
      }
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Button onClick={handleCheck} disabled={checking} size="sm" variant="outline" className="w-full">
      {checking ? "Checking…" : "Check Now"}
      {result && <span className="block text-[10px] text-muted-foreground mt-1">{result}</span>}
    </Button>
  );
}

function SystemStatusButton() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCheck = async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/diagnostic");
      if (resp.ok) {
        setStatus(await resp.json());
      } else {
        setStatus({ error: `HTTP ${resp.status}` });
      }
    } catch (e) {
      setStatus({ error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Button onClick={handleCheck} disabled={loading} size="sm" variant="outline" className="w-full">
        {loading ? "Checking…" : "Run Diagnostic"}
      </Button>
      {status && (
        <pre className="mt-2 text-[10px] text-muted-foreground bg-black/30 rounded p-2 overflow-auto max-h-40">
          {JSON.stringify(status, null, 2)}
        </pre>
      )}
    </div>
  );
}
