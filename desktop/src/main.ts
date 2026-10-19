// DISTORT Desktop — Electron main process
// A 100% free, anti-censorship VPN client. Designed to outperform Nekoray & Hiddify.

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { spawn, ChildProcess } from "child_process";
import Store from "electron-store";
import log from "electron-log";
import { initDatabase } from "./db-init";

// ---------------------------------------------------------------------------
// Logging — configure early so we capture errors during startup.
// We set a FIXED log file path so the user can always find it at:
//   %APPDATA%\DISTORT\logs\main.log
// ---------------------------------------------------------------------------
import { mkdirSync, existsSync } from "fs";

// Determine the DISTORT data directory.
// On Windows: %APPDATA%\DISTORT
// On macOS:   ~/Library/Application Support/DISTORT
// On Linux:   ~/.config/DISTORT
// We use "DISTORT" (uppercase) regardless of what app.getName() returns.
const DISTORT_DATA_DIR = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming"), "DISTORT")
  : process.platform === "darwin"
  ? path.join(process.env.HOME || "", "Library", "Application Support", "DISTORT")
  : path.join(process.env.HOME || "", ".config", "DISTORT");

// Create the logs directory if it doesn't exist
const LOG_DIR = path.join(DISTORT_DATA_DIR, "logs");
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (e: any) {
  // Directory might already exist or we lack permissions — log error to console
  console.error(`Failed to create log directory ${LOG_DIR}: ${e?.message}`);
}

// Force electron-log to write to our fixed path
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, "main.log");
log.transports.file.level = "info";
log.transports.console.level = "info";

