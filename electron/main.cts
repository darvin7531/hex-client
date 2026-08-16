import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import {
  assertMemoryMb,
  assertNickname,
  assertPackId,
  assertPackVersion,
  assertReleaseChannel,
  assertServerAddress,
  assertServerPort,
  assertResolution,
  assertSafeInstallerFileName,
  assertSameOriginHttpUrl,
  assertSilentArgs,
  normalizeApiBase,
  normalizeManagedRelativePath,
} from "./security/validation.cjs";
import { parseLauncherUpdate, parseLauncherVersion } from "./security/contracts.cjs";

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const {
  fetchClientBootstrap,
  fetchPackManifest,
  fetchPackVersions,
  deleteLocalPack,
  getLauncherDiagnosticsForVersion,
  launchPack,
  getGameLogs,
  getGameState,
  setGameLogHandler,
  setGameStateHandler,
  setLauncherLogHandler,
  setLauncherProgressHandler,
  syncPackVersion,
  updateApiBase,
  verifyPackFiles,
}: {
  fetchClientBootstrap: () => Promise<unknown>;
  fetchPackManifest: (packId: string, packVersion?: string, releaseChannel?: "stable" | "beta" | "test") => Promise<unknown>;
  fetchPackVersions: (packId: string, includeArchived?: boolean) => Promise<unknown>;
  deleteLocalPack: (packId: string) => Promise<unknown>;
  getLauncherDiagnosticsForVersion: (packId: string, packVersion?: string, releaseChannel?: "stable" | "beta" | "test") => Promise<unknown>;
  launchPack: (payload: {
    packId: string;
    packVersion?: string;
    releaseChannel?: "stable" | "beta" | "test";
    nickname: string;
    memoryMb: number;
    resolution: string;
    fullscreen: boolean;
    optionalFiles?: string[];
    serverOverride?: { address: string; port: number };
  }) => Promise<unknown>;
  setLauncherLogHandler: (handler: ((entry: {
    level: "info" | "warn" | "error";
    scope: string;
    message: string;
  }) => void) | null) => void;
  getGameLogs: () => unknown[];
  getGameState: () => unknown;
  setGameLogHandler: (handler: ((entry: unknown) => void) | null) => void;
  setGameStateHandler: (handler: ((state: unknown) => void) | null) => void;
  setLauncherProgressHandler: (handler: ((progress: {
    status: string;
    currentFile: string;
    downloadedFiles: number;
    totalFiles: number;
    bytesProgress: number;
    totalBytes: number;
    speedMbSec: number;
  }) => void) | null) => void;
  syncPackVersion: (packId: string, packVersion?: string, releaseChannel?: "stable" | "beta" | "test", repair?: boolean, optionalFiles?: string[]) => Promise<unknown>;
  updateApiBase: (newUrl: string) => void;
  verifyPackFiles: (packId: string, packVersion?: string, releaseChannel?: "stable" | "beta" | "test", optionalFiles?: string[]) => Promise<unknown>;
} = require("./launcher.cjs");

const {
  DEFAULT_API_BASE,
  ALLOW_CUSTOM_API_IN_PRODUCTION,
  INSTALLER_SIGNER_CERT_SHA256,
  REQUIRE_AUTHENTICODE_INSTALLER,
}: {
  DEFAULT_API_BASE: string;
  ALLOW_CUSTOM_API_IN_PRODUCTION: boolean;
  INSTALLER_SIGNER_CERT_SHA256: string;
  REQUIRE_AUTHENTICODE_INSTALLER: boolean;
} = require("./sharedConfig.cjs");

const isDev = !app.isPackaged;
const DEV_RENDERER_URL = "http://127.0.0.1:3000";
let mainWindow: BrowserWindow | null = null;

type ServerOverride = { address: string; port: number };

type ClientSettings = {
  nickname: string;
  nicknameHistory: string[];
  memoryMb: number;
  resolution: string;
  fullscreen: boolean;
  customApiUrl: string;
  optionalFilesByPack: Record<string, string[]>;
  selectedVersionsByPack: Record<string, string>;
  serverOverridesByPack: Record<string, ServerOverride>;
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
  nicknameHistory: ["HexPilot"],
  memoryMb: 4096,
  resolution: "1920x1080",
  fullscreen: false,
  customApiUrl: "",
  optionalFilesByPack: {},
  selectedVersionsByPack: {},
  serverOverridesByPack: {},
};

