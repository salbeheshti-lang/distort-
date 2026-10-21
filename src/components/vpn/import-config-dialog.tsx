"use client";

// DISTORT — ImportDialog (extracted from community-mesh-view.tsx)
// Single, self-contained modal for pasting one-or-more vmess/vless/trojan/ss
// URIs. POSTs to /api/imported-configs/import with `postJSONSoft` so we can
// surface structured backend errors (e.g. "Could not parse URI: host missing").
// Live preview uses countConfigUris (browser-safe — no Buffer dependency).
//
// Signature preserved from the old component:
//   ImportDialog({ open, onOpenChange, onDone })

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Plus, Check, AlertCircle, RefreshCw, Zap } from "lucide-react";
import { countConfigUris } from "@/lib/config-parser";
import { postJSONSoft } from "@/hooks/use-fetch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type ImportResponse = { ok: boolean; count: number; config?: { id: string } };

export function ImportDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);

  // Live-parse preview: count supported URIs by protocol scheme.
  // Uses countConfigUris (browser-safe regex; no Buffer dependency).
  const preview = useMemo(() => {
    if (!raw.trim()) return null;
    return countConfigUris(raw);
  }, [raw]);

  const handleImport = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    try {
      // postJSONSoft returns { ok, data, error } — never throws.
      // We use it instead of postJSON so we can read the structured error
      // from the backend (e.g. "Parsed URI is missing host or port...")
      const r = await postJSONSoft<ImportResponse>("/api/imported-configs/import", {
        raw,
        source: "personal",
      });
      if (!r.ok || !r.data) {
        toast.error("Import failed", { description: r.error ?? "Unknown error" });
        return;
      }
      const count = r.data.count;
      if (count === 1) {
        toast.success("Config imported", {
          description: "Saved to your personal configs (⭐).",
        });
      } else {
        toast.success("Configs imported", { description: `${count} parsed & saved.` });
      }
      setRaw("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      // Defensive — postJSONSoft never throws, but just in case:
      toast.error("Import failed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Block close while busy; clear text shortly after closing so the dialog
  // animation doesn't visibly flash an empty textarea.
  const handleOpenChange = (o: boolean) => {
    if (!o && busy) return;
    onOpenChange(o);
    if (!o) setTimeout(() => setRaw(""), 220);
  };

  // Import button is disabled when busy, empty, OR when text exists but no URIs
  // were detected (so the user can't submit a paste with zero parseable lines).
  const canImport =
    !busy &&
    raw.trim().length > 0 &&
    (!!preview && preview.total > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="glass-strong border-[#00f0ff]/20 max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wider text-white flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl bg-brand-gradient flex items-center justify-center shadow-[0_0_18px_rgba(0,240,255,0.35)]">
              <Plus className="w-4 h-4 text-[#02131a]" strokeWidth={2.5} />
            </span>
            Import Personal Config
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste one or more{" "}
            <code className="text-[#5cf2ff]">vmess://</code>,{" "}
            <code className="text-[#5cf2ff]">vless://</code>,{" "}
            <code className="text-[#5cf2ff]">trojan://</code> or{" "}
            <code className="text-[#5cf2ff]">ss://</code> URIs (one per line).
            They will be parsed, scored, and added to your Connect dropdown with
            a <span className="text-[#ffb020]">⭐</span> personal badge.
          </DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.25, ease: "easeOut" }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">
                Config URIs
              </label>
              {/* Live count chip — appears the moment ≥1 URI is detected */}
              {preview && preview.total > 0 && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.18 }}
                  className="text-[10px] font-tech uppercase tracking-wider text-[#10d9a0] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#10d9a0]/10 border border-[#10d9a0]/25"
                >
                  <Check className="w-2.5 h-2.5" strokeWidth={3} />
                  {preview.total} {preview.total === 1 ? "config" : "configs"}
                </motion.span>
              )}
            </div>

            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={
                "vless://a1b2c3d4-e5f6-7890-abcd-ef1234567890@host:443?type=ws&security=tls&sni=host&path=%2F#my-server\nvmess://eyJhZGQ...\ntrojan://pass@host:443#my-trojan"
              }
              className="bg-white/[0.04] border-white/10 font-mono text-xs min-h-[180px] resize-y focus-visible:border-[#00f0ff]/50 transition-colors"
              autoFocus
            />

            {/* Protocol breakdown chips — appear with stagger when URIs detected */}
            {preview && preview.total > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="flex flex-wrap gap-1.5 pt-1 overflow-hidden"
              >
                {Object.entries(preview.byProtocol).map(([k, v], i) => (
                  <motion.span
                    key={k}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="text-[10px] font-tech uppercase tracking-wider px-1.5 py-0.5 rounded border border-[#00f0ff]/20 text-[#5cf2ff] bg-[#00f0ff]/5"
                  >
                    {v} {k}
                  </motion.span>
                ))}
              </motion.div>
            )}

            {/* Error preview — when text is non-empty but no URIs match */}
            {preview && preview.total === 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="text-[11px] text-[#ff4d6d] flex items-start gap-1.5 pt-1"
              >
                <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span>
                  No valid URIs detected. Make sure each line starts with
                  vmess://, vless://, trojan://, or ss://
                </span>
              </motion.div>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1.5">
            <Zap className="w-3 h-3 mt-0.5 text-[#ffb020] flex-shrink-0" />
            <span>
              Single URIs are auto-favorited. Bulk pastes are deduplicated by
              host:port. Optimized configs (TLS/Reality/WS/gRPC) appear at the
              top of your dropdown.
            </span>
          </p>
        </motion.div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
            className="text-muted-foreground hover:text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={!canImport}
            className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5 mr-1.5" strokeWidth={2.5} />
            )}
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
