"use client";

// DISTORT — ImportDialog (redesigned)
//
// Supports TWO import modes via a Tabs switcher at the top of the modal:
//   1. "Config URIs"   — paste vmess://, vless://, trojan://, ss:// URIs
//                         (one per line). POSTs to /api/imported-configs/import.
//   2. "Subscription URL" — paste a single https:// subscription URL. POSTs to
//                         /api/subscriptions with {url, label, kind:"custom",
//                         intervalMin, fetchNow:true}.
//
// Smart auto-detect on PASTE:
//   - Starts with vmess/vless/trojan/ss://  → switch to "Config URIs" mode
//   - Starts with http(s)://                 → switch to "Subscription URL" mode
//   - Mixed lines                           → stay in "Config URIs" mode
//   (Auto-detect fires on paste only — not every keystroke — to avoid jumpy UI.)
//
// "📋 Paste" button reads from navigator.clipboard.readText() and triggers
// auto-detect. Shows a toast on success, or a permission-denied toast on error.
//
// Live preview per mode:
//   - Config URIs: green chip "N configs" + protocol breakdown chips,
//                  red error message when text is non-empty but no URIs match.
//   - Subscription URL: green ✓ + hostname when valid https://, red ✗ when
//                       invalid, yellow ⚠ when http:// (insecure).
//
// Subscription URL mode also exposes an "Auto-refresh (minutes)" number input
// (default 60). The Import button label changes based on mode:
//   - Config URIs mode → "Import"
//   - Subscription URL mode → "Add & Fetch"

import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus,
  Check,
  AlertCircle,
  RefreshCw,
  Zap,
  Clipboard,
  Link as LinkIcon,
  Clock,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type ImportMode = "uris" | "sub";

type ImportResponse = { ok: boolean; count: number; config?: { id: string } };
type SubResponse = {
  subscription: {
    id: string;
    url: string;
    label: string;
    lastCount?: number;
  };
  warning?: string;
};

// Detect the most-likely mode from arbitrary pasted text.
//   - Returns "uris" if any non-empty line starts with a known VPN scheme.
//   - Returns "sub" if the FIRST non-empty line starts with http(s):// and
//     no line starts with a VPN scheme.
//   - Returns null if no decision can be made (e.g. empty text).
function detectMode(text: string): ImportMode | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const hasVpnScheme = lines.some((l) =>
    /^(vmess|vless|trojan|ss):\/\//i.test(l)
  );
  if (hasVpnScheme) return "uris";
  if (/^https?:\/\//i.test(lines[0])) return "sub";
  return null;
}

// Validate a subscription URL. Returns:
//   - { ok: true, hostname }   for valid https:// URLs
//   - { ok: false, insecure }  for http:// URLs (warning, not error)
//   - { ok: false, error }     for completely invalid URLs
function validateSubUrl(
  url: string
): { ok: boolean; hostname?: string; insecure?: boolean; error?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "URL is empty" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "Must start with https://" };
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:") {
      return { ok: false, insecure: true, hostname: u.hostname };
    }
    return { ok: true, hostname: u.hostname };
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
}

