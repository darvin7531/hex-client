import { app, BrowserWindow, ipcMain, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
const {
  fetchClientBootstrap,
  deleteLocalPack,
  getLauncherDiagnostics,
  getLauncherDiagnosticsForVersion,
  launchPack,
  setLauncherLogHandler,
  syncPackVersion,
  syncPack,
  updateApiBase,
  verifyPackFiles,
}: {
  fetchClientBootstrap: () => Promise<unknown>;
  deleteLocalPack: (packId: string) => Promise<unknown>;
  getLauncherDiagnostics: (packId: string) => Promise<unknown>;
  getLauncherDiagnosticsForVersion: (packId: string, packVersion?: string) => Promise<unknown>;
  launchPack: (payload: {
    packId: string;
    packVersion?: string;
    nickname: string;
    memoryMb: number;
    resolution: string;
    fullscreen: boolean;
  }) => Promise<unknown>;
  setLauncherLogHandler: (handler: ((entry: {
    level: "info" | "warn" | "error";
    scope: string;
    message: string;
  }) => void) | null) => void;
  syncPackVersion: (packId: string, packVersion?: string, repair?: boolean) => Promise<unknown>;
  syncPack: (packId: string, repair?: boolean) => Promise<unknown>;
  updateApiBase: (newUrl: string) => void;
  verifyPackFiles: (packId: string, packVersion?: string) => Promise<unknown>;
} = require("./launcher.cjs");

const { DEFAULT_API_BASE } = require("./sharedConfig.cjs");

let mainWindow: BrowserWindow | null = null;
const isDev = !app.isPackaged;

type ClientSettings = {
  nickname: string;
  memoryMb: number;
  resolution: string;
  fullscreen: boolean;
  showArchivedBuilds: boolean;
  customApiUrl?: string;
};

// Dynamically retrieve API_BASE from settings at runtime
let cachedSettings: ClientSettings | null = null;
function getApiBase(): string {
  if (process.env.HEXLOADER_API_BASE) {
    return process.env.HEXLOADER_API_BASE;
  }
  if (cachedSettings?.customApiUrl) {
    return cachedSettings.customApiUrl;
  }
  return DEFAULT_API_BASE;
}

type LauncherUpdateManifest = {
  version: string;
  notes: string;
  fileName: string;
  installerUrl: string;
  sha256: string;
  silentArgs: string[];
  mandatory: boolean;
  publishedAt: string;
  platform?: string;
};

type LauncherVersionMeta = {
  currentVersion: string;
  minimumSupportedBackend: string;
  maintenanceMode: boolean;
};

type LauncherLogEntry = {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
};

const defaultClientSettings: ClientSettings = {
  nickname: "HexPilot",
  memoryMb: 4096,
  resolution: "1920x1080",
  fullscreen: false,
  showArchivedBuilds: false,
  customApiUrl: "",
};
const launcherLogBuffer: LauncherLogEntry[] = [];

function pushLauncherLog(
  level: LauncherLogEntry["level"],
  scope: string,
  message: string,
) {
  const entry: LauncherLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
  };

  launcherLogBuffer.push(entry);
  if (launcherLogBuffer.length > 400) {
    launcherLogBuffer.splice(0, launcherLogBuffer.length - 400);
  }

  mainWindow?.webContents.send("launcher:log", entry);
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "client-settings.json");
}

async function readClientSettings(): Promise<ClientSettings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ClientSettings>;
    const settings = {
      nickname:
        typeof parsed.nickname === "string" && parsed.nickname.trim()
          ? parsed.nickname
          : defaultClientSettings.nickname,
      memoryMb:
        typeof parsed.memoryMb === "number" && Number.isFinite(parsed.memoryMb) && parsed.memoryMb > 0
          ? parsed.memoryMb
          : defaultClientSettings.memoryMb,
      resolution:
        typeof parsed.resolution === "string" && parsed.resolution.trim()
          ? parsed.resolution
          : defaultClientSettings.resolution,
      fullscreen:
        typeof parsed.fullscreen === "boolean"
          ? parsed.fullscreen
          : defaultClientSettings.fullscreen,
      showArchivedBuilds:
        typeof parsed.showArchivedBuilds === "boolean"
          ? parsed.showArchivedBuilds
          : defaultClientSettings.showArchivedBuilds,
      customApiUrl:
        typeof parsed.customApiUrl === "string"
          ? parsed.customApiUrl
          : defaultClientSettings.customApiUrl,
    };
    cachedSettings = settings;
    if (settings.customApiUrl) {
      updateApiBase(settings.customApiUrl);
    }
    return settings;
  } catch {
    cachedSettings = { ...defaultClientSettings };
    return cachedSettings;
  }
}

