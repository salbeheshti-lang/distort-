"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe, MapPin, Loader2, RefreshCw, ShieldCheck, AlertCircle } from "lucide-react";
import { toast } from "sonner";

type IpInfo = {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  isp: string | null;
  loading: boolean;
  error: string | null;
};

const initial: IpInfo = {
  ip: null,
  country: null,
  countryCode: null,
  city: null,
  isp: null,
  loading: false,
  error: null,
};

export function IpLocationWidget({ isConnected }: { isConnected: boolean }) {
  const [realIp, setRealIp] = useState<IpInfo>(initial);
  const [vpnIp, setVpnIp] = useState<IpInfo>(initial);

  const fetchIpInfo = useCallback(async (target: "real" | "vpn"): Promise<IpInfo> => {
    try {
      // Use ipapi.co — free, no API key needed, returns JSON
      const resp = await fetch("https://ipapi.co/json/", {
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return {
        ip: data.ip || null,
        country: data.country_name || null,
        countryCode: data.country_code || null,
        city: data.city || null,
        isp: data.org || null,
        loading: false,
        error: null,
      };
    } catch (e) {
      return {
        ...initial,
        error: (e as Error).message,
      };
    }
  }, []);

  // Fetch real IP on mount
  useEffect(() => {
    setRealIp((s) => ({ ...s, loading: true }));
    fetchIpInfo("real").then(setRealIp);
  }, [fetchIpInfo]);

  // Fetch VPN IP when connected
  useEffect(() => {
    if (isConnected) {
      setVpnIp((s) => ({ ...s, loading: true }));
      // Wait 2s for tunnel to establish
      const timer = setTimeout(() => {
        fetchIpInfo("vpn").then(setVpnIp);
      }, 2000);
      return () => clearTimeout(timer);
    } else {
      setVpnIp(initial);
    }
  }, [isConnected, fetchIpInfo]);

  const refreshReal = () => {
    setRealIp((s) => ({ ...s, loading: true, error: null }));
    fetchIpInfo("real").then(setRealIp);
  };

  const refreshVpn = () => {
    setVpnIp((s) => ({ ...s, loading: true, error: null }));
    fetchIpInfo("vpn").then(setVpnIp);
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {/* Real IP (before VPN) */}
      <IpCard
        title="Your Real IP"
        icon={<Globe className="w-4 h-4 text-[#8aa0c4]" />}
        info={realIp}
        onRefresh={refreshReal}
        accent="#8aa0c4"
      />

      {/* VPN IP (after connecting) */}
      <IpCard
        title="VPN Exit IP"
        icon={<ShieldCheck className="w-4 h-4 text-[#10d9a0]" />}
        info={vpnIp}
        onRefresh={refreshVpn}
        accent="#10d9a0"
        disabled={!isConnected}
      />
    </div>
  );
}

function IpCard({
  title,
  icon,
  info,
  onRefresh,
  accent,
  disabled,
}: {
  title: string;
  icon: React.ReactNode;
  info: IpInfo;
  onRefresh: () => void;
  accent: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border p-4 transition-all ${
        disabled
          ? "bg-white/[0.01] border-white/5 opacity-50"
          : "bg-card border-white/5"
      }`}
      style={{ borderColor: disabled ? undefined : `${accent}20` }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span style={{ color: accent }}>{icon}</span>
          <span className="text-xs font-tech uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
        </div>
        {!disabled && (
          <button
            onClick={onRefresh}
            className="text-muted-foreground hover:text-white transition-colors"
            title="Refresh"
          >
            {info.loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      {disabled ? (
        <div className="text-sm text-muted-foreground py-2">
          Connect to VPN to see exit IP
        </div>
      ) : info.loading ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading…</span>
        </div>
      ) : info.error ? (
        <div className="flex items-center gap-2 py-2">
          <AlertCircle className="w-4 h-4 text-[#ff4d6d] flex-shrink-0" />
          <span className="text-xs text-[#ff4d6d]">Failed to load</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="font-mono text-lg font-bold text-white">
            {info.ip || "—"}
          </div>
          {info.country && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="w-3 h-3" />
              <span>
                {info.city ? `${info.city}, ` : ""}
                {info.country}
                {info.countryCode && (
                  <span className="ml-1 text-[10px] opacity-60">
                    ({info.countryCode})
                  </span>
                )}
              </span>
            </div>
          )}
          {info.isp && (
            <div className="text-[10px] text-muted-foreground/70 truncate">
              {info.isp}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
