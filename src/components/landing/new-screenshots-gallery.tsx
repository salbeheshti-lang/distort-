// DISTORT — Screenshot gallery (new sections)
// Showcases all the new UI sections built in this session

import { GalleryHorizontalEnd } from "lucide-react";

type Shot = {
  src: string;
  title: string;
  desc: string;
  category: "Emergency" | "Dashboard" | "Admin" | "Extension" | "Mobile";
};

const SHOTS: Shot[] = [
  // Landing + Dashboard
  {
    src: "/screenshots-new/01-landing.png",
    title: "Landing Page",
    desc: "Hero with animated D logo, 'Break the borders of the web' tagline, 9 feature cards, Iran-resilience ladder, sticky footer.",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/02-dashboard-connect.png",
    desc: "Default connect view with power button, pulse rings, protocol selector, stealth toggle.",
    title: "Dashboard — Connect",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/15-connected-live-metrics.png",
    desc: "Live connection to Turkey — real-time ↓/↑ speeds ticking, session timer, data counters incrementing.",
    title: "Connected — Live Metrics",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/27-servers-list.png",
    desc: "30 servers across 25+ countries with flag, ping, load, stealth badge. Search + filters.",
    title: "Servers List",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/08-community-mesh.png",
    desc: "200+ Iran-optimized Reality/gRPC/Vision configs from the live subscription. Test reach, export, import.",
    title: "Community Mesh — Iran",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/09-speed-test.png",
    desc: "Animated gauge — real Mbps measurement to the active node. 343 Mbps down / 3.7 Mbps up shown.",
    title: "Speed Test",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/10-statistics.png",
    desc: "KPI cards + 7-day traffic area chart + protocol pie + sessions-by-protocol bar.",
    title: "Statistics",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/11-settings.png",
    desc: "5 protocol cards (WireGuard/V2Ray/Trojan/Shadowsocks/SSH) with speed/resistance scores + security toggles.",
    title: "Settings",
    category: "Dashboard",
  },

  // Emergency Connectivity (the big new feature)
  {
    src: "/screenshots-new/03-emergency-initial.png",
    desc: "Emergency tab initial state — engine badge (browser-only/companion), honesty banner, real client-side diagnosis card.",
    title: "Emergency — Initial",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/04-emergency-diagnosing.png",
    desc: "Recovery cycle started — state machine transitions idle → diagnosing → selecting. Real network probes fire.",
    title: "Emergency — Diagnosing",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/05-emergency-exhausted.png",
    desc: "All candidates tried, none verified — honest EXHAUSTED state with reason. NO fake 'connected'.",
    title: "Emergency — Exhausted (honest failure)",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/06-import-config-dialog.png",
    desc: "Import Config dialog — paste URI, optional TCP probe, validate structure + reachability (3 independent states).",
    title: "Emergency — Import Dialog",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/07-import-config-validated.png",
    desc: "Validated VLESS Reality config — STRUCT=valid, REACH=unreachable (honest), TUNNEL=not-attempted. Saved to IndexedDB.",
    title: "Emergency — Config Validated",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/25-emergency-full-page.png",
    desc: "Full Emergency view — all cards visible: honesty banner, diagnosis, state machine, candidates, log, danger zone.",
    title: "Emergency — Full Page",
    category: "Emergency",
  },
  {
    src: "/screenshots-new/26-emergency-recovery-exhausted.png",
    desc: "After Recover Connection — engine tried candidates, honest failure logged with NO CREDENTIALS badge.",
    title: "Emergency — Recovery Log",
    category: "Emergency",
  },

  // Account with template honesty
  {
    src: "/screenshots-new/12-account.png",
    desc: "Account view — FREE tier, manual config generator, downloads, referral. TEMPLATE ONLY badge visible.",
    title: "Account",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/13-account-config-generator.png",
    desc: "Config generator with honesty banner — 'NOT CONNECTABLE — sample credentials' clearly labeled.",
    title: "Account — Config Generator (honesty)",
    category: "Dashboard",
  },
  {
    src: "/screenshots-new/14-account-template-generated.png",
    desc: "Generated template config — red 'NOT CONNECTABLE — SAMPLE CREDENTIALS' bar + warning comment in the config text.",
    title: "Account — Template Generated",
    category: "Dashboard",
  },

  // Admin panel
  {
    src: "/screenshots-new/18-admin-login.png",
    desc: "Secure admin login — HttpOnly session cookie, password-based, 24h expiry. No API key in localStorage.",
    title: "Admin — Login",
    category: "Admin",
  },
  {
    src: "/screenshots-new/19-admin-dashboard-messages.png",
    desc: "Admin Messages tab — VIP requests, collaboration proposals, support tickets, bug reports with reply/archive actions.",
    title: "Admin — Messages",
    category: "Admin",
  },
  {
    src: "/screenshots-new/20-admin-users.png",
    desc: "Admin Users tab — all registered users with tier (free/VIP/admin), join date, admin approval flow.",
    title: "Admin — Users",
    category: "Admin",
  },
  {
    src: "/screenshots-new/21-admin-vip.png",
    desc: "Admin VIP Management — grant VIP access form (email + duration) + current VIP users list.",
    title: "Admin — VIP Management",
    category: "Admin",
  },
  {
    src: "/screenshots-new/22-admin-admins.png",
    desc: "Admin Admins tab — add new admin + current admins list with approval chain.",
    title: "Admin — Admins",
    category: "Admin",
  },

  // Chrome extension
  {
    src: "/screenshots-new/23-extension-popup.png",
    desc: "Chrome extension popup — Browser Proxy Mode banner (honest), local-xray server (rides on desktop companion), connect button.",
    title: "Chrome Extension — Popup",
    category: "Extension",
  },
  {
    src: "/screenshots-new/24-extension-options.png",
    desc: "Extension options — 8 security toggles, protocol radios, preferred region, Iran-resilience ladder, danger zone.",
    title: "Chrome Extension — Options",
    category: "Extension",
  },

  // Mobile
  {
    src: "/screenshots-new/16-mobile-connected.png",
    desc: "Mobile responsive — bottom tab bar, connect view, live metrics ticking at 390px width.",
    title: "Mobile — Connected",
    category: "Mobile",
  },
  {
    src: "/screenshots-new/17-mobile-emergency.png",
    desc: "Mobile Emergency tab — engine badge, honesty banner, diagnosis card all responsive at 390px.",
    title: "Mobile — Emergency",
    category: "Mobile",
  },
];

