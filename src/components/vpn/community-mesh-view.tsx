"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Search, Shield, Crown, Zap, X, Check, Wifi, RefreshCw, Plus, Link2, Trash2, Star,
  Copy, Download, Filter, AlertCircle, Globe2, Activity, Server as ServerIcon, Clock,
} from "lucide-react";
import { useFetch, postJSON } from "@/hooks/use-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { putJSON } from "@/hooks/use-fetch";

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

type Subscription = {
  id: string;
  label: string;
  url: string;
  kind: string;
  enabled: boolean;
  intervalMin: number;
  lastFetchedAt: string | null;
  lastCount: number;
  lastError: string | null;
  _count?: { configs: number };
};

function flagFor(country?: string | null): string {
  if (!country) return "🌐";
  const map: Record<string, string> = {
    Iran: "🇮🇷", Germany: "🇩🇪", Netherlands: "🇳🇱", France: "🇫🇷", Finland: "🇫🇮",
    "United States": "🇺🇸", "United Kingdom": "🇬🇧", Japan: "🇯🇵", Singapore: "🇸🇬",
    Turkey: "🇹🇷", UAE: "🇦🇪", Georgia: "🇬🇪", Armenia: "🇦🇲",
  };
  return map[country] || "🌐";
}

function reachColor(reach: string): string {
  if (reach === "ok") return "#10d9a0";
  if (reach === "fail") return "#ff4d6d";
  return "#8aa0c4";
}

function scoreColor(score: number): string {
  if (score >= 80) return "#10d9a0";
  if (score >= 60) return "#00f0ff";
  if (score >= 40) return "#ffb020";
  return "#8aa0c4";
}

