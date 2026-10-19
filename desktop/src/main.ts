// DISTORT — Simple VPN client (like V2rayN architecture)
// Electron main process: directly spawns xray-core, sets system proxy
// NO Next.js server, NO Prisma, NO companion API — just Electron + xray

import { app, BrowserWindow, Tray, Menu, session, ipcMain, shell, nativeImage, dialog } from "electron";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import log from "electron-log";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const isDev = !!process.env.DISTORT_DEV;
const APP_VERSION = "2.0.0";

// Data directory: %APPDATA%\DISTORT on Windows
const DATA_DIR = process.platform === "win32"
  ? join(process.env.APPDATA || "", "DISTORT")
  : process.platform === "darwin"
  ? join(process.env.HOME || "", "Library", "Application Support", "DISTORT")
  : join(process.env.HOME || "", ".config", "DISTORT");

// Create data dir
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Log file
const LOG_DIR = join(DATA_DIR, "logs");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
log.transports.file.resolvePathFn = () => join(LOG_DIR, "main.log");
log.transports.file.level = "info";
log.transports.console.level = "info";

log.info("============================================================");
log.info(`DISTORT v${APP_VERSION} starting…`);
log.info(`Data dir: ${DATA_DIR}`);
log.info("============================================================");

// Config file (JSON, not SQLite)
const CONFIG_FILE = join(DATA_DIR, "configs.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// xray paths
function getXrayPath(): string {
  if (isDev) {
    return join(__dirname, "..", "resources", "bin", process.platform === "win32" ? "xray.exe" : "xray");
  }
  return join(process.resourcesPath, "bin", process.platform === "win32" ? "xray.exe" : "xray");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type VpnState = {
  connected: boolean;
  configUri: string | null;
  exitIp: string | null;
  startedAt: number | null;
};

type ConfigEntry = {
  uri: string;
  protocol: string;
  host: string;
  port: number;
  label: string;
  score: number;
  flags: string;
};

type Settings = {
  autoConnect: boolean;
  stealthMode: boolean;
  dnsLeakProtection: boolean;
  preferredProtocol: string;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let xrayProcess: ChildProcess | null = null;
let isQuitting = false;

// Load/save config
function loadConfigs(): ConfigEntry[] {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveConfigs(configs: ConfigEntry[]): void {
  try { writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2)); } catch {}
}

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...defaultSettings, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) };
    }
  } catch {}
  return defaultSettings;
}