const launcherLogBuffer: LauncherLogEntry[] = [];
let cachedSettings: ClientSettings | null = null;
const packOperationTails = new Map<string, Promise<void>>();

async function withPackOperation<T>(packId: string, operation: () => Promise<T>): Promise<T> {
  const key = assertPackId(packId).toLowerCase();
  const previous = packOperationTails.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  const tail = task.then(() => undefined, () => undefined);
  packOperationTails.set(key, tail);
  try {
    return await task;
  } finally {
    if (packOperationTails.get(key) === tail) packOperationTails.delete(key);
  }
}

function customApiOverrideAllowed() {
  return isDev || ALLOW_CUSTOM_API_IN_PRODUCTION;
}

function getApiBase() {
  if (customApiOverrideAllowed() && process.env.HEXLOADER_API_BASE) return normalizeApiBase(process.env.HEXLOADER_API_BASE);
  if (customApiOverrideAllowed() && cachedSettings?.customApiUrl) return normalizeApiBase(cachedSettings.customApiUrl);
  return normalizeApiBase(DEFAULT_API_BASE);
}

function pushLauncherLog(level: LauncherLogEntry["level"], scope: string, message: string) {
  const entry: LauncherLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message: message.slice(0, 8192),
  };
  launcherLogBuffer.push(entry);
  if (launcherLogBuffer.length > 400) launcherLogBuffer.splice(0, launcherLogBuffer.length - 400);
  mainWindow?.webContents.send("launcher:log", entry);
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "client-settings.json");
}

function totalMemoryMb() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function windowsSystemExecutable(...parts: string[]) {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  if (!path.win32.isAbsolute(root) || root.includes("\0")) throw new Error("Invalid Windows system root");
  return path.win32.join(root, ...parts);
}

function sanitizeOptionalMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [pack, paths] of Object.entries(value as Record<string, unknown>)) {
    let packId: string;
    try { packId = assertPackId(pack); } catch { continue; }
    if (!Array.isArray(paths) || paths.length > 4096) continue;
    const unique = new Set<string>();
    for (const item of paths) {
      try { unique.add(normalizeManagedRelativePath(item)); } catch { /* ignore corrupt legacy choice */ }
    }
    out[packId] = [...unique];
  }
  return out;
}

function sanitizeNicknameHistory(value: unknown, currentNickname: string): string[] {
  const candidates = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    try {
      const nickname = assertNickname(candidate);
      const key = nickname.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(nickname);
    } catch { /* ignore invalid legacy nickname */ }
  };
  add(currentNickname);
  for (const item of candidates) {
    if (out.length >= 10) break;
    add(item);
  }
  return out.slice(0, 10);
}


function sanitizeSelectedVersions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [packKey, rawVersion] of Object.entries(value as Record<string, unknown>)) {
    try {
      const packId = assertPackId(packKey);
      const version = assertPackVersion(rawVersion);
      if (version) out[packId] = version;
    } catch { /* ignore stale/corrupt version preference */ }
  }
  return out;
}

function sanitizeServerOverrides(value: unknown): Record<string, ServerOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ServerOverride> = {};
  for (const [packKey, raw] of Object.entries(value as Record<string, unknown>)) {
    try {
      const packId = assertPackId(packKey);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const candidate = raw as Record<string, unknown>;
      out[packId] = { address: assertServerAddress(candidate.address), port: assertServerPort(candidate.port) };
    } catch { /* ignore invalid legacy override */ }
  }
  return out;
}