async function writeClientSettings(next: Partial<ClientSettings>) {
  const current = await readClientSettings();
  const merged: ClientSettings = {
    ...current,
    ...next,
    nickname:
      typeof next.nickname === "string" && next.nickname.trim()
        ? next.nickname
        : current.nickname,
    memoryMb:
      typeof next.memoryMb === "number" && Number.isFinite(next.memoryMb) && next.memoryMb > 0
        ? next.memoryMb
        : current.memoryMb,
    resolution:
      typeof next.resolution === "string" && next.resolution.trim()
        ? next.resolution
        : current.resolution,
    fullscreen:
      typeof next.fullscreen === "boolean"
        ? next.fullscreen
        : current.fullscreen,
    showArchivedBuilds:
      typeof next.showArchivedBuilds === "boolean"
        ? next.showArchivedBuilds
        : current.showArchivedBuilds,
    customApiUrl:
      typeof next.customApiUrl === "string"
        ? next.customApiUrl
        : current.customApiUrl,
  };
  cachedSettings = merged;
  if (merged.customApiUrl) {
    updateApiBase(merged.customApiUrl);
  }
  await fs.writeFile(getSettingsPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

async function sha256OfFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function parseVersion(value: string) {
  return value.split(/[^0-9A-Za-z]+/).filter(Boolean);
}

function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumeric = Number(leftPart);
    const rightNumeric = Number(rightPart);

    if (!Number.isNaN(leftNumeric) && !Number.isNaN(rightNumeric)) {
      if (leftNumeric !== rightNumeric) {
        return leftNumeric - rightNumeric;
      }
      continue;
    }

    if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

function resolveAbsoluteUrl(urlOrPath: string) {
  if (/^https?:\/\//i.test(urlOrPath)) {
    return urlOrPath;
  }

  return new URL(urlOrPath, getApiBase().replace(/\/api$/, "/")).toString();
}

async function fetchLauncherUpdate() {
  pushLauncherLog("info", "updater", "Checking launcher update manifest");
  const response = await fetch(`${getApiBase()}/launcher/update?platform=win32`, {
    headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
  });

  if (response.status === 404) {
    pushLauncherLog("info", "updater", "No launcher installer is published on the server");
    return null;
  }

  if (!response.ok) {
    pushLauncherLog("error", "updater", `Update manifest request failed with ${response.status}`);
    throw new Error(`Failed to fetch launcher update metadata: ${response.status}`);
  }

  pushLauncherLog("info", "updater", `Update manifest loaded with status ${response.status}`);
  return (await response.json()) as LauncherUpdateManifest;
}

async function fetchLauncherVersion() {
  pushLauncherLog("info", "updater", "Checking launcher version metadata");
  const response = await fetch(`${getApiBase()}/launcher/version`, {
    headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
  });

  if (!response.ok) {
    pushLauncherLog("error", "updater", `Version metadata request failed with ${response.status}`);
    throw new Error(`Failed to fetch launcher version metadata: ${response.status}`);
  }

  pushLauncherLog("info", "updater", `Version metadata loaded with status ${response.status}`);
  return (await response.json()) as LauncherVersionMeta;
}

async function getLauncherUpdateStatus() {
  const currentVersion = app.getVersion();
  const [serverVersionMeta, remote] = await Promise.all([
    fetchLauncherVersion(),
    fetchLauncherUpdate().catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }
      throw error;
    }),
  ]);
  const serverVersion = serverVersionMeta.currentVersion;
  const outdated = compareVersions(serverVersion, currentVersion) > 0;

  if (!remote || compareVersions(remote.version, currentVersion) <= 0) {
    return {
      currentVersion,
      serverVersion,
      outdated,
      available: false,
      remote: null,
    };
  }

  return {
    currentVersion,
    serverVersion,
    outdated,
    available: true,
    remote: {
      ...remote,
      installerUrl: resolveAbsoluteUrl(remote.installerUrl),
    },
  };
}

async function downloadLauncherInstaller(manifest: LauncherUpdateManifest) {
  const downloadDir = path.join(app.getPath("temp"), "hexloader-updater");
  await fs.mkdir(downloadDir, { recursive: true });
  const targetPath = path.join(downloadDir, manifest.fileName || `HexLoader-${manifest.version}.exe`);
  pushLauncherLog("info", "updater", `Downloading launcher installer ${path.basename(targetPath)}`);
  const response = await fetch(resolveAbsoluteUrl(manifest.installerUrl), {
    headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
  });

  if (!response.ok || !response.body) {
    pushLauncherLog("error", "updater", `Installer download failed with ${response.status}`);
    throw new Error(`Failed to download installer: ${response.status}`);
  }

  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(targetPath));

  if (manifest.sha256) {
    const actualHash = await sha256OfFile(targetPath);
    if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
      pushLauncherLog("error", "updater", "Installer checksum mismatch");
      throw new Error("Installer checksum mismatch");
    }
  }

  pushLauncherLog("info", "updater", `Installer saved to ${targetPath}`);
  return targetPath;
}

