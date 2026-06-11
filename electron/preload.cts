import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hexloaderDesktop", {
  platform: process.platform,
  isElectron: true,
  getBootstrap: async () => {
    return ipcRenderer.invoke("launcher:bootstrap");
  },
  getSettings: async () => {
    return ipcRenderer.invoke("settings:get");
  },
  updateSettings: async (payload: {
    nickname?: string;
    memoryMb?: number;
    resolution?: string;
    fullscreen?: boolean;
    showArchivedBuilds?: boolean;
  }) => {
    return ipcRenderer.invoke("settings:update", payload);
  },
  getLauncherUpdateStatus: async () => {
    return ipcRenderer.invoke("launcher:update-status");
  },
  installLauncherUpdate: async () => {
    return ipcRenderer.invoke("launcher:install-update");
  },
  syncPack: async (payload: { packId: string; repair?: boolean }) => {
    return ipcRenderer.invoke("launcher:sync", payload);
  },
  launchPack: async (payload: {
    packId: string;
    packVersion?: string;
    nickname: string;
    memoryMb: number;
    resolution: string;
    fullscreen: boolean;
  }) => {
    return ipcRenderer.invoke("launcher:launch", payload);
  },
  getLauncherDiagnostics: async (payload: { packId: string; packVersion?: string }) => {
    return ipcRenderer.invoke("launcher:diagnostics", payload);
  },
  deleteLocalPack: async (payload: { packId: string }) => {
    return ipcRenderer.invoke("launcher:delete-local-pack", payload);
  },
  getLauncherLogs: async () => {
    return ipcRenderer.invoke("launcher:logs:get");
  },
  onLauncherLog: (callback: (entry: {
    id: string;
    timestamp: string;
    level: "info" | "warn" | "error";
    scope: string;
    message: string;
  }) => void) => {
    const listener = (_event: unknown, entry: {
      id: string;
      timestamp: string;
      level: "info" | "warn" | "error";
      scope: string;
      message: string;
    }) => {
      callback(entry);
    };

    ipcRenderer.on("launcher:log", listener);
    return () => {
      ipcRenderer.removeListener("launcher:log", listener);
    };
  },
  openPath: async (payload: { path: string }) => {
    return ipcRenderer.invoke("filesystem:open-path", payload);
  },
  openOrRevealPath: async (payload: { path: string }) => {
    return ipcRenderer.invoke("filesystem:open-or-reveal", payload);
  },
  getSystemMemory: async () => {
    return ipcRenderer.invoke("system:memory");
  },
  minimizeWindow: async () => {
    ipcRenderer.send("window:minimize");
  },
  toggleMaximizeWindow: async () => {
    return ipcRenderer.invoke("window:toggle-maximize");
  },
  closeWindow: async () => {
    ipcRenderer.send("window:close");
  },
  isWindowMaximized: async () => {
    return ipcRenderer.invoke("window:is-maximized");
  },
});
