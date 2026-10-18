-- DISTORT — Database seed data (SQL)
-- Inserts the 30 default VPN servers + admin user on first run.
-- Run AFTER schema.sql creates the tables.

-- Default UserSetting (id="default")
INSERT INTO UserSetting (
  id, protocol, killSwitch, dnsLeakProtection, ipv6LeakProtection,
  splitTunneling, obfuscation, autoConnect, blockTrackers, blockAds,
  stealthMode, preferredRegion, mtu, dnsServers, updatedAt
) VALUES (
  'default', 'wireguard', 1, 1, 1, 0, 1, 1, 1, 0, 1, 'auto', 1420,
  '1.1.1.1,9.9.9.9', datetime('now')
);

-- Founder admin user (with default password — user can change it later via /admin)
-- Default password: distort2026
-- Hash = SHA256(password + SESSION_SECRET)
-- SESSION_SECRET = "distort-desktop-session-secret-local" (set in desktop/src/main.ts)
INSERT INTO User (id, email, name, tier, isAdmin, passwordHash, createdAt, updatedAt)
VALUES (
  lower(hex(randomblob(12))),
  'founder@distort.app', 'Distort Founder', 'vip', 1,
  'ec1c1b63a7b395d36de9231364cb8b8e9b3b2c6825b2f0d5d1f29e9f4436c822',
  datetime('now'), datetime('now')
);

