import { app } from "electron";
import AdmZip = require("adm-zip");
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createBoundedGameEventStore } from "./security/gameEvents.cjs";
import type { GameLogEntry, GameProcessState } from "./security/gameEvents.cjs";
import {
  assertPackId,
  assertPackVersion,
  assertReleaseChannel,
  assertSafeArchiveFileName,
  assertSafeCacheSegment,
  assertSha1,
  assertSameOriginHttpUrl,
  assertTrustedOfficialUrl,
  normalizeApiBase,
  normalizeManagedRelativePath,
  offlineUuidFromNickname,
  safeJoinManaged,
} from "./security/validation.cjs";
import {
  parseLauncherVersion,
  parseNotices,
  parsePackRelease,
  parsePackSummaries,
  parsePackVersions,
} from "./security/contracts.cjs";
import type { LauncherVersion, Notice, PackFile, PackRelease, PackSummary } from "./security/contracts.cjs";
import { verifyManifestIntegrity } from "./security/manifestSignature.cjs";
import { buildConfiguredServerLaunchArgs } from "./security/launchArgs.cjs";
import { forgeCoordinateVersion, forgeInstallerUrl, forgeLoaderOnlyVersion, neoForgeInstallerUrl } from "./security/loaderConfig.cjs";
import { shouldPreserveExistingManagedFile, shouldPreserveObsoleteManagedFile, shouldVerifyManagedHash } from "./security/managedPolicy.cjs";
import { decideLibraryResolution } from "./security/libraryPolicy.cjs";
import { mavenIdentity, mavenPathFromCoordinate } from "./security/mavenCoordinate.cjs";
import {
  PackRollbackIncompleteError,
  cleanupOldPackTransactions,
  commitPackTransaction,
} from "./security/packTransaction.cjs";

type LauncherLogLevel = "info" | "warn" | "error";

type LauncherLogHandler = (entry: {
  level: LauncherLogLevel;
  scope: string;
  message: string;
}) => void;

type LauncherProgressHandler = (progress: {
  status: string;
  currentFile: string;
  downloadedFiles: number;
  totalFiles: number;
  bytesProgress: number;
  totalBytes: number;
  speedMbSec: number;
}) => void;

class BackendUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendUnavailableError";
  }
}

class BackendProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendProtocolError";
  }
}

type RuntimeAsset = {
  binary: {
    package: {
      link: string;
      name: string;
      checksum?: string;
    };
  };
};

type LaunchRequest = {
  packId: string;
  packVersion?: string;
  releaseChannel?: "stable" | "beta" | "test";
  nickname: string;
  memoryMb: number;
  resolution: string;
  fullscreen: boolean;
  optionalFiles?: string[];
  serverOverride?: { address: string; port: number };
};

type SyncResult = {
  release: PackRelease;
  javaPath: string;
  instanceDir: string;
  versionId: string;
  downloadedFiles: number;
  runtimeDownloaded: boolean;
};

type LaunchResult = SyncResult & {
  pid: number;
  logFile: string;
  commandPreview: string;
};

type VersionManifestEntry = {
  id: string;
  url: string;
  sha1?: string;
};

type DownloadSpec = {
  id?: string;
  path?: string;
  url: string;
  sha1?: string;
  size?: number;
};

type MinecraftLibrary = {
  name: string;
  url?: string;
  downloads?: {
    artifact?: DownloadSpec;
    classifiers?: Record<string, DownloadSpec>;
  };
  rules?: Array<{
    action: "allow" | "disallow";
    os?: {
      name?: string;
      arch?: string;
      version?: string;
    };
    features?: Record<string, boolean>;
  }>;
  natives?: Record<string, string>;
};

type MinecraftVersionJson = {
  id: string;
  inheritsFrom?: string;
  mainClass?: string;
  arguments?: {
    game?: Array<string | { rules?: MinecraftLibrary["rules"]; value: string | string[] }>;
    jvm?: Array<string | { rules?: MinecraftLibrary["rules"]; value: string | string[] }>;
  };
  minecraftArguments?: string;
  libraries?: MinecraftLibrary[];
  assetIndex?: {
    id: string;
    url: string;
    sha1?: string;
  };
  assets?: string;
  downloads?: {
    client?: DownloadSpec;
  };
  logging?: {
    client?: {
      argument: string;
      file: DownloadSpec;
    };
  };
  javaVersion?: {
    majorVersion: number;
  };
  type?: string;
};
const {
  DEFAULT_API_BASE,
  MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
  REQUIRE_SIGNED_MANIFESTS,
} = require("./sharedConfig.cjs");
let API_BASE = normalizeApiBase(DEFAULT_API_BASE);

export function updateApiBase(newUrl: string) {
  API_BASE = normalizeApiBase(newUrl || DEFAULT_API_BASE);
}
const MOJANG_VERSION_MANIFEST =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_PROFILE_URL = (minecraftVersion: string, loaderVersion: string) =>
  `https://meta.fabricmc.net/v2/versions/loader/${minecraftVersion}/${loaderVersion}/profile/json`;
const ADOPTIUM_ASSET_URL = (javaMajor: number, includeVendor = true) =>
  `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot?architecture=x64&image_type=jre&os=windows${
    includeVendor ? "&vendor=eclipse" : ""
  }`;

const OFFICIAL_DOWNLOAD_HOSTS = new Set([
  "api.adoptium.net",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "resources.download.minecraft.net",
  "libraries.minecraft.net",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "maven.neoforged.net",
  "maven.minecraftforge.net",
  "repo1.maven.org",
  "repo.maven.apache.org",
]);

function trustedOfficialUrl(raw: string) {
  return assertTrustedOfficialUrl(raw, OFFICIAL_DOWNLOAD_HOSTS);
}

let activeMinecraftProcess: ReturnType<typeof spawn> | null = null;
let activeMinecraftPid: number | null = null;
let launcherLogHandler: LauncherLogHandler | null = null;
let launcherProgressHandler: LauncherProgressHandler | null = null;
const gameEvents = createBoundedGameEventStore(1000);
export function getGameLogs() { return gameEvents.getLogs(); }
export function getGameState() { return gameEvents.getState(); }
export function setGameLogHandler(handler: ((entry: GameLogEntry) => void) | null) { gameEvents.setLogHandler(handler); }
export function setGameStateHandler(handler: ((state: GameProcessState) => void) | null) { gameEvents.setStateHandler(handler); }

export function setLauncherLogHandler(handler: LauncherLogHandler | null) {
  launcherLogHandler = handler;
}

export function setLauncherProgressHandler(handler: LauncherProgressHandler | null) {
  launcherProgressHandler = handler;
}

function writeLauncherLog(level: LauncherLogLevel, scope: string, message: string) {
  launcherLogHandler?.({ level, scope, message });
}

function isPidRunning(pid: number | null) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getLauncherRoot() {
  return path.join(app.getPath("userData"), "runtime");
}

function getInstancesRoot() {
  return path.join(getLauncherRoot(), "instances");
}

function getSharedMinecraftRoot() {
  return path.join(getLauncherRoot(), "minecraft");
}

function getRuntimesRoot() {
  return path.join(getLauncherRoot(), "java");
}

function getLogsRoot() {
  return path.join(getLauncherRoot(), "logs");
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed path escaped launcher storage");
  }

  try {
    const rootStat = await fs.lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`Symlink/junction is not allowed as managed storage root: ${resolvedRoot}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return;
  }

  if (relative === "" || relative === ".") return;
  const components = relative.split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink/junction is not allowed in managed storage: ${current}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
  }
}

async function hashFile(filePath: string, algorithm: "sha1" | "sha256") {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk as Buffer);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function sha1OfFile(filePath: string) {
  return hashFile(filePath, "sha1");
}

async function sha256OfFile(filePath: string) {
  return hashFile(filePath, "sha256");
}

async function readJsonResponseLimited(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new BackendProtocolError(`JSON response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new BackendProtocolError("Response body is missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BackendProtocolError(`JSON response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  try {
    return JSON.parse(merged.toString("utf8"));
  } catch (error) {
    throw new BackendProtocolError("Backend returned invalid JSON", { cause: error });
  }
}

