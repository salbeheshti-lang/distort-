"use strict";
// DISTORT Desktop — preload script
// Exposes a safe, minimal API to the renderer (sandboxed).
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("distort", {
    // VPN
    vpn: {
        connect: (server, protocol, configUri) => electron_1.ipcRenderer.invoke("vpn:connect", server, protocol, configUri),
        disconnect: () => electron_1.ipcRenderer.invoke("vpn:disconnect"),
        getState: () => electron_1.ipcRenderer.invoke("vpn:state"),
        onStateChange: (cb) => {
            const handler = (_e, state) => cb(state);
            electron_1.ipcRenderer.on("vpn:state-changed", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:state-changed", handler);
        },
        onConnecting: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("vpn:connecting", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:connecting", handler);
        },
        onReconnecting: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("vpn:reconnecting", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:reconnecting", handler);
        },
        onCountryChange: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("vpn:country-change", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:country-change", handler);
        },
        onExitInfo: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("vpn:exit-info", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:exit-info", handler);
        },
        onError: (cb) => {
            const handler = (_e, err) => cb(err);
            electron_1.ipcRenderer.on("vpn:error", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:error", handler);
        },
        onKillSwitch: (cb) => {
            const handler = () => cb();
            electron_1.ipcRenderer.on("vpn:kill-switch-activated", handler);
            return () => electron_1.ipcRenderer.removeListener("vpn:kill-switch-activated", handler);
        },
    },
    // Settings
    settings: {
        get: () => electron_1.ipcRenderer.invoke("settings:get"),
        set: (patch) => electron_1.ipcRenderer.invoke("settings:set", patch),
    },
    // App info
    app: {
        version: () => electron_1.ipcRenderer.invoke("app:version"),
        platform: () => electron_1.ipcRenderer.invoke("app:platform"),
    },
    // Auto-updater — events flow from main → renderer; renderer can also
    // trigger a manual check or install. The renderer should register all
    // the listeners it cares about; missing channels just get ignored.
    updater: {
        onChecking: (cb) => {
            const handler = () => cb();
            electron_1.ipcRenderer.on("update-checking", handler);
            return () => electron_1.ipcRenderer.removeListener("update-checking", handler);
        },
        onAvailable: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("update-available", handler);
            return () => electron_1.ipcRenderer.removeListener("update-available", handler);
        },
        onNotAvailable: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("update-not-available", handler);
            return () => electron_1.ipcRenderer.removeListener("update-not-available", handler);
        },
        onDownloading: (cb) => {
            const handler = (_e, progress) => cb(progress);
            electron_1.ipcRenderer.on("update-downloading", handler);
            return () => electron_1.ipcRenderer.removeListener("update-downloading", handler);
        },
        onDownloaded: (cb) => {
            const handler = (_e, info) => cb(info);
            electron_1.ipcRenderer.on("update-downloaded", handler);
            return () => electron_1.ipcRenderer.removeListener("update-downloaded", handler);
        },
        onError: (cb) => {
            const handler = (_e, err) => cb(err);
            electron_1.ipcRenderer.on("update-error", handler);
            return () => electron_1.ipcRenderer.removeListener("update-error", handler);
        },
        // Manual one-shot check (returns a status object, doesn't go through
        // the event channel). Useful for a "Check for updates" button.
        checkNow: () => electron_1.ipcRenderer.invoke("update:check-now"),
        // Install a downloaded update immediately (calls quitAndInstall).
        installNow: () => electron_1.ipcRenderer.invoke("update:install-now"),
    },
    // Navigation (from tray)
    onNavigate: (cb) => {
        const handler = (_e, view) => cb(view);
        electron_1.ipcRenderer.on("navigate", handler);
        return () => electron_1.ipcRenderer.removeListener("navigate", handler);
    },
    // Capabilities — what the desktop shell can actually do
    capabilities: {
        desktopShell: true,
        vpnEngine: true, // ✅ xray-core is bundled and integrated
        autoUpdate: true,
        systemTray: true,
        minimizeToTray: true,
        communityServersConfigured: true,
        socksProxy: { host: "127.0.0.1", port: 10808 },
        httpProxy: { host: "127.0.0.1", port: 10809 },
    },
});
