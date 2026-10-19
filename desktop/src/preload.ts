// DISTORT — preload (simplified)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("distort", {
  // VPN
  connect: (uri: string) => ipcRenderer.invoke("vpn:connect", uri),
  disconnect: () => ipcRenderer.invoke("vpn:disconnect"),

  // Configs
  configs: {
    get: () => ipcRenderer.invoke("configs:get"),
    add: (uri: string) => ipcRenderer.invoke("configs:add", uri),
    delete: (uri: string) => ipcRenderer.invoke("configs:delete", uri),
  },

  // Subscription
  fetchSubscription: (url: string) => ipcRenderer.invoke("subscription:fetch", url),

  // IP info
  getIpInfo: () => ipcRenderer.invoke("ip:info"),

  // Settings
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (s: any) => ipcRenderer.invoke("settings:save", s),
  },

  // App
  version: () => ipcRenderer.invoke("app:version"),

  // Events
  onConnected: (cb: () => void) => {
    ipcRenderer.on("vpn:connected", cb);
    return () => ipcRenderer.removeListener("vpn:connected", cb);
  },
  onDisconnected: (cb: () => void) => {
    ipcRenderer.on("vpn:disconnected", cb);
    return () => ipcRenderer.removeListener("vpn:disconnected", cb);
  },
  onConfigsUpdated: (cb: () => void) => {
    ipcRenderer.on("configs:updated", cb);
    return () => ipcRenderer.removeListener("configs:updated", cb);
  },
});