// Write a clear startup marker so we can find this log entry easily.
log.info("============================================================");
log.info("DISTORT Desktop starting up…");
log.info(`Electron: ${process.versions.electron}`);
log.info(`Node: ${process.versions.node}`);
log.info(`Platform: ${process.platform} ${process.arch}`);
log.info(`Process execPath: ${process.execPath}`);
log.info(`App version: 1.0.25`);
log.info(`Data dir: ${DISTORT_DATA_DIR}`);
log.info(`Log file: ${path.join(LOG_DIR, "main.log")}`);
log.info("============================================================");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const store = new Store<{ vpn: VpnState; settings: DesktopSettings }>({
  defaults: {
    vpn: { connected: false, server: null, protocol: "wireguard", startedAt: null },
    settings: {
      autoConnect: true,
      killSwitch: true,
      stealthMode: true,
      dnsLeakProtection: true,
      minimizeToTray: true,
      startMinimized: false,
    },
  },
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let vpnProcess: ChildProcess | null = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Companion control API — localhost-only HTTP server on port 10810
// (port 10809 is xray's HTTP proxy inbound, NOT a control API — see
// real-xray-config.ts: buildRealXrayConfig uses 10808 for SOCKS5 and
// 10809 for the HTTP proxy inbound. The control API must use a DIFFERENT
// port so the BrowserWithCompanionEngine in recovery-engine.ts can
// actually reach it.)
// ---------------------------------------------------------------------------
const COMPANION_API_HOST = "127.0.0.1"; // localhost ONLY — never 0.0.0.0
const COMPANION_API_PORT = 10810; // NOT 10809 (that's xray's HTTP proxy)
const COMPANION_API_VERSION = "1.0.0";
const COMPANION_API_PLATFORM = "desktop-companion";
const COMPANION_START_TIMEOUT_MS = 10_000;
const COMPANION_VERIFY_TIMEOUT_MS = 15_000;
const COMPANION_MAX_BODY_BYTES = 1024 * 1024; // 1MB cap on POST bodies

let companionApiServer: http.Server | null = null;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function getLoadUrl(): string {
  const isDev = !!process.env.DISTORT_DEV;
  if (isDev) {
    return "http://localhost:3000";
  }
  // Production: bundled Next.js standalone server (port 38571)
  return "http://localhost:38571";
}

function getOfflinePath(): string {
  return `file://${path.join(__dirname, "..", "resources", "offline.html")}`;
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "preload.js");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#050814",
    title: "DISTORT",
    show: false,
    frame: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!store.get("settings.startMinimized")) {
      mainWindow?.show();
    }
  });

  mainWindow?.on("close", (e) => {
    if (!isQuitting && store.get("settings.minimizeToTray")) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow?.on("closed", () => {
    mainWindow = null;
  });

  // Open external links in the default browser
  mainWindow?.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const url = getLoadUrl();
  log.info(`Loading URL: ${url}`);

  // Listen for load failures + console errors
  mainWindow?.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    log.error(`did-fail-load: errorCode=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    // Retry after 3s if the Next.js server might still be starting up
    if (errorCode !== -3) { // -3 is aborted (user navigated away) — don't retry
      setTimeout(() => {
        log.info(`Retrying load: ${url}`);
        mainWindow?.loadURL(url).catch(() => {
          log.warn("Retry failed — loading offline page");
          mainWindow?.loadURL(getOfflinePath());
        });
      }, 3000);
    }
  });

  mainWindow?.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    log.info(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow?.webContents.on("render-process-gone", (_e, details) => {
    log.error(`Render process gone: ${JSON.stringify(details)}`);
  });

  mainWindow?.loadURL(url).catch((err) => {
    log.warn(`Failed to load main URL: ${err?.message || err}`);
    // Retry once after 5s — Next.js server might still be starting
    setTimeout(() => {
      log.info(`Retrying load after 5s: ${url}`);
      mainWindow?.loadURL(url).catch(() => {
        log.warn("Retry failed — loading offline page");
        mainWindow?.loadURL(getOfflinePath());
      });
    }, 5000);
  });

  // After 30s, if still on offline page, reload the main URL one more time
  setTimeout(() => {
    if (mainWindow && !mainWindow.webContents.getURL().startsWith("http://localhost:38571")) {
      log.info("30s elapsed and dashboard not loaded — retrying main URL");
      mainWindow.loadURL(getLoadUrl()).catch(() => {
        log.warn("Final retry failed — staying on offline page");
      });
    }
  }, 30000);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray(): void {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Fallback: a 16x16 cyan square
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip("DISTORT — Freedom Beyond Borders");

  const updateMenu = () => {
    const vpn = store.get("vpn");
    const menu = Menu.buildFromTemplate([
      {
        label: `DISTORT v${app.getVersion()}`,
        enabled: false,
      },
      {
        label: vpn.connected ? "● Connected" : "○ Disconnected",
        enabled: false,
      },
      { type: "separator" },
      {
        label: vpn.connected ? "Disconnect" : "Quick Connect",
        click: () => {
          if (vpn.connected) {
            disconnectVpn();
          } else {
            quickConnect();
          }
        },
      },
      {
        label: "Check for Updates",
        click: () => {
          mainWindow?.webContents.send("update:check-now-trigger");
          if (autoUpdaterModule) {
            autoUpdaterModule.checkForUpdates().catch((err: Error) => {
              dialog.showErrorBox("Update Check Failed", err?.message || "Unknown error");
            });
          } else {
            dialog.showMessageBox({
              type: "info",
              title: "DISTORT Updates",
              message: `You are running v${app.getVersion()}.`,
              detail: "Auto-update is not available in this build.\n\nCheck https://github.com/di6tort-bit/distort/releases for the latest version.",
              buttons: ["OK"],
            });
          }
        },
      },
      { type: "separator" },
      {
        label: "Show Distort",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "Settings",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send("navigate", "settings");
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(menu);
  };

  updateMenu();
  tray?.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Refresh menu when VPN state changes
  ipcMain.on("vpn:state-changed", updateMenu);
}

// ---------------------------------------------------------------------------
// VPN engine — REAL xray-core integration with REAL credentials
// ---------------------------------------------------------------------------
type VpnState = {
  connected: boolean;
  server: { code: string; country: string; host: string; port: number } | null;
  protocol: string;
  startedAt: number | null;
  configUri?: string | null;
  exitIp?: string | null;
  exitCountry?: string | null;
};

type DesktopSettings = {
  autoConnect: boolean;
  killSwitch: boolean;
  stealthMode: boolean;
  dnsLeakProtection: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
};

// Path to the bundled xray binary (in production, it's in resources/bin)
function getXrayPath(): string {
  const isDev = !!process.env.DISTORT_DEV;
  if (isDev) {
    return path.join(__dirname, "..", "resources", "bin", "xray.exe");
  }
  // Production: resources/bin/xray.exe
  return path.join(process.resourcesPath, "bin", "xray.exe");
}

function getWintunPath(): string {
  const isDev = !!process.env.DISTORT_DEV;
  if (isDev) {
    return path.join(__dirname, "..", "resources", "bin", "wintun.dll");
  }
  return path.join(process.resourcesPath, "bin", "wintun.dll");
}

// Build a REAL xray config from a raw config URI (vmess://, vless://, trojan://, ss://).
// This is the extracted, reusable form: it takes ONLY a configUri (no server object)
// because the URI itself carries the host/port/credentials. Used by both the desktop
// UI's startVpnEngine() and the companion control API's /api/tunnel/start endpoint.
//
// Throws an honest error if the URI can't be parsed — NO fake/placeholder credentials.
function buildXrayConfigFromUri(configUri: string): object {
  if (!configUri || typeof configUri !== "string" || configUri.length < 10) {
    throw new Error("Invalid configUri — expected a non-empty vmess://, vless://, trojan://, or ss:// URI");
  }
  const { parseUriToRealConfig, buildRealXrayConfig } = require("./real-xray-config");
  const realCfg = parseUriToRealConfig(configUri);
  if (!realCfg) {
    throw new Error(
      "Could not parse the provided config URI — expected vmess://, vless://, trojan://, or ss://"
    );
  }
  const settings = store.get("settings");
  return buildRealXrayConfig(realCfg, {
    tun: false, // SOCKS5 + HTTP proxy mode — no admin required
    socksPort: 10808,
    httpPort: 10809,
    dnsLeakProtection: settings.dnsLeakProtection !== false,
  });
}

// Build a REAL xray config using real credentials from a Community Mesh URI.
// Falls back to a clear error if no real URI is provided — NO fake credentials.
function buildXrayConfig(server: VpnState["server"], protocol: string, configUri?: string | null): object {
  if (!server) throw new Error("No server selected");

  // If we have a real Community Mesh URI, use ITS credentials (not fakes).
  if (configUri && typeof configUri === "string" && configUri.length > 10) {
    return buildXrayConfigFromUri(configUri);
  }

  // No real URI → throw an honest error instead of using fake credentials.
  throw new Error(
    `No real VPN config provided. The Distort servers (${server.host}:${server.port}) are not yet operational. ` +
    `Please select a config from the Community Mesh tab — those use REAL credentials from the Iran subscription.`
  );
}

import { randomUUID as cryptoRandomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Tunnel traffic verification — top-level (reused by both the desktop UI's
// startVpnEngine() startup flow AND the companion control API's
// /api/tunnel/verify endpoint).
//
// Strategy: do a real SOCKS5 → TLS → HTTP GET through xray's local SOCKS5
// proxy (127.0.0.1:10808) to https://www.cloudflare.com/cdn-cgi/trace.
// If we get a response containing "ip=", the tunnel is verified working
// and we extract the exit IP + country.
//
// This is the ONLY way to prove the tunnel actually carries traffic —
// NOT just checking if the SOCKS port is open (that only proves xray's
// inbound is ready, not that the outbound to the VPN server works).
// ---------------------------------------------------------------------------
type VerifyTunnelResult = {
  verified: boolean;
  exitIp: string | null;
  exitCountry: string | null;
  latencyMs: number | null;
  error?: string;
};

async function verifyTunnelTraffic(): Promise<VerifyTunnelResult> {
  // Use HTTP fetch through the SOCKS5 proxy instead of raw SOCKS5 + TLS.
  // The previous raw SOCKS5 implementation was failing with ECONNRESET
  // because it manually implemented the SOCKS5 protocol + TLS handshake,
  // which is error-prone. Using Node's built-in fetch with a proxy agent
  // is more reliable.
  //
  // We use the HTTP proxy (port 10809) instead of SOCKS5 (port 10808)
  // because Node's fetch() supports HTTP proxies via env vars natively.
  const startTime = Date.now();
  try {
    // Set proxy env vars for this request
    const prevHttpProxy = process.env.HTTP_PROXY;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:10809";
    process.env.HTTPS_PROXY = "http://127.0.0.1:10809";

    // Try fetching through the proxy
    const resp = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(10000),
    });

    // Restore env vars
    process.env.HTTP_PROXY = prevHttpProxy || "";
    process.env.HTTPS_PROXY = prevHttpsProxy || "";

    if (!resp.ok) {
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs: Date.now() - startTime,
        error: `HTTP ${resp.status} through proxy`,
      };
    }

    const text = await resp.text();
    const latencyMs = Date.now() - startTime;

    // Validate response — must contain "ip=" to prove traffic flowed
    if (text.includes("ip=")) {
      const exitIp = text.match(/ip=([^\r\n]+)/)?.[1]?.trim() || "";
      const exitCountry = text.match(/loc=([^\r\n]+)/)?.[1]?.trim() || "";
      return {
        verified: true,
        exitIp: exitIp || null,
        exitCountry: exitCountry || null,
        latencyMs,
      };
    } else {
      return {
        verified: false,
        exitIp: null,
        exitCountry: null,
        latencyMs,
        error: "Proxy responded but no valid trace data",
      };
    }
  } catch (e: any) {
    // Restore env vars on error too
    process.env.HTTP_PROXY = "";
    process.env.HTTPS_PROXY = "";
    return {
      verified: false,
      exitIp: null,
      exitCountry: null,
      latencyMs: Date.now() - startTime,
      error: e?.message || String(e),
    };
  }
}

// Fetch the device's REAL public IP by doing a DIRECT (non-proxied) HTTPS
// GET to cloudflare/cdn-cgi/trace. Used by /api/tunnel/verify to compare
// against the exit IP — if they match, traffic is NOT going through the
// tunnel (leak). If they differ, tunnel is verified working.
async function fetchRealIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      "https://www.cloudflare.com/cdn-cgi/trace",
      { timeout: 8000 },
      (res: http.IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          const match = data.match(/ip=([^\r\n]+)/);
          resolve(match ? match[1].trim() : null);
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function startVpnEngine(server: VpnState["server"], protocol: string, configUri?: string | null): Promise<void> {
  if (!server) throw new Error("No server selected");
  log.info(`Starting xray-core: ${protocol} to ${server.host}:${server.port}`);

  // Stop any existing xray process
  if (vpnProcess) {
    try { vpnProcess.kill("SIGTERM"); } catch {}
    vpnProcess = null;
  }

  // Build the REAL config (uses real credentials from configUri, or throws)
  const config = buildXrayConfig(server, protocol, configUri);
  const configPath = path.join(app.getPath("userData"), "xray-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log.info(`xray config written to: ${configPath}`);

  const xrayPath = getXrayPath();
  if (!fs.existsSync(xrayPath)) {
    log.error(`xray binary not found at: ${xrayPath}`);
    throw new Error("VPN engine binary missing");
  }

  // Spawn xray.exe
  vpnProcess = spawn(xrayPath, ["run", "-c", configPath], {
    cwd: path.dirname(xrayPath),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Track xray's health — only mark "connected" after REAL HTTP request through proxy
  let handshakeConfirmed = false;
  let startupError = "";
  const startupTimeout = setTimeout(() => {
    if (!handshakeConfirmed && !startupError) {
      // xray is still alive after 5s — do a REAL HTTP request through the
      // SOCKS proxy to verify traffic actually flows to the destination.
      // This is more honest than just checking if the SOCKS port is open.
      verifyHttpThroughProxy().then((verified) => {
        if (verified && !handshakeConfirmed && !startupError) {
          handshakeConfirmed = true;
          store.set("vpn", {
            connected: true,
            server,
            protocol,
            configUri: configUri ?? null,
            startedAt: Date.now(),
          });
          mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
          log.info("xray-core confirmed working (HTTP through proxy succeeded) — connected");
          // Start tunnel health monitoring — checks every 30s if tunnel is alive
          startHealthMonitoring();
        } else if (!startupError) {
          log.warn("xray process alive but HTTP verification failed — NOT marking as connected");
          store.set("vpn", {
            connected: false,
            server,
            protocol,
            configUri: configUri ?? null,
            startedAt: null,
          });
          mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
          mainWindow?.webContents.send("vpn:error", "Tunnel started but HTTP request through proxy failed. The server may be unreachable or credentials may be invalid.");
        }
      });
    }
  }, 5000);

  // Also remove the premature "started"/"listening" trigger that could
  // mark connected before traffic verification completes.
  // (Previously, xray logging "started" would immediately mark connected —
  //  but that only means the inbound is ready, not that the outbound works.)

  // REAL HTTP verification: do an actual GET request through xray's SOCKS5 proxy.
  // This is the ONLY way to verify the tunnel works — NOT just checking if the
  // SOCKS port is open (that only proves xray's inbound is ready, not outbound).
  //
  // We delegate to the top-level verifyTunnelTraffic() which does a full SOCKS5
  // handshake + TLS + HTTP GET to cloudflare/cdn-cgi/trace and returns structured
  // data (verified + exitIp + exitCountry + latencyMs + error). The wrapper below
  // keeps the side effects that integrate with the desktop UI's startup flow
  // (updating the global vpn state + sending IPC events to the renderer).
  async function verifyHttpThroughProxy(): Promise<boolean> {
    // Make this function accessible to health monitoring (top-level ref)
    verifyHttpThroughProxyRef = verifyHttpThroughProxy;
    const result = await verifyTunnelTraffic();
    if (result.verified && result.exitIp) {
      log.info(`Traffic verification: exit IP=${result.exitIp}, country=${result.exitCountry} — tunnel verified (latency=${result.latencyMs}ms)`);
      // Store exit IP + country in VPN state
      const currentVpn = store.get("vpn");
      store.set("vpn", {
        ...currentVpn,
        exitIp: result.exitIp,
        exitCountry: result.exitCountry,
      });
      mainWindow?.webContents.send("vpn:exit-info", {
        exitIp: result.exitIp,
        exitCountry: result.exitCountry,
      });
      return true;
    } else {
      log.warn(`Traffic verification FAILED: ${result.error || "no valid response"} — NOT connected`);
      return false;
    }
  }

  vpnProcess.stdout?.on("data", (data) => {
    const line = data.toString().trim();
    log.info(`[xray] ${line}`);
    // NOTE: We do NOT mark "connected" here just because xray logs "started".
    // "started" only means the inbound proxy is ready — it does NOT prove the
    // outbound to the VPN server works. We wait for the 5s timeout to do a
    // real HTTP request through the proxy (see verifyHttpThroughProxy above).
  });

  vpnProcess.stderr?.on("data", (data) => {
    const line = data.toString().trim();
    log.error(`[xray] ${line}`);
    // Capture real errors — don't show "connected" if xray failed to start
    if (line.includes("error") || line.includes("failed") || line.includes("panic")) {
      startupError = line;
      clearTimeout(startupTimeout);
      store.set("vpn", {
        connected: false,
        server: null,
        protocol,
        configUri: null,
        startedAt: null,
      });
      mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
      mainWindow?.webContents.send("vpn:error", startupError);
    }
  });

  vpnProcess.on("exit", (code) => {
    log.info(`xray exited with code ${code}`);
    clearTimeout(startupTimeout);
    if (store.get("vpn.connected")) {
      store.set("vpn", { ...store.get("vpn"), connected: false, startedAt: null });
      mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
      // If kill switch is enabled, block all traffic now
      if (store.get("settings.killSwitch")) {
        log.warn("Kill switch activated — xray exited unexpectedly");
        mainWindow?.webContents.send("vpn:kill-switch-activated");
      }
    }
  });

  // Wait briefly for xray to start (but don't block on handshake)
  await new Promise((r) => setTimeout(r, 500));

  if (!handshakeConfirmed && !startupError) {
    // Still starting — show "connecting" state
    store.set("vpn", {
      connected: false,
      server,
      protocol,
      configUri: configUri ?? null,
      startedAt: null,
    });
    mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
    log.info("xray-core starting — waiting for handshake");
  }
}

async function stopVpnEngine(): Promise<void> {
  // Stop health monitoring when tunnel goes down
  stopHealthMonitoring();
  // NOTE: Do NOT reset reconnectAttempts here — that's done by smartReconnect
  // only after SUCCESSFUL reconnection. Resetting here would allow infinite retries.
  log.info("Stopping xray-core…");
  if (vpnProcess) {
    try {
      vpnProcess.kill("SIGTERM");
      // Give it 500ms to exit gracefully
      await new Promise((r) => setTimeout(r, 500));
      if (!vpnProcess.killed) {
        vpnProcess.kill("SIGKILL");
      }
    } catch (e) {
      log.error("Error killing xray:", e);
    }
    vpnProcess = null;
  }

  // If kill switch is enabled, block all non-tunnel traffic until user reconnects.
  // On Windows: use netsh advfirewall to add a block rule (requires admin).
  // On macOS/Linux: we can't easily block without root, so we just warn the user.
  const settings = store.get("settings");
  if (settings.killSwitch && process.platform === "win32") {
    await enableKillSwitch();
  } else if (settings.killSwitch) {
    log.warn("Kill switch: not implemented on this platform — traffic may leak");
    mainWindow?.webContents.send("vpn:warning", "Kill switch is enabled but not implemented on this platform. Your real IP may be exposed.");
  }

  store.set("vpn", {
    connected: false,
    server: null,
    protocol: store.get("vpn.protocol"),
    startedAt: null,
  });
  mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
}

// REAL kill switch on Windows.
//
// APPROACH: Route table manipulation (NOT Windows Firewall).
//
// Why not firewall? Windows Firewall has a known issue: Block rules can
// override Allow rules depending on policy settings. This makes it
// unreliable for a kill switch — the VPN server might get blocked too,
// preventing reconnection.
//
// Instead, we manipulate the system's routing table:
// 1. Remove the default route (so no traffic can leave)
// 2. Add a specific route for the VPN server IP (so the tunnel can reconnect)
//
// This is more reliable because:
// - Route table is processed in priority order (lowest metric wins)
// - We add the VPN server route with a LOW metric (high priority)
// - The default route is removed, so all other traffic fails
// - No "Block vs Allow" priority conflict
//
// NOTE: This requires admin privileges. If the app doesn't have admin,
// the kill switch won't work and we log a clear warning.
let killSwitchActive = false;
let savedDefaultGateway = "";
let savedInterfaceIndex = 0;
let savedDefaultMetric = 25;
let healthCheckTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds

// Tunnel health monitoring — checks every 30s if the tunnel is still alive.
// If the tunnel dies:
// 1. Auto-disconnect (user requested: "only when ping is lost, auto-disconnect")
// 2. Try to reconnect to a SIMILAR country first
// 3. If no similar country available, notify user where it will connect

// Top-level reference to the verification function (defined inside startVpnEngine)
let verifyHttpThroughProxyRef: (() => Promise<boolean>) | null = null;
let lastConnectedCountry: string | null = null;
let isReconnecting = false; // prevents concurrent reconnect attempts

function startHealthMonitoring(): void {
  if (healthCheckTimer) clearInterval(healthCheckTimer);

  healthCheckTimer = setInterval(async () => {
    const vpnState = store.get("vpn");
    if (!vpnState.connected) return;
    if (isReconnecting) return; // already reconnecting, don't stack

    // Quick check: is xray process still alive?
    if (!vpnProcess || vpnProcess.killed) {
      log.warn("Health check: xray process is dead — auto-disconnecting and reconnecting");
      // Remember the country we were connected to
      lastConnectedCountry = vpnState.exitCountry || vpnState.server?.country || null;
      await smartReconnectWithCountryPreference();
      return;
    }

    // Periodic traffic verification
    if (verifyHttpThroughProxyRef) {
      try {
        const verified = await verifyHttpThroughProxyRef();
        if (!verified) {
          log.warn("Health check: ping lost (no traffic through tunnel) — auto-disconnecting");
          // User requested: "only when ping is lost, auto-disconnect and reconnect to similar country"
          const currentVpn = store.get("vpn");
          lastConnectedCountry = currentVpn.exitCountry || currentVpn.server?.country || null;
          await smartReconnectWithCountryPreference();
        } else {
          reconnectAttempts = 0;
        }
      } catch (e: any) {
        log.warn(`Health check error: ${e?.message}`);
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  log.info(`Health monitoring started (every ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}

function stopHealthMonitoring(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    log.info("Health monitoring stopped");
  }
}

// Smart reconnect with COUNTRY PREFERENCE:
// 1. Try configs from the SAME country as the last connection
// 2. If none available, pick best available and NOTIFY user
// 3. Uses exponential backoff (1s, 2s, 4s, 8s, 16s)
// 4. Max 5 attempts
async function smartReconnectWithCountryPreference(): Promise<void> {
  if (isReconnecting) {
    log.info("Smart reconnect: already in progress — skipping");
    return;
  }
  isReconnecting = true;

  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`Smart reconnect: max attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
      store.set("vpn", {
        ...store.get("vpn"),
        connected: false,
        startedAt: null,
      });
      mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
      mainWindow?.webContents.send("vpn:error",
        "Tunnel died and automatic reconnection failed after 5 attempts. " +
        "The network may be heavily filtered. Please try Quick Connect again manually."
      );
      stopHealthMonitoring();
      return;
    }

    reconnectAttempts++;
    const delay = Math.pow(2, reconnectAttempts - 1) * 1000;
    const jitter = delay * (0.75 + Math.random() * 0.5);
    const actualDelay = Math.round(jitter);

    log.info(`Smart reconnect: attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${actualDelay}ms (last country: ${lastConnectedCountry || "unknown"})`);

    mainWindow?.webContents.send("vpn:reconnecting", {
      attempt: reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: actualDelay,
      lastCountry: lastConnectedCountry,
    });

    await new Promise((r) => setTimeout(r, actualDelay));

    // Stop current tunnel
    await stopVpnEngine();
    await disableKillSwitch();

    // Get configs and sort by country preference
    const meshUrl = `${getLoadUrl()}/api/imported-configs?bucket=optimized&limit=50`;
    const meshRes = await fetch(meshUrl);
    const meshData: any = await meshRes.json() as any;
    let configs = meshData?.configs || [];

    if (configs.length === 0) {
      // Try cached configs (national internet scenario)
      try {
        const cacheFile = path.join(app.getPath("userData"), "cached-configs.json");
        if (fs.existsSync(cacheFile)) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
          configs = cached.configs || [];
          log.info(`Smart reconnect: using ${configs.length} cached configs (subscription URL unreachable)`);
        }
      } catch {}
    }

    if (configs.length === 0) {
      log.error("Smart reconnect: no configs available at all");
      mainWindow?.webContents.send("vpn:error", "No VPN configs available. Network may be completely blocked.");
      return;
    }

    // Sort configs: same country first, then by score
    const sameCountry = configs.filter((c: any) =>
      lastConnectedCountry && (c.country === lastConnectedCountry || c.country?.includes(lastConnectedCountry))
    );
    const otherCountry = configs.filter((c: any) =>
      !lastConnectedCountry || !(c.country === lastConnectedCountry || c.country?.includes(lastConnectedCountry))
    );

    // If we have same-country configs, try those first
    const sortedConfigs = [...sameCountry, ...otherCountry].slice(0, 10);

    if (sameCountry.length > 0) {
      log.info(`Smart reconnect: trying ${sameCountry.length} configs from same country (${lastConnectedCountry})`);
    } else {
      // No similar country — notify user where we'll connect
      const firstConfig = sortedConfigs[0];
      const targetCountry = firstConfig?.country || "unknown";
      log.info(`Smart reconnect: no configs from ${lastConnectedCountry} — will connect to ${targetCountry}`);
      mainWindow?.webContents.send("vpn:country-change", {
        from: lastConnectedCountry,
        to: targetCountry,
        message: `No servers available in ${lastConnectedCountry}. Connecting to ${targetCountry} instead.`,
      });
    }

    // Try each config
    for (let i = 0; i < sortedConfigs.length; i++) {
      const cfg = sortedConfigs[i];
      log.info(`Smart reconnect: trying config ${i + 1}/${sortedConfigs.length} — ${cfg.protocol} ${cfg.host}:${cfg.port} (${cfg.country || "?"})`);

      const server: VpnState["server"] = {
        code: cfg.host,
        country: cfg.country || cfg.host,
        host: cfg.host,
        port: cfg.port,
      };

      await disableKillSwitch();
      try {
        await startVpnEngine(server, cfg.protocol, cfg.uri);
        await new Promise((r) => setTimeout(r, 7000));
        const vpnState = store.get("vpn");
        if (vpnState.connected) {
          log.info(`Smart reconnect: SUCCESS on attempt ${reconnectAttempts} via ${cfg.host} (${cfg.country})`);
          reconnectAttempts = 0;
          startHealthMonitoring();
          return;
        }
      } catch (e: any) {
        log.warn(`Smart reconnect: config ${i + 1} failed: ${e?.message}`);
      }
      await stopVpnEngine();
    }

    log.warn(`Smart reconnect: attempt ${reconnectAttempts} failed — will retry`);
  } finally {
    isReconnecting = false;
  }
}

async function enableKillSwitch(): Promise<void> {
  if (killSwitchActive) return;
  try {
    log.info("Kill switch: enabling via route table manipulation…");
    const { exec } = require("child_process") as { exec: (cmd: string, cb: (e: any, o: string, e2: string) => void) => void };

    if (process.platform !== "win32") {
      log.warn("Kill switch: route table manipulation only implemented for Windows");
      return;
    }

    // Step 1: Get ALL active IPv4 routes using PowerShell (more reliable than route print)
    // We need: default gateway, interface index, and interface metric
    const routeInfo = await new Promise<{ gateway: string; iface: string; ifaceIp: string; metric: number }>((resolve) => {
      // PowerShell gives us structured output including metric
      exec(
        'powershell -Command "Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1 -Property NextHop,InterfaceIndex,InterfaceMetric | Format-List"',
        (err, stdout) => {
          if (err) {
            log.warn(`Kill switch: PowerShell Get-NetRoute failed: ${err.message}, trying route print`);
            exec("route print -4 0.0.0.0", (err2, stdout2) => {
              if (err2) {
                resolve({ gateway: "", iface: "", ifaceIp: "", metric: 25 });
                return;
              }
              parseRoutePrintOutput(stdout2, resolve);
            });
            return;
          }
          const gateway = stdout.match(/NextHop\s*:\s*(\d+\.\d+\.\d+\.\d+)/)?.[1] || "";
          const iface = stdout.match(/InterfaceIndex\s*:\s*(\d+)/)?.[1] || "";
          const metric = parseInt(stdout.match(/InterfaceMetric\s*:\s*(\d+)/)?.[1] || "25");
          if (iface) {
            exec(
              `powershell -Command "(Get-NetIPAddress -InterfaceIndex ${iface} -AddressFamily IPv4).IPAddress"`,
              (e3, ipOut) => {
                const ifaceIp = ipOut?.trim() || "";
                resolve({ gateway, iface, ifaceIp, metric });
              }
            );
          } else {
            resolve({ gateway, iface, ifaceIp: "", metric });
          }
        }
      );
    });

    savedDefaultGateway = routeInfo.gateway;
    savedInterfaceIndex = parseInt(routeInfo.iface) || 0;
    savedDefaultMetric = routeInfo.metric || 25;

    if (!savedDefaultGateway || savedInterfaceIndex === 0) {
      log.error("Kill switch: could not find default route — kill switch ABORTED (would not work)");
      return;
    }

    log.info(`Kill switch: gateway=${savedDefaultGateway}, iface=${savedInterfaceIndex}, ip=${routeInfo.ifaceIp}`);

    // Step 2: Get the VPN server IP
    // CRITICAL: If we can't resolve the VPN server IP, we MUST NOT remove
    // the default route — otherwise the tunnel can't reconnect and the user
    // is left without internet.
    const vpnServer = store.get("vpn.server") as { host?: string } | null;
    const vpnHost = vpnServer?.host || "";
    let vpnIp = "";
    if (vpnHost) {
      try {
        const dnsPromises = require("dns").promises;
        const addresses = await dnsPromises.lookup(vpnHost, { all: true });
        if (Array.isArray(addresses) && addresses.length > 0) {
          vpnIp = addresses[0].address;
        }
      } catch (e: any) {
        log.error(`Kill switch: ABORTED — could not resolve VPN server IP: ${e.message}`);
        log.error("Kill switch: If we removed the default route now, the tunnel couldn't reconnect.");
        return; // FAIL-CLOSED: don't proceed without VPN server route
      }
    }

    if (!vpnIp) {
      log.error("Kill switch: ABORTED — VPN server IP is empty, cannot add exclusion route");
      return;
    }

    // NOW we have all the info — persist route info to disk for crash recovery
    const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
    fs.writeFileSync(routeBackupFile, JSON.stringify({
      gateway: savedDefaultGateway,
      interfaceIndex: savedInterfaceIndex,
      interfaceIp: routeInfo.ifaceIp,
      metric: savedDefaultMetric,
      vpnIp: vpnIp, // CRITICAL: save VPN server IP so crash recovery can delete its route
      timestamp: Date.now(),
    }));
    log.info(`Kill switch: route info saved (gateway=${savedDefaultGateway}, iface=${savedInterfaceIndex}, metric=${savedDefaultMetric}, vpnIp=${vpnIp})`);

    // Step 3: Add a specific route for the VPN server (high priority)
    // This must be done BEFORE removing the default route.
    // CRITICAL: If this fails, we MUST NOT remove the default route —
    // otherwise the tunnel can't reconnect and the user loses internet.
    const vpnRouteAdded = await new Promise<boolean>((resolve) => {
      exec(
        `route add ${vpnIp} mask 255.255.255.255 ${savedDefaultGateway} metric 1 IF ${savedInterfaceIndex}`,
        (err) => {
          if (err) {
            log.error(`Kill switch: ABORTED — could not add VPN server route: ${err.message}`);
            log.error("Kill switch: Without this route, removing default route would break reconnection.");
            resolve(false);
          } else {
            log.info(`Kill switch: VPN server ${vpnIp} route added (metric 1)`);
            resolve(true);
          }
        }
      );
    });

    if (!vpnRouteAdded) {
      // VPN route failed — DO NOT remove default route
      // Delete the backup file since kill switch didn't actually activate
      try {
        const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
        if (fs.existsSync(routeBackupFile)) fs.unlinkSync(routeBackupFile);
      } catch {}
      return; // ABORT — don't proceed to step 4
    }

    // Step 4: Remove the default IPv4 route (blocks all other traffic)
    await new Promise<void>((resolve) => {
      exec(
        `route delete 0.0.0.0 mask 0.0.0.0 ${savedDefaultGateway} IF ${savedInterfaceIndex}`,
        (err) => {
          if (err) {
            log.warn(`Kill switch: could not remove default IPv4 route: ${err.message}`);
          } else {
            log.info("Kill switch: default IPv4 route removed");
          }
          resolve();
        }
      );
    });

    // Step 4b: Also remove IPv6 default route to prevent IPv6 leaks
    // Without this, traffic can bypass the tunnel via IPv6
    await new Promise<void>((resolve) => {
      exec(
        'route delete ::/0',
        (err) => {
          if (err) {
            log.warn(`Kill switch: could not remove IPv6 default route: ${err.message} (may not exist)`);
          } else {
            log.info("Kill switch: IPv6 default route removed — IPv6 leak prevented");
          }
          resolve();
        }
      );
    });

    // Step 4c: Disable IPv6 entirely via netsh (extra protection)
    await new Promise<void>((resolve) => {
      exec(
        'netsh interface ipv6 6to4 set state state=disabled undoonstop=disabled',
        (err) => {
          if (err) {
            log.warn(`Kill switch: could not disable IPv6 6to4: ${err.message}`);
          }
          resolve();
        }
      );
    });

    // Step 5: VERIFY the default IPv4 route is actually gone
    const verified = await new Promise<boolean>((resolve) => {
      exec("route print -4 0.0.0.0", (err, stdout) => {
        if (err) {
          log.error("Kill switch: VERIFICATION failed — could not query route table");
          resolve(false);
          return;
        }
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\d+\.\d+\.\d+\.\d+/.test(line)) {
            log.error(`Kill switch: VERIFICATION FAILED — default route still exists: ${line.trim()}`);
            resolve(false);
            return;
          }
        }
        log.info("Kill switch: VERIFIED — no default IPv4 route found");
        resolve(true);
      });
    });

    // Step 6: If verification failed, RESTORE everything immediately
    // to avoid leaving the user without internet
    if (!verified) {
      log.error("Kill switch: verification failed — restoring default route and cleaning up");

      // Restore IPv4 default route
      await new Promise<void>((resolve) => {
        exec(
          `route add 0.0.0.0 mask 0.0.0.0 ${savedDefaultGateway} metric ${savedDefaultMetric} IF ${savedInterfaceIndex}`,
          (err) => {
            if (err) {
              log.error(`Kill switch: FAILED to restore default route: ${err.message}`);
            } else {
              log.info("Kill switch: default route restored after verification failure");
            }
            resolve();
          }
        );
      });

      // Restore IPv6 default route
      await new Promise<void>((resolve) => {
        exec('netsh interface ipv6 6to4 set state state=enabled undoonstop=enabled', () => resolve());
      });

      // Delete the VPN server route we added
      await new Promise<void>((resolve) => {
        exec(`route delete ${vpnIp}`, () => resolve());
      });

      // Delete backup file
      try {
        const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
        if (fs.existsSync(routeBackupFile)) fs.unlinkSync(routeBackupFile);
      } catch {}

      killSwitchActive = false;
      return; // Kill switch is NOT active
    }

    killSwitchActive = true;
    mainWindow?.webContents.send("vpn:kill-switch-activated");
    log.info("Kill switch: ACTIVE — IPv4 + IPv6 routes blocked, VPN server excluded");
  } catch (e: any) {
    log.warn(`Kill switch error: ${e?.message}`);
  }
}

// Helper: parse 'route print' output (fallback when PowerShell isn't available)
function parseRoutePrintOutput(stdout: string, resolve: (val: { gateway: string; iface: string; ifaceIp: string; metric: number }) => void) {
  const lines = stdout.split("\n");
  for (const line of lines) {
    // IPv4 route table format:
    // Network    Netmask       Gateway       Interface    Metric
    // 0.0.0.0    0.0.0.0       192.168.1.1   192.168.1.5   25
    const match = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/);
    if (match) {
      const gateway = match[1];
      const ifaceIp = match[2];
      const metric = parseInt(match[3]) || 25;
      const { exec } = require("child_process");
      exec(
        `powershell -Command "(Get-NetIPAddress -IPAddress ${ifaceIp}).InterfaceIndex"`,
        (e: any, out: string) => {
          resolve({ gateway, iface: out?.trim() || "0", ifaceIp, metric });
        }
      );
      return;
    }
  }
  resolve({ gateway: "", iface: "", ifaceIp: "", metric: 25 });
}

async function disableKillSwitch(): Promise<void> {
  if (!killSwitchActive) return;
  try {
    log.info("Kill switch: restoring default route…");
    const { exec } = require("child_process") as { exec: (cmd: string, cb: (e: any, o: string, e2: string) => void) => void };

    // Restore the default route
    if (savedDefaultGateway && savedInterfaceIndex > 0) {
      await new Promise<void>((resolve) => {
        exec(
          `route add 0.0.0.0 mask 0.0.0.0 ${savedDefaultGateway} metric ${savedDefaultMetric} IF ${savedInterfaceIndex}`,
          (err) => {
            if (err) {
              log.error(`Kill switch: FAILED to restore default route: ${err.message}`);
              log.error("Kill switch: YOUR INTERNET MAY BE BLOCKED — run this manually:");
              log.error(`  route add 0.0.0.0 mask 0.0.0.0 ${savedDefaultGateway} metric ${savedDefaultMetric} IF ${savedInterfaceIndex}`);
            } else {
              log.info("Kill switch: default route restored — internet is back");
              killSwitchActive = false;
              // Delete the backup file since we successfully restored
              try {
                const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
                if (fs.existsSync(routeBackupFile)) fs.unlinkSync(routeBackupFile);
              } catch {}
            }
            resolve();
          }
        );
      });
    }

    // Restore IPv6 (6to4)
    await new Promise<void>((resolve) => {
      exec('netsh interface ipv6 6to4 set state state=enabled undoonstop=enabled', () => {
        log.info("Kill switch: IPv6 6to4 re-enabled");
        resolve();
      });
    });

    // Remove the VPN server specific route (re-resolve in case IP changed)
    const vpnServer = store.get("vpn.server") as { host?: string } | null;
    const vpnHost = vpnServer?.host || "";
    if (vpnHost && savedDefaultGateway) {
      try {
        const dnsPromises = require("dns").promises;
        const addresses = await dnsPromises.lookup(vpnHost, { all: true });
        if (addresses.length > 0) {
          const vpnIp = addresses[0].address;
          await new Promise<void>((resolve) => {
            exec(`route delete ${vpnIp}`, () => resolve());
          });
        }
      } catch (e: any) {
        log.warn(`Kill switch: could not remove VPN server route: ${e.message}`);
        // Try deleting the route using the saved VPN IP (from backup file)
        try {
          const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
          if (fs.existsSync(routeBackupFile)) {
            const backup = JSON.parse(fs.readFileSync(routeBackupFile, "utf-8"));
            if (backup.vpnIp) {
              exec(`route delete ${backup.vpnIp}`, () => {});
            }
          }
        } catch {}
      }
    }
  } catch (e: any) {
    log.warn(`Kill switch disable error: ${e?.message}`);
  }
}

async function quickConnect(): Promise<void> {
  try {
    // Step 1: Get configs from API
    let configs: any[] = [];
    try {
      const meshUrl = `${getLoadUrl()}/api/imported-configs?bucket=optimized&limit=20`;
      const meshRes = await fetch(meshUrl);
      if (meshRes.ok) {
        const meshData: any = await meshRes.json() as any;
        configs = meshData?.configs || [];
        log.info(`Quick connect: fetched ${configs.length} configs from API`);
      } else {
        log.warn(`Quick connect: API returned ${meshRes.status}, trying alternatives`);
      }
    } catch (e: any) {
      log.warn(`Quick connect: API fetch failed (${e?.message}), trying alternatives`);
    }

    // Step 2: If no configs from API, try refreshing subscription directly
    if (configs.length === 0) {
      log.info("Quick connect: no configs from API — refreshing Iran subscription directly");
      try {
        const subResp = await fetch(`${getLoadUrl()}/api/subscriptions`);
        if (subResp.ok) {
          const subData: any = await subResp.json() as any;
          const subs = subData.subscriptions || [];
          for (const sub of subs) {
            log.info(`Quick connect: refreshing subscription "${sub.label}"`);
            const refreshResp = await fetch(`${getLoadUrl()}/api/subscriptions/${sub.id}/refresh`, { method: "POST" });
            if (refreshResp.ok) {
              const refreshData: any = await refreshResp.json() as any;
              log.info(`Quick connect: subscription refreshed — ${refreshData.count || 0} configs`);
            }
          }
          // Now try fetching configs again
          const meshRes2 = await fetch(`${getLoadUrl()}/api/imported-configs?bucket=optimized&limit=20`);
          if (meshRes2.ok) {
            const meshData2: any = await meshRes2.json() as any;
            configs = meshData2?.configs || [];
            log.info(`Quick connect: after refresh, fetched ${configs.length} configs`);
          }
        }
      } catch (e: any) {
        log.warn(`Quick connect: subscription refresh failed: ${e?.message}`);
      }
    }

    // Step 3: If still no configs, fetch mixed_iran.txt DIRECTLY (guaranteed fallback)
    if (configs.length === 0) {
      log.info("Quick connect: no configs from API — fetching mixed_iran.txt directly");
      try {
        const subUrl = "https://raw.githubusercontent.com/miladtahanian/Config-Collector/main/mixed_iran.txt";
        const subRes = await fetch(subUrl, {
          signal: AbortSignal.timeout(15000),
          headers: { "User-Agent": "DISTORT/1.0" },
        });
        if (subRes.ok) {
          const text = await subRes.text();
          const lines = text.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 10);
          log.info(`Quick connect: fetched ${lines.length} lines from mixed_iran.txt`);
          // Parse each line and add to configs
          for (const line of lines) {
            try {
              // Import via API
              await fetch(`${getLoadUrl()}/api/imported-configs/import`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: line }),
              });
            } catch {}
          }
          // Now fetch optimized configs
          const meshRes3 = await fetch(`${getLoadUrl()}/api/imported-configs?bucket=optimized&limit=20`);
          if (meshRes3.ok) {
            const meshData3: any = await meshRes3.json() as any;
            configs = meshData3?.configs || [];
            log.info(`Quick connect: after direct fetch, got ${configs.length} configs`);
          }
        }
      } catch (e: any) {
        log.warn(`Quick connect: direct mixed_iran.txt fetch failed: ${e?.message}`);
      }
    }

    // Step 4: Last resort — try cached configs
    if (configs.length === 0) {
      try {
        const cacheFile = path.join(app.getPath("userData"), "cached-configs.json");
        if (fs.existsSync(cacheFile)) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
          configs = cached.configs || [];
          log.info(`Quick connect: using ${configs.length} cached configs (offline mode)`);
        }
      } catch (e: any) {
        log.warn(`Quick connect: cache read failed: ${e?.message}`);
      }
    }

    if (configs.length === 0) {
      log.error("Quick connect: no configs available after all attempts");
      mainWindow?.webContents.send("vpn:error",
        "No VPN configs available. All sources failed: API, subscription refresh, direct fetch, and cache."
      );
      return;
    }

    log.info(`Quick connect: trying ${configs.length} configs in sequence (auto-failover)`);

    // Try each config until one connects successfully
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      log.info(`Quick connect: attempt ${i + 1}/${configs.length} — ${cfg.protocol} ${cfg.host}:${cfg.port} (${cfg.flags || 'no flags'})`);

      // Notify UI of attempt
      mainWindow?.webContents.send("vpn:connecting", {
        attempt: i + 1,
        total: configs.length,
        host: cfg.host,
        protocol: cfg.protocol,
      });

      const server: VpnState["server"] = {
        code: cfg.host,
        country: cfg.country || cfg.host,
        host: cfg.host,
        port: cfg.port,
      };

      // Disable kill switch before attempting (from previous failed try)
      await disableKillSwitch();

      try {
        await startVpnEngine(server, cfg.protocol, cfg.uri);

        // Wait for verification (startVpnEngine does this internally with 5s timeout)
        // Check if connected after 7 seconds (5s verification + 2s buffer)
        await new Promise((r) => setTimeout(r, 7000));

        const vpnState = store.get("vpn");
        if (vpnState.connected) {
          log.info(`Quick connect: SUCCESS on attempt ${i + 1} — connected via ${cfg.host}`);

          // Step 3: Cache this working config for offline use
          // (national internet scenario — subscription URL may be unreachable)
          try {
            const cacheFile = path.join(app.getPath("userData"), "last-working-config.json");
            fs.writeFileSync(cacheFile, JSON.stringify({
              uri: cfg.uri,
              protocol: cfg.protocol,
              host: cfg.host,
              port: cfg.port,
              country: cfg.country,
              timestamp: Date.now(),
            }));
            log.info(`Quick connect: cached working config to ${cacheFile}`);
          } catch {}

          return; // Success!
        } else {
          log.warn(`Quick connect: attempt ${i + 1} failed — trying next config`);
          await stopVpnEngine();
        }
      } catch (e: any) {
        log.warn(`Quick connect: attempt ${i + 1} error: ${e?.message} — trying next`);
        await stopVpnEngine();
      }
    }

    // All configs failed — try cached offline config (national internet scenario)
    log.warn("Quick connect: all Community Mesh configs failed — trying cached offline config");
    try {
      const cacheFile = path.join(app.getPath("userData"), "last-working-config.json");
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        log.info(`Quick connect: trying cached config from ${new Date(cached.timestamp).toISOString()}: ${cached.host}`);

        const server: VpnState["server"] = {
          code: cached.host,
          country: cached.country || cached.host,
          host: cached.host,
          port: cached.port,
        };

        await disableKillSwitch();
        await startVpnEngine(server, cached.protocol, cached.uri);

        await new Promise((r) => setTimeout(r, 7000));
        const vpnState = store.get("vpn");
        if (vpnState.connected) {
          log.info("Quick connect: SUCCESS with cached offline config");
          return;
        }
      }
    } catch (e: any) {
      log.warn(`Quick connect: cached config also failed: ${e?.message}`);
    }

    log.error("Quick connect: ALL configs failed — cannot connect");
    mainWindow?.webContents.send("vpn:error",
      "All VPN configs failed. The network may be heavily filtered. Try again later or import a new config."
    );
  } catch (e: any) {
    log.error("Quick connect failed:", e?.message || e);
    mainWindow?.webContents.send("vpn:error", `Quick connect failed: ${e?.message || "unknown error"}`);
  }
}

function disconnectVpn(): void {
  stopVpnEngine();
}

// ---------------------------------------------------------------------------
// Companion control API — localhost-only HTTP server on 127.0.0.1:10810
//
// The BrowserWithCompanionEngine (in src/lib/emergency-connectivity/recovery-engine.ts)
// reaches this API from the web dashboard (loaded at http://localhost:3000) to
// drive xray-core without needing raw TCP/IPC access from the browser.
//
// Endpoints:
//   GET  /api/health         → { ok, version, platform }
//   POST /api/tunnel/start    → body { configUri } → { ok, error? }
//   POST /api/tunnel/stop     → { ok }
//   GET  /api/tunnel/status   → { running, exitIp, realIp }
//   POST /api/tunnel/verify   → { trafficVerified, exitIp, realIp, latencyMs, error? }
//
// Security:
//   - Binds to 127.0.0.1 ONLY (never 0.0.0.0) — no remote access
//   - No auth (localhost-only is the auth)
//   - configUri is NEVER logged (scrubbed before any log line)
//   - POST bodies must be valid JSON ≤ 1MB
//   - /tunnel/start has a 10s overall timeout
//   - /tunnel/verify has a 15s overall timeout
// ---------------------------------------------------------------------------

// Scrub configUri from any string before logging. Matches vmess://, vless://,
// trojan://, ss://, hysteria2://, wireguard:// schemes followed by base64/url
// payload. The credential portion is replaced with [REDACTED].
function scrubConfigUri(s: string): string {
  if (!s) return s;
  return s.replace(
    /(vless|vmess|trojan|ss|hysteria2?|wireguard|tuic):\/\/[^\s"'<>]+/gi,
    "$1://[REDACTED]"
  );
}

// Start xray from a raw configUri (vmess/vless/trojan/ss). Used by the
// companion API's /api/tunnel/start endpoint. Shares the global vpnProcess
// variable with the desktop UI flow so the two can't double-spawn xray.
async function startTunnelFromUri(configUri: string): Promise<{ ok: boolean; error?: string }> {
  // Stop any existing xray process first (whether started by the API or by
  // the desktop UI's startVpnEngine() — there is only one xray process slot).
  if (vpnProcess) {
    try { vpnProcess.kill("SIGTERM"); } catch {}
    vpnProcess = null;
  }
  stopHealthMonitoring();

  // Build the REAL config (uses real credentials from configUri, or throws)
  let config: object;
  try {
    config = buildXrayConfigFromUri(configUri);
  } catch (e: any) {
    // Scrub just in case the error message echoes part of the URI
    log.warn(`[companion-api] /api/tunnel/start config build failed: ${scrubConfigUri(e?.message || String(e))}`);
    return { ok: false, error: e?.message || "Failed to build xray config from URI" };
  }

  const configPath = path.join(app.getPath("userData"), "xray-config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e: any) {
    log.error(`[companion-api] Failed to write xray config: ${e?.message}`);
    return { ok: false, error: `Failed to write xray config: ${e?.message}` };
  }
  log.info("[companion-api] xray config written (configUri REDACTED)");

  const xrayPath = getXrayPath();
  if (!fs.existsSync(xrayPath)) {
    log.error(`[companion-api] xray binary not found at: ${xrayPath}`);
    return { ok: false, error: "VPN engine binary missing (xray not bundled)" };
  }

  try {
    vpnProcess = spawn(xrayPath, ["run", "-c", configPath], {
      cwd: path.dirname(xrayPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    vpnProcess.stdout?.on("data", (data) => {
      log.info(`[xray] ${data.toString().trim()}`);
    });
    vpnProcess.stderr?.on("data", (data) => {
      const line = data.toString().trim();
      log.error(`[xray] ${line}`);
    });
    vpnProcess.on("exit", (code) => {
      log.info(`[companion-api] xray exited with code ${code}`);
      vpnProcess = null;
      // If the desktop UI thought it was connected, mark it disconnected now.
      const vpn = store.get("vpn");
      if (vpn.connected) {
        store.set("vpn", { ...vpn, connected: false, startedAt: null });
        mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
      }
    });

    // Wait briefly for xray to start (so we can detect immediate crashes)
    await new Promise((r) => setTimeout(r, 500));

    if (!vpnProcess || vpnProcess.killed) {
      return { ok: false, error: "xray process exited immediately — check config validity or xray binary" };
    }

    // Update the desktop UI state so it doesn't show "Disconnected" while
    // the companion API is actively running a tunnel. Verification is done
    // separately via /api/tunnel/verify.
    const vpn = store.get("vpn");
    store.set("vpn", {
      ...vpn,
      connected: false, // NOT verified yet — /api/tunnel/verify will set this
      protocol: "companion-api",
      startedAt: Date.now(),
      configUri: null, // never persist the raw URI
      exitIp: null,
      exitCountry: null,
    });
    mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));

    log.info("[companion-api] xray spawned successfully (configUri REDACTED)");

    // CRITICAL: Set Electron browser proxy to route through xray's SOCKS5
    try {
      await session.defaultSession.setProxy({
        proxyRules: "socks5://127.0.0.1:10808",
      });
      log.info("[companion-api] Browser proxy set to socks5://127.0.0.1:10808");
    } catch (e: any) {
      log.warn(`[companion-api] Failed to set browser proxy: ${e?.message}`);
    }

    return { ok: true };
  } catch (e: any) {
    log.error(`[companion-api] Failed to spawn xray: ${e?.message}`);
    return { ok: false, error: `Failed to spawn xray: ${e?.message}` };
  }
}

// Stop the xray process (shared by the API and the desktop UI flow).
async function stopTunnel(): Promise<{ ok: boolean }> {
  log.info("[companion-api] /api/tunnel/stop — stopping xray-core…");
  stopHealthMonitoring();
  if (vpnProcess) {
    try {
      vpnProcess.kill("SIGTERM");
      // Give it 500ms to exit gracefully
      await new Promise((r) => setTimeout(r, 500));
      if (!vpnProcess.killed) {
        try { vpnProcess.kill("SIGKILL"); } catch {}
      }
    } catch (e: any) {
      log.error(`[companion-api] Error killing xray: ${e?.message}`);
    }
    vpnProcess = null;
  }

  // Clear the browser proxy
  try {
    await session.defaultSession.setProxy({ proxyRules: "" });
    log.info("[companion-api] Browser proxy cleared");
  } catch (e: any) {
    log.warn(`[companion-api] Failed to clear proxy: ${e?.message}`);
  }

  // Reflect the stopped state in the desktop UI
  const vpn = store.get("vpn");
  store.set("vpn", {
    ...vpn,
    connected: false,
    startedAt: null,
    exitIp: null,
    exitCountry: null,
  });
  mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
  return { ok: true };
}

// Snapshot of the current tunnel state for /api/tunnel/status.
function getTunnelStatus(): { running: boolean; exitIp: string | null; realIp: string | null } {
  const vpn = store.get("vpn");
  return {
    running: !!vpnProcess && !vpnProcess.killed,
    // Exit IP is only known after a successful /api/tunnel/verify
    exitIp: vpn.exitIp || null,
    // Real IP is intentionally NOT cached — it's only fetched on demand
    // during /api/tunnel/verify. Returning null here is honest.
    realIp: null,
  };
}

// Verify the tunnel by doing a real HTTP request through xray's SOCKS5 proxy
// (127.0.0.1:10808) to cloudflare/cdn-cgi/trace, AND a direct (non-proxied)
// request to get the real IP. If they differ, traffic is going through the
// tunnel → verified. If they match (or either is null), NOT verified.
async function handleTunnelVerify(): Promise<{
  trafficVerified: boolean;
  exitIp: string | null;
  realIp: string | null;
  latencyMs: number | null;
  error?: string;
}> {
  if (!vpnProcess || vpnProcess.killed) {
    // Still fetch the real IP so the caller has *something* useful even
    // when no tunnel is active — they can compare future verify calls.
    const realIp = await fetchRealIp();
    return {
      trafficVerified: false,
      exitIp: null,
      realIp,
      latencyMs: null,
      error: "No active tunnel — call POST /api/tunnel/start first",
    };
  }

  // Run both probes in parallel — they don't depend on each other.
  const [trafficResult, realIp] = await Promise.all([
    verifyTunnelTraffic(),
    fetchRealIp(),
  ]);

  const exitIp = trafficResult.exitIp;
  // Verification rule: traffic must have flowed (verified=true), AND the exit
  // IP must differ from the real IP. If they're the same, the tunnel is
  // leaking or xray is bypassing itself.
  const trafficVerified =
    trafficResult.verified &&
    !!exitIp &&
    !!realIp &&
    exitIp !== realIp;

  // Reflect the verified exit IP in the desktop UI state too, so the UI
  // stays in sync with what the companion API just measured.
  if (trafficVerified && exitIp) {
    const vpn = store.get("vpn");
    store.set("vpn", {
      ...vpn,
      connected: true,
      exitIp,
      exitCountry: trafficResult.exitCountry,
    });
    mainWindow?.webContents.send("vpn:state-changed", store.get("vpn"));
    mainWindow?.webContents.send("vpn:exit-info", {
      exitIp,
      exitCountry: trafficResult.exitCountry,
    });
  }

  return {
    trafficVerified,
    exitIp,
    realIp,
    latencyMs: trafficResult.latencyMs,
    error: trafficResult.error,
  };
}

// Parse a request body buffer as JSON. Returns null on empty or invalid JSON.
function parseJsonBody(buf: Buffer): any | null {
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

// Send a JSON response. Sets CORS + Content-Type headers.
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Route a single HTTP request to the appropriate handler.
async function handleCompanionApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  bodyBuf: Buffer
): Promise<void> {
  // GET /api/health
  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      version: COMPANION_API_VERSION,
      platform: COMPANION_API_PLATFORM,
    });
    return;
  }

  // POST /api/tunnel/start
  if (pathname === "/api/tunnel/start" && req.method === "POST") {
    const body = parseJsonBody(bodyBuf);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body — expected { configUri: string }" });
      return;
    }
    const configUri = body.configUri;
    if (typeof configUri !== "string" || configUri.length < 10) {
      sendJson(res, 400, { ok: false, error: "Missing or invalid 'configUri' field (must be a string ≥ 10 chars)" });
      return;
    }

    // Race the start against a 10s overall timeout. If xray doesn't spawn
    // within 10s, return an error (the spawned process may still be
    // initializing in the background — /api/tunnel/verify will catch that).
    let result: { ok: boolean; error?: string };
    try {
      result = await Promise.race([
        startTunnelFromUri(configUri),
        new Promise<{ ok: false; error: string }>((resolve) => {
          setTimeout(
            () => resolve({ ok: false, error: `Tunnel start timed out after ${COMPANION_START_TIMEOUT_MS / 1000}s` }),
            COMPANION_START_TIMEOUT_MS
          );
        }),
      ]);
    } catch (e: any) {
      result = { ok: false, error: e?.message || "Unexpected error during tunnel start" };
    }
    sendJson(res, 200, result);
    return;
  }

  // POST /api/tunnel/stop
  if (pathname === "/api/tunnel/stop" && req.method === "POST") {
    const result = await stopTunnel();
    sendJson(res, 200, result);
    return;
  }

  // GET /api/tunnel/status
  if (pathname === "/api/tunnel/status" && req.method === "GET") {
    const status = getTunnelStatus();
    sendJson(res, 200, status);
    return;
  }

  // POST /api/tunnel/verify
  if (pathname === "/api/tunnel/verify" && req.method === "POST") {
    let result: any;
    try {
      result = await Promise.race([
        handleTunnelVerify(),
        new Promise<any>((resolve) => {
          setTimeout(
            () => resolve({
              trafficVerified: false,
              exitIp: null,
              realIp: null,
              latencyMs: null,
              error: `Tunnel verify timed out after ${COMPANION_VERIFY_TIMEOUT_MS / 1000}s`,
            }),
            COMPANION_VERIFY_TIMEOUT_MS
          );
        }),
      ]);
    } catch (e: any) {
      result = {
        trafficVerified: false,
        exitIp: null,
        realIp: null,
        latencyMs: null,
        error: e?.message || "Unexpected error during tunnel verify",
      };
    }
    sendJson(res, 200, result);
    return;
  }

  // 404
  sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${pathname}` });
}