async function readClientSettings(): Promise<ClientSettings> {
  let parsed: Partial<ClientSettings> = {};
  try {
    parsed = JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as Partial<ClientSettings>;
  } catch {
    // First launch or corrupt settings: fall back to safe defaults.
  }

  let customApiUrl = "";
  if (customApiOverrideAllowed() && typeof parsed.customApiUrl === "string" && parsed.customApiUrl.trim()) {
    try { customApiUrl = normalizeApiBase(parsed.customApiUrl.trim()); } catch { customApiUrl = ""; }
  }

  const nickname = (() => { try { return assertNickname(parsed.nickname ?? defaultClientSettings.nickname); } catch { return defaultClientSettings.nickname; } })();
  const settings: ClientSettings = {
    nickname,
    nicknameHistory: sanitizeNicknameHistory(parsed.nicknameHistory, nickname),
    memoryMb: (() => { try { return assertMemoryMb(parsed.memoryMb ?? defaultClientSettings.memoryMb, totalMemoryMb()); } catch { return Math.min(defaultClientSettings.memoryMb, Math.max(1024, totalMemoryMb() - 2048)); } })(),
    resolution: (() => { try { return assertResolution(parsed.resolution ?? defaultClientSettings.resolution); } catch { return defaultClientSettings.resolution; } })(),
    fullscreen: typeof parsed.fullscreen === "boolean" ? parsed.fullscreen : defaultClientSettings.fullscreen,
    customApiUrl,
    optionalFilesByPack: sanitizeOptionalMap(parsed.optionalFilesByPack),
    selectedVersionsByPack: sanitizeSelectedVersions(parsed.selectedVersionsByPack),
    serverOverridesByPack: sanitizeServerOverrides(parsed.serverOverridesByPack),
  };
  cachedSettings = settings;
  updateApiBase(getApiBase());
  return settings;
}

async function writeClientSettings(next: Partial<ClientSettings>) {
  const current = await readClientSettings();
  const merged: ClientSettings = { ...current };
  if (next.nickname !== undefined) {
    merged.nickname = assertNickname(next.nickname);
    merged.nicknameHistory = sanitizeNicknameHistory([merged.nickname, ...merged.nicknameHistory], merged.nickname);
  }
  if (next.nicknameHistory !== undefined) merged.nicknameHistory = sanitizeNicknameHistory(next.nicknameHistory, merged.nickname);
  if (next.memoryMb !== undefined) merged.memoryMb = assertMemoryMb(next.memoryMb, totalMemoryMb());
  if (next.resolution !== undefined) merged.resolution = assertResolution(next.resolution);
  if (next.fullscreen !== undefined) {
    if (typeof next.fullscreen !== "boolean") throw new Error("Invalid fullscreen setting");
    merged.fullscreen = next.fullscreen;
  }
  if (next.optionalFilesByPack !== undefined) merged.optionalFilesByPack = sanitizeOptionalMap(next.optionalFilesByPack);
  if (next.selectedVersionsByPack !== undefined) merged.selectedVersionsByPack = sanitizeSelectedVersions(next.selectedVersionsByPack);
  if (next.serverOverridesByPack !== undefined) merged.serverOverridesByPack = sanitizeServerOverrides(next.serverOverridesByPack);
  if (next.customApiUrl !== undefined) {
    if (!customApiOverrideAllowed()) throw new Error("Custom backend override is disabled in this production build");
    merged.customApiUrl = next.customApiUrl.trim() ? normalizeApiBase(next.customApiUrl.trim()) : "";
  }
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const temp = `${settingsPath}.tmp-${randomUUID()}`;
  const backup = `${settingsPath}.bak-${randomUUID()}`;
  const hadSettings = await fs.access(settingsPath).then(() => true, () => false);

  let committed = false;
  try {
    await fs.writeFile(temp, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (hadSettings) await fs.rename(settingsPath, backup);
    try {
      await fs.rename(temp, settingsPath);
      committed = true;
    } catch (error) {
      if (hadSettings) {
        const currentMissing = await fs.access(settingsPath).then(() => false, () => true);
        if (currentMissing) await fs.rename(backup, settingsPath).catch(() => {});
      }
      throw error;
    }
    if (hadSettings) await fs.rm(backup, { force: true });
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
    // If commit/restore failed, keep the backup for manual recovery rather than deleting the last valid settings file.
    if (committed) await fs.rm(backup, { force: true }).catch(() => {});
  }

  cachedSettings = merged;
  updateApiBase(getApiBase());
  return { ...merged, canOverrideApi: customApiOverrideAllowed() };
}

async function hashFileSha256(filePath: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Writable({
    write(chunk, _encoding, callback) { hash.update(chunk as Buffer); callback(); },
  }));
  return hash.digest("hex");
}