async function fetchJson<T>(url: string, maxBytes = 8 * 1024 * 1024): Promise<T> {
  writeLauncherLog("info", "network", `GET ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      writeLauncherLog("error", "network", `GET ${url} failed with ${response.status}`);
      const requestError = new Error(`Failed to fetch ${url}: ${response.status}`) as Error & { status?: number };
      requestError.status = response.status;
      throw requestError;
    }

    const parsed = await readJsonResponseLimited(response, maxBytes);
    writeLauncherLog("info", "network", `GET ${url} -> ${response.status}`);
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, maxBytes = 64 * 1024): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error(`Text response exceeds ${maxBytes} bytes`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Text response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRemoteChecksum(url: string, algorithm: "sha1" | "sha256") {
  const trusted = trustedOfficialUrl(url);
  const suffix = algorithm === "sha256" ? ".sha256" : ".sha1";
  const text = (await fetchText(`${trusted}${suffix}`, 4096)).trim().split(/\s+/)[0] ?? "";
  const re = algorithm === "sha256" ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{40}$/i;
  if (!re.test(text)) throw new Error(`Invalid ${algorithm} checksum metadata for ${url}`);
  return text.toLowerCase();
}

async function commitDownloadedFile(tempPath: string, destination: string) {
  const backupPath = `${destination}.bak-${randomUUID()}`;
  const hadDestination = await exists(destination);
  let committed = false;
  if (hadDestination) {
    await fs.rename(destination, backupPath);
  }
  try {
    await fs.rename(tempPath, destination);
    committed = true;
    if (hadDestination) await fs.rm(backupPath, { force: true });
  } catch (error) {
    if (hadDestination && !(await exists(destination))) {
      await fs.rename(backupPath, destination).catch(() => {});
    }
    throw error;
  } finally {
    // Never delete the last known-good backup if replacement/restore did not complete.
    if (committed) await fs.rm(backupPath, { force: true }).catch(() => {});
  }
}

async function writeManagedTextAtomic(root: string, destination: string, content: string) {
  await assertNoSymlinkComponents(root, destination);
  await ensureDir(path.dirname(destination));
  await assertNoSymlinkComponents(root, destination);
  const tempPath = `${destination}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await commitDownloadedFile(tempPath, destination);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadFile(
  url: string,
  destination: string,
  expectedHash?: { algorithm: "sha1" | "sha256"; value?: string },
  expectedSize?: number,
  allowRedirects = true,
  onProgress?: (written: number, total: number) => void,
) {
  const launcherRoot = getLauncherRoot();
  await assertNoSymlinkComponents(launcherRoot, destination);
  if (await exists(destination)) {
    if (!expectedHash?.value) return false;
    const currentHash = await hashFile(destination, expectedHash.algorithm).catch(() => "");
    if (currentHash.toLowerCase() === expectedHash.value.toLowerCase()) return false;
  }

  await ensureDir(path.dirname(destination));
  await assertNoSymlinkComponents(launcherRoot, destination);
  writeLauncherLog("info", "download", `Preparing ${path.basename(destination)}`);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = `${destination}.part-${randomUUID()}`;
    try {
      writeLauncherLog("info", "download", `Downloading ${path.basename(destination)} (attempt ${attempt + 1}/3)`);
      const controller = new AbortController();
      // Absolute wall-clock limit covers both headers and the response body.
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": `HexLoader/${app.getVersion()}` },
          signal: controller.signal,
          redirect: allowRedirects ? "follow" : "error",
        });

        if (!response.ok || !response.body) {
          throw new Error(`Failed to download ${url}: ${response.status}`);
        }
        if (allowRedirects) trustedOfficialUrl(response.url);

        const declared = Number(response.headers.get("content-length") || 0);
      if (expectedSize !== undefined && expectedSize >= 0 && declared > 0 && declared !== expectedSize) {
        throw new Error(`Unexpected content length for ${path.basename(destination)}: ${declared} != ${expectedSize}`);
      }

      let written = 0;
      const limit = expectedSize !== undefined && expectedSize >= 0
        ? Math.max(expectedSize, 1)
        : 2 * 1024 * 1024 * 1024;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          written += (chunk as Buffer).length;
          onProgress?.(written, expectedSize ?? declared ?? 0);
          if (written > limit) {
            callback(new Error(`Download exceeded size limit for ${path.basename(destination)}`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(response.body as unknown as NodeJS.ReadableStream, limiter, createWriteStream(tempPath, { flags: "wx" }));

      if (expectedSize !== undefined && expectedSize >= 0 && written !== expectedSize) {
        throw new Error(`Downloaded size mismatch for ${path.basename(destination)}: ${written} != ${expectedSize}`);
      }

      if (expectedHash?.value) {
        const actualHash = await hashFile(tempPath, expectedHash.algorithm);
        if (actualHash.toLowerCase() !== expectedHash.value.toLowerCase()) {
          throw new Error(`Checksum mismatch for ${path.basename(destination)}`);
        }
      }

        await commitDownloadedFile(tempPath, destination);
        writeLauncherLog("info", "download", `Saved ${path.basename(destination)}`);
        return true;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      await fs.rm(tempPath, { force: true }).catch(() => {});
      writeLauncherLog(
        attempt < 2 ? "warn" : "error",
        "download",
        `${path.basename(destination)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function normalizeOsName() {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "osx";
  }
  return "linux";
}

function normalizeArchName() {
  if (process.arch === "x64") {
    return "x64";
  }
  return process.arch;
}

function evaluateRules(rules?: MinecraftLibrary["rules"]) {
  if (!rules?.length) {
    return true;
  }

  let allowed = false;
  for (const rule of rules) {
    if (rule.features) {
      continue;
    }

    if (rule.os) {
      const osMatches =
        (!rule.os.name || rule.os.name === normalizeOsName()) &&
        (!rule.os.arch || rule.os.arch === normalizeArchName());
      if (!osMatches) {
        continue;
      }
    }

    allowed = rule.action === "allow";
  }

  return allowed;
}

function mavenPathFromName(name: string) {
  return mavenPathFromCoordinate(name);
}


function mergeVersions(base: MinecraftVersionJson, overlay: MinecraftVersionJson): MinecraftVersionJson {
  // Child libraries are evaluated before inherited libraries. De-duplication is
  // intentionally deferred until after OS/rule evaluation in ensureLibraries:
  // a disabled child entry must not hide an otherwise-valid parent library.
  return {
    ...base,
    ...overlay,
    libraries: [...(overlay.libraries ?? []), ...(base.libraries ?? [])],
    arguments: {
      game: [...(base.arguments?.game ?? []), ...(overlay.arguments?.game ?? [])],
      jvm: [...(base.arguments?.jvm ?? []), ...(overlay.arguments?.jvm ?? [])],
    },
  };
}

function requiredSha1(value: unknown, label: string) {
  try {
    return assertSha1(value, true);
  } catch {
    throw new Error(`${label} is missing a valid SHA-1 checksum`);
  }
}

async function getMinecraftVersionEntry(versionId: string) {
  const manifest = await fetchJson<{ versions?: VersionManifestEntry[] }>(MOJANG_VERSION_MANIFEST);
  if (!Array.isArray(manifest.versions) || manifest.versions.length > 10_000) {
    throw new Error("Official Minecraft version manifest is malformed");
  }
  const version = manifest.versions.find((entry) => entry.id === versionId);
  if (!version) {
    throw new Error(`Minecraft version ${versionId} not found in official manifest`);
  }
  return version;
}

async function resolveMojangVersion(versionId: string): Promise<MinecraftVersionJson> {
  const safeVersionId = assertSafeCacheSegment(versionId, "Minecraft version id");
  const entry = await getMinecraftVersionEntry(safeVersionId);
  const root = getSharedMinecraftRoot();
  const versionJsonPath = path.join(root, "metadata", "versions", `${safeVersionId}.json`);
  await downloadFile(trustedOfficialUrl(entry.url), versionJsonPath, { algorithm: "sha1", value: requiredSha1(entry.sha1, `Minecraft ${safeVersionId} metadata`) });
  return JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
}

async function resolveFabricVersion(release: PackRelease) {
  if (release.loaderType !== "Fabric") {
    throw new Error(`Fabric resolver received unsupported loader type: ${release.loaderType}`);
  }

  return fetchJson<MinecraftVersionJson>(
    FABRIC_PROFILE_URL(release.minecraftVersion, release.loaderVersion),
  );
}

function getNeoForgeVersionId(loaderVersion: string) {
  const safeLoaderVersion = assertPackVersion(loaderVersion)!;
  return assertSafeCacheSegment(`neoforge-${safeLoaderVersion}`, "NeoForge version id");
}

function getNeoForgeVersionJsonPath(loaderVersion: string) {
  const versionId = getNeoForgeVersionId(loaderVersion);
  return path.join(getSharedMinecraftRoot(), "versions", versionId, `${versionId}.json`);
}

function getNeoForgeRuntimeArtifacts(loaderVersion: string) {
  const versionId = getNeoForgeVersionId(loaderVersion);
  return {
    versionJar: path.join(getSharedMinecraftRoot(), "versions", versionId, `${versionId}.jar`),
  };
}

async function ensureLauncherProfilesStub(rootDir: string) {
  const profilesPath = path.join(rootDir, "launcher_profiles.json");
  await assertNoSymlinkComponents(rootDir, profilesPath);
  if (await exists(profilesPath)) {
    const stat = await fs.lstat(profilesPath);
    if (!stat.isFile()) throw new Error("launcher_profiles.json must be a regular file");
    return;
  }

  await ensureDir(rootDir);
  await writeManagedTextAtomic(rootDir, profilesPath, JSON.stringify({ profiles: {}, selectedProfile: "" }, null, 2));
}

async function runCommand(executable: string, args: string[], cwd: string, scope: string) {
  writeLauncherLog("info", scope, `${path.basename(executable)} ${args.join(" ")}`);

  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
  });

  const outputTail: string[] = [];
  const pushTail = (text: string) => {
    if (!text) {
      return;
    }
    outputTail.push(text);
    if (outputTail.length > 40) {
      outputTail.shift();
    }
  };

  const shouldLogProcessLine = (text: string) =>
    [
      "Target Directory:",
      "Extracting json",
      "Considering minecraft client jar",
      "Downloading libraries",
      "Downloading library from",
      "Injecting profile",
      "Successfully installed client into launcher.",
      "There was an error during installation",
    ].some((needle) => text.includes(needle));

  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const text of lines) {
      pushTail(text);
      if (shouldLogProcessLine(text)) {
        writeLauncherLog("info", scope, text);
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const text of lines) {
      pushTail(text);
      stderr += `${text}\n`;
      writeLauncherLog("warn", scope, text);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      writeLauncherLog("error", scope, "Process exceeded 15 minute safety timeout");
      child.kill("SIGKILL");
      reject(new Error(`${scope} process timed out`));
    }, 15 * 60 * 1000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || outputTail.join("\n") || `Process exited with code ${exitCode}`);
  }
}

async function ensureNeoForgeVersion(release: PackRelease, javaPath: string, forceInstall = false) {
  if (release.loaderType !== "NeoForge") {
    throw new Error(`Unsupported loader type for NeoForge resolver: ${release.loaderType}`);
  }

  const versionJsonPath = getNeoForgeVersionJsonPath(release.loaderVersion);
  if (!forceInstall && await exists(versionJsonPath)) {
    try {
      await assertNoSymlinkComponents(getSharedMinecraftRoot(), versionJsonPath);
      const cached = JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
      if (cached?.id === getNeoForgeVersionId(release.loaderVersion)) {
        writeLauncherLog("info", "loader", `Using cached NeoForge ${release.loaderVersion}`);
        return cached;
      }
    } catch {
      writeLauncherLog("warn", "loader", `Cached NeoForge ${release.loaderVersion} metadata is invalid; reinstalling`);
    }
  }

  const installerDir = path.join(
    getSharedMinecraftRoot(),
    "metadata",
    "loaders",
    "neoforge",
    release.loaderVersion,
  );
  const installerPath = path.join(
    installerDir,
    `neoforge-${release.loaderVersion}-installer.jar`,
  );

  writeLauncherLog("info", "loader", `Installing NeoForge ${release.loaderVersion}`);
  await ensureLauncherProfilesStub(getSharedMinecraftRoot());
  const installerUrl = trustedOfficialUrl(neoForgeInstallerUrl(release.loaderVersion));
  const installerChecksum = await resolveStrongestRemoteChecksum(installerUrl, "NeoForge installer");
  await downloadFile(installerUrl, installerPath, installerChecksum);
  await runCommand(
    javaPath,
    ["-jar", installerPath, "--install-client", getSharedMinecraftRoot()],
    getSharedMinecraftRoot(),
    "loader",
  );

  if (!(await exists(versionJsonPath))) {
    throw new Error(`NeoForge installer did not create ${path.basename(versionJsonPath)}`);
  }

  await assertNoSymlinkComponents(getSharedMinecraftRoot(), versionJsonPath);
  const installed = JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
  if (installed?.id !== getNeoForgeVersionId(release.loaderVersion)) {
    throw new Error(`NeoForge installer created unexpected version metadata: ${installed?.id ?? "missing id"}`);
  }
  return installed;
}


async function findInstalledForgeVersion(release: PackRelease): Promise<{ path: string; version: MinecraftVersionJson } | null> {
  const versionsRoot = path.join(getSharedMinecraftRoot(), "versions");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const forgeOnly = forgeLoaderOnlyVersion(release.minecraftVersion, release.loaderVersion).toLowerCase();
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes("forge"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of candidates) {
    let safeId: string;
    try { safeId = assertSafeCacheSegment(entry.name, "Forge version id"); } catch { continue; }
    const jsonPath = path.join(versionsRoot, safeId, `${safeId}.json`);
    try {
      await assertNoSymlinkComponents(getSharedMinecraftRoot(), jsonPath);
      const parsed = JSON.parse(await fs.readFile(jsonPath, "utf8")) as MinecraftVersionJson;
      const parsedId = typeof parsed.id === "string" ? parsed.id.toLowerCase() : "";
      const inherits = typeof parsed.inheritsFrom === "string" ? parsed.inheritsFrom : "";
      if (inherits === release.minecraftVersion && parsedId.includes("forge") && parsedId.includes(forgeOnly)) {
        return { path: jsonPath, version: parsed };
      }
    } catch {
      // Ignore unrelated/corrupt version entries and keep looking for the exact Forge install.
    }
  }
  return null;
}

async function resolveStrongestRemoteChecksum(url: string, label = "Loader installer") {
  try {
    const sha256 = await resolveRemoteChecksum(url, "sha256");
    return { algorithm: "sha256" as const, value: sha256 };
  } catch (sha256Error) {
    writeLauncherLog("warn", "loader", `SHA-256 sidecar unavailable for ${path.basename(new URL(url).pathname)}; falling back to Maven SHA-1`);
    try {
      const sha1 = await resolveRemoteChecksum(url, "sha1");
      return { algorithm: "sha1" as const, value: sha1 };
    } catch (sha1Error) {
      throw new Error(`${label} checksum metadata is unavailable`, { cause: sha1Error ?? sha256Error });
    }
  }
}

async function ensureForgeVersion(release: PackRelease, javaPath: string, forceInstall = false) {
  if (release.loaderType !== "Forge") {
    throw new Error(`Unsupported loader type for Forge resolver: ${release.loaderType}`);
  }

  const cached = forceInstall ? null : await findInstalledForgeVersion(release);
  if (cached) {
    writeLauncherLog("info", "loader", `Using cached Forge ${release.loaderVersion}`);
    return cached.version;
  }

  const coordinate = forgeCoordinateVersion(release.minecraftVersion, release.loaderVersion);
  const installerDir = path.join(getSharedMinecraftRoot(), "metadata", "loaders", "forge", coordinate);
  const installerPath = path.join(installerDir, `forge-${coordinate}-installer.jar`);
  await ensureLauncherProfilesStub(getSharedMinecraftRoot());

  writeLauncherLog("info", "loader", `Installing Forge ${release.loaderVersion} for Minecraft ${release.minecraftVersion}`);
  const installerUrl = trustedOfficialUrl(forgeInstallerUrl(release.minecraftVersion, release.loaderVersion));
  const checksum = await resolveStrongestRemoteChecksum(installerUrl, "Forge installer");
  await downloadFile(installerUrl, installerPath, checksum);
  await runCommand(
    javaPath,
    ["-jar", installerPath, "--installClient", getSharedMinecraftRoot()],
    getSharedMinecraftRoot(),
    "loader",
  );

  const installed = await findInstalledForgeVersion(release);
  if (!installed) {
    throw new Error(`Forge ${release.loaderVersion} installer completed but no matching client version metadata was created`);
  }
  return installed.version;
}

function getResolvedMinecraftVersionId(release: PackRelease, version: Pick<MinecraftVersionJson, "inheritsFrom" | "id">) {
  return version.inheritsFrom || release.minecraftVersion;
}

async function ensureVersionAliasJar(versionId: string, sourceJarPath: string) {
  const safeVersionId = assertSafeCacheSegment(versionId, "version alias");
  const sharedRoot = getSharedMinecraftRoot();
  const aliasJarPath = path.join(sharedRoot, "versions", safeVersionId, `${safeVersionId}.jar`);
  await assertNoSymlinkComponents(sharedRoot, sourceJarPath);
  await assertNoSymlinkComponents(sharedRoot, aliasJarPath);
  await ensureDir(path.dirname(aliasJarPath));
  await assertNoSymlinkComponents(sharedRoot, aliasJarPath);

  const sourceExists = await exists(sourceJarPath);
  if (!sourceExists) {
    throw new Error(`Source jar missing for alias ${versionId}: ${path.basename(sourceJarPath)}`);
  }

  const sourceHash = await sha1OfFile(sourceJarPath);
  if (await exists(aliasJarPath)) {
    const aliasHash = await sha1OfFile(aliasJarPath).catch(() => "");
    if (sourceHash === aliasHash) return aliasJarPath;
  }

  const tempPath = `${aliasJarPath}.tmp-${randomUUID()}`;
  try {
    await fs.copyFile(sourceJarPath, tempPath, fsConstants.COPYFILE_EXCL);
    if (await sha1OfFile(tempPath) !== sourceHash) throw new Error(`Alias jar copy verification failed for ${versionId}`);
    await commitDownloadedFile(tempPath, aliasJarPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return aliasJarPath;
}

async function resolveLaunchVersion(release: PackRelease, javaPath?: string, forceLoaderInstall = false) {
  let loaderVersion: MinecraftVersionJson;

  if (release.loaderType === "Fabric") {
    loaderVersion = await resolveFabricVersion(release);
  } else if (release.loaderType === "NeoForge") {
    if (!javaPath) {
      throw new Error("NeoForge installation requires a resolved Java runtime");
    }
    loaderVersion = await ensureNeoForgeVersion(release, javaPath, forceLoaderInstall);
  } else if (release.loaderType === "Forge") {
    if (!javaPath) {
      throw new Error("Forge installation requires a resolved Java runtime");
    }
    loaderVersion = await ensureForgeVersion(release, javaPath, forceLoaderInstall);
  } else {
    throw new Error(`Unsupported loader type: ${release.loaderType}`);
  }

  const resolvedMinecraftVersion = getResolvedMinecraftVersionId(release, loaderVersion);
  if (resolvedMinecraftVersion !== release.minecraftVersion) {
    throw new Error(
      `Loader metadata targets Minecraft ${resolvedMinecraftVersion}, but backend manifest declares ${release.minecraftVersion}`,
    );
  }

  const baseVersion = await resolveMojangVersion(resolvedMinecraftVersion);
  return mergeVersions(baseVersion, loaderVersion);
}

function assertSafeArchiveEntry(entryName: string, root: string) {
  const normalized = entryName.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return root;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) {
    throw new Error(`Unsafe archive entry: ${entryName}`);
  }
  let portable: string;
  try {
    portable = normalizeManagedRelativePath(normalized);
  } catch {
    throw new Error(`Unsafe archive entry: ${entryName}`);
  }
  const parts = portable.split("/");
  const target = path.resolve(root, ...parts);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Archive entry escaped target directory: ${entryName}`);
  }
  return target;
}

function zipEntryLooksLikeSymlink(entry: AdmZip.IZipEntry) {
  const attr = Number((entry.header as unknown as { attr?: number }).attr ?? 0);
  const unixMode = (attr >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

async function extractZipSafely(
  zipPath: string,
  targetDir: string,
  options: { maxEntries: number; maxUnpackedBytes: number; flatten?: boolean },
) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > options.maxEntries) {
    throw new Error(`Archive has too many entries: ${entries.length}`);
  }
  let total = 0;
  let packedTotal = 0;
  await ensureDir(targetDir);
  for (const entry of entries) {
    const target = assertSafeArchiveEntry(entry.entryName, targetDir);
    await assertNoSymlinkComponents(targetDir, target);
    if (zipEntryLooksLikeSymlink(entry)) {
      throw new Error(`Archive contains a symlink: ${entry.entryName}`);
    }
    const header = entry.header as unknown as { size?: number; compressedSize?: number };
    const unpackedSize = Number(header.size ?? 0);
    const compressedSize = Number(header.compressedSize ?? 0);
    if (!Number.isFinite(unpackedSize) || unpackedSize < 0 || !Number.isFinite(compressedSize) || compressedSize < 0) {
      throw new Error(`Invalid archive entry size: ${entry.entryName}`);
    }
    total += unpackedSize;
    packedTotal += compressedSize;
    if (total > options.maxUnpackedBytes) throw new Error("Archive exceeds unpacked size limit");
    if (compressedSize > 0 && unpackedSize > 32 * 1024 * 1024 && unpackedSize / compressedSize > 200) {
      throw new Error(`Archive entry has suspicious compression ratio: ${entry.entryName}`);
    }
  }
  if (packedTotal > 0 && total > 128 * 1024 * 1024 && total / packedTotal > 100) {
    throw new Error("Archive has suspicious overall compression ratio");
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    zip.extractEntryTo(entry, targetDir, !options.flatten, true, false);
  }
}

async function resolveJavaRuntime(javaMajor: number, expectedPackageSha256 = "") {
  const runtimeId = `temurin-${javaMajor}-win-x64`;
  const runtimeRoot = path.join(getRuntimesRoot(), runtimeId);
  const markerPath = path.join(runtimeRoot, ".complete");
  writeLauncherLog("info", "java", `Resolving runtime ${runtimeId}`);

  if (await exists(markerPath)) {
    const javaPath = await findJavaExecutable(runtimeRoot);
    if (javaPath) {
      writeLauncherLog("info", "java", `Using cached runtime ${runtimeId}`);
      return { javaPath, runtimeDownloaded: false };
    }
  }

  let assets = await fetchJson<RuntimeAsset[]>(ADOPTIUM_ASSET_URL(javaMajor));
  if (!assets.length) {
    assets = await fetchJson<RuntimeAsset[]>(ADOPTIUM_ASSET_URL(javaMajor, false));
  }

  const runtimeAsset = assets[0]?.binary?.package;
  if (!runtimeAsset?.link) {
    throw new Error(`No Temurin runtime found for Java ${javaMajor}`);
  }

  await ensureDir(runtimeRoot);
  const runtimeArchiveName = assertSafeArchiveFileName(runtimeAsset.name, ".zip");
  const zipPath = path.join(runtimeRoot, runtimeArchiveName);
  writeLauncherLog("info", "java", `Downloading runtime package ${runtimeArchiveName}`);
  if (!runtimeAsset.checksum || !/^[a-f0-9]{64}$/i.test(runtimeAsset.checksum)) {
    throw new Error(`Adoptium runtime ${runtimeArchiveName} has no valid SHA-256 checksum`);
  }
  if (expectedPackageSha256 && runtimeAsset.checksum.toLowerCase() !== expectedPackageSha256.toLowerCase()) {
    throw new Error(`Adoptium runtime checksum does not match backend Java package pin for Java ${javaMajor}`);
  }
  await downloadFile(trustedOfficialUrl(runtimeAsset.link), zipPath, {
    algorithm: "sha256",
    value: runtimeAsset.checksum,
  }, undefined, true);

  writeLauncherLog("info", "java", `Extracting runtime ${runtimeArchiveName}`);
  await extractZipSafely(zipPath, runtimeRoot, {
    maxEntries: 20_000,
    maxUnpackedBytes: 2 * 1024 * 1024 * 1024,
  });
  await writeManagedTextAtomic(runtimeRoot, markerPath, runtimeAsset.link);

  const javaPath = await findJavaExecutable(runtimeRoot);
  if (!javaPath) {
    throw new Error("Downloaded runtime does not contain java.exe");
  }

  return { javaPath, runtimeDownloaded: true };
}

async function findJavaExecutable(rootDir: string): Promise<string | null> {
  if (!(await exists(rootDir))) {
    return null;
  }
  await assertNoSymlinkComponents(getRuntimesRoot(), rootDir);

  const queue = [rootDir];
  while (queue.length) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EPERM") {
        return null;
      }

      throw error;
    });

    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "java.exe") {
        return candidate;
      }
      if (entry.isDirectory() && entry.name !== "__MACOSX") {
        queue.push(candidate);
      }
    }
  }

  return null;
}