export function ImportDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>("uris");
  const [raw, setRaw] = useState("");
  const [subUrl, setSubUrl] = useState("");
  const [subLabel, setSubLabel] = useState("");
  const [intervalMin, setIntervalMin] = useState(60);
  const [busy, setBusy] = useState(false);
  // Ref to the textarea so the Paste button can focus it after filling.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- Live previews ----
  const urisPreview = useMemo(() => {
    if (mode !== "uris" || !raw.trim()) return null;
    return countConfigUris(raw);
  }, [mode, raw]);

  const subPreview = useMemo(() => {
    if (mode !== "sub" || !subUrl.trim()) return null;
    return validateSubUrl(subUrl);
  }, [mode, subUrl]);

  // ---- Auto-detect mode on PASTE (not on every keystroke) ----
  // Reads what was pasted and switches mode if a clear winner is detected.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    const detected = detectMode(text);
    if (detected && detected !== mode) {
      setMode(detected);
      // When switching INTO subscription mode, populate the subUrl field
      // (the textarea will still receive the paste, but we'll clear it
      // after the mode-switch renders to avoid double text).
      if (detected === "sub") {
        // Defer the URL field population until after the mode switch renders.
        const firstLine = text.split(/\r?\n/)[0].trim();
        setTimeout(() => {
          setSubUrl(firstLine);
          setRaw(""); // clear the textarea (we moved the URL to the sub field)
        }, 0);
      } else if (detected === "uris") {
        // Already in URI flow — let the textarea keep the pasted text.
      }
    }
  };

  // ---- "📋 Paste" button — read from clipboard ----
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast.error("Clipboard is empty", {
          description: "Copy a config URI or subscription URL first.",
        });
        return;
      }
      const detected = detectMode(text);
      // Auto-switch mode based on clipboard contents.
      if (detected && detected !== mode) {
        setMode(detected);
      }
      const target = detected ?? mode;
      if (target === "sub") {
        const firstLine = text.split(/\r?\n/)[0].trim();
        setSubUrl(firstLine);
        setRaw("");
      } else {
        setRaw(text);
      }
      toast.success("Pasted from clipboard");
      // Refocus the relevant input.
      setTimeout(() => {
        if (target === "sub") {
          const el = document.getElementById(
            "sub-url-input"
          ) as HTMLInputElement | null;
          el?.focus();
        } else {
          textareaRef.current?.focus();
        }
      }, 0);
    } catch {
      toast.error("Clipboard access denied", {
        description: "Paste manually with Ctrl+V (Cmd+V on Mac).",
      });
    }
  };

  // ---- Submit handlers ----
  const handleImportUris = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    try {
      const r = await postJSONSoft<ImportResponse>(
        "/api/imported-configs/import",
        { raw, source: "personal" }
      );
      if (!r.ok || !r.data) {
        toast.error("Import failed", {
          description: r.error ?? "Unknown error",
        });
        return;
      }
      const count = r.data.count;
      if (count === 1) {
        toast.success("Config imported", {
          description: "Saved to your personal configs (⭐).",
        });
      } else {
        toast.success("Configs imported", {
          description: `${count} parsed & saved.`,
        });
      }
      setRaw("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error("Import failed", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const handleAddSub = async () => {
    const validation = validateSubUrl(subUrl);
    if (!validation.ok && !validation.insecure) {
      toast.error("Invalid subscription URL", {
        description: validation.error ?? "Must start with https://",
      });
      return;
    }
    setBusy(true);
    try {
      const r = await postJSONSoft<SubResponse>("/api/subscriptions", {
        url: subUrl.trim(),
        label: subLabel.trim() || undefined,
        kind: "custom",
        intervalMin,
        fetchNow: true,
      });
      if (!r.ok || !r.data) {
        toast.error("Subscription add failed", {
          description: r.error ?? "Unknown error",
        });
        return;
      }
      const count = r.data.subscription?.lastCount ?? 0;
      if (r.data.warning) {
        // Saved but fetch failed — surface the warning.
        toast.warning("Subscription saved (fetch failed)", {
          description: r.data.warning,
        });
      } else if (count > 0) {
        toast.success("Subscription added", {
          description: `${count} configs fetched.`,
        });
      } else {
        toast.success("Subscription added", {
          description: "No configs found in the URL yet.",
        });
      }
      setSubUrl("");
      setSubLabel("");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error("Subscription add failed", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  // Block close while busy; clear text shortly after closing so the dialog
  // animation doesn't visibly flash an empty textarea.
  const handleOpenChange = (o: boolean) => {
    if (!o && busy) return;
    onOpenChange(o);
    if (!o) {
      setTimeout(() => {
        setRaw("");
        setSubUrl("");
        setSubLabel("");
      }, 220);
    }
  };

  // Compute "can submit" based on mode.
  const canImportUris =
    !busy && raw.trim().length > 0 && (!!urisPreview && urisPreview.total > 0);
  const canAddSub =
    !busy &&
    subUrl.trim().length > 0 &&
    (!!subPreview && (subPreview.ok || subPreview.insecure === true));

  const canSubmit = mode === "uris" ? canImportUris : canAddSub;

  // Submit dispatcher — calls the right handler based on mode.
  const handleSubmit = () => {
    if (mode === "uris") handleImportUris();
    else handleAddSub();
  };

  const submitLabel = mode === "uris"
    ? busy
      ? "Importing…"
      : "Import"
    : busy
    ? "Fetching…"
    : "Add & Fetch";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="glass-strong border-[#00f0ff]/20 max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wider text-white flex items-center gap-3">
            <span className="w-8 h-8 rounded-xl bg-brand-gradient flex items-center justify-center shadow-[0_0_18px_rgba(0,240,255,0.35)]">
              <Plus className="w-4 h-4 text-[#02131a]" strokeWidth={2.5} />
            </span>
            Import Configs
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste individual{" "}
            <code className="text-[#5cf2ff]">vmess://</code>,{" "}
            <code className="text-[#5cf2ff]">vless://</code>,{" "}
            <code className="text-[#5cf2ff]">trojan://</code> or{" "}
            <code className="text-[#5cf2ff]">ss://</code> URIs, or add a{" "}
            <code className="text-[#5cf2ff]">https://</code> subscription URL.
            Personal imports are tagged with{" "}
            <span className="text-[#ffb020]">⭐</span>.
          </DialogDescription>
        </DialogHeader>

        {/* ===== Tab switcher — Config URIs vs Subscription URL ===== */}
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as ImportMode)}
          className="w-full"
        >
          <TabsList className="bg-white/[0.03] border border-white/5 w-full">
            <TabsTrigger
              value="uris"
              className="data-[state=active]:bg-[#00f0ff]/15 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs"
            >
              <Plus className="w-3 h-3 mr-1.5" strokeWidth={2.5} />
              Config URIs
            </TabsTrigger>
            <TabsTrigger
              value="sub"
              className="data-[state=active]:bg-[#00f0ff]/15 data-[state=active]:text-[#5cf2ff] font-tech uppercase tracking-wider text-xs"
            >
              <LinkIcon className="w-3 h-3 mr-1.5" strokeWidth={2.5} />
              Subscription URL
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04, duration: 0.2, ease: "easeOut" }}
          className="space-y-3"
        >
          {/* ===== Config URIs mode ===== */}
          {mode === "uris" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">
                  Config URIs
                </label>
                <div className="flex items-center gap-2">
                  {/* 📋 Paste button — reads from clipboard + auto-detects mode */}
                  <button
                    type="button"
                    onClick={handlePasteFromClipboard}
                    className="inline-flex items-center gap-1 text-[10px] font-tech uppercase tracking-wider text-muted-foreground hover:text-[#5cf2ff] px-2 py-0.5 rounded-full border border-white/10 hover:border-[#00f0ff]/40 transition-colors"
                    title="Read from clipboard"
                  >
                    <Clipboard className="w-2.5 h-2.5" strokeWidth={2.2} />
                    Paste
                  </button>
                  {/* Live count chip — appears the moment ≥1 URI is detected */}
                  {urisPreview && urisPreview.total > 0 && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.18 }}
                      className="text-[10px] font-tech uppercase tracking-wider text-[#10d9a0] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#10d9a0]/10 border border-[#10d9a0]/25"
                    >
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                      {urisPreview.total}{" "}
                      {urisPreview.total === 1 ? "config" : "configs"}
                    </motion.span>
                  )}
                </div>
              </div>

              <Textarea
                ref={textareaRef}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                onPaste={handlePaste}
                placeholder={
                  "vless://a1b2c3d4-e5f6-7890-abcd-ef1234567890@host:443?type=ws&security=tls&sni=host&path=%2F#my-server\nvmess://eyJhZGQ...\ntrojan://pass@host:443#my-trojan"
                }
                className="bg-white/[0.04] border-white/10 font-mono text-xs min-h-[180px] resize-y focus-visible:border-[#00f0ff]/50 transition-colors"
                autoFocus
              />

              {/* Protocol breakdown chips — appear with stagger when URIs detected */}
              {urisPreview && urisPreview.total > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="flex flex-wrap gap-1.5 pt-1 overflow-hidden"
                >
                  {Object.entries(urisPreview.byProtocol).map(([k, v], i) => (
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
              {urisPreview && urisPreview.total === 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="text-[11px] text-[#ff4d6d] flex items-start gap-1.5 pt-1"
                >
                  <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span>
                    No valid URIs detected. Make sure each line starts with
                    vmess://, vless://, trojan://, or ss://. (Subscription URLs
                    should be added in the &quot;Subscription URL&quot; tab.)
                  </span>
                </motion.div>
              )}

              <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1.5">
                <Zap className="w-3 h-3 mt-0.5 text-[#ffb020] flex-shrink-0" />
                <span>
                  Single URIs are auto-favorited. Bulk pastes are deduplicated
                  by host:port. Optimized configs (TLS/Reality/WS/gRPC) appear
                  at the top of your dropdown.
                </span>
              </p>
            </div>
          )}

          {/* ===== Subscription URL mode ===== */}
          {mode === "sub" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">
                    Subscription URL
                  </label>
                  <div className="flex items-center gap-2">
                    {/* 📋 Paste button — same component, different target */}
                    <button
                      type="button"
                      onClick={handlePasteFromClipboard}
                      className="inline-flex items-center gap-1 text-[10px] font-tech uppercase tracking-wider text-muted-foreground hover:text-[#5cf2ff] px-2 py-0.5 rounded-full border border-white/10 hover:border-[#00f0ff]/40 transition-colors"
                      title="Read from clipboard"
                    >
                      <Clipboard className="w-2.5 h-2.5" strokeWidth={2.2} />
                      Paste
                    </button>
                    {/* URL validity chip */}
                    {subPreview && subPreview.ok && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.18 }}
                        className="text-[10px] font-tech uppercase tracking-wider text-[#10d9a0] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#10d9a0]/10 border border-[#10d9a0]/25"
                      >
                        <Check className="w-2.5 h-2.5" strokeWidth={3} />
                        Valid · {subPreview.hostname}
                      </motion.span>
                    )}
                    {subPreview &&
                      !subPreview.ok &&
                      subPreview.insecure === true && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.18 }}
                          className="text-[10px] font-tech uppercase tracking-wider text-[#ffb020] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#ffb020]/10 border border-[#ffb020]/25"
                        >
                          <AlertCircle className="w-2.5 h-2.5" strokeWidth={3} />
                          Insecure · use https://
                        </motion.span>
                      )}
                    {subPreview &&
                      !subPreview.ok &&
                      subPreview.insecure === undefined && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.18 }}
                          className="text-[10px] font-tech uppercase tracking-wider text-[#ff4d6d] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#ff4d6d]/10 border border-[#ff4d6d]/25"
                        >
                          <AlertCircle className="w-2.5 h-2.5" strokeWidth={3} />
                          Invalid
                        </motion.span>
                      )}
                  </div>
                </div>

                <Input
                  id="sub-url-input"
                  type="url"
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  onPaste={handlePaste as unknown as React.ClipboardEventHandler<HTMLInputElement>}
                  placeholder="https://example.com/sub.txt"
                  className="bg-white/[0.04] border-white/10 font-mono text-xs focus-visible:border-[#00f0ff]/50 transition-colors"
                  autoFocus
                />

                {/* Inline error / insecure message */}
                {subPreview &&
                  !subPreview.ok &&
                  subPreview.insecure === undefined &&
                  subUrl.trim().length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="text-[11px] text-[#ff4d6d] flex items-start gap-1.5 pt-0.5"
                    >
                      <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>
                        {subPreview.error ??
                          "Invalid URL — must start with https://"}
                      </span>
                    </motion.div>
                  )}
                {subPreview &&
                  !subPreview.ok &&
                  subPreview.insecure === true && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="text-[11px] text-[#ffb020] flex items-start gap-1.5 pt-0.5"
                    >
                      <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>
                        Insecure URL — your subscription token will be sent in
                        plaintext. Use <code>https://</code> if the server
                        supports it.
                      </span>
                    </motion.div>
                  )}
              </div>

              {/* Optional label + auto-refresh interval */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground">
                    Label{" "}
                    <span className="text-muted-foreground/60 normal-case">
                      (optional)
                    </span>
                  </label>
                  <Input
                    type="text"
                    value={subLabel}
                    onChange={(e) => setSubLabel(e.target.value)}
                    placeholder="My subscription"
                    className="bg-white/[0.04] border-white/10 text-xs focus-visible:border-[#00f0ff]/50 transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-tech uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3 text-[#5cf2ff]" strokeWidth={2.2} />
                    Auto-refresh
                  </label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={1440}
                      value={intervalMin}
                      onChange={(e) =>
                        setIntervalMin(
                          Math.max(
                            0,
                            Math.min(1440, Number(e.target.value) || 0)
                          )
                        )
                      }
                      className="bg-white/[0.04] border-white/10 text-xs w-20 text-center focus-visible:border-[#00f0ff]/50 transition-colors"
                    />
                    <span className="text-[10px] font-tech uppercase tracking-wider text-muted-foreground">
                      min
                    </span>
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1.5">
                <Zap className="w-3 h-3 mt-0.5 text-[#ffb020] flex-shrink-0" />
                <span>
                  Fetched immediately. The subscription URL is stored and
                  auto-refreshed on the interval above. Set 0 to disable
                  auto-refresh.
                </span>
              </p>
            </div>
          )}
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
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-wider disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5 mr-1.5" strokeWidth={2.5} />
            )}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
