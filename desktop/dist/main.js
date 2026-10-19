"use strict";
// DISTORT — Simple VPN client (like V2rayN architecture)
// Electron main process: directly spawns xray-core, sets system proxy
// NO Next.js server, NO Prisma, NO companion API — just Electron + xray
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const electron_log_1 = __importDefault(require("electron-log"));
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const isDev = !!process.env.DISTORT_DEV;
const APP_VERSION = "2.0.3";
// Data directory: %APPDATA%\DISTORT on Windows
const DATA_DIR = process.platform === "win32"
    ? (0, path_1.join)(process.env.APPDATA || "", "DISTORT")
    : process.platform === "darwin"
        ? (0, path_1.join)(process.env.HOME || "", "Library", "Application Support", "DISTORT")
        : (0, path_1.join)(process.env.HOME || "", ".config", "DISTORT");
// Create data dir
try {
    (0, fs_1.mkdirSync)(DATA_DIR, { recursive: true });
}
catch { }
// Log file
const LOG_DIR = (0, path_1.join)(DATA_DIR, "logs");
try {
    (0, fs_1.mkdirSync)(LOG_DIR, { recursive: true });
}
catch { }
electron_log_1.default.transports.file.resolvePathFn = () => (0, path_1.join)(LOG_DIR, "main.log");
electron_log_1.default.transports.file.level = "info";
electron_log_1.default.transports.console.level = "info";
electron_log_1.default.info("============================================================");
electron_log_1.default.info(`DISTORT v${APP_VERSION} starting…`);
electron_log_1.default.info(`Data dir: ${DATA_DIR}`);
electron_log_1.default.info("============================================================");
// Config file (JSON, not SQLite)
const CONFIG_FILE = (0, path_1.join)(DATA_DIR, "configs.json");
const SETTINGS_FILE = (0, path_1.join)(DATA_DIR, "settings.json");
const STATS_FILE = (0, path_1.join)(DATA_DIR, "stats.json");
// xray paths
function getXrayPath() {
    if (isDev) {
        return (0, path_1.join)(__dirname, "..", "resources", "bin", process.platform === "win32" ? "xray.exe" : "xray");
    }
    return (0, path_1.join)(process.resourcesPath, "bin", process.platform === "win32" ? "xray.exe" : "xray");
}
let mainWindow = null;
let tray = null;
let xrayProcess = null;
let isQuitting = false;
// Load/save config
function loadConfigs() {
    try {
        if ((0, fs_1.existsSync)(CONFIG_FILE)) {
            return JSON.parse((0, fs_1.readFileSync)(CONFIG_FILE, "utf-8"));
        }
    }
    catch { }
    return [];
}
function saveConfigs(configs) {
    try {
        (0, fs_1.writeFileSync)(CONFIG_FILE, JSON.stringify(configs, null, 2));
    }
    catch { }
}
function loadSettings() {
    try {
        if ((0, fs_1.existsSync)(SETTINGS_FILE)) {
            return { ...defaultSettings, ...JSON.parse((0, fs_1.readFileSync)(SETTINGS_FILE, "utf-8")) };
        }
    }
    catch { }
    return defaultSettings;
}
function saveSettings(settings) {
    try {
        (0, fs_1.writeFileSync)(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
    catch { }
}
const defaultSettings = {
    autoConnect: false,
    stealthMode: true,
    dnsLeakProtection: true,
    preferredProtocol: "auto",
};
// ---------------------------------------------------------------------------
// Config parser (inline — no external dependency)
// ---------------------------------------------------------------------------
function parseConfigUri(uri) {
    try {
        const trimmed = uri.trim();
        let protocol = "";
        let host = "";
        let port = 0;
        let label = "";
        let score = 30;
        let flags = [];
        if (trimmed.startsWith("vless://")) {
            protocol = "vless";
            // vless://uuid@host:port?params#label
            const afterScheme = trimmed.slice(8);
            const atIdx = afterScheme.indexOf("@");
            const hashIdx = afterScheme.indexOf("#");
            const hostPort = afterScheme.slice(atIdx + 1, hashIdx > 0 ? hashIdx : undefined).split("?")[0];
            const [h, p] = hostPort.split(":");
            host = h;
            port = parseInt(p) || 443;
            if (hashIdx > 0)
                label = decodeURIComponent(afterScheme.slice(hashIdx + 1));
            const queryStr = afterScheme.split("?")[1]?.split("#")[0] || "";
            const params = new URLSearchParams(queryStr);
            const security = params.get("security") || "none";
            const network = params.get("type") || "tcp";
            const sni = params.get("sni") || "";
            if (security === "reality") {
                score += 35;
                flags.push("Reality");
            }
            else if (security === "tls") {
                score += 25;
                flags.push("TLS");
            }
            if (network === "grpc") {
                score += 14;
                flags.push("gRPC");
            }
            if (network === "ws") {
                score += 12;
                flags.push("WS");
            }
            if (sni) {
                score += 8;
                flags.push("SNI");
            }
            if (params.get("flow") === "xtls-rprx-vision") {
                score += 12;
                flags.push("Vision");
            }
        }
        else if (trimmed.startsWith("vmess://")) {
            protocol = "vmess";
            const b64 = trimmed.slice(8);
            const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
            host = json.add || json.host || "";
            port = json.port || 443;
            label = json.ps || json.remark || `${protocol} ${host}:${port}`;
            const security = json.tls || "none";
            const network = json.net || "tcp";
            if (security === "tls") {
                score += 25;
                flags.push("TLS");
            }
            if (network === "ws") {
                score += 12;
                flags.push("WS");
            }
            if (network === "grpc") {
                score += 14;
                flags.push("gRPC");
            }
        }
        else if (trimmed.startsWith("trojan://")) {
            protocol = "trojan";
            const url = new URL(trimmed);
            host = url.hostname;
            port = parseInt(url.port) || 443;
            label = url.hash ? decodeURIComponent(url.hash.slice(1)) : `trojan ${host}:${port}`;
            score += 25;
            flags.push("TLS");
            const sni = url.searchParams.get("sni");
            if (sni) {
                score += 8;
                flags.push("SNI");
            }
        }
        else if (trimmed.startsWith("ss://")) {
            protocol = "ss";
            const url = new URL(trimmed);
            host = url.hostname;
            port = parseInt(url.port) || 8388;
            label = url.hash ? decodeURIComponent(url.hash.slice(1)) : `ss ${host}:${port}`;
        }
        else {
            return null;
        }
        return { uri: trimmed, protocol, host, port, label, score, flags: flags.join(",") };
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Build xray config from URI
// ---------------------------------------------------------------------------
function buildXrayConfig(uri) {
    const parsed = parseConfigUri(uri);
    if (!parsed)
        return null;
    const socksPort = 10808;
    const httpPort = 10809;
    const config = {
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
        const outbound = {
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
        }
        else if (security === "tls") {
            outbound.streamSettings.tlsSettings = { serverName: params.get("sni") || "" };
        }
        if (network === "ws") {
            outbound.streamSettings.wsSettings = { path: params.get("path") || "/", headers: { Host: params.get("host") || "" } };
        }
        else if (network === "grpc") {
            outbound.streamSettings.grpcSettings = { serviceName: params.get("serviceName") || "" };
        }
        config.outbounds.push(outbound);
    }
    else if (parsed.protocol === "vmess") {
        const b64 = uri.slice(8);
        const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
        const network = json.net || "tcp";
        const security = json.tls || "none";
        const outbound = {
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
        }
        else if (network === "grpc") {
            outbound.streamSettings.grpcSettings = { serviceName: json.path || "" };
        }
        config.outbounds.push(outbound);
    }
    else if (parsed.protocol === "trojan") {
        const url = new URL(uri);
        const password = url.username;
        const sni = url.searchParams.get("sni") || parsed.host;
        config.outbounds.push({
            tag: "proxy",
            protocol: "trojan",
            settings: { servers: [{ address: parsed.host, port: parsed.port, password }] },
            streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: sni } },
        });
    }
    else if (parsed.protocol === "ss") {
        const url = new URL(uri);
        const userInfo = atob(url.username);
        const [method, password] = userInfo.split(":");
        config.outbounds.push({
            tag: "proxy",
            protocol: "shadowsocks",
            settings: { servers: [{ address: parsed.host, port: parsed.port, method, password }] },
        });
    }
    else {
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
async function connectVpn(configUri) {
    electron_log_1.default.info(`[vpn] Connecting…`);
    // Stop existing
    if (xrayProcess) {
        try {
            xrayProcess.kill("SIGTERM");
        }
        catch { }
        xrayProcess = null;
    }
    // Build config
    const config = buildXrayConfig(configUri);
    if (!config) {
        return { ok: false, error: "Could not parse config URI" };
    }
    // Write config to temp file
    const configPath = (0, path_1.join)(DATA_DIR, "xray-config.json");
    try {
        (0, fs_1.writeFileSync)(configPath, JSON.stringify(config, null, 2));
    }
    catch (e) {
        return { ok: false, error: `Failed to write config: ${e.message}` };
    }
    // Spawn xray
    const xrayPath = getXrayPath();
    if (!(0, fs_1.existsSync)(xrayPath)) {
        return { ok: false, error: `xray not found at ${xrayPath}` };
    }
    electron_log_1.default.info(`[vpn] Spawning xray from ${xrayPath}`);
    try {
        xrayProcess = (0, child_process_1.spawn)(xrayPath, ["run", "-c", configPath], {
            cwd: (0, path_1.dirname)(xrayPath),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        xrayProcess.stdout?.on("data", (data) => {
            electron_log_1.default.info(`[xray] ${data.toString().trim()}`);
        });
        xrayProcess.stderr?.on("data", (data) => {
            electron_log_1.default.error(`[xray] ${data.toString().trim()}`);
        });
        xrayProcess.on("exit", (code) => {
            electron_log_1.default.info(`[xray] exited with code ${code}`);
            xrayProcess = null;
            // Clear proxy
            electron_1.session.defaultSession.setProxy({ proxyRules: "" }).catch(() => { });
            mainWindow?.webContents.send("vpn:disconnected");
        });
        // Wait for xray to start
        await new Promise((r) => setTimeout(r, 1500));
        if (!xrayProcess || xrayProcess.killed) {
            return { ok: false, error: "xray exited immediately — check config validity" };
        }
        // Set system proxy (browser traffic goes through SOCKS5)
        await electron_1.session.defaultSession.setProxy({
            proxyRules: "socks5://127.0.0.1:10808",
        });
        electron_log_1.default.info("[vpn] Browser proxy set to socks5://127.0.0.1:10808");
        // Also set env proxy for Next.js server (if running)
        process.env.HTTP_PROXY = "http://127.0.0.1:10809";
        process.env.HTTPS_PROXY = "http://127.0.0.1:10809";
        electron_log_1.default.info("[vpn] Connected successfully");
        mainWindow?.webContents.send("vpn:connected", { configUri: null });
        return { ok: true };
    }
    catch (e) {
        electron_log_1.default.error(`[vpn] Failed to spawn xray: ${e.message}`);
        return { ok: false, error: e.message };
    }
}
async function disconnectVpn() {
    electron_log_1.default.info("[vpn] Disconnecting…");
    // Clear proxy
    await electron_1.session.defaultSession.setProxy({ proxyRules: "" }).catch(() => { });
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    if (xrayProcess) {
        try {
            xrayProcess.kill("SIGTERM");
            await new Promise((r) => setTimeout(r, 500));
            if (!xrayProcess.killed)
                xrayProcess.kill("SIGKILL");
        }
        catch { }
        xrayProcess = null;
    }
    mainWindow?.webContents.send("vpn:disconnected");
    electron_log_1.default.info("[vpn] Disconnected");
}
// ---------------------------------------------------------------------------
// Fetch subscription (configs from URL)
// ---------------------------------------------------------------------------
async function fetchSubscription(url) {
    try {
        electron_log_1.default.info(`[sub] Fetching: ${url}`);
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            headers: { "User-Agent": "DISTORT/2.0" },
        });
        if (!resp.ok) {
            return { ok: false, error: `HTTP ${resp.status}` };
        }
        const text = await resp.text();
        const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 10);
        const configs = [];
        for (const line of lines) {
            const parsed = parseConfigUri(line);
            if (parsed)
                configs.push(parsed);
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
        electron_log_1.default.info(`[sub] Fetched ${configs.length} configs (total: ${existing.length})`);
        return { ok: true, configs: existing, count: configs.length };
    }
    catch (e) {
        electron_log_1.default.error(`[sub] Failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
}
// ---------------------------------------------------------------------------
// Fetch IP info (server-side, no CORS)
// ---------------------------------------------------------------------------
async function fetchIpInfo() {
    const providers = [
        { url: "https://ipwho.is/", map: (d) => ({ ip: d.ip, country: d.country, city: d.city, isp: d.connection?.isp }) },
        { url: "https://api.ipify.org?format=json", map: (d) => ({ ip: d.ip, country: null, city: null, isp: null }) },
    ];
    for (const p of providers) {
        try {
            const resp = await fetch(p.url, { signal: AbortSignal.timeout(5000) });
            if (resp.ok) {
                const data = await resp.json();
                const mapped = p.map(data);
                if (mapped.ip)
                    return mapped;
            }
        }
        catch { }
    }
    throw new Error("Could not fetch IP info");
}
// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 900,
        height: 600,
        minWidth: 700,
        minHeight: 500,
        backgroundColor: "#050814",
        title: "DISTORT",
        show: false,
        icon: (0, path_1.join)(__dirname, "..", "build", "icon.png"),
        webPreferences: {
            preload: (0, path_1.join)(__dirname, "preload.js"),
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
        : `file://${(0, path_1.join)(__dirname, "..", "ui", "index.html")}`;
    electron_log_1.default.info(`[ui] Loading from: ${uiPath}`);
    mainWindow.loadURL(uiPath).catch((err) => {
        electron_log_1.default.error(`[ui] Failed to load: ${err.message}`);
    });
}
// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
    let icon = electron_1.nativeImage.createFromPath((0, path_1.join)(__dirname, "..", "build", "icon.png"));
    if (icon.isEmpty())
        icon = electron_1.nativeImage.createEmpty();
    tray = new electron_1.Tray(icon);
    tray.setToolTip("DISTORT");
    const menu = electron_1.Menu.buildFromTemplate([
        { label: `DISTORT v${APP_VERSION}`, enabled: false },
        { type: "separator" },
        { label: "Show", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { label: "Quit", click: () => { isQuitting = true; electron_1.app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
}
// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
electron_1.ipcMain.handle("vpn:connect", async (_e, configUri) => {
    return connectVpn(configUri);
});
electron_1.ipcMain.handle("vpn:disconnect", async () => {
    await disconnectVpn();
    return { ok: true };
});
electron_1.ipcMain.handle("configs:get", async () => {
    return loadConfigs();
});
electron_1.ipcMain.handle("configs:add", async (_e, uri) => {
    const parsed = parseConfigUri(uri);
    if (!parsed)
        return { ok: false, error: "Could not parse URI" };
    const configs = loadConfigs();
    if (!configs.find(c => c.uri === parsed.uri)) {
        configs.push(parsed);
        saveConfigs(configs);
    }
    return { ok: true, config: parsed };
});
electron_1.ipcMain.handle("configs:delete", async (_e, uri) => {
    const configs = loadConfigs().filter(c => c.uri !== uri);
    saveConfigs(configs);
    return { ok: true };
});
electron_1.ipcMain.handle("subscription:fetch", async (_e, url) => {
    return fetchSubscription(url);
});
electron_1.ipcMain.handle("ip:info", async () => {
    try {
        return { ok: true, ...(await fetchIpInfo()) };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
});
electron_1.ipcMain.handle("settings:get", async () => {
    return loadSettings();
});
electron_1.ipcMain.handle("settings:save", async (_e, settings) => {
    saveSettings(settings);
    return { ok: true };
});
electron_1.ipcMain.handle("app:version", async () => APP_VERSION);
// Open external links in system browser
electron_1.ipcMain.handle("shell:openExternal", async (_e, url) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
        electron_1.shell.openExternal(url);
    }
    return { ok: true };
});
// ---------------------------------------------------------------------------
// Speed test (real download through proxy)
// ---------------------------------------------------------------------------
electron_1.ipcMain.handle("speed:test", async () => {
    try {
        // Download a 10MB test file through the proxy
        const testUrls = [
            "https://speed.cloudflare.com/__down?bytes=10000000",
            "https://www.google.com/generate_204",
        ];
        for (const url of testUrls) {
            try {
                const start = Date.now();
                const resp = await fetch(url, {
                    signal: AbortSignal.timeout(15000),
                });
                if (!resp.ok)
                    continue;
                const buf = await resp.arrayBuffer();
                const elapsed = (Date.now() - start) / 1000;
                const mbps = (buf.byteLength / 1024 / 1024 / elapsed).toFixed(1);
                electron_log_1.default.info(`[speed] ${url}: ${mbps} Mbps (${buf.byteLength} bytes in ${elapsed}s)`);
                return { ok: true, downloadMbps: parseFloat(mbps), pingMs: Math.round(elapsed * 1000) };
            }
            catch (e) {
                // try next URL
            }
        }
        return { ok: false, error: "Speed test failed — no test server responded" };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
});
// ---------------------------------------------------------------------------
// Tunnel status (is xray running?)
// ---------------------------------------------------------------------------
electron_1.ipcMain.handle("tunnel:status", async () => {
    return {
        running: xrayProcess !== null && !xrayProcess.killed,
        connected: xrayProcess !== null && !xrayProcess.killed,
    };
});
function loadStats() {
    try {
        if ((0, fs_1.existsSync)(STATS_FILE)) {
            return JSON.parse((0, fs_1.readFileSync)(STATS_FILE, "utf-8"));
        }
    }
    catch { }
    return { totalDown: 0, totalUp: 0, totalSessions: 0, totalTime: 0, sessions: [] };
}
function saveStats(stats) {
    try {
        (0, fs_1.writeFileSync)(STATS_FILE, JSON.stringify(stats, null, 2));
    }
    catch { }
}
electron_1.ipcMain.handle("stats:get", async () => {
    return loadStats();
});
electron_1.ipcMain.handle("stats:reset", async () => {
    const empty = { totalDown: 0, totalUp: 0, totalSessions: 0, totalTime: 0, sessions: [] };
    saveStats(empty);
    return { ok: true };
});
electron_1.ipcMain.handle("stats:record", async (_e, data) => {
    const stats = loadStats();
    stats.totalSessions++;
    stats.totalTime += data.duration;
    stats.totalDown += data.bytes;
    stats.sessions.unshift({
        startedAt: Date.now() - data.duration * 1000,
        duration: data.duration,
        bytes: data.bytes,
    });
    // Keep only last 50 sessions
    if (stats.sessions.length > 50)
        stats.sessions = stats.sessions.slice(0, 50);
    saveStats(stats);
    return { ok: true };
});
// ---------------------------------------------------------------------------
// Config search/filter
// ---------------------------------------------------------------------------
electron_1.ipcMain.handle("configs:search", async (_e, query) => {
    const configs = loadConfigs();
    if (!query)
        return configs;
    const q = query.toLowerCase();
    return configs.filter(c => c.host.toLowerCase().includes(q) ||
        c.protocol.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.flags.toLowerCase().includes(q));
});
// ---------------------------------------------------------------------------
// Delete all configs
// ---------------------------------------------------------------------------
electron_1.ipcMain.handle("configs:clear", async () => {
    saveConfigs([]);
    return { ok: true };
});
// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
electron_1.app.whenReady().then(() => {
    createWindow();
    createTray();
    // Auto-fetch default Iran subscription on first run
    if (loadConfigs().length === 0) {
        electron_log_1.default.info("[init] First run — fetching default Iran subscription");
        fetchSubscription("https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt")
            .then((r) => {
            if (r.ok) {
                electron_log_1.default.info(`[init] Auto-fetched ${r.count} configs`);
                mainWindow?.webContents.send("configs:updated");
            }
        })
            .catch((e) => electron_log_1.default.warn(`[init] Auto-fetch failed: ${e.message}`));
    }
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", async (e) => {
    if (xrayProcess) {
        e.preventDefault();
        await disconnectVpn();
        isQuitting = true;
        electron_1.app.quit();
    }
});
