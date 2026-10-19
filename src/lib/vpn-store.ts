"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type ServerLite = {
  id: string;
  code: string;
  country: string;
  countryCode: string;
  city: string;
  flag: string;
  host: string;
  port: number;
  protocols: string[];
  load: number;
  ping: number;
  upMbps: number;
  downMbps: number;
  online: boolean;
  premium: boolean;
  stealth: boolean;
  note?: string | null;
};

export type Settings = {
  protocol: string;
  killSwitch: boolean;
  dnsLeakProtection: boolean;
  ipv6LeakProtection: boolean;
  splitTunneling: boolean;
  obfuscation: boolean;
  autoConnect: boolean;
  blockTrackers: boolean;
  blockAds: boolean;
  stealthMode: boolean;
  preferredRegion: string;
  mtu: number;
  dnsServers: string;
};

type LiveStats = {
  downBps: number;
  upBps: number;
  totalDown: number;
  totalUp: number;
  ping: number;
  connectedSince: number | null;
  exitIp?: string | null;
  exitCountry?: string | null;
};

type VpnStore = {
  // connection
  state: ConnectionState;
  currentServer: ServerLite | null;
  lastError: string | null;
  // live stats
  live: LiveStats;
  // settings
  settings: Settings;
  // view
  view: "landing" | "connect" | "servers" | "speedtest" | "stats" | "settings" | "account";
  // actions
  connect: (server: ServerLite, protocol: string) => void;
  disconnect: () => void;
  setView: (v: VpnStore["view"]) => void;
  setCurrentServer: (s: ServerLite | null) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetStats: () => void;
  setExitInfo: (exitIp: string, exitCountry: string) => void;
  // internal ticker id
  _ticker: ReturnType<typeof setInterval> | null;
};

const DEFAULT_SETTINGS: Settings = {
  protocol: "wireguard",
  killSwitch: true,
  dnsLeakProtection: true,
  ipv6LeakProtection: true,
  splitTunneling: false,
  obfuscation: true,
  autoConnect: false,
  blockTrackers: true,
  blockAds: false,
  stealthMode: true,
  preferredRegion: "auto",
  mtu: 1420,
  dnsServers: "1.1.1.1,9.9.9.9",
};

const initialLive: LiveStats = {
  downBps: 0,
  upBps: 0,
  totalDown: 0,
  totalUp: 0,
  ping: 0,
  connectedSince: null,
};

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Detect if we're running inside the Electron desktop app (real VPN engine)
// vs a plain browser (demo mode — no actual tunneling).
export function isElectron(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as any).distort?.capabilities?.vpnEngine;
}

export function isDemoMode(): boolean {
  return !isElectron();
}

export const useVpnStore = create<VpnStore>()(
  persist(
    (set, get) => ({
      state: "disconnected",
      currentServer: null,
      lastError: null,
      live: initialLive,
      settings: DEFAULT_SETTINGS,
      view: "landing",
      _ticker: null,

      connect: (server, protocol) => {
        const prev = get()._ticker;
        if (prev) clearInterval(prev);

        set({ state: "connecting", currentServer: server, lastError: null, live: { ...initialLive } });

        // If running in Electron desktop app, use the REAL VPN engine (xray-core).
        // The main process will spawn xray, establish the TUN tunnel, and only
        // report 'connected' after xray confirms handshake.
        if (isElectron()) {
          const distort = (window as any).distort;
          // Get the config URI from the selected Community Mesh config if available
          // For now, the desktop quickConnect handles this server-side.
          distort.vpn.connect(server, protocol, (server as any).configUri || null)
            .then((vpnState: any) => {
              // The main process sends state updates via onStateChange
              // This just handles the immediate response
              if (vpnState?.connected) {
                set({ state: "connected", live: { ...initialLive, connectedSince: vpnState.startedAt, ping: server.ping || 0 } });
              }
            })
            .catch((e: Error) => {
              set({ state: "error", lastError: e?.message || "Connection failed" });
            });
          return;
        }

        // DEMO MODE (browser only) — simulate connection for preview purposes.
        // This does NOT create a real VPN tunnel. No traffic is encrypted.
        const handshakeDelay = protocol === "wireguard" ? 900 : protocol === "v2ray" ? 1300 : protocol === "trojan" ? 1500 : 1100;

        window.setTimeout(() => {
          if (get().state !== "connecting") return; // user cancelled
          const now = Date.now();
          set({
            state: "connected",
            live: { ...initialLive, connectedSince: now, ping: server.ping || rand(18, 70) },
          });

          // Start a live ticker that reads REAL speed from companion API.
          // Falls back to demo simulation if companion is not available.
          const ticker = window.setInterval(async () => {
            const s = get();
            if (s.state !== "connected") return;

            // Try to read real speed from companion API
            try {
              const resp = await fetch("/api/tunnel/status");
              if (resp.ok) {
                const data = await resp.json();
                if (data.running && data.downBps !== undefined) {
                  // REAL speeds from xray-core
                  const downBps = data.downBps || 0;
                  const upBps = data.upBps || 0;
                  const jitter = rand(-2, 3);
                  set({
                    live: {
                      downBps,
                      upBps,
                      totalDown: s.live.totalDown + downBps,
                      totalUp: s.live.totalUp + upBps,
                      ping: Math.max(8, s.live.ping + jitter),
                      connectedSince: s.live.connectedSince,
                      exitIp: data.exitIp || s.live.exitIp,
                      exitCountry: data.exitCountry || s.live.exitCountry,
                    },
                  });
                  return;
                }
              }
            } catch {
              // Companion API not available — fall through to demo mode
            }

            // DEMO FALLBACK — simulated speeds (when companion API is not running)
            const burst = Math.random() > 0.8;
            const downBps = burst ? rand(4, 14) * 1_000_000 : rand(200_000, 2_500_000);
            const upBps = burst ? rand(1, 4) * 1_000_000 : rand(60_000, 700_000);
            const jitter = rand(-4, 6);
            set({
              live: {
                downBps,
                upBps,
                totalDown: s.live.totalDown + downBps,
                totalUp: s.live.totalUp + upBps,
                ping: Math.max(8, s.live.ping + jitter),
                connectedSince: s.live.connectedSince,
              },
            });
          }, 1000);

          set({ _ticker: ticker });
        }, handshakeDelay);
      },

      disconnect: () => {
        const prev = get()._ticker;
        if (prev) clearInterval(prev);
        set({ state: "disconnected", live: { ...initialLive }, _ticker: null });
      },

      setView: (v) => set({ view: v }),
      setCurrentServer: (s) => set({ currentServer: s }),
      updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
      resetStats: () => set({ live: { ...initialLive } }),
      setExitInfo: (exitIp, exitCountry) => set({ live: { ...get().live, exitIp, exitCountry } }),
    }),
    {
      name: "distort-vpn",
      partialize: (s) => ({ settings: s.settings, currentServer: s.currentServer, view: s.view }),
    }
  )
);

// Helpers
export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bps: number): string {
  if (bps < 1000) return `${bps} b/s`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} KB/s`;
  return `${(bps / 1_000_000).toFixed(1)} MB/s`;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
