"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { DownloadSection } from "@/components/landing/download";
import { Dashboard } from "@/components/vpn/dashboard";
import { Button } from "@/components/ui/button";
import { Server as ServerIcon, ArrowDown } from "lucide-react";

export default function Home() {
  const [mode, setMode] = useState<"landing" | "app">(() =>
    typeof window !== "undefined" && window.location.hash === "#app" ? "app" : "landing"
  );

  // Sync hash changes (back/forward buttons).
  useEffect(() => {
    const onHash = () => setMode(window.location.hash === "#app" ? "app" : "landing");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const launchApp = () => {
    setMode("app");
    window.location.hash = "app";
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const backHome = () => {
    setMode("landing");
    if (window.location.hash === "#app") {
      history.replaceState(null, "", window.location.pathname);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader onLaunch={launchApp} />

      <main className="flex-1">
        <AnimatePresence mode="wait">
          {mode === "landing" ? (
            <motion.div
              key="landing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
            >
              <Hero onLaunch={launchApp} />
              <Features />
              <ServersCta onLaunch={launchApp} />
              <DownloadSection onLaunch={launchApp} />
            </motion.div>
          ) : (
            <motion.div
              key="app"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Dashboard onClose={backHome} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <SiteFooter />
    </div>
  );
}

function ServersCta({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section id="servers-cta" className="relative py-16 px-4">
      <div className="mx-auto max-w-6xl">
        <div className="relative overflow-hidden rounded-3xl glass-strong border border-white/10 p-8 md:p-12 text-center">
          <div className="mesh-bg opacity-60" />
          <div className="absolute inset-0 grid-overlay opacity-30" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#00f0ff]/10 border border-[#00f0ff]/30 mb-5">
              <ServerIcon className="w-3.5 h-3.5 text-[#5cf2ff]" />
              <span className="text-[10px] font-tech uppercase tracking-[0.2em] text-[#5cf2ff]">30+ nodes · 5 protocols</span>
            </div>
            <h2 className="font-display text-3xl md:text-5xl font-extrabold tracking-tight mb-4">
              Pick your <span className="text-gradient-brand">exit</span>. Anywhere on Earth.
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto mb-8">
              From Frankfurt to Tokyo, Helsinki to Dubai — every node is stealth-capable and tuned for
              low-latency access from censored regions. Auto-pick lets Distort choose the fastest one for you.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button onClick={onLaunch} size="lg" className="bg-brand-gradient text-[#02131a] hover:opacity-90 font-tech uppercase tracking-[0.15em] px-8 h-12">
                <ServerIcon className="w-4 h-4 mr-2" /> Browse servers
              </Button>
              <a href="#download">
                <Button variant="outline" size="lg" className="border-white/15 bg-white/[0.03] hover:bg-white/[0.06] font-tech uppercase tracking-[0.15em] h-12">
                  <ArrowDown className="w-4 h-4 mr-2" /> Get the apps
                </Button>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