async function ensureClientJar(version: MinecraftVersionJson, minecraftVersion: string) {
  const safeMinecraftVersion = assertSafeCacheSegment(minecraftVersion, "Minecraft version id");
  const client = version.downloads?.client;
  if (!client) {
    throw new Error(`Client jar metadata missing for ${safeMinecraftVersion}`);
  }

  const jarPath = path.join(getSharedMinecraftRoot(), "versions", safeMinecraftVersion, `${safeMinecraftVersion}.jar`);
  await downloadFile(trustedOfficialUrl(client.url), jarPath, {
    algorithm: "sha1",
    value: requiredSha1(client.sha1, `Minecraft ${safeMinecraftVersion} client`),
  }, client.size);

  return jarPath;
}

async function ensureAssets(version: MinecraftVersionJson) {
  if (!version.assetIndex) {
    return;
  }

  const assetsRoot = path.join(getSharedMinecraftRoot(), "assets");
  const assetIndexId = assertSafeCacheSegment(version.assetIndex.id, "asset index id");
  const indexPath = path.join(assetsRoot, "indexes", `${assetIndexId}.json`);
  writeLauncherLog("info", "assets", `Syncing asset index ${assetIndexId}`);
  await downloadFile(trustedOfficialUrl(version.assetIndex.url), indexPath, {
    algorithm: "sha1",
    value: requiredSha1(version.assetIndex.sha1, `Asset index ${assetIndexId}`),
  });

  const indexJson = JSON.parse(await fs.readFile(indexPath, "utf-8")) as {
    objects: Record<string, { hash: string; size: number }>;
  };

  const objects = Object.values(indexJson.objects);
  const concurrency = 12;

  for (let index = 0; index < objects.length; index += concurrency) {
    const batch = objects.slice(index, index + concurrency);
    await Promise.all(
      batch.map(async (objectData) => {
        const objectHash = String(objectData.hash ?? "").toLowerCase();
        if (!/^[a-f0-9]{40}$/.test(objectHash)) throw new Error("Asset index contains invalid SHA-1");
        if (!Number.isInteger(objectData.size) || objectData.size < 0 || objectData.size > 512 * 1024 * 1024) {
          throw new Error(`Asset ${objectHash} has invalid size`);
        }
        const objectPath = path.join(assetsRoot, "objects", objectHash.slice(0, 2), objectHash);
        const objectUrl = `https://resources.download.minecraft.net/${objectHash.slice(0, 2)}/${objectHash}`;
        await downloadFile(trustedOfficialUrl(objectUrl), objectPath, {
          algorithm: "sha1",
          value: objectHash,
        }, objectData.size);
      }),
    );
  }
}