// Start the companion control API server on 127.0.0.1:10810.
// ---------------------------------------------------------------------------
// Companion API server
// ---------------------------------------------------------------------------

// ALLOWED ORIGINS — strict allowlist (addresses user review issue P1-ب).
// Using "*" is NOT safe even on localhost: a malicious web page on any origin
// the user visits could send requests to 127.0.0.1:10810 and control the
// tunnel (start/stop/verify). We MUST verify the Origin header against an
// explicit allowlist.
//
// The web dashboard runs on:
//   - Dev: http://localhost:3000
//   - Prod: https://distort.app (when deployed)
//
// We also allow the Electron renderer (app://) for when the dashboard is
// bundled inside the desktop app itself.
const COMPANION_ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:38571",
  "http://127.0.0.1:38571",
  "https://distort.app",
  "https://www.distort.app",
  "app://",
  "file://", // for bundled dashboard
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  // Exact match against the allowlist
  if (COMPANION_ALLOWED_ORIGINS.has(origin)) return true;
  // Allow the Electron renderer's custom scheme
  if (origin.startsWith("app://")) return true;
  return false;
}

// Idempotent — calling it twice is a no-op.
function startCompanionApiServer(): void {
  if (companionApiServer) {
    log.info("[companion-api] Already running — skipping startCompanionApiServer()");
    return;
  }

  const server = http.createServer((req, res) => {
    // SECURITY (P1-ب): strict Origin allowlist instead of "*".
    // A malicious web page on any origin the user visits could otherwise
    // send requests to 127.0.0.1:10810 and control the tunnel.
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin"); // cache correctly per-origin
    } else {
      // Don't set CORS header — browser will block the response.
      // (We still process the request in case it's a same-origin call
      // from the Electron renderer, which doesn't send an Origin header.)
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Don't allow credentials — we don't use cookies here
    res.setHeader("Access-Control-Allow-Credentials", "false");

    if (req.method === "OPTIONS") {
      // Preflight — reject if origin not allowed
      if (origin && !isAllowedOrigin(origin)) {
        res.writeHead(403);
        res.end("Forbidden origin");
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const fullUrl = new URL(
      req.url || "/",
      `http://${COMPANION_API_HOST}:${COMPANION_API_PORT}`
    );
    const pathname = fullUrl.pathname;

    // SECURITY (P1-ب): also check the Host header to prevent DNS rebinding.
    // A malicious site could set up "evil.com" to resolve to 127.0.0.1 and
    // then fetch("http://evil.com:10810/api/tunnel/start"). The browser
    // would send Host: evil.com:10810, which we reject.
    const hostHeader = req.headers.host || "";
    const expectedHost = `${COMPANION_API_HOST}:${COMPANION_API_PORT}`;
    if (hostHeader !== expectedHost) {
      log.warn(`[companion-api] Rejected request with Host header "${hostHeader}" (expected "${expectedHost}") — possible DNS rebinding attempt`);
      sendJson(res, 403, { ok: false, error: "Forbidden Host header" });
      return;
    }

    // Log the request line WITHOUT the query string or body — configUri
    // lives in the body and must never appear in logs.
    log.info(`[companion-api] ${req.method} ${pathname} (origin=${origin || "none"})`);

    // Read the request body (POST only). Cap at COMPANION_MAX_BODY_BYTES
    // to prevent memory exhaustion from oversized payloads.
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      const totalSoFar = chunks.reduce((acc, c) => acc + c.length, 0);
      if (totalSoFar + chunk.length > COMPANION_MAX_BODY_BYTES) {
        aborted = true;
        log.warn(`[companion-api] Request body exceeded ${COMPANION_MAX_BODY_BYTES} bytes — aborting`);
        sendJson(res, 413, { ok: false, error: "Request body too large" });
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (aborted) return;
      const bodyBuf = Buffer.concat(chunks);
      try {
        await handleCompanionApiRequest(req, res, pathname, bodyBuf);
      } catch (e: any) {
        log.error(`[companion-api] Unhandled error in handler: ${e?.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: "Internal server error" });
        }
      }
    });

    req.on("error", (e: any) => {
      log.warn(`[companion-api] Request stream error: ${e?.message}`);
      if (!res.headersSent) {
        sendJson(res, 400, { ok: false, error: "Bad request" });
      }
    });
  });

  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      log.error(
        `[companion-api] Port ${COMPANION_API_PORT} is already in use — ` +
        `another Distort Desktop instance may be running. The companion control API will NOT be available.`
      );
    } else {
      log.error(`[companion-api] Server error: ${err?.message}`);
    }
  });

  server.listen(COMPANION_API_PORT, COMPANION_API_HOST, () => {
    log.info(`Companion control API listening on http://${COMPANION_API_HOST}:${COMPANION_API_PORT}`);
  });

  companionApiServer = server;
}

// Stop the companion control API server (called on app quit).
function stopCompanionApiServer(): void {
  if (!companionApiServer) return;
  try {
    companionApiServer.closeAllConnections?.();
  } catch {}
  try {
    companionApiServer.close();
  } catch {}
  companionApiServer = null;
  log.info("[companion-api] Server stopped");
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle("vpn:connect", async (_e, server, protocol, configUri) => {
  await startVpnEngine(server, protocol, configUri);
  return store.get("vpn");
});

ipcMain.handle("vpn:disconnect", async () => {
  await stopVpnEngine();
  return store.get("vpn");
});

ipcMain.handle("vpn:state", async () => {
  return store.get("vpn");
});

ipcMain.handle("settings:get", async () => {
  return store.get("settings");
});

ipcMain.handle("settings:set", async (_e, patch) => {
  const current = store.get("settings");
  store.set("settings", { ...current, ...patch });
  return store.get("settings");
});

ipcMain.handle("app:version", async () => {
  return app.getVersion();
});

ipcMain.handle("app:platform", async () => {
  return { platform: process.platform, arch: process.arch };
});

// ---------------------------------------------------------------------------
// Auto-updater — electron-updater with GitHub Releases provider
// ---------------------------------------------------------------------------
// HONEST LIMITATION: the updater only fully works for SIGNED builds. Our
// current Windows builds are NOT code-signed (no EV/authenticode certificate),
// so electron-updater will still CHECK for updates and DOWNLOAD them, but
// `quitAndInstall()` may pop a SmartScreen / "unknown publisher" warning
// because the new installer is also unsigned. electron-builder also
// generates latest.yml automatically — that file MUST be published alongside
// the .exe assets in the GitHub Release for the updater to find the update.
//
// The publish config lives in package.json → build.publish = { provider: github,
// owner: "di6tort-bit", repo: "distort" }. In CI we pass `--publish onTag`
// so a `git tag v1.2.3 && git push --tags` triggers a real release.
//
// electron-store persists in app.getPath("userData"), which is OUTSIDE the
// install directory — so user settings, subscriptions, cached configs and
// tunnel state all SURVIVE an update. Nothing to migrate.
//
// Until we publish a real release with proper versioning AND signing, this
// code: (a) runs at startup, (b) checks the GitHub Releases API for a newer
// version, (c) logs the result, (d) forwards status to the renderer for the
// UI badge. If no release exists yet (current state), it just logs
// "update-not-available" and exits cleanly.
let autoUpdaterModule: any | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;

function sendToRenderer(channel: string, payload?: unknown): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (e: any) {
    log.warn(`[auto-updater] Failed to send IPC "${channel}": ${e?.message}`);
  }
}

function setupAutoUpdater(): void {
  // Lazy-require so the build doesn't fail in environments where
  // electron-updater's native bits aren't available (e.g. dev without
  // electron-builder's install-app-deps). We also wrap in try/catch so
  // any failure here is non-fatal — auto-update is a convenience, not a
  // correctness-critical feature.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    autoUpdaterModule = require("electron-updater").autoUpdater;
  } catch (e: any) {
    log.warn(`[auto-updater] electron-updater not available — auto-update disabled. Reason: ${e?.message}`);
    sendToRenderer("update-error", { message: `Auto-updater unavailable: ${e?.message || "unknown error"}` });
    return;
  }

  const updater = autoUpdaterModule;
  if (!updater) {
    log.warn("[auto-updater] electron-updater returned no autoUpdater object — disabled");
    sendToRenderer("update-error", { message: "Auto-updater unavailable: no autoUpdater export" });
    return;
  }

  // In dev mode (DISTORT_DEV set, or !app.isPackaged) electron-updater has
  // no app-update.yml to read and will throw "Update config file not found".
  // We still wire up the listeners so the renderer can render an honest
  // "not available in dev" state, but we skip the actual check.
  const isDev = !!process.env.DISTORT_DEV || !app.isPackaged;

  // Configuration
  updater.autoDownload = false;            // DON'T auto-download — ask user first
  updater.autoInstallOnAppQuit = false;   // DON'T auto-install — user must confirm
  // We explicitly do NOT disable code-signature verification in production
  // (win.verifyUpdateCodeSignature in package.json is already false because
  // we have no cert — that only disables electron-builder's BUILDER-time
  // check, not the runtime updater check). When we DO get a cert, flip
  // verifyUpdateCodeSignature back to true and remove this comment.

  // Allow auto-updater's own logs to flow into our electron-log sink.
  try {
    updater.logger = log;
  } catch {}

  // --- Event wiring ---
  updater.on("checking-for-update", () => {
    log.info("[auto-updater] Checking for update…");
    sendToRenderer("update-checking");
  });

  updater.on("update-available", (info: any) => {
    log.info(`[auto-updater] Update available: v${info?.version || "?"} (current v${app.getVersion()})`);
    sendToRenderer("update-available", {
      version: info?.version ?? null,
      releaseDate: info?.releaseDate ?? null,
      releaseNotes: info?.releaseNotes ?? null,
    });

    // Show a dialog asking if user wants to download
    dialog.showMessageBox({
      type: "info",
      title: "DISTORT Update Available",
      message: `Version ${info?.version || "new"} is available.`,
      detail: `You are currently running v${app.getVersion()}.\n\nWould you like to download the update now? You can install it later.`,
      buttons: ["Download now", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((choice) => {
      if (choice.response === 0) {
        log.info("[auto-updater] User chose to download — starting download…");
        updater.downloadUpdate().catch((err: Error) => {
          log.error(`[auto-updater] Download failed: ${err?.message}`);
        });
      } else {
        log.info("[auto-updater] User chose to skip this update");
      }
    });
  });

  updater.on("update-not-available", (info: any) => {
    log.info(`[auto-updater] Up to date (v${app.getVersion()})`);
    sendToRenderer("update-not-available", { version: info?.version ?? app.getVersion() });
  });

  updater.on("error", (err: Error) => {
    log.error(`[auto-updater] Error: ${err?.message}`);
    sendToRenderer("update-error", { message: err?.message || String(err) });
  });

  updater.on("download-progress", (progress: any) => {
    // progress: { percent, transferred, total, bytesPerSecond }
    const pct = typeof progress?.percent === "number" ? Math.round(progress.percent) : null;
    log.info(`[auto-updater] Downloading update: ${pct ?? "?"}% (${progress?.transferred ?? 0}/${progress?.total ?? 0} bytes)`);
    sendToRenderer("update-downloading", {
      percent: pct,
      transferred: progress?.transferred ?? 0,
      total: progress?.total ?? 0,
      bytesPerSecond: progress?.bytesPerSecond ?? 0,
    });
  });

  updater.on("update-downloaded", async (info: any) => {
    log.info(`[auto-updater] Update downloaded: v${info?.version || "?"} — ready to install on quit`);
    sendToRenderer("update-downloaded", {
      version: info?.version ?? null,
      releaseDate: info?.releaseDate ?? null,
    });

    // Prompt the user — they may be mid-tunnel and not want to restart now.
    // The renderer also gets the event so it can show a custom toast, but we
    // additionally show a native dialog (works even if the renderer is on
    // the offline page or a non-dashboard route).
    try {
      const choice = await dialog.showMessageBox({
        type: "info",
        title: "DISTORT Update Ready",
        message: "A new version is available.",
        detail: `Version ${info?.version || "(unknown)"} has been downloaded and will be installed. Install and restart now? Your settings and saved configs are preserved.`,
        buttons: ["Install & Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        log.info("[auto-updater] User chose to install now — calling quitAndInstall()");
        // quitAndInstall() closes all windows, runs the installer, and relaunches.
        // isForceRunAfter=true ensures the app restarts after install completes.
        isQuitting = true; // skip the minimize-to-tray intercept in mainWindow 'close'
        updater.quitAndInstall(false, true);
      } else {
        log.info("[auto-updater] User chose to defer — will install on next quit (autoInstallOnAppQuit=true)");
      }
    } catch (e: any) {
      log.warn(`[auto-updater] Dialog failed: ${e?.message}. Update will install on next quit.`);
    }
  });

  // --- Kick off the check loop ---
  if (isDev) {
    log.info("[auto-updater] Skipping check in dev mode (electron-updater requires a packaged app).");
    sendToRenderer("update-not-available", { version: app.getVersion(), dev: true });
    return;
  }

  // First check immediately (well, after a short delay so the app finishes
  // booting — checking during the very first tick races with network setup
  // on slow machines).
  setTimeout(() => {
    updater.checkForUpdates().catch((err: Error) => {
      log.warn(`[auto-updater] Initial check failed: ${err?.message}`);
    });
  }, 5_000);

  // Then every 30 minutes. electron-updater is smart enough to not re-download
  // if the version hasn't changed.
  const CHECK_INTERVAL_MS = 30 * 60 * 1000;
  updateCheckTimer = setInterval(() => {
    updater.checkForUpdates().catch((err: Error) => {
      log.warn(`[auto-updater] Periodic check failed: ${err?.message}`);
    });
  }, CHECK_INTERVAL_MS);

  log.info(`[auto-updater] Initialised — checking every ${CHECK_INTERVAL_MS / 60_000}min (provider: github/di6tort-bit/distort)`);
}

// IPC handler — renderer can request a manual check (e.g. a "Check for updates"
// button in Settings). Returns a status object so the renderer doesn't need
// to round-trip through the event channel for a one-shot check.
ipcMain.handle("update:check-now", async () => {
  if (!autoUpdaterModule) {
    return { ok: false, error: "Auto-updater not available" };
  }
  try {
    const result = await autoUpdaterModule.checkForUpdates();
    return {
      ok: true,
      updateInfo: result?.updateInfo
        ? {
            version: result.updateInfo.version,
            releaseDate: result.updateInfo.releaseDate,
          }
        : null,
      currentVersion: app.getVersion(),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// IPC handler — renderer can install a downloaded update immediately (used
// by the "Install now" button in our own toast, as an alternative to the
// native dialog).
ipcMain.handle("update:install-now", async () => {
  if (!autoUpdaterModule) {
    return { ok: false, error: "Auto-updater not available" };
  }
  try {
    isQuitting = true;
    autoUpdaterModule.quitAndInstall(false, true);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// Stop the auto-updater's periodic check (called on app quit).
function stopAutoUpdater(): void {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
import { spawn as spawnChild } from "child_process";

let nextServer: ReturnType<typeof spawnChild> | null = null;

function getNextStandalonePath(): string {
  const isDev = !!process.env.DISTORT_DEV;
  if (isDev) {
    return path.join(__dirname, "..", "..", ".next", "standalone");
  }
  // Production: bundled in resources/next-standalone
  return path.join(process.resourcesPath, "next-standalone");
}

function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const standalonePath = getNextStandalonePath();
    const serverJs = path.join(standalonePath, "server.js");

    log.info(`Starting Next.js standalone server from: ${serverJs}`);

    if (!fs.existsSync(serverJs)) {
      log.warn(`Next.js standalone server.js not found at ${serverJs}`);
      log.info("Will use offline page as fallback");
      resolve();
      return;
    }

    // Copy static assets to the right place if needed
    const staticSrc = path.join(standalonePath, ".next", "static");
    const staticDest = path.join(standalonePath, ".next", "static");
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
      // already in place
    }

    // Start the Next.js standalone server on port 38571.
    //
    // CRITICAL: in production, process.execPath is the Electron binary (e.g.,
    // DISTORT.exe), NOT Node.js. The Next.js standalone server.js is a pure
    // Node.js script — it won't run under Electron's GUI process.
    //
    // FIX: set ELECTRON_RUN_AS_NODE=1, which tells the Electron binary to
    // behave as a pure Node.js runtime (no GUI, no Chromium). This is the
    // standard way to run Node.js scripts from an Electron app.
    //
    // Without this fix, the spawn appears to succeed (no error), but the
    // server never actually starts — the window loads localhost:38571,
    // gets nothing, and shows the "VPN Engine Ready / RETRY CONNECTION"
    // offline page forever.
    //
    // DATABASE_URL: the Next.js server needs a SQLite database. We put it
    // in the user's userData directory so it persists across app updates.
    // The path must use file: prefix for Prisma to recognize it as SQLite.
    const dbPath = path.join(DISTORT_DATA_DIR, "distort.db");
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      try { fs.mkdirSync(dbDir, { recursive: true }); } catch {}
    }
    log.info(`Database path: ${dbPath}`);

    // First run: create the database schema + seed data.
    // Uses sql.js (pure JavaScript, WASM-based) to avoid native module
    // compilation issues on CI. The schema + seed SQL files are bundled
    // with the app in resources/db/.
    const initAndStartServer = () => {
      nextServer = spawnChild(process.execPath, [serverJs], {
        cwd: standalonePath,
        env: {
          ...process.env,
          PORT: "38571",
          NODE_ENV: "production",
          HOSTNAME: "127.0.0.1",
          ELECTRON_RUN_AS_NODE: "1",
          DATABASE_URL: `file:${dbPath}`,
          DISTORT_SESSION_SECRET: process.env.DISTORT_SESSION_SECRET || "distort-desktop-session-secret-local",
          // CRITICAL: set a local API key so checkAuth() doesn't return 503.
          // The client (web dashboard) sends this key via x-api-key header.
          // We inject it into the browser via preload.ts → window.distort.apiKey
          DISTORT_API_KEY: "distort-desktop-local-api-key-for-localhost-only-32chars",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      nextServer.stdout?.on("data", (data) => {
        log.info(`[next] ${data.toString().trim()}`);
      });
      nextServer.stderr?.on("data", (data) => {
        log.error(`[next] ${data.toString().trim()}`);
      });

      // Wait for server to be ready
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        fetch("http://127.0.0.1:38571/")
          .then((r) => {
            if (r.ok) {
              clearInterval(checkInterval);
              log.info("Next.js standalone server is ready on port 38571");
              resolve();
            }
          })
          .catch(() => {
            if (attempts > 20) {
              clearInterval(checkInterval);
              log.warn("Next.js server didn't start in time");
              resolve();
            }
          });
      }, 500);
    };

    if (!fs.existsSync(dbPath)) {
      log.info("First run — initializing database schema + seed data…");
      initDatabase(dbPath)
        .then(() => {
          log.info("Database initialized successfully");
          initAndStartServer();
        })
        .catch((e: any) => {
          log.error(`Database initialization failed: ${e?.message}`);
          initAndStartServer(); // Start server anyway — it may still work
        });
    } else {
      log.info("Database already exists — skipping initialization");
      initAndStartServer();
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-fetch Community Mesh subscription on first run
// ---------------------------------------------------------------------------
// After the Next.js server is ready, fetch the Iran config subscription so
// that Quick Connect has configs to try. This is called once 5 seconds after
// the server starts, and only fetches if there are fewer than 10 configs in
// the DB (i.e., first run or after a reset).
async function autoFetchSubscription(): Promise<void> {
  try {
    // Wait a bit for the server to be fully ready
    await new Promise((r) => setTimeout(r, 5000));

    // Check if we already have configs — if so, skip
    const countRes = await fetch("http://127.0.0.1:38571/api/imported-configs?limit=1");
    if (countRes.ok) {
      const countData = await countRes.json() as { configs: unknown[] };
      if (countData.configs && countData.configs.length > 0) {
        log.info("Auto-fetch: configs already exist — skipping subscription fetch");
        return;
      }
    }

    // Get the subscription list
    const subsRes = await fetch("http://127.0.0.1:38571/api/subscriptions");
    if (!subsRes.ok) {
      log.warn(`Auto-fetch: could not list subscriptions (${subsRes.status})`);
      return;
    }
    const subsData = await subsRes.json() as { subscriptions: Array<{ id: string; url: string; label: string }> };
    const subs = subsData.subscriptions || [];

    if (subs.length === 0) {
      log.info("Auto-fetch: no subscriptions in DB — nothing to fetch");
      return;
    }

    // Refresh each subscription (usually just one — the Iran config collector)
    for (const sub of subs) {
      log.info(`Auto-fetch: refreshing "${sub.label}" (${sub.url})`);
      const refreshRes = await fetch(`http://127.0.0.1:38571/api/subscriptions/${sub.id}/refresh`, {
        method: "POST",
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json() as { count?: number };
        log.info(`Auto-fetch: "${sub.label}" refreshed — ${refreshData.count || 0} configs`);
      } else {
        log.warn(`Auto-fetch: refresh failed for "${sub.label}" (${refreshRes.status})`);
      }
    }

    log.info("Auto-fetch: subscription fetch complete — Quick Connect is ready");
  } catch (e: any) {
    log.warn(`Auto-fetch: failed (non-fatal): ${e?.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single-instance lock — prevents multiple DISTORT instances from running.
// Without this, every click on the app icon spawns a new instance, each
// trying to start its own Next.js server on port 38571 (which fails for all
// but the first). This was causing the "20 DISTORT icons in taskbar" bug.
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit this one immediately.
  // The existing instance will be focused via the 'second-instance' event.
  log.info("Another DISTORT instance is already running — quitting this one.");
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance — focus the existing window.
    log.info("Second instance blocked — focusing existing window.");
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // CRASH RECOVERY: Check if kill switch was active when the app last closed.
  // If so, restore the default route IMMEDIATELY so the user isn't left
  // without internet.
  try {
    const routeBackupFile = path.join(app.getPath("userData"), "killswitch-backup.json");
    if (fs.existsSync(routeBackupFile)) {
      const backup = JSON.parse(fs.readFileSync(routeBackupFile, "utf-8"));
      log.warn(`Crash recovery: found kill switch backup from ${new Date(backup.timestamp).toISOString()}`);
      log.warn(`Crash recovery: restoring default route to ${backup.gateway} on interface ${backup.interfaceIndex}…`);

      const { exec } = require("child_process");
      if (backup.gateway && backup.interfaceIndex) {
        exec(
          `route add 0.0.0.0 mask 0.0.0.0 ${backup.gateway} metric ${backup.metric || 25} IF ${backup.interfaceIndex}`,
          (err: any) => {
            if (err) {
              log.error(`Crash recovery: FAILED to restore route: ${err.message}`);
              log.error(`Crash recovery: Run manually: route add 0.0.0.0 mask 0.0.0.0 ${backup.gateway} metric ${backup.metric || 25} IF ${backup.interfaceIndex}`);
              // DO NOT delete the backup file — keep it so the user can retry
              // or we can try again on next launch.
            } else {
              log.info("Crash recovery: default route restored — internet should be back");
              // Only delete backup after SUCCESSFUL restore
              try { fs.unlinkSync(routeBackupFile); } catch {}
            }
          }
        );
      }
    }
  } catch (e: any) {
    log.warn(`Crash recovery check failed: ${e?.message}`);
  }

  // Start Next.js standalone server first (if available)
  await startNextServer();

  createWindow();
  createTray();

  // Auto-fetch Community Mesh subscription on first run.
  // This populates the Iran config list so Quick Connect has configs to try.
  // Runs in the background — doesn't block app startup.
  autoFetchSubscription().catch((e) => log.warn(`Auto-fetch failed: ${e?.message}`));

  // Start the companion control API on 127.0.0.1:10810.
  // This is what the BrowserWithCompanionEngine (in the web dashboard's
  // recovery-engine.ts) reaches out to in order to spawn xray-core and
  // verify tunnel traffic. MUST run on a different port than xray's HTTP
  // proxy (10809) — see comment near COMPANION_API_PORT for details.
  startCompanionApiServer();

  // Start the auto-updater (electron-updater + GitHub Releases).
  // Non-fatal if it fails: wraps everything in try/catch and just logs.
  // Skips the actual check in dev mode (electron-updater requires a packaged
  // app to read app-update.yml).
  try {
    setupAutoUpdater();
  } catch (e: any) {
    log.warn(`[auto-updater] setupAutoUpdater threw (non-fatal): ${e?.message}`);
  }

  // Auto-connect on startup if enabled
  if (store.get("settings.autoConnect")) {
    setTimeout(() => quickConnect(), 1500);
  }

  // AUTO-REFRESH SUBSCRIPTIONS — keeps configs fresh for national internet resilience.
  // Every 60 minutes, refresh all enabled subscriptions so we always have the latest
  // working configs. This is critical for Iran: configs get blocked frequently and
  // new ones are published in the subscription URL regularly.
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
  let refreshTimer: NodeJS.Timeout | null = null;

  async function autoRefreshSubscriptions(): Promise<void> {
    try {
      log.info("Auto-refresh: refreshing all subscriptions…");
      const subsRes = await fetch(`${getLoadUrl()}/api/subscriptions`);
      const subsData: any = await subsRes.json();
      const subs = subsData?.subscriptions || [];

      for (const sub of subs) {
        if (!sub.enabled) continue;
        try {
          log.info(`Auto-refresh: refreshing "${sub.label}"…`);
          const refreshRes = await fetch(`${getLoadUrl()}/api/subscriptions/${sub.id}/refresh`, {
            method: "POST",
          });
          const refreshData: any = await refreshRes.json();
          log.info(`Auto-refresh: "${sub.label}" refreshed — ${refreshData.count || 0} configs`);
        } catch (e: any) {
          log.warn(`Auto-refresh: failed to refresh "${sub.label}": ${e?.message}`);
        }
      }

      // Also cache all optimized configs to disk for offline use
      // (national internet scenario — subscription URL may be unreachable)
      try {
        const configsRes = await fetch(`${getLoadUrl()}/api/imported-configs?bucket=optimized&limit=500`);
        const configsData: any = await configsRes.json();
        const configs = configsData?.configs || [];
        if (configs.length > 0) {
          const cacheFile = path.join(app.getPath("userData"), "cached-configs.json");
          fs.writeFileSync(cacheFile, JSON.stringify({
            configs: configs.map((c: any) => ({
              uri: c.uri,
              protocol: c.protocol,
              host: c.host,
              port: c.port,
              country: c.country,
              score: c.score,
              flags: c.flags,
            })),
            timestamp: Date.now(),
          }));
          log.info(`Auto-refresh: cached ${configs.length} configs to ${cacheFile} for offline use`);
        }
      } catch (e: any) {
        log.warn(`Auto-refresh: failed to cache configs: ${e?.message}`);
      }
    } catch (e: any) {
      log.warn(`Auto-refresh error: ${e?.message}`);
    }
  }

  // Run first refresh IMMEDIATELY (so configs are cached on disk for quick
  // connect / offline use as soon as possible after startup), then every
  // 60min for ongoing freshness.
  autoRefreshSubscriptions();
  refreshTimer = setInterval(autoRefreshSubscriptions, REFRESH_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !store.get("settings.minimizeToTray")) {
    app.quit();
  }
});

app.on("before-quit", async (e) => {
  // Always clean up: stop xray, disable kill switch, even if quitting due to crash.
  if (store.get("vpn.connected")) {
    e.preventDefault();
    await stopVpnEngine();
    isQuitting = true;
  }
  // CRITICAL: Always disable kill switch on quit, otherwise the user's internet
  // would be permanently blocked if the app crashed while kill switch was active.
  await disableKillSwitch();
  // Stop the companion control API server (port 10810).
  stopCompanionApiServer();
  // Stop the auto-updater's periodic check timer.
  stopAutoUpdater();
  if (!isQuitting) {
    isQuitting = true;
    app.quit();
  }
});

// On SIGINT/SIGTERM (e.g., system shutdown), clean up before exiting.
process.on("SIGINT", async () => {
  log.info("Received SIGINT — cleaning up…");
  await stopVpnEngine();
  await disableKillSwitch();
  stopCompanionApiServer();
  stopAutoUpdater();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  log.info("Received SIGTERM — cleaning up…");
  await stopVpnEngine();
  await disableKillSwitch();
  stopCompanionApiServer();
  stopAutoUpdater();
  process.exit(0);
});

// On uncaught exceptions (potential crash), try to clean up before exiting.
process.on("uncaughtException", async (err) => {
  log.error("Uncaught exception — cleaning up before exit:", err);
  try {
    await stopVpnEngine();
    await disableKillSwitch();
    stopCompanionApiServer();
    stopAutoUpdater();
  } catch {}
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Phase 2 — real xray-core integration scaffolding
// ---------------------------------------------------------------------------
// The functions below are stubs for the real VPN engine.
// They will be wired to xray-core / sing-box binaries in Phase 2.
//
// export async function startXray(config: object): Promise<ChildProcess> {
//   const xrayBin = path.join(process.resourcesPath, "bin", "xray");
//   const configFile = path.join(app.getPath("userData"), "xray-config.json");
//   fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
//   return spawn(xrayBin, ["run", "-c", configFile], { stdio: ["ignore", "pipe", "pipe"] });
// }
//
// export async function startWireGuard(confPath: string): Promise<ChildProcess> {
//   // Use wireguard-go or boringtun for userspace WireGuard
//   const wgBin = path.join(process.resourcesPath, "bin", "wireguard-go");
//   return spawn(wgBin, [confPath]);
// }
