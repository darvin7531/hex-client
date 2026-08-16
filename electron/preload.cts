import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hexloaderDesktop", {
  platform: process.platform,
  isElectron: true,
  getBootstrap: () => ipcRenderer.invoke("launcher:bootstrap"),
  getManifest: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) => ipcRenderer.invoke("launcher:manifest", payload),
  getVersions: (payload: { packId: string; includeArchived?: boolean }) => ipcRenderer.invoke("launcher:versions", payload),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (payload: {
    nickname?: string;
    nicknameHistory?: string[];
    memoryMb?: number;
    resolution?: string;
    fullscreen?: boolean;
    customApiUrl?: string;
    optionalFilesByPack?: Record<string, string[]>;
    selectedVersionsByPack?: Record<string, string>;
    serverOverridesByPack?: Record<string, { address: string; port: number }>;
  }) => ipcRenderer.invoke("settings:update", payload),
  getLauncherUpdateStatus: () => ipcRenderer.invoke("launcher:update-status"),
  installLauncherUpdate: () => ipcRenderer.invoke("launcher:install-update"),
  syncPack: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test"; repair?: boolean; optionalFiles?: string[] }) =>
    ipcRenderer.invoke("launcher:sync", payload),
  launchPack: (payload: {
    packId: string;
    packVersion?: string;
    releaseChannel?: "stable" | "beta" | "test";
    nickname: string;
    memoryMb: number;
    resolution: string;
    fullscreen: boolean;
    optionalFiles?: string[];
  }) => ipcRenderer.invoke("launcher:launch", payload),
  getLauncherDiagnostics: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) =>
    ipcRenderer.invoke("launcher:diagnostics", payload),
  deleteLocalPack: (payload: { packId: string }) => ipcRenderer.invoke("launcher:delete-local-pack", payload),
  verifyPackFiles: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) => ipcRenderer.invoke("launcher:verify-files", payload),
  getLauncherLogs: () => ipcRenderer.invoke("launcher:logs:get"),
  getGameLogs: () => ipcRenderer.invoke("game:logs:get"),
  getGameState: () => ipcRenderer.invoke("game:state:get"),
  onGameLog: (callback: (entry: unknown) => void) => { const listener = (_event: unknown, entry: unknown) => callback(entry); ipcRenderer.on("game:log", listener); return () => ipcRenderer.removeListener("game:log", listener); },
  onGameState: (callback: (state: unknown) => void) => { const listener = (_event: unknown, state: unknown) => callback(state); ipcRenderer.on("game:state", listener); return () => ipcRenderer.removeListener("game:state", listener); },
  onLauncherLog: (callback: (entry: unknown) => void) => {
    const listener = (_event: unknown, entry: unknown) => callback(entry);
    ipcRenderer.on("launcher:log", listener);
    return () => ipcRenderer.removeListener("launcher:log", listener);
  },
  onSyncProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on("launcher:sync-progress", listener);
    return () => ipcRenderer.removeListener("launcher:sync-progress", listener);
  },
  getSystemMemory: () => ipcRenderer.invoke("system:memory"),
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),
});