async function ensureLoggingConfig(version: MinecraftVersionJson) {
  const clientLogging = version.logging?.client;
  if (!clientLogging?.file?.url || !clientLogging.file.id) {
    return null;
  }

  const loggingId = assertSafeCacheSegment(clientLogging.file.id, "logging config id");
  const loggingPath = path.join(getSharedMinecraftRoot(), "assets", "log_configs", loggingId);
  writeLauncherLog("info", "logging", `Syncing log config ${loggingId}`);
  await downloadFile(trustedOfficialUrl(clientLogging.file.url), loggingPath, {
    algorithm: "sha1",
    value: requiredSha1(clientLogging.file.sha1, `Logging config ${loggingId}`),
  }, clientLogging.file.size);
  return { argument: clientLogging.argument, path: loggingPath };
}

async function ensureLibraries(version: MinecraftVersionJson) {
  const librariesRoot = path.join(getSharedMinecraftRoot(), "libraries");
  const safeVersionId = assertSafeCacheSegment(version.id, "loader version id");
  const nativesDir = path.join(getSharedMinecraftRoot(), "natives", safeVersionId);
  const classpath: string[] = [];
  const seenClasspath = new Set<string>();
  const seenLibraryIdentities = new Set<string>();

  await ensureDir(nativesDir);
  writeLauncherLog("info", "libraries", `Resolving libraries for ${version.id}`);

  for (const library of version.libraries ?? []) {
    if (!evaluateRules(library.rules)) {
      continue;
    }
    const libraryIdentity = mavenIdentity(library.name);
    if (seenLibraryIdentities.has(libraryIdentity)) {
      continue;
    }
    seenLibraryIdentities.add(libraryIdentity);

    const artifact = library.downloads?.artifact;
    const libraryPath = normalizeManagedRelativePath(artifact?.path ?? mavenPathFromName(library.name));
    const resolvedLibraryPath = safeJoinManaged(librariesRoot, libraryPath);
    await assertNoSymlinkComponents(librariesRoot, resolvedLibraryPath);

    const repositoryBase = library.url ? (library.url.endsWith("/") ? library.url : `${library.url}/`) : "";
    const explicitLibraryUrl = artifact?.url || (repositoryBase ? new URL(libraryPath, repositoryBase).toString() : "");
    const declaredSha1 = artifact?.sha1 ? requiredSha1(artifact.sha1, `Library ${library.name}`) : "";
    const localExists = await exists(resolvedLibraryPath);
    let declaredHashMatches = true;
    let declaredSizeMatches = true;

    if (localExists && declaredSha1) {
      const localSha1 = await sha1OfFile(resolvedLibraryPath).catch(() => "");
      declaredHashMatches = localSha1.toLowerCase() === declaredSha1.toLowerCase();
    }
    if (localExists && artifact?.size !== undefined) {
      const stat = await fs.stat(resolvedLibraryPath).catch(() => null);
      declaredSizeMatches = Boolean(stat?.isFile() && stat.size === artifact.size);
    }

    const libraryDecision = decideLibraryResolution({
      localExists,
      declaredHashMatches,
      declaredSizeMatches,
      hasExplicitDownloadUrl: Boolean(explicitLibraryUrl),
    });

    if (libraryDecision === "reinstall-loader") {
      // Forge/NeoForge installers can create processor outputs that are not
      // ordinary Maven downloads. A missing/corrupt generated artifact must
      // never be replaced from a guessed repository URL.
      throw new Error(`Loader-generated library is missing or corrupted: ${library.name}`);
    }
    if (libraryDecision === "download") {
      const trustedLibraryUrl = trustedOfficialUrl(explicitLibraryUrl);
      const librarySha1 = declaredSha1 || await resolveRemoteChecksum(trustedLibraryUrl, "sha1");
      await downloadFile(trustedLibraryUrl, resolvedLibraryPath, {
        algorithm: "sha1",
        value: librarySha1,
      }, artifact?.size);
    }

    if (!seenClasspath.has(resolvedLibraryPath)) {
      classpath.push(resolvedLibraryPath);
      seenClasspath.add(resolvedLibraryPath);
    }

    const nativesKey = library.natives?.[normalizeOsName()];
    const nativeSpec = nativesKey
      ? library.downloads?.classifiers?.[nativesKey.replace("${arch}", "64")]
      : undefined;

    if (nativeSpec?.url && nativeSpec.path) {
      const nativePath = normalizeManagedRelativePath(nativeSpec.path);
      const nativeArchivePath = safeJoinManaged(librariesRoot, nativePath);
      const trustedNativeUrl = trustedOfficialUrl(nativeSpec.url);
      const nativeSha1 = nativeSpec.sha1 || await resolveRemoteChecksum(trustedNativeUrl, "sha1");
      await downloadFile(trustedNativeUrl, nativeArchivePath, {
        algorithm: "sha1",
        value: nativeSha1,
      }, nativeSpec.size);

      const nativeZip = new AdmZip(nativeArchivePath);
      const nativeEntries = nativeZip.getEntries().filter((entry) => !entry.isDirectory && !entry.entryName.replace(/\\/g, "/").toUpperCase().startsWith("META-INF/"));
      let nativeBytes = 0;
      const flattenedNames = new Set<string>();
      for (const entry of nativeEntries) {
        assertSafeArchiveEntry(entry.entryName, nativesDir);
        if (zipEntryLooksLikeSymlink(entry)) throw new Error(`Native archive contains symlink: ${entry.entryName}`);
        const flattened = assertSafeCacheSegment(path.basename(entry.entryName.replace(/\\/g, "/")), "native filename").toLowerCase();
        if (flattenedNames.has(flattened)) throw new Error(`Native archive has duplicate flattened filename: ${flattened}`);
        flattenedNames.add(flattened);
        await assertNoSymlinkComponents(nativesDir, path.join(nativesDir, flattened));
        const header = entry.header as unknown as { size?: number; compressedSize?: number };
        const unpacked = Number(header.size ?? 0);
        const packed = Number(header.compressedSize ?? 0);
        if (!Number.isFinite(unpacked) || unpacked < 0 || !Number.isFinite(packed) || packed < 0) throw new Error("Invalid native archive metadata");
        if (packed > 0 && unpacked > 16 * 1024 * 1024 && unpacked / packed > 200) throw new Error(`Suspicious native compression ratio: ${entry.entryName}`);
        nativeBytes += unpacked;
        if (nativeBytes > 512 * 1024 * 1024) throw new Error("Native archive exceeds unpacked size limit");
      }
      for (const entry of nativeEntries) {
        nativeZip.extractEntryTo(entry, nativesDir, false, true, false);
      }
    }
  }

  return { classpath, nativesDir };
}