async function verifyInstallerAuthenticode(installerPath: string) {
  const expected = INSTALLER_SIGNER_CERT_SHA256.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (!expected) {
    if (REQUIRE_AUTHENTICODE_INSTALLER) {
      throw new Error("Authenticode verification is required but no installer certificate fingerprint is pinned");
    }
    return { verified: false, fingerprint: "" };
  }
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Pinned Authenticode certificate SHA-256 fingerprint is invalid");
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    "$sig=Get-AuthenticodeSignature -LiteralPath $args[0]",
    "$fp=''",
    "if ($sig.SignerCertificate) { $fp=$sig.SignerCertificate.GetCertHashString('SHA256') }",
    "[Console]::Out.Write(($sig.Status.ToString())+'|'+$fp)",
  ].join("; ");

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(windowsSystemExecutable("System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
      installerPath,
    ], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const limit = 16 * 1024;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > limit) child.kill();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > limit) child.kill();
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Authenticode verification timed out")); }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `Authenticode verification exited with ${code}`));
      else resolve(stdout.trim());
    });
  });

  const [status, fingerprintRaw = ""] = output.split("|", 2);
  const fingerprint = fingerprintRaw.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (status !== "Valid") throw new Error(`Installer Authenticode signature is not valid: ${status || "Unknown"}`);
  if (fingerprint !== expected) throw new Error("Installer was signed by an unexpected certificate");
  return { verified: true, fingerprint };
}

function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    const normalized = value.trim().replace(/^v/i, "").split("+", 1)[0]!;
    const [core, prerelease = ""] = normalized.split("-", 2);
    const main = core!.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    if (!main.length || main.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
    return { main, prerelease: prerelease ? prerelease.split(".") : [] };
  };
  const l = parse(left);
  const r = parse(right);
  if (!l || !r) return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

  const length = Math.max(l.main.length, r.main.length);
  for (let index = 0; index < length; index += 1) {
    const lv = l.main[index] ?? 0;
    const rv = r.main[index] ?? 0;
    if (lv !== rv) return lv - rv;
  }
  if (!l.prerelease.length && r.prerelease.length) return 1;
  if (l.prerelease.length && !r.prerelease.length) return -1;
  for (let index = 0; index < Math.max(l.prerelease.length, r.prerelease.length); index += 1) {
    const lv = l.prerelease[index];
    const rv = r.prerelease[index];
    if (lv === undefined) return -1;
    if (rv === undefined) return 1;
    if (lv === rv) continue;
    const ln = /^\d+$/.test(lv) ? Number(lv) : null;
    const rn = /^\d+$/.test(rv) ? Number(rv) : null;
    if (ln !== null && rn !== null) return ln - rn;
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    return lv.localeCompare(rv);
  }
  return 0;
}

async function parseBoundedJson(response: Response, maxBytes: number) {
  if (!response.body) throw new Error("Response body missing");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Response is too large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("Response is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")) as unknown;
}