export function CommunityMeshView() {
  const [tab, setTab] = useState<"optimized" | "all" | "favorites">("optimized");
  const [query, setQuery] = useState("");
  const [proto, setProto] = useState<string>("all");
  const [showImport, setShowImport] = useState(false);
  const [showAddSub, setShowAddSub] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const subsState = useFetch<{ subscriptions: Subscription[] }>("/api/subscriptions");
  const configsState = useFetch<{ configs: ImportedConfig[]; count: number }>(
    `/api/imported-configs?bucket=${tab === "all" ? "" : tab === "favorites" ? "" : "optimized"}&favorite=${tab === "favorites" ? "1" : ""}&q=${encodeURIComponent(query)}&protocol=${proto === "all" ? "" : proto}&limit=200`
  );

  const subscriptions = subsState.data?.subscriptions ?? [];
  const configs = configsState.data?.configs ?? [];
  const totalImported = configsState.data?.count ?? 0;

  const refreshSub = async (id: string, label: string) => {
    setRefreshing(id);
    try {
      const r = await postJSON<{ count: number; fetchedAt?: string; error?: string }>(`/api/subscriptions/${id}/refresh`, {});
      if (r.error) throw new Error(r.error);
      toast.success("Subscription refreshed", { description: `${label}: ${r.count} configs parsed` });
      subsState.refetch();
      configsState.refetch();
    } catch (e) {
      toast.error("Refresh failed", { description: (e as Error).message });
    } finally {
      setRefreshing(null);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await postJSON<{ checked: number; ok: number }>("/api/imported-configs/check", { limit: 30 });
      toast.success("Reachability check done", { description: `${r.ok}/${r.checked} endpoints reachable` });
      configsState.refetch();
    } catch (e) {
      toast.error("Check failed", { description: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };

  const toggleFav = async (c: ImportedConfig) => {
    try {
      await putJSON(`/api/imported-configs/${c.id}`, { favorite: !c.favorite });
      configsState.refetch();
    } catch {
      toast.error("Could not update favorite");
    }
  };

  const copyUri = (c: ImportedConfig) => {
    navigator.clipboard.writeText(c.uri);
    toast.success("Config URI copied", { description: `${c.protocol} ${c.host}:${c.port}` });
  };

  const downloadSub = () => {
    const blob = new Blob([configs.map((c) => c.uri).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "distort-community-mesh.txt";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Subscription exported");
  };

  const removeConfig = async (c: ImportedConfig) => {
    try {
      await fetch(`/api/imported-configs/${c.id}`, { method: "DELETE" });
      toast.success("Config removed");
      configsState.refetch();
      subsState.refetch();
    } catch {
      toast.error("Could not remove config");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header / stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={<ServerIcon className="w-4 h-4" />} label="Subscriptions" value={String(subscriptions.length)} color="#00f0ff" />
        <KpiCard icon={<Globe2 className="w-4 h-4" />} label="Total Configs" value={String(totalImported)} color="#8b5cf6" />
        <KpiCard icon={<Shield className="w-4 h-4" />} label="Optimized" value={String(configs.filter((c) => c.bucket === "optimized").length)} color="#10d9a0" />
        <KpiCard icon={<Star className="w-4 h-4" />} label="Favorites" value={String(configs.filter((c) => c.favorite).length)} color="#ffb020" />
      </div>

      {/* Subscriptions panel */}
      <Card className="glass border-white/5">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
              <Link2 className="w-4 h-4 text-[#00f0ff]" /> Subscription Sources
            </CardTitle>
            <Button size="sm" onClick={() => setShowAddSub(true)} className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider h-8">
              <Plus className="w-3.5 h-3.5 mr-1" /> Add URL
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {subsState.loading ? (
            <div className="text-xs text-muted-foreground font-tech uppercase tracking-wider">Loading subscriptions…</div>
          ) : subscriptions.length === 0 ? (
            <div className="text-sm text-muted-foreground py-2">
              No subscriptions yet. Add the Iran config-collector URL or paste your own configs.
            </div>
          ) : (
            subscriptions.map((s) => (
              <div key={s.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${s.kind === "community" ? "bg-[#00f0ff]/10 border-[#00f0ff]/30 text-[#5cf2ff]" : "bg-[#8b5cf6]/10 border-[#8b5cf6]/30 text-[#a78bfa]"}`}>
                    {s.kind === "community" ? <Globe2 className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-sm truncate">{s.label}</span>
                      <Badge variant="outline" className={`text-[9px] font-tech uppercase tracking-wider h-4 ${s.kind === "community" ? "border-[#00f0ff]/30 text-[#5cf2ff]" : "border-[#8b5cf6]/30 text-[#a78bfa]"}`}>
                        {s.kind}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] font-tech uppercase tracking-wider h-4 border-white/10 text-muted-foreground">
                        {s._count?.configs ?? s.lastCount} configs
                      </Badge>
                      {s.lastError && (
                        <Badge variant="outline" className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#ff4d6d]/30 text-[#ff4d6d]">
                          <AlertCircle className="w-2.5 h-2.5 mr-0.5" />error
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono mt-0.5">{s.url}</div>
                    {s.lastFetchedAt && (
                      <div className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        Last: {new Date(s.lastFetchedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refreshSub(s.id, s.label)}
                    disabled={refreshing === s.id || !s.enabled}
                    className="h-8 border-[#00f0ff]/30 text-[#5cf2ff] hover:bg-[#00f0ff]/10 font-tech uppercase tracking-wider text-[10px]"
                  >
                    <RefreshCw className={`w-3 h-3 mr-1 ${refreshing === s.id ? "animate-spin" : ""}`} />
                    {s.intervalMin > 0 ? `Auto ${s.intervalMin}m` : "Refresh"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Toolbar */}
      <Card className="glass border-white/5">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by host, country, label…"
                className="pl-10 bg-white/[0.03] border-white/10 focus-visible:border-[#00f0ff]/50"
              />
            </div>
            <div className="flex gap-2">
              <select
                value={proto}
                onChange={(e) => setProto(e.target.value)}
                className="h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-[#00f0ff]/50"
              >
                <option value="all">All protocols</option>
                <option value="vless">VLESS</option>
                <option value="vmess">VMess</option>
                <option value="trojan">Trojan</option>
                <option value="ss">Shadowsocks</option>
              </select>
              <Button variant="outline" onClick={runCheck} disabled={checking} className="border-[#10d9a0]/30 text-[#10d9a0] hover:bg-[#10d9a0]/10 font-tech uppercase tracking-wider text-xs h-9">
                <Activity className={`w-3.5 h-3.5 mr-1.5 ${checking ? "animate-spin" : ""}`} />
                {checking ? "Checking…" : "Test reach"}
              </Button>
              <Button variant="outline" onClick={downloadSub} className="border-white/10 text-muted-foreground hover:text-white font-tech uppercase tracking-wider text-xs h-9">
                <Download className="w-3.5 h-3.5 mr-1.5" /> Export
              </Button>
              <Button onClick={() => setShowImport(true)} className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider text-xs h-9">
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Import
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-3">
            <TabsList className="bg-white/[0.03] border border-white/5 h-9">
              <TabsTrigger value="optimized" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
                <Shield className="w-3 h-3 mr-1" /> Optimized
              </TabsTrigger>
              <TabsTrigger value="all" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
                <Filter className="w-3 h-3 mr-1" /> All
              </TabsTrigger>
              <TabsTrigger value="favorites" className="data-[state=active]:bg-[#00f0ff]/10 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs">
                <Star className="w-3 h-3 mr-1" /> Favorites
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardContent>
      </Card>

      {/* Config list */}
      <Card className="glass border-white/5">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
              <ServerIcon className="w-4 h-4 text-[#8b5cf6]" /> Distort Config
              <span className="text-xs text-muted-foreground font-tech">· {configs.length} configs</span>
            </CardTitle>
            <span className="text-[10px] text-muted-foreground font-tech uppercase tracking-wider">
              Sorted by score ↓
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {configsState.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3 animate-pulse h-14" />
              ))}
            </div>
          ) : configs.length === 0 ? (
            <div className="text-center py-12">
              <Globe2 className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No configs in this view yet.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Import a config or refresh a subscription to populate the mesh.</p>
            </div>
          ) : (
            <div className="max-h-[560px] overflow-y-auto pr-1 -mr-1 space-y-2">
              {configs.map((c, i) => {
                const flags = c.flags ? c.flags.split(",").filter(Boolean) : [];
                return (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.01, 0.3) }}
                    className="rounded-xl border border-white/5 bg-white/[0.02] hover:border-[#00f0ff]/20 hover:bg-white/[0.04] transition-colors p-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{flagFor(c.country)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white text-sm truncate">{c.label || `${c.host}:${c.port}`}</span>
                          <Badge variant="outline" className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#8b5cf6]/30 text-[#a78bfa]">
                            {c.protocol}
                          </Badge>
                          {flags.map((f) => (
                            <Badge key={f} variant="outline" className="text-[9px] font-tech uppercase tracking-wider h-4 border-[#00f0ff]/30 text-[#5cf2ff]">
                              {f}
                            </Badge>
                          ))}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                          {c.host}:{c.port} · {c.network}/{c.security}
                          {c.sni && <span className="text-muted-foreground/70"> · sni={c.sni}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {/* Score */}
                        <div className="text-center">
                          <div className="font-mono text-sm font-bold" style={{ color: scoreColor(c.score) }}>{c.score}</div>
                          <div className="text-[9px] text-muted-foreground font-tech uppercase tracking-wider">score</div>
                        </div>
                        {/* Reach */}
                        <div className="text-center">
                          <div className="font-mono text-sm font-bold" style={{ color: reachColor(c.reach) }}>
                            {c.reach === "ok" ? `${c.latencyMs}ms` : c.reach === "fail" ? "✗" : "—"}
                          </div>
                          <div className="text-[9px] text-muted-foreground font-tech uppercase tracking-wider">reach</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-[#ffb020]" onClick={() => toggleFav(c)}>
                          <Star className={`w-3.5 h-3.5 ${c.favorite ? "fill-[#ffb020] text-[#ffb020]" : ""}`} />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-[#5cf2ff]" onClick={() => copyUri(c)}>
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-[#ff4d6d]" onClick={() => removeConfig(c)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import dialog */}
      <ImportDialog open={showImport} onOpenChange={setShowImport} onDone={() => { configsState.refetch(); subsState.refetch(); }} />
      <AddSubDialog open={showAddSub} onOpenChange={setShowAddSub} onDone={() => { subsState.refetch(); configsState.refetch(); }} />
    </div>
  );
}

function KpiCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <Card className="glass border-white/5 relative overflow-hidden">
      <div className="absolute inset-0 opacity-25" style={{ background: `radial-gradient(circle at top right, ${color}, transparent 70%)` }} />
      <CardContent className="p-4 relative">
        <div className="flex items-center gap-2 mb-2">
          <span style={{ color }}>{icon}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-tech">{label}</span>
        </div>
        <div className="font-display text-2xl font-bold text-white">{value}</div>
      </CardContent>
    </Card>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [raw, setRaw] = useState("");
  const [source, setSource] = useState("personal");
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    try {
      const r = await postJSON<{ count: number; config?: unknown }>("/api/imported-configs/import", { raw, source });
      toast.success("Configs imported", { description: `${r.count} parsed & saved.` });
      setRaw("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error("Import failed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong border-[#00f0ff]/20 max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wider text-white flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#00f0ff]" /> Import Personal Configs
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste one or more <code className="text-[#5cf2ff]">vmess://</code>, <code className="text-[#5cf2ff]">vless://</code>, <code className="text-[#5cf2ff]">trojan://</code> or <code className="text-[#5cf2ff]">ss://</code> URIs (one per line). They will be parsed, scored, and added to your Distort Config.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Source label</Label>
            <Input value={source} onChange={(e) => setSource(e.target.value)} className="bg-white/[0.04] border-white/10" placeholder="personal" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Config URIs</Label>
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"vless://uuid@host:443?security=reality&sni=...#my-server\nvmess://eyJhZGQ...\ntrojan://pass@host:443#my-trojan"}
              className="bg-white/[0.04] border-white/10 font-mono text-xs min-h-[180px] resize-y"
            />
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            Single URIs are auto-favorited. Bulk pastes are deduplicated by host:port. Optimized configs (TLS/Reality/WS/gRPC) are highlighted.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-white">Cancel</Button>
          <Button onClick={handleImport} disabled={busy || !raw.trim()} className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider">
            {busy ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddSubDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [interval, setInterval] = useState(60);
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await postJSON<{ subscription: Subscription; warning?: string }>("/api/subscriptions", {
        url, label: label || undefined, kind: "custom", intervalMin: interval, fetchNow: true,
      });
      if (r.warning) {
        toast.warning("Subscription added (fetch warning)", { description: r.warning });
      } else {
        toast.success("Subscription added", { description: `${r.subscription.label}: ${r.subscription.lastCount} configs` });
      }
      setUrl(""); setLabel("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error("Could not add subscription", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong border-[#00f0ff]/20 max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wider text-white flex items-center gap-2">
            <Link2 className="w-4 h-4 text-[#00f0ff]" /> Add Subscription URL
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Distort will fetch the URL, parse all <code className="text-[#5cf2ff]">vmess://</code> / <code className="text-[#5cf2ff]">vless://</code> / <code className="text-[#5cf2ff]">trojan://</code> / <code className="text-[#5cf2ff]">ss://</code> URIs, and auto-refresh on your schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Subscription URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/sub.txt" className="bg-white/[0.04] border-white/10 font-mono text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My subscription" className="bg-white/[0.04] border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Auto-refresh (min)</Label>
              <Input type="number" value={interval} onChange={(e) => setInterval(Number(e.target.value))} className="bg-white/[0.04] border-white/10" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-white">Cancel</Button>
          <Button onClick={handleAdd} disabled={busy || !url.trim()} className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider">
            {busy ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
            {busy ? "Adding…" : "Add & Fetch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