async function readLocalRelease(instanceDir: string): Promise<PackRelease | null> {
  const manifestPath = path.join(instanceDir, ".hexloader-release.json");
  try {
    await assertNoSymlinkComponents(instanceDir, manifestPath);
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return parsePackRelease(raw) as PackRelease;
  } catch {
    return null;
  }
}

async function verifyCachedManagedFiles(
  release: PackRelease,
  instanceDir: string,
  optionalFiles: readonly string[],
) {
  const activeFiles = selectedFilesForRelease(release, optionalFiles);
  for (const file of activeFiles) {
    const targetPath = safeJoinManaged(instanceDir, file.path);
    await assertNoSymlinkComponents(instanceDir, targetPath);
    if (!(await exists(targetPath))) {
      throw new Error(`Offline launch requires missing file: ${file.path}`);
    }
    if (!shouldVerifyManagedHash(file.updatePolicy, file.preserveUserChanges)) continue;
    if (!file.sha256) {
      if (file.required) throw new Error(`Cached required file has no SHA-256: ${file.path}`);
      continue;
    }
    const actual = await sha256OfFile(targetPath).catch(() => "");
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      throw new Error(`Offline launch detected corrupted file: ${file.path}`);
    }
  }
}

async function loadCachedLaunchContext(request: LaunchRequest): Promise<{ syncResult: SyncResult; version: MinecraftVersionJson }> {
  const safePackId = assertPackId(request.packId);
  const instanceDir = path.join(getInstancesRoot(), safePackId);
  const release = await readLocalRelease(instanceDir);
  if (!release) throw new Error(`Pack ${safePackId} is not installed locally`);
  if (request.packVersion && release.packVersion !== request.packVersion) {
    throw new Error(`Cached version ${release.packVersion} does not match requested ${request.packVersion}`);
  }
  const requestedChannel = assertReleaseChannel(request.releaseChannel ?? "stable");
  if (release.releaseChannel !== requestedChannel) {
    throw new Error(`Cached channel ${release.releaseChannel} does not match requested ${requestedChannel}`);
  }

  // Cached manifests are parsed again and cryptographically verified when signing is enabled.
  verifyManifestIntegrity(
    release as import("./security/contracts.cjs").PackRelease,
    MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
    Boolean(REQUIRE_SIGNED_MANIFESTS),
  );
  await verifyCachedManagedFiles(release, instanceDir, request.optionalFiles ?? []);

  const runtimeInfo = await getManagedRuntimeInfo(release.javaRequirements.majorVersion);
  if (!runtimeInfo.javaPath) throw new Error(`Managed Java ${release.javaRequirements.majorVersion} is not installed`);

  const launchVersionPath = path.join(instanceDir, ".hexloader-launch-version.json");
  let version: MinecraftVersionJson;
  try {
    await assertNoSymlinkComponents(instanceDir, launchVersionPath);
    version = JSON.parse(await fs.readFile(launchVersionPath, "utf8")) as MinecraftVersionJson;
  } catch {
    throw new Error("Cached launch metadata is missing or corrupted");
  }
  if (!version?.id || typeof version.id !== "string" || version.id.length > 256) {
    throw new Error("Cached launch metadata is invalid");
  }

  writeLauncherLog("warn", "launch", `Backend unavailable; using verified cached release ${release.packId}@${release.packVersion}`);
  return {
    version,
    syncResult: {
      release,
      javaPath: runtimeInfo.javaPath,
      instanceDir,
      versionId: version.id,
      downloadedFiles: 0,
      runtimeDownloaded: false,
    },
  };
}

function selectedFilesForRelease(release: PackRelease, optionalFiles: readonly string[]) {
  const selected = new Set(optionalFiles.map((item) => item.toLowerCase()));
  return release.files.filter((file) => file.updatePolicy !== "optional" || selected.has(file.path.toLowerCase()));
}

function obsoleteManagedPaths(
  previous: PackRelease | null,
  next: PackRelease,
  optionalFiles: readonly string[],
) {
  if (!previous) return [];
  const nextPaths = new Set(selectedFilesForRelease(next, optionalFiles).map((file) => file.path.toLowerCase()));
  return previous.files
    .filter((oldFile) => !nextPaths.has(oldFile.path.toLowerCase()) && !shouldPreserveObsoleteManagedFile(oldFile.updatePolicy, oldFile.preserveUserChanges))
    .map((oldFile) => oldFile.path);
}

type StagedPackFiles = {
  downloadedFiles: number;
  stagedPaths: string[];
};

async function stagePackFiles(
  release: PackRelease,
  previousRelease: PackRelease | null,
  instanceDir: string,
  stagingNewRoot: string,
  optionalFiles: readonly string[] = [],
): Promise<StagedPackFiles> {
  let downloadedFiles = 0;
  const stagedPaths: string[] = [];
  const activeFiles = selectedFilesForRelease(release, optionalFiles);
  const previousByPath = new Map((previousRelease?.files ?? []).map((file) => [file.path.toLowerCase(), file]));
  const totalBytes = activeFiles.reduce((sum, file) => sum + file.size, 0);
  let completedBytes = 0;
  const startedAt = Date.now();
  writeLauncherLog("info", "pack", `Preparing pack ${release.packId}@${release.packVersion} (${activeFiles.length} managed files)`);

  for (const file of activeFiles) {
    const targetPath = safeJoinManaged(instanceDir, file.path);
    await assertNoSymlinkComponents(instanceDir, targetPath);
    const expectedHash = file.sha256 || undefined;

    const targetExists = await exists(targetPath);
    let currentHash = "";
    if (targetExists && expectedHash) currentHash = await sha256OfFile(targetPath).catch(() => "");

    if (targetExists && file.preserveUserChanges) {
      completedBytes += file.size;
      launcherProgressHandler?.({
        status: "Preserving user file",
        currentFile: file.path,
        downloadedFiles,
        totalFiles: activeFiles.length,
        bytesProgress: completedBytes,
        totalBytes,
        speedMbSec: 0,
      });
      continue;
    }

    let alreadyValid = false;
    if (targetExists) {
      if (!expectedHash) {
        if (file.required) throw new Error(`Required file has no checksum: ${file.path}`);
        alreadyValid = true;
      } else {
        alreadyValid = currentHash.toLowerCase() === expectedHash.toLowerCase();
      }
    }
    if (alreadyValid) {
      completedBytes += file.size;
      continue;
    }

    if (targetExists && file.updatePolicy === "required_keep_if_same") {
      const previousFile = previousByPath.get(file.path.toLowerCase());
      if (shouldPreserveExistingManagedFile({
        updatePolicy: file.updatePolicy,
        preserveUserChanges: file.preserveUserChanges,
        currentHash,
        previousHash: previousFile?.sha256,
        expectedHash,
      })) {
        completedBytes += file.size;
        launcherProgressHandler?.({
          status: "Preserving modified file",
          currentFile: file.path,
          downloadedFiles,
          totalFiles: activeFiles.length,
          bytesProgress: completedBytes,
          totalBytes,
          speedMbSec: 0,
        });
        writeLauncherLog("info", "pack", `Preserving user-modified managed file ${file.path}`);
        continue;
      }
    }

    if (!expectedHash) throw new Error(`Refusing to download unverified pack file: ${file.path}`);

    const trustedUrl = assertSameOriginHttpUrl(file.sourceUrl, API_BASE);
    const stagedPath = safeJoinManaged(stagingNewRoot, file.path);
    await assertNoSymlinkComponents(stagingNewRoot, stagedPath);
    const fileBaseBytes = completedBytes;
    await downloadFile(
      trustedUrl,
      stagedPath,
      { algorithm: "sha256", value: expectedHash },
      file.size,
      false,
      (written) => {
        const elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000);
        launcherProgressHandler?.({
          status: "Downloading files",
          currentFile: file.path,
          downloadedFiles,
          totalFiles: activeFiles.length,
          bytesProgress: Math.min(totalBytes, fileBaseBytes + written),
          totalBytes,
          speedMbSec: Number(((fileBaseBytes + written) / 1024 / 1024 / elapsed).toFixed(1)),
        });
      },
    );
    completedBytes += file.size;
    downloadedFiles += 1;
    stagedPaths.push(file.path);
    launcherProgressHandler?.({
      status: "Verifying files",
      currentFile: file.path,
      downloadedFiles,
      totalFiles: activeFiles.length,
      bytesProgress: completedBytes,
      totalBytes,
      speedMbSec: 0,
    });
  }

  return { downloadedFiles, stagedPaths };
}