async function installLauncherUpdate() {
  const status = await getLauncherUpdateStatus();
  if (!status.remote || !status.available) {
    throw new Error("Launcher update is not available");
  }

  const installerPath = await downloadLauncherInstaller(status.remote);
  const extension = path.extname(installerPath).toLowerCase();
  pushLauncherLog("info", "updater", `Launching installer ${path.basename(installerPath)}`);

  if (extension === ".msi") {
    const args = ["/i", installerPath, ...(status.remote.silentArgs.length ? status.remote.silentArgs : ["/passive"])];
    const child = spawn("msiexec.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } else {
    const child = spawn(installerPath, status.remote.silentArgs.length ? status.remote.silentArgs : ["/S"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  pushLauncherLog("info", "updater", "Installer launched, closing current launcher");
  setTimeout(() => app.quit(), 300);

  return {
    currentVersion: status.currentVersion,
    targetVersion: status.remote.version,
    installerPath,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b1016",
    title: "HexLoader",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(path.join(app.getAppPath(), "dist-renderer", "index.html"));
}

app.whenReady().then(async () => {
  setLauncherLogHandler((entry) => {
    pushLauncherLog(entry.level, entry.scope, entry.message);
  });
  // Load settings to restore custom API path in main/launcher process
  await readClientSettings();
  pushLauncherLog("info", "app", `HexLoader desktop initialized, version ${app.getVersion()}`);

  ipcMain.handle("launcher:bootstrap", () => {
    return fetchClientBootstrap();
  });

  ipcMain.handle("launcher:logs:get", () => {
    return launcherLogBuffer;
  });

  ipcMain.handle("settings:get", () => {
    return readClientSettings();
  });

  ipcMain.handle("settings:update", (_event, payload: Partial<ClientSettings>) => {
    return writeClientSettings(payload);
  });

  ipcMain.handle("launcher:update-status", () => {
    return getLauncherUpdateStatus();
  });

  ipcMain.handle("launcher:install-update", () => {
    return installLauncherUpdate();
  });

  ipcMain.handle("launcher:sync", (_event, payload: { packId: string; repair?: boolean }) => {
    return syncPackVersion(payload.packId, (payload as { packVersion?: string }).packVersion, Boolean(payload.repair));
  });

  ipcMain.handle(
    "launcher:launch",
    (
      _event,
      payload: {
        packId: string;
        packVersion?: string;
        nickname: string;
        memoryMb: number;
        resolution: string;
        fullscreen: boolean;
      },
    ) => {
      return launchPack(payload);
    },
  );

  ipcMain.handle("launcher:diagnostics", (_event, payload: { packId: string }) => {
    return getLauncherDiagnosticsForVersion(payload.packId, (payload as { packVersion?: string }).packVersion);
  });

  ipcMain.handle("launcher:delete-local-pack", (_event, payload: { packId: string }) => {
    return deleteLocalPack(payload.packId);
  });

  ipcMain.handle("launcher:verify-files", (_event, payload: { packId: string; packVersion?: string }) => {
    return verifyPackFiles(payload.packId, payload.packVersion);
  });

  ipcMain.handle("filesystem:open-path", async (_event, payload: { path: string }) => {
    return shell.openPath(payload.path);
  });

  ipcMain.handle("filesystem:open-or-reveal", async (_event, payload: { path: string }) => {
    try {
      const stat = await fs.stat(payload.path);
      if (stat.isDirectory()) {
        return shell.openPath(payload.path);
      }

      shell.showItemInFolder(payload.path);
      return "";
    } catch {
      return shell.openPath(payload.path);
    }
  });

  ipcMain.handle("system:memory", () => {
    const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
    const reservedMemoryMb = totalMemoryMb >= 12288 ? 3072 : 2048;
    const recommendedMaxMemoryMb = Math.max(2048, totalMemoryMb - reservedMemoryMb);

    return {
      totalMemoryMb,
      recommendedMaxMemoryMb,
    };
  });

  ipcMain.on("window:minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) {
      return false;
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }

    mainWindow.maximize();
    return true;
  });

  ipcMain.on("window:close", () => {
    mainWindow?.close();
  });

  ipcMain.handle("window:is-maximized", () => {
    return mainWindow?.isMaximized() ?? false;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  setLauncherLogHandler(null);
});