-- 30 VPN servers across 25+ countries (from src/lib/vpn-data.ts)
INSERT INTO VpnServer (id, code, country, countryCode, city, flag, host, port, protocols, load, ping, upMbps, downMbps, online, premium, stealth, note, createdAt, updatedAt) VALUES
(lower(hex(randomblob(12))), 'ir-nrt-relay', 'Iran (Relay)', 'IR', 'Tehran Relay', '🇮🇷', 'relay.distort.local', 8443, 'shadowsocks,trojan', 35, 6, 1000, 1000, 1, 0, 1, 'Domestic relay · only routes to borders, no exit', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'tr-ist-01', 'Turkey', 'TR', 'Istanbul', '🇹🇷', 'tr-ist-01.distort.net', 8443, 'v2ray,trojan,shadowsocks', 24, 18, 2500, 2500, 1, 0, 1, 'Closest low-latency to Iran · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ae-dxb-01', 'UAE', 'AE', 'Dubai', '🇦🇪', 'ae-dxb-01.distort.net', 8443, 'v2ray,trojan,shadowsocks', 16, 24, 5000, 5000, 1, 0, 1, 'Gulf hub · obfuscated', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'am-evn-01', 'Armenia', 'AM', 'Yerevan', '🇦🇲', 'am-evn-01.distort.net', 8443, 'v2ray,trojan,shadowsocks', 7, 28, 1000, 1000, 1, 0, 1, 'Neighbor node · low-latency from Iran', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ge-tbs-01', 'Georgia', 'GE', 'Tbilisi', '🇬🇪', 'ge-tbs-01.distort.net', 8443, 'v2ray,trojan,shadowsocks', 11, 32, 1000, 1000, 1, 0, 1, 'Caucasus gateway · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'de-fra-01', 'Germany', 'DE', 'Frankfurt', '🇩🇪', 'de-fra-01.distort.net', 8443, 'wireguard,v2ray,trojan,shadowsocks', 18, 42, 10000, 10000, 1, 0, 1, '10Gbps backbone · anti-censor ready', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'fr-par-01', 'France', 'FR', 'Paris', '🇫🇷', 'fr-par-01.distort.net', 8443, 'wireguard,v2ray,trojan,shadowsocks', 26, 44, 10000, 10000, 1, 0, 1, 'CDN-fronted entry · DPI bypass', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'nl-ams-01', 'Netherlands', 'NL', 'Amsterdam', '🇳🇱', 'nl-ams-01.distort.net', 8443, 'wireguard,v2ray,trojan,shadowsocks', 22, 48, 10000, 10000, 1, 0, 1, 'Obfuscated TLS front · Iran optimized', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'lu-lux-01', 'Luxembourg', 'LU', 'Luxembourg', '🇱🇺', 'lu-lux-01.distort.net', 8443, 'wireguard,v2ray,trojan', 6, 50, 1000, 1000, 1, 0, 1, 'Quiet jurisdiction · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'at-vie-01', 'Austria', 'AT', 'Vienna', '🇦🇹', 'at-vie-01.distort.net', 8443, 'v2ray,trojan', 10, 50, 1000, 1000, 1, 0, 1, 'Stealth · CDN-fronted', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ch-zrh-01', 'Switzerland', 'CH', 'Zurich', '🇨🇭', 'ch-zrh-01.distort.net', 8443, 'wireguard,v2ray,trojan', 9, 52, 5000, 5000, 1, 0, 1, 'Privacy jurisdiction · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'pl-waw-01', 'Poland', 'PL', 'Warsaw', '🇵🇱', 'pl-waw-01.distort.net', 8443, 'v2ray,trojan', 13, 54, 1000, 1000, 1, 0, 1, 'Central Europe · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'fi-hel-01', 'Finland', 'FI', 'Helsinki', '🇫🇮', 'fi-hel-01.distort.net', 8443, 'wireguard,v2ray,trojan', 12, 55, 5000, 5000, 1, 0, 1, 'Low-latency to MENA · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'uk-lon-01', 'United Kingdom', 'GB', 'London', '🇬🇧', 'uk-lon-01.distort.net', 8443, 'wireguard,v2ray,trojan', 31, 58, 5000, 5000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ee-tll-01', 'Estonia', 'EE', 'Tallinn', '🇪🇪', 'ee-tll-01.distort.net', 8443, 'v2ray,trojan', 8, 58, 1000, 1000, 1, 0, 1, 'Baltic stealth node', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'es-mad-01', 'Spain', 'ES', 'Madrid', '🇪🇸', 'es-mad-01.distort.net', 8443, 'wireguard,v2ray', 17, 60, 2000, 2000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'se-sto-01', 'Sweden', 'SE', 'Stockholm', '🇸🇪', 'se-sto-01.distort.net', 8443, 'wireguard,v2ray,trojan', 14, 62, 2000, 2000, 1, 0, 0, 'Privacy-friendly jurisdiction', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'gb-man-01', 'United Kingdom', 'GB', 'Manchester', '🇬🇧', 'gb-man-01.distort.net', 8443, 'wireguard,v2ray', 11, 62, 1000, 1000, 1, 0, 0, 'Beta node', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'is-rey-01', 'Iceland', 'IS', 'Reykjavik', '🇮🇸', 'is-rey-01.distort.net', 8443, 'v2ray,trojan', 4, 70, 1000, 1000, 1, 0, 1, 'Strong privacy law · stealth', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'in-mum-01', 'India', 'IN', 'Mumbai', '🇮🇳', 'in-mum-01.distort.net', 8443, 'wireguard,v2ray', 27, 78, 2000, 2000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'sg-sin-01', 'Singapore', 'SG', 'Singapore', '🇸🇬', 'sg-sin-01.distort.net', 8443, 'v2ray,trojan,shadowsocks', 28, 88, 5000, 5000, 1, 0, 1, 'Asia hub · stealth for censored regions', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'jp-tyo-01', 'Japan', 'JP', 'Tokyo', '🇯🇵', 'jp-tyo-01.distort.net', 8443, 'v2ray,trojan', 21, 95, 5000, 5000, 1, 0, 1, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'us-nyc-01', 'United States', 'US', 'New York', '🇺🇸', 'us-nyc-01.distort.net', 8443, 'wireguard,v2ray,trojan', 38, 110, 10000, 10000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ca-tor-01', 'Canada', 'CA', 'Toronto', '🇨🇦', 'ca-tor-01.distort.net', 8443, 'wireguard,v2ray', 19, 120, 2000, 2000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'us-lax-01', 'United States', 'US', 'Los Angeles', '🇺🇸', 'us-lax-01.distort.net', 8443, 'wireguard,v2ray', 33, 140, 5000, 5000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'us-sea-01', 'United States', 'US', 'Seattle', '🇺🇸', 'us-sea-01.distort.net', 8443, 'wireguard,v2ray', 9, 150, 20000, 20000, 1, 1, 0, '20Gbps · beta-early-access', datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'za-jnb-01', 'South Africa', 'ZA', 'Johannesburg', '🇿🇦', 'za-jnb-01.distort.net', 8443, 'wireguard,v2ray', 8, 160, 1000, 1000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'br-sao-01', 'Brazil', 'BR', 'São Paulo', '🇧🇷', 'br-sao-01.distort.net', 8443, 'wireguard,v2ray', 15, 180, 2000, 2000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'au-syd-01', 'Australia', 'AU', 'Sydney', '🇦🇺', 'au-syd-01.distort.net', 8443, 'wireguard,v2ray', 12, 210, 2000, 2000, 1, 0, 0, NULL, datetime('now'), datetime('now')),
(lower(hex(randomblob(12))), 'ru-mow-01', 'Russia', 'RU', 'Moscow', '🇷🇺', 'ru-mow-01.distort.net', 8443, 'wireguard,v2ray', 0, 0, 1000, 1000, 0, 0, 0, 'Maintenance', datetime('now'), datetime('now'));

-- Community Mesh subscription (Iran config collector)
INSERT INTO Subscription (id, label, url, kind, enabled, intervalMin, lastCount, createdAt, updatedAt)
VALUES (
  lower(hex(randomblob(12))),
  'Iran Config Collector (Milad Tahanian)',
  'https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt',
  'community', 1, 60, 0, datetime('now'), datetime('now')
);