function parseResolution(value: string) {
  const [width, height] = value.split("x").map((part) => Number(part));
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720,
  };
}


function resolveArgumentValue(
  entry: string | { rules?: MinecraftLibrary["rules"]; value: string | string[] },
) {
  if (typeof entry === "string") {
    return [entry];
  }

  if (!evaluateRules(entry.rules)) {
    return [];
  }

  return Array.isArray(entry.value) ? entry.value : [entry.value];
}

function applyPlaceholders(input: string, placeholders: Record<string, string>) {
  return input.replace(/\$\{([^}]+)\}/g, (_match, key) => placeholders[key] ?? "");
}

function buildLaunchArguments(input: {
  version: MinecraftVersionJson;
  classpath: string[];
  nativesDir: string;
  clientJarPath: string;
  release: PackRelease;
  request: LaunchRequest;
  instanceDir: string;
  javaPath: string;
  loggingConfigPath: { argument: string; path: string } | null;
}) {
  const { width, height } = parseResolution(input.request.resolution);
  const uuid = offlineUuidFromNickname(input.request.nickname);
  const assetsRoot = path.join(getSharedMinecraftRoot(), "assets");
  const classpathSeparator = process.platform === "win32" ? ";" : ":";
  const placeholders: Record<string, string> = {
    natives_directory: input.nativesDir,
    launcher_name: "HexLoader",
    launcher_version: app.getVersion(),
    classpath: [...input.classpath, input.clientJarPath].join(classpathSeparator),
    classpath_separator: classpathSeparator,
    library_directory: path.join(getSharedMinecraftRoot(), "libraries"),
    version_name: input.version.id,
    version_type: input.version.type ?? "release",
    assets_root: assetsRoot,
    assets_index_name: input.version.assetIndex?.id ?? input.version.assets ?? "",
    game_directory: input.instanceDir,
    user_type: "legacy",
    auth_player_name: input.request.nickname,
    auth_uuid: uuid,
    auth_access_token: "offline",
    auth_session: "offline",
    clientid: "",
    auth_xuid: "",
    user_properties: "{}",
  };

  const jvmArgs = [
    `-Xms1024M`,
    `-Xmx${Math.max(1024, input.request.memoryMb)}M`,
    `-Djava.library.path=${input.nativesDir}`,
    `-Dminecraft.launcher.brand=HexLoader`,
    `-Dminecraft.launcher.version=${app.getVersion()}`,
  ];

  if (input.loggingConfigPath) {
    jvmArgs.push(
      applyPlaceholders(input.loggingConfigPath.argument, {
        path: input.loggingConfigPath.path,
      }),
    );
  }

  const resolvedJvmArguments = (input.version.arguments?.jvm ?? []).flatMap(resolveArgumentValue);
  for (const argument of resolvedJvmArguments) {
    const value = applyPlaceholders(argument, placeholders).trim();
    if (value) {
      jvmArgs.push(value);
    }
  }

  jvmArgs.push(input.version.mainClass ?? "net.minecraft.client.main.Main");

  const gameArgs = (input.version.arguments?.game ?? []).flatMap(resolveArgumentValue);
  const launchGameArgs = gameArgs.map((argument) => applyPlaceholders(argument, placeholders));

  if (launchGameArgs.length === 0 && input.version.minecraftArguments) {
    launchGameArgs.push(
      ...input.version.minecraftArguments
        .split(" ")
        .map((argument) => applyPlaceholders(argument, placeholders)),
    );
  }

  launchGameArgs.push("--width", String(width), "--height", String(height));
  if (input.request.fullscreen) {
    launchGameArgs.push("--fullscreen");
  }

  const serverLaunch = buildConfiguredServerLaunchArgs(
    input.release.minecraftVersion,
    input.release.serverBootstrap,
    input.request.serverOverride,
  );
  if (serverLaunch.args.length) {
    launchGameArgs.push(...serverLaunch.args);
    writeLauncherLog(
      "info",
      "launch",
      `Auto-connect enabled: ${serverLaunch.target} (${input.release.minecraftVersion})${serverLaunch.usedOverride ? " [user override]" : ""}`,
    );
  }

  return {
    executable: input.javaPath,
    args: [...jvmArgs, ...launchGameArgs],
    commandPreview: `${path.basename(input.javaPath)} ${jvmArgs.join(" ")} ...`,
  };
}

function validateReleaseTrust(release: PackRelease) {
  // Verify the server's canonical payload before normalizing any URL for local use.
  const integrity = verifyManifestIntegrity(
    release as import("./security/contracts.cjs").PackRelease,
    MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
    Boolean(REQUIRE_SIGNED_MANIFESTS),
  );
  for (const file of release.files) {
    file.sourceUrl = assertSameOriginHttpUrl(file.sourceUrl, API_BASE);
    if (file.required && !file.sha256) {
      throw new Error(`Required file has no SHA-256: ${file.path}`);
    }
  }
  writeLauncherLog(
    integrity.verified ? "info" : "warn",
    "manifest",
    `Manifest ${release.packId}@${release.packVersion}: ${integrity.mode}${integrity.verified ? " verified" : " compatibility mode"}`,
  );
  return release;
}

function isBackendConnectivityFailure(error: unknown) {
  if (error instanceof BackendProtocolError) return false;
  const status = Number((error as { status?: number } | null)?.status ?? 0);
  return !status || status >= 500;
}

function throwBackendConnectivityError(error: unknown, target: string): never {
  if (isBackendConnectivityFailure(error)) {
    throw new BackendUnavailableError(`Backend unavailable while loading ${target}`, { cause: error });
  }
  throw error;
}

async function fetchRelease(packId: string, releaseChannel: "stable" | "beta" | "test" = "stable") {
  const safePackId = assertPackId(packId);
  const channel = assertReleaseChannel(releaseChannel);
  let raw: unknown;
  try {
    raw = await fetchJson<unknown>(`${API_BASE}/packs/${encodeURIComponent(safePackId)}/latest?channel=${encodeURIComponent(channel)}`);
  } catch (error) {
    throwBackendConnectivityError(error, `${safePackId}:${channel}`);
  }
  const release = validateReleaseTrust(parsePackRelease(raw) as PackRelease);
  if (release.releaseChannel !== channel) throw new BackendProtocolError(`Backend returned channel ${release.releaseChannel}, expected ${channel}`);
  return release;
}

async function fetchReleaseByVersion(packId: string, packVersion?: string, releaseChannel: "stable" | "beta" | "test" = "stable") {
  const safePackId = assertPackId(packId);
  const safeVersion = assertPackVersion(packVersion, true);
  const channel = assertReleaseChannel(releaseChannel);
  if (!safeVersion) return fetchRelease(safePackId, channel);

  let raw: unknown;
  try {
    raw = await fetchJson<unknown>(
      `${API_BASE}/packs/${encodeURIComponent(safePackId)}/releases/${encodeURIComponent(safeVersion)}?channel=${encodeURIComponent(channel)}`,
    );
  } catch (error) {
    throwBackendConnectivityError(error, `${safePackId}@${safeVersion}:${channel}`);
  }
  const release = validateReleaseTrust(parsePackRelease(raw) as PackRelease);
  if (release.releaseChannel !== channel) throw new BackendProtocolError(`Backend returned channel ${release.releaseChannel}, expected ${channel}`);
  return release;
}

export async function fetchPackVersions(packId: string, includeArchived = true) {
  const safePackId = assertPackId(packId);
  let raw: unknown;
  try {
    raw = await fetchJson<unknown>(
      `${API_BASE}/packs/${encodeURIComponent(safePackId)}/versions?includeArchived=${includeArchived ? "true" : "false"}`,
    );
  } catch (error) {
    throwBackendConnectivityError(error, `${safePackId} versions`);
  }
  const versions = parsePackVersions(raw);
  if (versions.some((item) => item.packId !== safePackId)) {
    throw new BackendProtocolError(`Backend returned versions for a different pack`);
  }
  return versions;
}

function getInstanceDirForRelease(release: Pick<PackRelease, "packId">) {
  const safePackId = assertPackId(release.packId);
  return path.join(getInstancesRoot(), safePackId);
}