function saveSettings(settings: Settings): void {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

const defaultSettings: Settings = {
  autoConnect: false,
  stealthMode: true,
  dnsLeakProtection: true,
  preferredProtocol: "auto",
};

// ---------------------------------------------------------------------------
// Config parser (inline — no external dependency)
// ---------------------------------------------------------------------------
function parseConfigUri(uri: string): ConfigEntry | null {
  try {
    const trimmed = uri.trim();
    let protocol = "";
    let host = "";
    let port = 0;
    let label = "";
    let score = 30;
    let flags: string[] = [];

    if (trimmed.startsWith("vless://")) {
      protocol = "vless";
      // vless://uuid@host:port?params#label
      const afterScheme = trimmed.slice(8);
      const atIdx = afterScheme.indexOf("@");
      const hashIdx = afterScheme.indexOf("#");
      const hostPort = afterScheme.slice(atIdx + 1, hashIdx > 0 ? hashIdx : undefined).split("?")[0];
      const [h, p] = hostPort.split(":");
      host = h; port = parseInt(p) || 443;
      if (hashIdx > 0) label = decodeURIComponent(afterScheme.slice(hashIdx + 1));

      const queryStr = afterScheme.split("?")[1]?.split("#")[0] || "";
      const params = new URLSearchParams(queryStr);
      const security = params.get("security") || "none";
      const network = params.get("type") || "tcp";
      const sni = params.get("sni") || "";

      if (security === "reality") { score += 35; flags.push("Reality"); }
      else if (security === "tls") { score += 25; flags.push("TLS"); }
      if (network === "grpc") { score += 14; flags.push("gRPC"); }
      if (network === "ws") { score += 12; flags.push("WS"); }
      if (sni) { score += 8; flags.push("SNI"); }
      if (params.get("flow") === "xtls-rprx-vision") { score += 12; flags.push("Vision"); }
    } else if (trimmed.startsWith("vmess://")) {
      protocol = "vmess";
      const b64 = trimmed.slice(8);
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      host = json.add || json.host || "";
      port = json.port || 443;
      label = json.ps || json.remark || `${protocol} ${host}:${port}`;
      const security = json.tls || "none";
      const network = json.net || "tcp";
      if (security === "tls") { score += 25; flags.push("TLS"); }
      if (network === "ws") { score += 12; flags.push("WS"); }
      if (network === "grpc") { score += 14; flags.push("gRPC"); }
    } else if (trimmed.startsWith("trojan://")) {
      protocol = "trojan";
      const url = new URL(trimmed);
      host = url.hostname;
      port = parseInt(url.port) || 443;
      label = url.hash ? decodeURIComponent(url.hash.slice(1)) : `trojan ${host}:${port}`;
      score += 25; flags.push("TLS");
      const sni = url.searchParams.get("sni");
      if (sni) { score += 8; flags.push("SNI"); }
    } else if (trimmed.startsWith("ss://")) {
      protocol = "ss";
      const url = new URL(trimmed);
      host = url.hostname;
      port = parseInt(url.port) || 8388;
      label = url.hash ? decodeURIComponent(url.hash.slice(1)) : `ss ${host}:${port}`;
    } else {
      return null;
    }

    return { uri: trimmed, protocol, host, port, label, score, flags: flags.join(",") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build xray config from URI
// ---------------------------------------------------------------------------
function buildXrayConfig(uri: string): object | null {
  const parsed = parseConfigUri(uri);
  if (!parsed) return null;

  const socksPort = 10808;
  const httpPort = 10809;

  const config: any = {
    log: { loglevel: "warning" },
    inbounds: [
      { tag: "socks-in", listen: "127.0.0.1", port: socksPort, protocol: "socks", settings: { auth: "noauth", udp: true } },
      { tag: "http-in", listen: "127.0.0.1", port: httpPort, protocol: "http", settings: {} },
    ],
    outbounds: [],
    routing: { rules: [] },
  };

  // Build outbound based on protocol
  if (parsed.protocol === "vless") {
    const url = new URL(uri);
    const uuid = url.username;
    const params = url.searchParams;
    const security = params.get("security") || "none";
    const network = params.get("type") || "tcp";

    const outbound: any = {
      tag: "proxy",
      protocol: "vless",
      settings: { vnext: [{ address: parsed.host, port: parsed.port, users: [{ id: uuid, encryption: "none", flow: params.get("flow") || "" }] }] },
      streamSettings: { network, security },
    };

    if (security === "reality") {
      outbound.streamSettings.realitySettings = {
        serverName: params.get("sni") || "",
        publicKey: params.get("pbk") || "",
        shortId: params.get("sid") || "",
        fingerprint: params.get("fp") || "chrome",
      };
    } else if (security === "tls") {
      outbound.streamSettings.tlsSettings = { serverName: params.get("sni") || "" };
    }

    if (network === "ws") {
      outbound.streamSettings.wsSettings = { path: params.get("path") || "/", headers: { Host: params.get("host") || "" } };
    } else if (network === "grpc") {
      outbound.streamSettings.grpcSettings = { serviceName: params.get("serviceName") || "" };
    }

    config.outbounds.push(outbound);
  } else if (parsed.protocol === "vmess") {
    const b64 = uri.slice(8);
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    const network = json.net || "tcp";
    const security = json.tls || "none";

    const outbound: any = {
      tag: "proxy",
      protocol: "vmess",
      settings: { vnext: [{ address: json.add, port: json.port, users: [{ id: json.id, alterId: json.aid || 0, security: "auto" }] }] },
      streamSettings: { network, security },
    };

    if (security === "tls") {
      outbound.streamSettings.tlsSettings = { serverName: json.sni || json.add };
    }
    if (network === "ws") {
      outbound.streamSettings.wsSettings = { path: json.path || "/", headers: { Host: json.host || json.add } };
    } else if (network === "grpc") {
      outbound.streamSettings.grpcSettings = { serviceName: json.path || "" };
    }

    config.outbounds.push(outbound);
  } else if (parsed.protocol === "trojan") {
    const url = new URL(uri);
    const password = url.username;
    const sni = url.searchParams.get("sni") || parsed.host;

    config.outbounds.push({
      tag: "proxy",
      protocol: "trojan",
      settings: { servers: [{ address: parsed.host, port: parsed.port, password }] },
      streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: sni } },
    });
  } else if (parsed.protocol === "ss") {
    const url = new URL(uri);
    const userInfo = atob(url.username);
    const [method, password] = userInfo.split(":");

    config.outbounds.push({
      tag: "proxy",
      protocol: "shadowsocks",
      settings: { servers: [{ address: parsed.host, port: parsed.port, method, password }] },
    });
  } else {
    return null;
  }

  // Direct outbound for local traffic
  config.outbounds.push({ tag: "direct", protocol: "freedom", settings: {} });
  config.outbounds.push({ tag: "block", protocol: "blackhole", settings: {} });

  // Routing: proxy everything
  config.routing.rules.push({ type: "field", outboundTag: "proxy" });

  // DNS
  config.dns = {
    servers: ["1.1.1.1", "9.9.9.9"],
    queryStrategy: "UseIP",
  };

  return config;
}

// ---------------------------------------------------------------------------
// VPN connect/disconnect
// ---------------------------------------------------------------------------
async function connectVpn(configUri: string): Promise<{ ok: boolean; error?: string }> {
  log.info(`[vpn] Connecting…`);

  // Stop existing
  if (xrayProcess) {
    try { xrayProcess.kill("SIGTERM"); } catch {}
    xrayProcess = null;
  }

  // Build config
  const config = buildXrayConfig(configUri);
  if (!config) {
    return { ok: false, error: "Could not parse config URI" };
  }

  // Write config to temp file
  const configPath = join(DATA_DIR, "xray-config.json");
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e: any) {
    return { ok: false, error: `Failed to write config: ${e.message}` };
  }

  // Spawn xray
  const xrayPath = getXrayPath();
  if (!existsSync(xrayPath)) {
    return { ok: false, error: `xray not found at ${xrayPath}` };
  }

  log.info(`[vpn] Spawning xray from ${xrayPath}`);

  try {
    xrayProcess = spawn(xrayPath, ["run", "-c", configPath], {
      cwd: dirname(xrayPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    xrayProcess.stdout?.on("data", (data) => {
      log.info(`[xray] ${data.toString().trim()}`);
    });
    xrayProcess.stderr?.on("data", (data) => {
      log.error(`[xray] ${data.toString().trim()}`);
    });
    xrayProcess.on("exit", (code) => {
      log.info(`[xray] exited with code ${code}`);
      xrayProcess = null;
      // Clear proxy
      session.defaultSession.setProxy({ proxyRules: "" }).catch(() => {});
      mainWindow?.webContents.send("vpn:disconnected");
    });

    // Wait for xray to start
    await new Promise((r) => setTimeout(r, 1500));

    if (!xrayProcess || xrayProcess.killed) {
      return { ok: false, error: "xray exited immediately — check config validity" };
    }

    // Set system proxy (browser traffic goes through SOCKS5)
    await session.defaultSession.setProxy({
      proxyRules: "socks5://127.0.0.1:10808",
    });
    log.info("[vpn] Browser proxy set to socks5://127.0.0.1:10808");

    // Also set env proxy for Next.js server (if running)
    process.env.HTTP_PROXY = "http://127.0.0.1:10809";
    process.env.HTTPS_PROXY = "http://127.0.0.1:10809";

    log.info("[vpn] Connected successfully");
    mainWindow?.webContents.send("vpn:connected", { configUri: null });
    return { ok: true };
  } catch (e: any) {
    log.error(`[vpn] Failed to spawn xray: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function disconnectVpn(): Promise<void> {
  log.info("[vpn] Disconnecting…");

  // Clear proxy
  await session.defaultSession.setProxy({ proxyRules: "" }).catch(() => {});
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;

  if (xrayProcess) {
    try {
      xrayProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!xrayProcess.killed) xrayProcess.kill("SIGKILL");
    } catch {}
    xrayProcess = null;
  }

  mainWindow?.webContents.send("vpn:disconnected");
  log.info("[vpn] Disconnected");
}

// ---------------------------------------------------------------------------
// Fetch subscription (configs from URL)
// ---------------------------------------------------------------------------
async function fetchSubscription(url: string): Promise<{ ok: boolean; configs?: ConfigEntry[]; count?: number; error?: string }> {
  try {
    log.info(`[sub] Fetching: ${url}`);
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "DISTORT/2.0" },
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const text = await resp.text();
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 10);

    const configs: ConfigEntry[] = [];
    for (const line of lines) {
      const parsed = parseConfigUri(line);
      if (parsed) configs.push(parsed);
    }

    // Merge with existing configs (dedup by URI)
    const existing = loadConfigs();
    const existingUris = new Set(existing.map(c => c.uri));
    for (const cfg of configs) {
      if (!existingUris.has(cfg.uri)) {
        existing.push(cfg);
      }
    }
    saveConfigs(existing);

    log.info(`[sub] Fetched ${configs.length} configs (total: ${existing.length})`);
    return { ok: true, configs: existing, count: configs.length };
  } catch (e: any) {
    log.error(`[sub] Failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Fetch IP info (server-side, no CORS)
// ---------------------------------------------------------------------------
async function fetchIpInfo(): Promise<{ ip: string; country: string | null; city: string | null; isp: string | null }> {
  const providers = [
    { url: "https://ipwho.is/", map: (d: any) => ({ ip: d.ip, country: d.country, city: d.city, isp: d.connection?.isp }) },
    { url: "https://api.ipify.org?format=json", map: (d: any) => ({ ip: d.ip, country: null, city: null, isp: null }) },
  ];

  for (const p of providers) {
    try {
      const resp = await fetch(p.url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const mapped = p.map(data);
        if (mapped.ip) return mapped;
      }
    } catch {}
  }
  throw new Error("Could not fetch IP info");
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: "#050814",
    title: "DISTORT",
    show: false,
    icon: join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Load UI
  const uiPath = isDev
    ? `http://localhost:3000`
    : `file://${join(__dirname, "..", "ui", "index.html")}`;

  log.info(`[ui] Loading from: ${uiPath}`);
  mainWindow.loadURL(uiPath).catch((err) => {
    log.error(`[ui] Failed to load: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray(): void {
  let icon = nativeImage.createFromPath(join(__dirname, "..", "build", "icon.png"));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("DISTORT");

  const menu = Menu.buildFromTemplate([
    { label: `DISTORT v${APP_VERSION}`, enabled: false },
    { type: "separator" },
    { label: "Show", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle("vpn:connect", async (_e, configUri: string) => {
  return connectVpn(configUri);
});

ipcMain.handle("vpn:disconnect", async () => {
  await disconnectVpn();
  return { ok: true };
});

ipcMain.handle("configs:get", async () => {
  return loadConfigs();
});

ipcMain.handle("configs:add", async (_e, uri: string) => {
  const parsed = parseConfigUri(uri);
  if (!parsed) return { ok: false, error: "Could not parse URI" };
  const configs = loadConfigs();
  if (!configs.find(c => c.uri === parsed.uri)) {
    configs.push(parsed);
    saveConfigs(configs);
  }
  return { ok: true, config: parsed };
});

ipcMain.handle("configs:delete", async (_e, uri: string) => {
  const configs = loadConfigs().filter(c => c.uri !== uri);
  saveConfigs(configs);
  return { ok: true };
});

ipcMain.handle("subscription:fetch", async (_e, url: string) => {
  return fetchSubscription(url);
});

ipcMain.handle("ip:info", async () => {
  try {
    return { ok: true, ...(await fetchIpInfo()) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("settings:get", async () => {
  return loadSettings();
});

ipcMain.handle("settings:save", async (_e, settings: Settings) => {
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle("app:version", async () => APP_VERSION);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  createTray();

  // Auto-fetch default Iran subscription on first run
  if (loadConfigs().length === 0) {
    log.info("[init] First run — fetching default Iran subscription");
    fetchSubscription("https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt")
      .then((r) => {
        if (r.ok) {
          log.info(`[init] Auto-fetched ${r.count} configs`);
          mainWindow?.webContents.send("configs:updated");
        }
      })
      .catch((e) => log.warn(`[init] Auto-fetch failed: ${e.message}`));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (e) => {
  if (xrayProcess) {
    e.preventDefault();
    await disconnectVpn();
    isQuitting = true;
    app.quit();
  }
});
