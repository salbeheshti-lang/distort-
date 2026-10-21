// DISTORT — global relay mesh seed data
// Includes Iran-resilient (stealth) nodes tuned for national-intranet scenarios.
//
// HONEST STATUS: The `*.distort.net` hostnames below are PLACEHOLDERS — they
// don't resolve in DNS and no server is deployed there yet. Every server is
// marked `online: false` with an honest note pointing users at the Community
// Mesh configs (imported via the Quick Connect flow / Connect tab). The
// Server List tab still shows them as a "world map" feature — the plan is to
// replace each placeholder with a real community-operated relay as the
// Distort mesh rolls out.

export type SeedServer = {
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
  note?: string;
};

const NOT_YET_DEPLOYED = "Distort managed node — not yet deployed. Use Quick Connect with Community Mesh configs instead.";

// 32 nodes across 26 countries. Stealth nodes are tuned to bypass DPI / national filtering.
// ALL marked offline honestly — see comment block at the top of this file.
export const SEED_SERVERS: SeedServer[] = [
  // --- Stealth / Iran-resilient core ---
  { code: "de-fra-01", country: "Germany", countryCode: "DE", city: "Frankfurt", flag: "🇩🇪", host: "de-fra-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "nl-ams-01", country: "Netherlands", countryCode: "NL", city: "Amsterdam", flag: "🇳🇱", host: "nl-ams-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "fi-hel-01", country: "Finland", countryCode: "FI", city: "Helsinki", flag: "🇫🇮", host: "fi-hel-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "fr-par-01", country: "France", countryCode: "FR", city: "Paris", flag: "🇫🇷", host: "fr-par-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "ch-zrh-01", country: "Switzerland", countryCode: "CH", city: "Zurich", flag: "🇨🇭", host: "ch-zrh-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },

  // --- Europe standard ---
  { code: "uk-lon-01", country: "United Kingdom", countryCode: "GB", city: "London", flag: "🇬🇧", host: "uk-lon-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },
  { code: "se-sto-01", country: "Sweden", countryCode: "SE", city: "Stockholm", flag: "🇸🇪", host: "se-sto-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },
  { code: "es-mad-01", country: "Spain", countryCode: "ES", city: "Madrid", flag: "🇪🇸", host: "es-mad-01.distort.net", port: 51820, protocols: ["wireguard", "trojan"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- North America ---
  { code: "us-nyc-01", country: "United States", countryCode: "US", city: "New York", flag: "🇺🇸", host: "us-nyc-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray", "trojan"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },
  { code: "us-lax-01", country: "United States", countryCode: "US", city: "Los Angeles", flag: "🇺🇸", host: "us-lax-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },
  { code: "ca-tor-01", country: "Canada", countryCode: "CA", city: "Toronto", flag: "🇨🇦", host: "ca-tor-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Asia ---
  { code: "sg-sin-01", country: "Singapore", countryCode: "SG", city: "Singapore", flag: "🇸🇬", host: "sg-sin-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 10000, downMbps: 10000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "jp-tyo-01", country: "Japan", countryCode: "JP", city: "Tokyo", flag: "🇯🇵", host: "jp-tyo-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "tr-ist-01", country: "Turkey", countryCode: "TR", city: "Istanbul", flag: "🇹🇷", host: "tr-ist-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "ae-dxb-01", country: "UAE", countryCode: "AE", city: "Dubai", flag: "🇦🇪", host: "ae-dxb-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "in-mum-01", country: "India", countryCode: "IN", city: "Mumbai", flag: "🇮🇳", host: "in-mum-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 5000, downMbps: 5000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Oceania ---
  { code: "au-syd-01", country: "Australia", countryCode: "AU", city: "Sydney", flag: "🇦🇺", host: "au-syd-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- South America ---
  { code: "br-sao-01", country: "Brazil", countryCode: "BR", city: "São Paulo", flag: "🇧🇷", host: "br-sao-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Africa ---
  { code: "za-jnb-01", country: "South Africa", countryCode: "ZA", city: "Johannesburg", flag: "🇿🇦", host: "za-jnb-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 1000, downMbps: 1000, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Middle East / neighbors ---
  { code: "ge-tbs-01", country: "Georgia", countryCode: "GE", city: "Tbilisi", flag: "🇬🇪", host: "ge-tbs-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "am-evn-01", country: "Armenia", countryCode: "AM", city: "Yerevan", flag: "🇦🇲", host: "am-evn-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 1000, downMbps: 1000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },

  // --- Premium tier (still free during beta) ---
  { code: "us-sea-01", country: "United States", countryCode: "US", city: "Seattle", flag: "🇺🇸", host: "us-sea-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 20000, downMbps: 20000, online: false, premium: true, stealth: false, note: NOT_YET_DEPLOYED },
  { code: "gb-man-01", country: "United Kingdom", countryCode: "GB", city: "Manchester", flag: "🇬🇧", host: "gb-man-01.distort.net", port: 51820, protocols: ["wireguard", "v2ray"], load: 0, ping: 0, upMbps: 20000, downMbps: 20000, online: false, premium: true, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Offline (realism) ---
  { code: "ru-mow-01", country: "Russia", countryCode: "RU", city: "Moscow", flag: "🇷🇺", host: "ru-mow-01.distort.net", port: 51820, protocols: ["wireguard"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: false, note: NOT_YET_DEPLOYED },

  // --- Extra stealth for hard-line regions ---
  { code: "lu-lux-01", country: "Luxembourg", countryCode: "LU", city: "Luxembourg", flag: "🇱🇺", host: "lu-lux-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "is-rey-01", country: "Iceland", countryCode: "IS", city: "Reykjavik", flag: "🇮🇸", host: "is-rey-01.distort.net", port: 8443, protocols: ["wireguard", "v2ray", "trojan"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "ee-tll-01", country: "Estonia", countryCode: "EE", city: "Tallinn", flag: "🇪🇪", host: "ee-tll-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "pl-waw-01", country: "Poland", countryCode: "PL", city: "Warsaw", flag: "🇵🇱", host: "pl-waw-01.distort.net", port: 8443, protocols: ["v2ray", "trojan", "shadowsocks"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "at-vie-01", country: "Austria", countryCode: "AT", city: "Vienna", flag: "🇦🇹", host: "at-vie-01.distort.net", port: 8443, protocols: ["v2ray", "trojan"], load: 0, ping: 0, upMbps: 2500, downMbps: 2500, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
  { code: "ir-nrt-relay", country: "Iran (Relay)", countryCode: "IR", city: "Tehran Relay", flag: "🇮🇷", host: "relay.distort.local", port: 8443, protocols: ["shadowsocks", "trojan"], load: 0, ping: 0, upMbps: 1000, downMbps: 1000, online: false, premium: false, stealth: true, note: NOT_YET_DEPLOYED },
];

export const PROTOCOLS = [
  {
    id: "wireguard",
    name: "WireGuard",
    description: "Modern, fast, audited. Best for stable networks.",
    speed: 95,
    resilience: 60,
    badge: "Fastest",
  },
  {
    id: "v2ray",
    name: "V2Ray (VMess)",
    description: "Pluggable transport. Disguises traffic as HTTPS.",
    speed: 80,
    resilience: 92,
    badge: "Stealth",
  },
  {
    id: "trojan",
    name: "Trojan",
    description: "Looks like normal TLS traffic. Defeats DPI.",
    speed: 82,
    resilience: 95,
    badge: "Anti-DPI",
  },
  {
    id: "shadowsocks",
    name: "Shadowsocks",
    description: "Lightweight SOCKS5 proxy with AEAD ciphers.",
    speed: 88,
    resilience: 78,
    badge: "Light",
  },
  {
    id: "ssh",
    name: "SSH Tunnel",
    description: "Last-resort fallback. Looks like remote shell.",
    speed: 50,
    resilience: 90,
    badge: "Fallback",
  },
] as const;