const CATEGORIES: Array<Shot["category"]> = [
  "Emergency",
  "Dashboard",
  "Admin",
  "Extension",
  "Mobile",
];

const CATEGORY_COLORS: Record<Shot["category"], string> = {
  Emergency: "#ff4d6d",
  Dashboard: "#00f0ff",
  Admin: "#8b5cf6",
  Extension: "#10d9a0",
  Mobile: "#ffb020",
};

const CATEGORY_LABELS: Record<Shot["category"], string> = {
  Emergency: "Emergency Connectivity (new)",
  Dashboard: "Dashboard & Landing",
  Admin: "Admin Panel",
  Extension: "Chrome Extension",
  Mobile: "Mobile Responsive",
};

export function NewScreenshotsGallery() {
  return (
    <section className="space-y-12">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#00f0ff]/10 border border-[#00f0ff]/30 text-[#00f0ff] text-xs tracking-widest uppercase">
          <GalleryHorizontalEnd className="w-3 h-3" />
          New Sections Gallery
        </div>
        <h2 className="text-3xl md:text-4xl font-bold text-[#eaf2ff]">
          Every new feature, captured
        </h2>
        <p className="text-[#8aa0c4] max-w-2xl mx-auto text-sm">
          Honest UI — every &quot;Connected&quot; state shown here is backed by
          real traffic verification. No fake success states, no simulated speeds.
        </p>
      </div>

      {CATEGORIES.map((cat) => {
        const shots = SHOTS.filter((s) => s.category === cat);
        if (shots.length === 0) return null;
        return (
          <div key={cat} className="space-y-4">
            <div className="flex items-center gap-3">
              <span
                className="w-2 h-8 rounded-full"
                style={{ background: CATEGORY_COLORS[cat] }}
              />
              <h3 className="text-xl font-semibold text-[#eaf2ff]">
                {CATEGORY_LABELS[cat]}
              </h3>
              <span className="text-xs text-[#5a6478]">
                {shots.length} screenshot{shots.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {shots.map((shot) => (
                <figure
                  key={shot.src}
                  className="group rounded-xl overflow-hidden border border-white/5 bg-[#0a1020] hover:border-[#00f0ff]/30 transition-colors"
                >
                  <div className="aspect-video overflow-hidden bg-[#050814]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={shot.src}
                      alt={shot.title}
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-300"
                      loading="lazy"
                    />
                  </div>
                  <figcaption className="p-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-[#eaf2ff] truncate">
                        {shot.title}
                      </h4>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider"
                        style={{
                          color: CATEGORY_COLORS[cat],
                          background: `${CATEGORY_COLORS[cat]}15`,
                        }}
                      >
                        {cat}
                      </span>
                    </div>
                    <p className="text-xs text-[#8aa0c4] leading-relaxed line-clamp-3">
                      {shot.desc}
                    </p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
