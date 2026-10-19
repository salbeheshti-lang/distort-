// DISTORT — preload (v2.0.3 — all features)
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("distort", {
    // VPN
    connect: (uri) => ipcRenderer.invoke("vpn:connect", uri),
    disconnect: () => ipcRenderer.invoke("vpn:disconnect"),
    tunnelStatus: () => ipcRenderer.invoke("tunnel:status"),
    // Configs
    configs: {
        get: () => ipcRenderer.invoke("configs:get"),
        add: (uri) => ipcRenderer.invoke("configs:add", uri),
        delete: (uri) => ipcRenderer.invoke("configs:delete", uri),
        search: (q) => ipcRenderer.invoke("configs:search", q),
        clear: () => ipcRenderer.invoke("configs:clear"),
    },
    // Subscription
    fetchSubscription: (url) => ipcRenderer.invoke("subscription:fetch", url),
    // IP info
    getIpInfo: () => ipcRenderer.invoke("ip:info"),
    // Speed test
    speedTest: () => ipcRenderer.invoke("speed:test"),
    // Stats
    stats: {
        get: () => ipcRenderer.invoke("stats:get"),
        reset: () => ipcRenderer.invoke("stats:reset"),
        record: (data) => ipcRenderer.invoke("stats:record", data),
    },
    // Settings
    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        save: (s) => ipcRenderer.invoke("settings:save", s),
    },
    // App
    version: () => ipcRenderer.invoke("app:version"),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
    // Events
    onConnected: (cb) => {
        ipcRenderer.on("vpn:connected", cb);
        return () => ipcRenderer.removeListener("vpn:connected", cb);
    },
    onDisconnected: (cb) => {
        ipcRenderer.on("vpn:disconnected", cb);
        return () => ipcRenderer.removeListener("vpn:disconnected", cb);
    },
    onConfigsUpdated: (cb) => {
        ipcRenderer.on("configs:updated", cb);
        return () => ipcRenderer.removeListener("configs:updated", cb);
    },
});
