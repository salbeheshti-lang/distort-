"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Download, Copy, Check, Chrome, Monitor, Smartphone, Shield, Gift, Users, Sparkles, FileCode2, KeyRound, Heart, ExternalLink, AlertTriangle, Zap } from "lucide-react";
import { useFetch, postJSON } from "@/hooks/use-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { PROTOCOLS } from "@/lib/vpn-data";
import type { ServerLite } from "@/lib/vpn-store";

type Account = {
  id: string;
  email: string;
  name?: string | null;
  tier: string;
  referral?: string | null;
  createdAt: string;
};

// Config response shape from /api/servers/[id]/config.
// The connectable/source/warning fields were added in task 2-D — older
// responses may not carry them, so we treat them as optional and fall
// back to the safe assumption that any legacy response is a non-connectable
// template (because the route only ever emits templates).
type GenResult = {
  filename: string;
  mime: string;
  content: string;
  // New (task 2-D) — missing from legacy responses:
  connectable?: boolean;
  source?: "template" | "provisioned" | "imported";
  warning?: string | null;
  label?: string;
  protocol?: string;
  country?: string;
};

export function AccountView() {
  const { data: servers } = useFetch<{ servers: ServerLite[] }>("/api/servers");
  const { data: account } = useFetch<{ account: Account }>("/api/account");
  const [selectedServer, setSelectedServer] = useState<string>("");
  const [protocol, setProtocol] = useState<string>("wireguard");
  const [generated, setGenerated] = useState<GenResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");

  const serverList = servers?.servers ?? [];
  const firstServer = serverList[0];

  const generate = async () => {
    const sid = selectedServer || firstServer?.id;
    if (!sid) {
      toast.error("No server available");
      return;
    }
    setGenerating(true);
    setGenerated(null);
    try {
      const r = await postJSON<GenResult>(`/api/servers/${sid}/config`, { protocol });
      setGenerated(r);
      // Always remind the user this is a TEMPLATE (the route never returns a
      // real, connectable config — provisioning is a separate path). The
      // success toast wording is intentionally cautious so the user doesn't
      // mistake the generated text for a working config in an emergency.
      toast.success("Template config generated", {
        description: `${r.filename} — NOT CONNECTABLE (sample credentials)`,
      });
    } catch (e) {
      toast.error("Failed to generate config", { description: (e as Error).message });
    } finally {
      setGenerating(false);
    }
  };

  // Stub call to the (not-yet-built) provisioning path. Once the real
  // provisioning infrastructure is wired up, this button can be flipped to
  // invoke provisionConfig() from @/lib/config-generator directly.
  const requestProvisionedConfig = () => {
    toast.error("Provisioning is not yet available", {
      description:
        "Use the Distort Config tab to import real configs from the Iran subscription, or paste your own config URI.",
    });
  };

  const copy = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success("Copied to clipboard");
  };

  const download = () => {
    if (!generated) return;
    const blob = new Blob([generated.content], { type: generated.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = generated.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Download started", { description: generated.filename });
  };

  const signup = async () => {
    if (!email) return;
    try {
      const r = await postJSON<{ account: Account }>("/api/account", { email, referral: "FREEDOM" });
      toast.success("Free account ready", { description: r.account.email });
    } catch (e) {
      toast.error("Sign-up failed", { description: (e as Error).message });
    }
  };

  const acc = account?.account;

  return (
    <div className="space-y-4">
      {/* Account card */}
      <Card className="glass border-white/5 relative overflow-hidden">
        <div className="absolute inset-0 bg-brand-gradient-soft opacity-30" />
        <CardContent className="relative p-5 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-brand-gradient flex items-center justify-center text-[#02131a] font-display font-extrabold text-xl">
            {(acc?.name ?? acc?.email ?? "D").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display text-lg font-bold text-white truncate">{acc?.name ?? "Free User"}</h3>
              <Badge className="bg-[#10d9a0]/15 border-[#10d9a0]/40 text-[#10d9a0] hover:bg-[#10d9a0]/20 font-tech uppercase tracking-wider text-[10px]">
                <Sparkles className="w-3 h-3 mr-1" />{acc?.tier ?? "free"} · 100% Free
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground truncate">{acc?.email ?? "Sign up to sync your settings across devices."}</p>
            {acc?.referral && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <Gift className="w-3 h-3 text-[#ffb020]" /> Referral code: <span className="font-mono text-[#ffb020]">{acc.referral}</span>
              </p>
            )}
          </div>
          {!acc?.email && (
            <div className="flex gap-2 w-full sm:w-auto">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="bg-white/[0.04] border-white/10 flex-1 sm:w-52" />
              <Button onClick={signup} className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider whitespace-nowrap">
                <Heart className="w-3.5 h-3.5 mr-1.5" /> Join Free
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Config generator (TEMPLATE / preview only) */}
      <Card className="glass border-white/5">
        <CardHeader className="pb-3">
          <CardTitle className="font-display tracking-wider text-sm flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#00f0ff]" /> Manual Config Generator
            <Badge variant="outline" className="border-[#ffb020]/40 text-[#ffb020] font-tech uppercase text-[9px] ml-1">Template only</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Generate a <span className="text-[#ffb020]">template / preview</span> config to inspect the structure for each protocol
            (WireGuard, V2Ray, Trojan, Shadowsocks, SSH). Configs use sample credentials and will not connect.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Server</label>
              <select
                value={selectedServer}
                onChange={(e) => setSelectedServer(e.target.value)}
                className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-[#00f0ff]/50"
              >
                <option value="">Auto (best)</option>
                {serverList.filter((s) => s.online).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.flag} {s.country} · {s.city} · {s.code}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">Protocol</label>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm focus:outline-none focus:border-[#00f0ff]/50"
              >
                {PROTOCOLS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <Button onClick={generate} disabled={generating} className="w-full bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider">
            <FileCode2 className="w-4 h-4 mr-2" /> {generating ? "Generating…" : "Generate Template Config"}
          </Button>

          {/* Persistent honesty banner — the manual generator only ever
              produces TEMPLATE configs (sample credentials, not connectable).
              Surfacing this BEFORE the user clicks Generate prevents the
              emergency-scenario trap where a user mistakes a template for a
              working connection. */}
          <div className="flex items-start gap-2 rounded-lg border border-[#ffb020]/30 bg-[#ffb020]/5 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-[#ffb020] shrink-0 mt-0.5" />
            <p className="text-xs text-[#ffb020]/90 leading-relaxed">
              <span className="font-tech uppercase tracking-wider">Template / preview only —</span>{" "}
              configs generated here use <span className="font-semibold">sample credentials</span> and
              <span className="font-semibold"> cannot connect</span>. For a real connection, use the
              Distort Config tab or your own server.
            </p>
          </div>

          {generated && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-[#00f0ff]/30 bg-[#050814]/80 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="font-mono text-xs text-[#5cf2ff]">{generated.filename}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={copy} className="h-7 text-xs">
                    {copied ? <Check className="w-3.5 h-3.5 text-[#10d9a0]" /> : <Copy className="w-3.5 h-3.5" />}
                    <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={download} className="h-7 text-xs">
                    <Download className="w-3.5 h-3.5" />
                    <span className="ml-1">Download</span>
                  </Button>
                </div>
              </div>
              {/* Per-config NOT CONNECTABLE badge — re-stated here so the
                  user sees it right next to the config text, in case they
                  scrolled past the banner above. */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-[#ff4d6d]/5">
                <AlertTriangle className="w-3.5 h-3.5 text-[#ff4d6d] shrink-0" />
                <span className="text-[11px] font-tech uppercase tracking-wider text-[#ff4d6d]">
                  NOT CONNECTABLE — sample credentials
                </span>
              </div>
              <pre className="max-h-72 overflow-auto p-3 text-[11px] font-mono text-muted-foreground leading-relaxed">
{generated.content}
              </pre>
            </motion.div>
          )}

          {/* Provisioned-config CTA — separate path from the template
              generator above. Clicking it surfaces the (stub) provisioning
              unavailability so the user is redirected to Distort Config. */}
          <Button
            variant="outline"
            onClick={requestProvisionedConfig}
            className="w-full border-[#8b5cf6]/40 text-[#a78bfa] hover:bg-[#8b5cf6]/10 font-tech uppercase tracking-wider"
          >
            <Zap className="w-4 h-4 mr-2" /> Get a real provisioned config
          </Button>
        </CardContent>
      </Card>

      {/* Downloads */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <DownloadCard
          icon={<Chrome className="w-5 h-5" />}
          title="Chrome Extension"
          desc="Browser-level proxy with stealth transport. MV3, 100% free."
          badge="MV3"
          href="/extension"
          onClick={() => toast.info("Load unpacked", { description: "Open chrome://extensions → Developer mode → Load unpacked → select the /extension folder." })}
        />
        <DownloadCard
          icon={<Monitor className="w-5 h-5" />}
          title="Desktop App"
          desc="Windows / macOS / Linux. Full tunnel engine + kill switch."
          badge="Beta"
          href="#download"
          onClick={() => toast.info("Desktop build", { description: "Coming soon — packaged Electron builds are in the repo's electron/ folder." })}
        />
        <DownloadCard
          icon={<Smartphone className="w-5 h-5" />}
          title="Mobile Apps"
          desc="iOS & Android. WireGuard-based with stealth fallback."
          badge="Soon"
          href="#download"
          onClick={() => toast.info("Mobile apps", { description: "iOS & Android builds are on the roadmap. Use the config generator with WireGuard mobile apps in the meantime." })}
        />
      </div>

      {/* Referral / share */}
      <Card className="glass border-white/5">
        <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-[#8b5cf6]/15 border border-[#8b5cf6]/30 flex items-center justify-center">
            <Users className="w-5 h-5 text-[#8b5cf6]" />
          </div>
          <div className="flex-1">
            <h4 className="font-display font-bold text-white">Invite a friend to freedom</h4>
            <p className="text-xs text-muted-foreground">Distort is 100% free forever. Share your link and help more people stay online.</p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Input readOnly value="distort.app/r/FREEDOM" className="bg-white/[0.04] border-white/10 font-mono text-xs flex-1 sm:w-48" />
            <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText("distort.app/r/FREEDOM"); toast.success("Referral link copied"); }} className="border-[#00f0ff]/30 text-[#5cf2ff] hover:bg-[#00f0ff]/10">
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DownloadCard({ icon, title, desc, badge, href, onClick }: { icon: React.ReactNode; title: string; desc: string; badge: string; href: string; onClick: () => void }) {
  return (
    <a href={href} onClick={(e) => { e.preventDefault(); onClick(); }} className="group block">
      <Card className="glass border-white/5 hover:border-[#00f0ff]/30 transition-colors h-full">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-11 h-11 rounded-xl bg-brand-gradient-soft border border-white/10 flex items-center justify-center text-[#5cf2ff] group-hover:text-[#00f0ff] transition-colors">
              {icon}
            </div>
            <Badge variant="outline" className="border-[#8b5cf6]/40 text-[#8b5cf6] font-tech uppercase text-[10px]">{badge}</Badge>
          </div>
          <h4 className="font-display font-bold text-white mb-1 flex items-center gap-1.5">
            {title}
            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </h4>
          <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
        </CardContent>
      </Card>
    </a>
  );
}