async function listLocalPackSummaries(): Promise<PackSummary[]> {
  const instancesRoot = getInstancesRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(instancesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > 512) throw new Error("Too many local instances");

  const packs: PackSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let packId: string;
    try { packId = assertPackId(entry.name); } catch { continue; }
    const instanceDir = path.join(instancesRoot, packId);
    await assertNoSymlinkComponents(instancesRoot, instanceDir);
    const release = await readLocalRelease(instanceDir);
    if (!release) continue;
    try {
      verifyManifestIntegrity(
        release as import("./security/contracts.cjs").PackRelease,
        MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
        Boolean(REQUIRE_SIGNED_MANIFESTS),
      );
    } catch (error) {
      writeLauncherLog("error", "offline", `Ignoring untrusted cached manifest for ${packId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    packs.push({
      packId: release.packId,
      packName: release.packName,
      description: "Локально установленная сборка (backend недоступен)",
      releaseChannel: release.releaseChannel,
      latestVersion: release.packVersion,
      minecraftVersion: release.minecraftVersion,
      loaderType: release.loaderType,
      loaderVersion: release.loaderVersion,
      javaVersion: release.javaRequirements.majorVersion,
      heroTitle: release.packName,
      heroSubtitle: `Offline • ${release.packVersion}`,
    });
  }
  return packs.sort((a, b) => a.packName.localeCompare(b.packName));
}

export async function fetchClientBootstrap() {
  writeLauncherLog("info", "bootstrap", "Loading launcher bootstrap");
  let raw: [unknown, unknown, unknown];
  try {
    raw = await Promise.all([
      fetchJson<unknown>(`${API_BASE}/launcher/version`, 256 * 1024),
      fetchJson<unknown>(`${API_BASE}/packs`, 4 * 1024 * 1024),
      fetchJson<unknown>(`${API_BASE}/notices`, 4 * 1024 * 1024),
    ]);
  } catch (error) {
    if (!isBackendConnectivityFailure(error)) throw error;
    const packs = await listLocalPackSummaries();
    if (!packs.length) throw new BackendUnavailableError("Backend unavailable and no trusted local packs are installed", { cause: error });
    writeLauncherLog("warn", "bootstrap", `Backend unavailable; exposing ${packs.length} trusted local pack(s)`);
    return {
      launcherVersion: {
        currentVersion: app.getVersion(),
        minimumSupportedBackend: "offline",
        maintenanceMode: false,
        backendApiVersion: "2.0.0-offline",
        capabilities: ["offline_cached_launch"],
      },
      packs,
      notices: [{
        id: "offline-mode",
        title: "Автономный режим",
        body: "Backend недоступен. Доступны только уже установленные и проверенные сборки; обновление и установка новых файлов отключены.",
        tone: "warning" as const,
      }],
      offline: true,
    };
  }

  const [launcherRaw, packsRaw, noticesRaw] = raw;
  return {
    launcherVersion: parseLauncherVersion(launcherRaw),
    packs: parsePackSummaries(packsRaw),
    notices: parseNotices(noticesRaw),
    offline: false,
  };
}

export async function fetchPackManifest(packId: string, packVersion?: string, releaseChannel: "stable" | "beta" | "test" = "stable") {
  try {
    return await fetchReleaseByVersion(packId, packVersion, releaseChannel);
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error;
    const safePackId = assertPackId(packId);
    const safeVersion = assertPackVersion(packVersion, true);
    const instanceDir = path.join(getInstancesRoot(), safePackId);
    const release = await readLocalRelease(instanceDir);
    if (!release || (safeVersion && release.packVersion !== safeVersion) || release.releaseChannel !== assertReleaseChannel(releaseChannel)) throw error;
    verifyManifestIntegrity(
      release as import("./security/contracts.cjs").PackRelease,
      MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
      Boolean(REQUIRE_SIGNED_MANIFESTS),
    );
    writeLauncherLog("warn", "manifest", `Backend unavailable; using cached manifest ${release.packId}@${release.packVersion}`);
    return release;
  }
}


export async function launchPack(request: LaunchRequest): Promise<LaunchResult> {
  gameEvents.setState({ status: "launching", packId: request.packId });
  writeLauncherLog("info", "launch", `Launch requested for ${request.packId} as ${request.nickname}`);
  let syncResult: SyncResult;
  let version: MinecraftVersionJson;
  try {
    syncResult = await syncPackVersion(request.packId, request.packVersion, request.releaseChannel ?? "stable", false, request.optionalFiles ?? []);
    version = await resolveLaunchVersion(syncResult.release, syncResult.javaPath);
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error;
    const cached = await loadCachedLaunchContext(request);
    syncResult = cached.syncResult;
    version = cached.version;
  }
  const resolvedMinecraftVersion = getResolvedMinecraftVersionId(syncResult.release, version);
  const neoForgeArtifacts =
    syncResult.release.loaderType === "NeoForge"
      ? getNeoForgeRuntimeArtifacts(syncResult.release.loaderVersion)
      : null;
  const safeResolvedMinecraftVersion = assertSafeCacheSegment(resolvedMinecraftVersion, "resolved Minecraft version");
  const clientJarPath = neoForgeArtifacts?.versionJar ??
    path.join(
      getSharedMinecraftRoot(),
      "versions",
      safeResolvedMinecraftVersion,
      `${safeResolvedMinecraftVersion}.jar`,
    );
  const [{ classpath, nativesDir }, loggingConfigPath] = await Promise.all([
    ensureLibraries(version),
    ensureLoggingConfig(version),
  ]);

  const launchPlan = buildLaunchArguments({
    version,
    classpath,
    nativesDir,
    clientJarPath,
    release: syncResult.release,
    request,
    instanceDir: syncResult.instanceDir,
    javaPath: syncResult.javaPath,
    loggingConfigPath,
  });

  await ensureDir(getLogsRoot());
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(getLogsRoot(), `${request.packId}-${timestamp}.log`);

  if (isPidRunning(activeMinecraftPid)) {
    throw new Error("Minecraft process is already running");
  }

  activeMinecraftProcess = null;
  activeMinecraftPid = null;

  const logHandle = await fs.open(logFile, "a", 0o600);
  await logHandle.appendFile(`[launcher] Starting Minecraft at ${new Date().toISOString()}\n`);
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(launchPlan.executable, launchPlan.args, {
      cwd: syncResult.instanceDir,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await logHandle.close().catch(() => {});
    gameEvents.setState({ status: "error", packId: request.packId, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  if (!child?.pid) {
    await logHandle.close().catch(() => {});
    writeLauncherLog("error", "launch", "Minecraft process did not return a PID");
    gameEvents.setState({ status: "error", packId: request.packId, message: "Failed to start Minecraft process" });
    throw new Error("Failed to start Minecraft process");
  }

  activeMinecraftProcess = child;
  activeMinecraftPid = child.pid;
  child.stdout?.on("data", (chunk: Buffer | string) => { void logHandle.appendFile(chunk).catch(() => {}); gameEvents.acceptChunk("stdout", chunk); });
  child.stderr?.on("data", (chunk: Buffer | string) => { void logHandle.appendFile(chunk).catch(() => {}); gameEvents.acceptChunk("stderr", chunk); });
  child.unref();
  gameEvents.setState({ status: "running", packId: request.packId, pid: child.pid });
  writeLauncherLog("info", "launch", `Minecraft started with PID ${child.pid}`);
  child.once("close", (code) => {
    gameEvents.flush(); void logHandle.close().catch(() => {});
    activeMinecraftProcess = null;
    activeMinecraftPid = null;
    writeLauncherLog("info", "launch", `Minecraft exited with code ${code ?? -1}`);
    gameEvents.setState({ status: "exited", packId: request.packId, exitCode: code });
  });
  child.once("error", (error) => {
    gameEvents.flush(); void logHandle.close().catch(() => {});
    activeMinecraftProcess = null;
    activeMinecraftPid = null;
    writeLauncherLog("error", "launch", `Minecraft process error: ${String(error)}`);
    gameEvents.setState({ status: "error", packId: request.packId, message: error.message });
  });

  return {
    ...syncResult,
    pid: child.pid,
    logFile,
    commandPreview: launchPlan.commandPreview,
  };
}

export async function getManagedRuntimeInfo(javaMajor: number) {
  const runtimeId = `temurin-${javaMajor}-win-x64`;
  const javaPath = await findJavaExecutable(path.join(getRuntimesRoot(), runtimeId));
  return {
    runtimeId,
    installed: Boolean(javaPath),
    javaPath,
  };
}


export async function syncPackVersion(packId: string, packVersion?: string, releaseChannel: "stable" | "beta" | "test" = "stable", repair = false, optionalFiles: string[] = []): Promise<SyncResult> {
  if (isPidRunning(activeMinecraftPid)) {
    throw new Error("Cannot modify a pack while Minecraft is running");
  }
  writeLauncherLog(
    "info",
    "sync",
    `${repair ? "Repair" : "Sync"} requested for ${packId}${packVersion ? `@${packVersion}` : ""}`,
  );
  const release = await fetchReleaseByVersion(packId, packVersion, releaseChannel);
  const instanceDir = getInstanceDirForRelease(release);
  const { javaPath, runtimeDownloaded } = await resolveJavaRuntime(release.javaRequirements.majorVersion, release.javaRequirements.sha256);
  let version = await resolveLaunchVersion(release, javaPath, repair && release.loaderType !== "Fabric");
  let resolvedMinecraftVersion = getResolvedMinecraftVersionId(release, version);
  let resolvedClientJarPath = await ensureClientJar(version, resolvedMinecraftVersion);
  if (release.loaderType === "NeoForge") {
    await ensureVersionAliasJar(version.id, resolvedClientJarPath);
  }

  await ensureDir(instanceDir);
  await Promise.all([ensureAssets(version), ensureLoggingConfig(version)]);
  try {
    await ensureLibraries(version);
  } catch (error) {
    const recoverableLoaderCacheError =
      release.loaderType !== "Fabric" &&
      error instanceof Error &&
      error.message.startsWith("Loader-generated library is missing or corrupted:");
    if (!recoverableLoaderCacheError) throw error;

    writeLauncherLog("warn", "loader", `${error.message}; rerunning ${release.loaderType} installer once`);
    version = await resolveLaunchVersion(release, javaPath, true);
    resolvedMinecraftVersion = getResolvedMinecraftVersionId(release, version);
    resolvedClientJarPath = await ensureClientJar(version, resolvedMinecraftVersion);
    if (release.loaderType === "NeoForge") {
      await ensureVersionAliasJar(version.id, resolvedClientJarPath);
    }
    await ensureLibraries(version);
  }

  const previousRelease = await readLocalRelease(instanceDir);
  const transactionRoot = path.join(instanceDir, `.hexloader-txn-${randomUUID()}`);
  const transactionNewRoot = path.join(transactionRoot, "new");
  await ensureDir(transactionNewRoot);
  let downloadedFiles = 0;
  let committed = false;
  let keepRecoveryData = false;
  try {
    const staged = await stagePackFiles(release, previousRelease, instanceDir, transactionNewRoot, optionalFiles);
    downloadedFiles = staged.downloadedFiles;

    const releaseMetadataPath = ".hexloader-release.json";
    const launchMetadataPath = ".hexloader-launch-version.json";
    await writeManagedTextAtomic(
      transactionNewRoot,
      safeJoinManaged(transactionNewRoot, releaseMetadataPath),
      JSON.stringify(release, null, 2),
    );
    await writeManagedTextAtomic(
      transactionNewRoot,
      safeJoinManaged(transactionNewRoot, launchMetadataPath),
      JSON.stringify(version, null, 2),
    );

    const obsoletePaths = obsoleteManagedPaths(previousRelease, release, optionalFiles);
    const transactionResult = await commitPackTransaction(
      instanceDir,
      transactionRoot,
      [...staged.stagedPaths, releaseMetadataPath, launchMetadataPath],
      obsoletePaths,
      assertNoSymlinkComponents,
    );
    for (const removedPath of transactionResult.removedPaths) {
      writeLauncherLog("info", "pack", `Removed obsolete managed file ${removedPath}`);
    }
    committed = true;
  } catch (error) {
    keepRecoveryData = error instanceof PackRollbackIncompleteError;
    throw error;
  } finally {
    if (committed || !keepRecoveryData) {
      await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    } else {
      writeLauncherLog("error", "sync", `Rollback was incomplete; recovery data kept at ${transactionRoot}`);
    }
  }
  await cleanupOldPackTransactions(instanceDir, assertNoSymlinkComponents, transactionRoot);

  launcherProgressHandler?.({
    status: "Ready",
    currentFile: "",
    downloadedFiles,
    totalFiles: selectedFilesForRelease(release, optionalFiles).length,
    bytesProgress: selectedFilesForRelease(release, optionalFiles).reduce((sum, file) => sum + file.size, 0),
    totalBytes: selectedFilesForRelease(release, optionalFiles).reduce((sum, file) => sum + file.size, 0),
    speedMbSec: 0,
  });
  writeLauncherLog("info", "sync", `Pack ${release.packId}@${release.packVersion} is ready`);

  return {
    release,
    javaPath,
    instanceDir,
    versionId: version.id,
    downloadedFiles,
    runtimeDownloaded,
  };
}

export async function getLauncherDiagnosticsForVersion(packId: string, packVersion?: string, releaseChannel: "stable" | "beta" | "test" = "stable") {
  const safePackId = assertPackId(packId);
  const safeVersion = assertPackVersion(packVersion, true);
  writeLauncherLog(
    "info",
    "diagnostics",
    `Collecting diagnostics for ${safePackId}${safeVersion ? `@${safeVersion}` : ""}`,
  );

  const instanceDir = path.join(getInstancesRoot(), safePackId);
  let release: PackRelease | null = null;
  try {
    release = await fetchReleaseByVersion(safePackId, safeVersion, releaseChannel);
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error;
    release = await readLocalRelease(instanceDir);
    if (!release) throw error;
    if (safeVersion && release.packVersion !== safeVersion) throw error;
    const channel = assertReleaseChannel(releaseChannel);
    if (release.releaseChannel !== channel) throw error;
    verifyManifestIntegrity(
      release as import("./security/contracts.cjs").PackRelease,
      MANIFEST_SIGNING_PUBLIC_KEY_BASE64,
      Boolean(REQUIRE_SIGNED_MANIFESTS),
    );
    writeLauncherLog("warn", "diagnostics", `Using verified cached metadata for ${safePackId}@${release.packVersion}`);
  }

  const runtimeInfo = await getManagedRuntimeInfo(release.javaRequirements.majorVersion);
  const instanceManifestPath = path.join(instanceDir, ".hexloader-release.json");
  const launchVersionPath = path.join(instanceDir, ".hexloader-launch-version.json");
  let installedManifestVersion = "";

  if (await exists(instanceManifestPath)) {
    try {
      await assertNoSymlinkComponents(instanceDir, instanceManifestPath);
      const rawManifest = await fs.readFile(instanceManifestPath, "utf-8");
      const manifest = JSON.parse(rawManifest) as { packVersion?: string };
      installedManifestVersion = String(manifest.packVersion ?? "");
    } catch {
      installedManifestVersion = "";
    }
  }

  const instanceInstalled =
    (await exists(instanceDir)) &&
    (await exists(instanceManifestPath)) &&
    (await exists(launchVersionPath)) &&
    installedManifestVersion === release.packVersion;
  const processRunning = isPidRunning(activeMinecraftPid);
  if (!processRunning) {
    activeMinecraftProcess = null;
    activeMinecraftPid = null;
  }

  return {
    packId: safePackId,
    release,
    runtimeInfo,
    instanceDir,
    instanceInstalled,
    installedManifestVersion,
    paths: {
      instanceManifestPath,
      launchVersionPath,
    },
    processRunning,
    roots: {
      launcherRoot: getLauncherRoot(),
      instancesRoot: getInstancesRoot(),
      sharedMinecraftRoot: getSharedMinecraftRoot(),
      runtimesRoot: getRuntimesRoot(),
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      totalMemoryMb: Math.floor(os.totalmem() / 1024 / 1024),
    },
  };
}

export async function deleteLocalPack(packId: string) {
  if (isPidRunning(activeMinecraftPid)) {
    throw new Error("Cannot delete a pack while Minecraft is running");
  }
  const safePackId = assertPackId(packId);
  const instanceDir = path.join(getInstancesRoot(), safePackId);

  await assertNoSymlinkComponents(getInstancesRoot(), instanceDir);
  await fs.rm(instanceDir, { recursive: true, force: true });
  writeLauncherLog("info", "storage", `Deleted local instance for ${safePackId}`);

  return { packId: safePackId, instanceDir, deleted: true };
}

export async function verifyPackFiles(packId: string, packVersion?: string, releaseChannel: "stable" | "beta" | "test" = "stable", optionalFiles: string[] = []) {
  writeLauncherLog("info", "verify", `Verifying files for ${packId}${packVersion ? `@${packVersion}` : ""}`);

  let release: PackRelease;
  try {
    release = await fetchReleaseByVersion(packId, packVersion, releaseChannel);
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error;
    writeLauncherLog("warn", "verify", `Cannot reach backend to verify ${packId}: ${error.message}`);
    return { status: "backend_unavailable" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: 0, serverVersion: "" };
  }

  const instanceDir = getInstanceDirForRelease(release);
  const activeFiles = selectedFilesForRelease(release, optionalFiles);
  const instanceManifestPath = path.join(instanceDir, ".hexloader-release.json");

  // Check if instance exists at all
  if (!(await exists(instanceDir)) || !(await exists(instanceManifestPath))) {
    writeLauncherLog("info", "verify", `Pack ${packId} is not installed locally`);
    return { status: "not_installed" as const, missingFiles: activeFiles.length, corruptedFiles: 0, newFiles: 0, totalFiles: activeFiles.length, serverVersion: release.packVersion };
  }

  // Read the full local manifest (with files array)
  let localManifest: { packVersion?: string; files?: PackFile[] } = {};
  try {
    await assertNoSymlinkComponents(instanceDir, instanceManifestPath);
    const raw = await fs.readFile(instanceManifestPath, "utf-8");
    localManifest = JSON.parse(raw);
  } catch {
    // Can't read → treat as not installed
    return { status: "not_installed" as const, missingFiles: activeFiles.length, corruptedFiles: 0, newFiles: 0, totalFiles: activeFiles.length, serverVersion: release.packVersion };
  }

  const localVersion = String(localManifest.packVersion ?? "");

  // Different version on server → update available
  if (localVersion && localVersion !== release.packVersion) {
    writeLauncherLog("info", "verify", `Update available: local ${localVersion} → server ${release.packVersion}`);
    return { status: "update_available" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: activeFiles.length, serverVersion: release.packVersion, localVersion };
  }

  // Same version — check if server manifest has files that the local manifest didn't have
  // (i.e. files were added to the same version on the backend)
  const localFilePaths = new Set((localManifest.files ?? []).map((f) => f.path));
  const localFileHashes = new Map((localManifest.files ?? []).map((f) => [f.path, f.sha256 ?? ""]));
  let newFiles = 0;
  let manifestChanged = false;

  for (const serverFile of activeFiles) {
    if (!localFilePaths.has(serverFile.path)) {
      // File exists on server but not in local manifest → new file added
      newFiles += 1;
      manifestChanged = true;
    } else {
      // File was in local manifest — check if hash changed on server side
      const localHash = localFileHashes.get(serverFile.path) ?? "";
      if (serverFile.sha256 && localHash && serverFile.sha256.toLowerCase() !== localHash.toLowerCase()) {
        manifestChanged = true;
      }
    }
  }

  // Verify each file on disk
  let missingFiles = 0;
  let corruptedFiles = 0;
  const corruptedPaths: string[] = [];

  for (const file of activeFiles) {
    const targetPath = safeJoinManaged(instanceDir, file.path);
    await assertNoSymlinkComponents(instanceDir, targetPath);

    if (!(await exists(targetPath))) {
      missingFiles += 1;
      continue;
    }

    if (file.sha256 && shouldVerifyManagedHash(file.updatePolicy, file.preserveUserChanges)) {
      try {
        const localHash = await sha256OfFile(targetPath);
        if (localHash.toLowerCase() !== file.sha256.toLowerCase()) {
          corruptedFiles += 1;
          corruptedPaths.push(file.path);
        }
      } catch {
        corruptedFiles += 1;
        corruptedPaths.push(file.path);
      }
    }
  }

  if (manifestChanged && missingFiles === 0 && corruptedFiles === 0 && newFiles > 0) {
    // Server added new files to the same version, but nothing on disk is broken
    writeLauncherLog("info", "verify", `Pack ${packId}: ${newFiles} new files added to version ${release.packVersion} on server`);
    return {
      status: "update_available" as const,
      missingFiles,
      corruptedFiles,
      newFiles,
      totalFiles: activeFiles.length,
      serverVersion: release.packVersion,
      localVersion,
    };
  }

  if (missingFiles > 0 || corruptedFiles > 0) {
    writeLauncherLog(
      "warn",
      "verify",
      `Pack ${packId}: ${missingFiles} missing, ${corruptedFiles} corrupted, ${newFiles} new out of ${activeFiles.length} selected files`,
    );
    return {
      status: "repair_required" as const,
      missingFiles,
      corruptedFiles,
      corruptedPaths,
      newFiles,
      totalFiles: activeFiles.length,
      serverVersion: release.packVersion,
      localVersion,
    };
  }

  if (manifestChanged) {
    writeLauncherLog("info", "verify", `Pack ${packId}: manifest changed on server for version ${release.packVersion}`);
    return {
      status: "update_available" as const,
      missingFiles: 0,
      corruptedFiles: 0,
      newFiles,
      totalFiles: activeFiles.length,
      serverVersion: release.packVersion,
      localVersion,
    };
  }

  writeLauncherLog("info", "verify", `Pack ${packId}@${release.packVersion} — all ${activeFiles.length} selected files verified OK`);
  return { status: "ok" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: activeFiles.length, serverVersion: release.packVersion, localVersion };
}