async function fetchBackendJson(pathname: string, maxBytes = 1024 * 1024) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${getApiBase()}${pathname}`, {
      headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const error = new Error(`Backend request failed: ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return await parseBoundedJson(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLauncherVersion() {
  return parseLauncherVersion(await fetchBackendJson("/launcher/version", 256 * 1024));
}

async function fetchLauncherUpdate() {
  try {
    const parsed = parseLauncherUpdate(await fetchBackendJson("/launcher/update?platform=win32", 512 * 1024));
    parsed.installerUrl = assertSameOriginHttpUrl(parsed.installerUrl, getApiBase());
    parsed.fileName = assertSafeInstallerFileName(parsed.fileName, `HexLoader-${parsed.version}.exe`);
    parsed.silentArgs = assertSilentArgs(parsed.silentArgs, parsed.fileName);
    return parsed;
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return null;
    throw error;
  }
}

async function getLauncherUpdateStatus() {
  const currentVersion = app.getVersion();
  const [serverVersionMeta, remote] = await Promise.all([fetchLauncherVersion(), fetchLauncherUpdate()]);
  const serverVersion = serverVersionMeta.currentVersion;
  const outdated = compareVersions(serverVersion, currentVersion) > 0;
  if (!remote || compareVersions(remote.version, currentVersion) <= 0) {
    return { currentVersion, serverVersion, outdated, available: false, remote: null };
  }
  return { currentVersion, serverVersion, outdated, available: true, remote };
}

async function downloadLauncherInstaller(manifest: ReturnType<typeof parseLauncherUpdate>) {
  const downloadDir = path.join(app.getPath("temp"), "hexloader-updater");
  await fs.mkdir(downloadDir, { recursive: true });
  const safeName = assertSafeInstallerFileName(manifest.fileName, `HexLoader-${manifest.version}.exe`);
  const targetPath = path.join(downloadDir, safeName);
  const tempPath = `${targetPath}.part-${randomUUID()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    const response = await fetch(assertSameOriginHttpUrl(manifest.installerUrl, getApiBase()), {
      headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error(`Installer download failed: ${response.status}`);
    let written = 0;
    const maxBytes = 1024 * 1024 * 1024;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        written += (chunk as Buffer).length;
        if (written > maxBytes) callback(new Error("Installer exceeds 1 GiB safety limit"));
        else callback(null, chunk);
      },
    });
    await pipeline(response.body as unknown as NodeJS.ReadableStream, limiter, createWriteStream(tempPath, { flags: "wx" }));
    const hash = await hashFileSha256(tempPath);
    if (hash !== manifest.sha256.toLowerCase()) throw new Error("Installer checksum mismatch");
    const signature = await verifyInstallerAuthenticode(tempPath);
    if (signature.verified) pushLauncherLog("info", "updater", `Authenticode signer verified: ${signature.fingerprint}`);
    await fs.rm(targetPath, { force: true });
    await fs.rename(tempPath, targetPath);
    return targetPath;
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function installLauncherUpdate() {
  const status = await getLauncherUpdateStatus();
  if (!status.remote || !status.available) throw new Error("Launcher update is not available");
  const installerPath = await downloadLauncherInstaller(status.remote);
  const extension = path.extname(installerPath).toLowerCase();
  const args = status.remote.silentArgs.length
    ? status.remote.silentArgs
    : extension === ".msi" ? ["/passive"] : ["/S"];
  const child = extension === ".msi"
    ? spawn(windowsSystemExecutable("System32", "msiexec.exe"), ["/i", installerPath, ...args], { detached: true, stdio: "ignore", windowsHide: true, shell: false })
    : spawn(installerPath, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installer process did not start in time")), 15_000);
    child.once("spawn", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child.unref();
  pushLauncherLog("info", "updater", `Installer process started for ${status.remote.version}`);
  setTimeout(() => app.quit(), 300);
  return { currentVersion: status.currentVersion, targetVersion: status.remote.version, installerPath };
}

function expectedRendererUrl(raw: string) {
  if (isDev) {
    try {
      const url = new URL(raw);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === DEV_RENDERER_URL;
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(raw);
    return url.protocol === "app:" && url.hostname === "renderer";
  } catch {
    return false;
  }
}

function assertTrustedIpc(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Untrusted IPC sender");
  const senderFrame = event.senderFrame;
  if (!senderFrame || !expectedRendererUrl(senderFrame.url)) throw new Error("Untrusted IPC frame");
}

function handleTrusted(channel: string, handler: (...args: any[]) => unknown | Promise<unknown>) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpc(event);
    return handler(...args);
  });
}

function onTrusted(channel: string, handler: (...args: any[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    try { assertTrustedIpc(event); handler(...args); } catch { /* ignore untrusted event */ }
  });
}

function validateOptionalFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096) return [];
  return [...new Set(value.map((item) => normalizeManagedRelativePath(item)))];
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: isDev,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!expectedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.on("closed", () => { mainWindow = null; });

  if (isDev) {
    void mainWindow.loadURL(DEV_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadURL("app://renderer/index.html");
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

app.whenReady().then(async () => {
  if (!isDev) {
    const rendererRoot = path.resolve(process.resourcesPath, "dist-renderer");
    protocol.handle("app", (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "renderer") return new Response("Not found", { status: 404 });
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
      const target = path.resolve(rendererRoot, relativePath);
      const relative = path.relative(rendererRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(pathToFileURL(target).toString());
    });
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());

  setLauncherLogHandler((entry) => pushLauncherLog(entry.level, entry.scope, entry.message));
  setLauncherProgressHandler((progress) => mainWindow?.webContents.send("launcher:sync-progress", progress));
  setGameLogHandler((entry) => mainWindow?.webContents.send("game:log", entry));
  setGameStateHandler((state) => mainWindow?.webContents.send("game:state", state));
  await readClientSettings();
  pushLauncherLog("info", "app", `HexLoader initialized, version ${app.getVersion()}`);

  handleTrusted("launcher:bootstrap", () => fetchClientBootstrap());
  handleTrusted("launcher:manifest", (payload: { packId?: unknown; packVersion?: unknown; releaseChannel?: unknown }) =>
    fetchPackManifest(assertPackId(payload?.packId), assertPackVersion(payload?.packVersion, true), assertReleaseChannel(payload?.releaseChannel ?? "stable")));
  handleTrusted("launcher:versions", (payload: { packId?: unknown; includeArchived?: unknown }) =>
    fetchPackVersions(assertPackId(payload?.packId), payload?.includeArchived !== false));
  handleTrusted("launcher:logs:get", () => launcherLogBuffer.slice());
  handleTrusted("game:logs:get", () => getGameLogs());
  handleTrusted("game:state:get", () => getGameState());
  handleTrusted("settings:get", async () => ({ ...(await readClientSettings()), canOverrideApi: customApiOverrideAllowed() }));
  handleTrusted("settings:update", (payload: Partial<ClientSettings>) => writeClientSettings(payload ?? {}));
  handleTrusted("launcher:update-status", () => getLauncherUpdateStatus());
  handleTrusted("launcher:install-update", () => installLauncherUpdate());
  handleTrusted("launcher:sync", (payload: any) => {
    const packId = assertPackId(payload?.packId);
    const packVersion = assertPackVersion(payload?.packVersion, true);
    const releaseChannel = assertReleaseChannel(payload?.releaseChannel ?? "stable");
    const repair = Boolean(payload?.repair);
    const optionalFiles = validateOptionalFiles(payload?.optionalFiles);
    return withPackOperation(packId, () => syncPackVersion(packId, packVersion, releaseChannel, repair, optionalFiles));
  });
  handleTrusted("launcher:launch", async (payload: any) => {
    const request = {
      packId: assertPackId(payload?.packId),
      packVersion: assertPackVersion(payload?.packVersion, true),
      releaseChannel: assertReleaseChannel(payload?.releaseChannel ?? "stable"),
      nickname: assertNickname(payload?.nickname),
      memoryMb: assertMemoryMb(payload?.memoryMb, totalMemoryMb()),
      resolution: assertResolution(payload?.resolution),
      fullscreen: Boolean(payload?.fullscreen),
      optionalFiles: validateOptionalFiles(payload?.optionalFiles),
    };
    const settings = await readClientSettings();
    const override = settings.serverOverridesByPack[request.packId];
    return withPackOperation(request.packId, () => launchPack({ ...request, serverOverride: override }));
  });
  handleTrusted("launcher:diagnostics", (payload: any) => {
    const packId = assertPackId(payload?.packId);
    const packVersion = assertPackVersion(payload?.packVersion, true);
    const releaseChannel = assertReleaseChannel(payload?.releaseChannel ?? "stable");
    return withPackOperation(packId, () => getLauncherDiagnosticsForVersion(packId, packVersion, releaseChannel));
  });
  handleTrusted("launcher:delete-local-pack", (payload: any) => {
    const packId = assertPackId(payload?.packId);
    return withPackOperation(packId, () => deleteLocalPack(packId));
  });
  handleTrusted("launcher:verify-files", async (payload: any) => {
    const packId = assertPackId(payload?.packId);
    const packVersion = assertPackVersion(payload?.packVersion, true);
    const releaseChannel = assertReleaseChannel(payload?.releaseChannel ?? "stable");
    const settings = await readClientSettings();
    const optionalFiles = settings.optionalFilesByPack[packId] ?? [];
    return withPackOperation(packId, () => verifyPackFiles(packId, packVersion, releaseChannel, optionalFiles));
  });
  handleTrusted("system:memory", () => {
    const total = totalMemoryMb();
    const reserved = total >= 12288 ? 3072 : 2048;
    return { totalMemoryMb: total, recommendedMaxMemoryMb: Math.max(2048, total - reserved) };
  });
  handleTrusted("window:toggle-maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
    mainWindow.maximize(); return true;
  });
  handleTrusted("window:is-maximized", () => mainWindow?.isMaximized() ?? false);
  onTrusted("window:minimize", () => mainWindow?.minimize());
  onTrusted("window:close", () => mainWindow?.close());

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  setLauncherLogHandler(null);
  setLauncherProgressHandler(null);
  setGameLogHandler(null);
  setGameStateHandler(null);
});
