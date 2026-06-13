import { app } from "electron";
import AdmZip = require("adm-zip");
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

type LauncherLogLevel = "info" | "warn" | "error";

type LauncherLogHandler = (entry: {
  level: LauncherLogLevel;
  scope: string;
  message: string;
}) => void;

type LauncherVersion = {
  currentVersion: string;
  minimumSupportedBackend: string;
  maintenanceMode: boolean;
};

type Notice = {
  id: string;
  title: string;
  body: string;
  tone: "info" | "warning" | "success";
};

type PackSummary = {
  packId: string;
  packName: string;
  description: string;
  releaseChannel: string;
  latestVersion: string;
  minecraftVersion: string;
  loaderType: "Fabric" | "Forge" | "NeoForge";
  loaderVersion: string;
  javaVersion: number;
  heroTitle: string;
  heroSubtitle: string;
};

type PackFile = {
  path: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  kind: string;
  updatePolicy: string;
  required: boolean;
  preserveUserChanges: boolean;
  executable: boolean;
};

type PackRelease = {
  packId: string;
  packName: string;
  packVersion: string;
  releaseChannel: string;
  minecraftVersion: string;
  loaderType: "Fabric" | "Forge" | "NeoForge";
  loaderVersion: string;
  javaRequirements: {
    majorVersion: number;
    vendor?: string;
    arch: string;
    os: string;
    runtimePackageId: string;
    sha256: string;
  };
  serverBootstrap: {
    serverName: string;
    serverAddress: string;
    serverPort: number;
    autoConnect: boolean;
    allowUserOverride: boolean;
  };
  files: PackFile[];
  changelog: string[];
  diagnostics: string[];
};

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
  nickname: string;
  memoryMb: number;
  resolution: string;
  fullscreen: boolean;
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
};

type DownloadSpec = {
  id?: string;
  path?: string;
  url: string;
  sha1?: string;
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
const { DEFAULT_API_BASE } = require("./sharedConfig.cjs");
let API_BASE = process.env.HEXLOADER_API_BASE ?? DEFAULT_API_BASE;

export function updateApiBase(newUrl: string) {
  API_BASE = newUrl || process.env.HEXLOADER_API_BASE || DEFAULT_API_BASE;
}
const MOJANG_VERSION_MANIFEST =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_PROFILE_URL = (minecraftVersion: string, loaderVersion: string) =>
  `https://meta.fabricmc.net/v2/versions/loader/${minecraftVersion}/${loaderVersion}/profile/json`;
const NEOFORGE_INSTALLER_URL = (loaderVersion: string) =>
  `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
const ADOPTIUM_ASSET_URL = (javaMajor: number, includeVendor = true) =>
  `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot?architecture=x64&image_type=jre&os=windows${
    includeVendor ? "&vendor=eclipse" : ""
  }`;

let activeMinecraftProcess: ReturnType<typeof spawn> | null = null;
let activeMinecraftPid: number | null = null;
let launcherLogHandler: LauncherLogHandler | null = null;

export function setLauncherLogHandler(handler: LauncherLogHandler | null) {
  launcherLogHandler = handler;
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

async function sha1OfFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha1").update(buffer).digest("hex");
}

async function sha256OfFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchJson<T>(url: string): Promise<T> {
  writeLauncherLog("info", "network", `GET ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "HexLoader/0.2.3",
    },
    signal: controller.signal,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }

    throw error;
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    writeLauncherLog("error", "network", `GET ${url} failed with ${response.status}`);
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  writeLauncherLog("info", "network", `GET ${url} -> ${response.status}`);

  return (await response.json()) as T;
}

async function downloadFile(
  url: string,
  destination: string,
  expectedHash?: { algorithm: "sha1" | "sha256"; value?: string },
) {
  if (await exists(destination)) {
    if (!expectedHash?.value) {
      return false;
    }

    const currentHash =
      expectedHash.algorithm === "sha1"
        ? await sha1OfFile(destination)
        : await sha256OfFile(destination);

    if (currentHash.toLowerCase() === expectedHash.value.toLowerCase()) {
      return false;
    }
  }

  await ensureDir(path.dirname(destination));
  writeLauncherLog("info", "download", `Preparing ${path.basename(destination)}`);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeLauncherLog(
        "info",
        "download",
        `Downloading ${path.basename(destination)} (attempt ${attempt + 1}/3)`,
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "HexLoader/0.2.3",
        },
        signal: controller.signal,
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Download timed out: ${url}`);
        }

        throw error;
      }).finally(() => clearTimeout(timeout));

      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${url}: ${response.status}`);
      }

      const tempPath = `${destination}.tmp`;
      await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(tempPath));
      await fs.rename(tempPath, destination);
      writeLauncherLog("info", "download", `Saved ${path.basename(destination)}`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      writeLauncherLog(
        attempt < 2 ? "warn" : "error",
        "download",
        `${path.basename(destination)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await fs.rm(`${destination}.tmp`, { force: true }).catch(() => {});
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (expectedHash?.value) {
    const actualHash =
      expectedHash.algorithm === "sha1"
        ? await sha1OfFile(destination)
        : await sha256OfFile(destination);

    if (actualHash.toLowerCase() !== expectedHash.value.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${path.basename(destination)}`);
    }
  }

  return true;
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
  const [group, artifact, version, classifier] = name.split(":");
  const base = `${group.replace(/\./g, "/")}/${artifact}/${version}`;
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${base}/${fileName}`;
}

function mergeVersions(base: MinecraftVersionJson, overlay: MinecraftVersionJson): MinecraftVersionJson {
  return {
    ...base,
    ...overlay,
    libraries: [...(base.libraries ?? []), ...(overlay.libraries ?? [])],
    arguments: {
      game: [...(base.arguments?.game ?? []), ...(overlay.arguments?.game ?? [])],
      jvm: [...(base.arguments?.jvm ?? []), ...(overlay.arguments?.jvm ?? [])],
    },
  };
}

async function getMinecraftVersionEntry(versionId: string) {
  const manifest = await fetchJson<{ versions: VersionManifestEntry[] }>(MOJANG_VERSION_MANIFEST);
  const version = manifest.versions.find((entry) => entry.id === versionId);
  if (!version) {
    throw new Error(`Minecraft version ${versionId} not found in official manifest`);
  }
  return version;
}

async function resolveMojangVersion(versionId: string): Promise<MinecraftVersionJson> {
  const entry = await getMinecraftVersionEntry(versionId);
  const root = getSharedMinecraftRoot();
  const versionJsonPath = path.join(root, "metadata", "versions", `${versionId}.json`);
  await downloadFile(entry.url, versionJsonPath, { algorithm: "sha1", value: undefined });
  return JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
}

async function resolveFabricVersion(release: PackRelease) {
  if (release.loaderType !== "Fabric") {
    throw new Error(`Unsupported loader type for MVP: ${release.loaderType}`);
  }

  return fetchJson<MinecraftVersionJson>(
    FABRIC_PROFILE_URL(release.minecraftVersion, release.loaderVersion),
  );
}

function getNeoForgeVersionId(loaderVersion: string) {
  return `neoforge-${loaderVersion}`;
}

function getNeoForgeVersionJsonPath(loaderVersion: string) {
  const versionId = getNeoForgeVersionId(loaderVersion);
  return path.join(getSharedMinecraftRoot(), "versions", versionId, `${versionId}.json`);
}

function getNeoForgeLibraryDir(loaderVersion: string) {
  return path.join(getSharedMinecraftRoot(), "libraries", "net", "neoforged", "neoforge", loaderVersion);
}

function getNeoForgeRuntimeArtifacts(loaderVersion: string) {
  const root = getNeoForgeLibraryDir(loaderVersion);
  const versionId = getNeoForgeVersionId(loaderVersion);
  return {
    universalJar: path.join(root, `${versionId}-universal.jar`),
    patchedClientJar: path.join(root, `${versionId}-client.jar`),
    versionJar: path.join(getSharedMinecraftRoot(), "versions", versionId, `${versionId}.jar`),
  };
}

async function ensureLauncherProfilesStub(rootDir: string) {
  const profilesPath = path.join(rootDir, "launcher_profiles.json");
  if (await exists(profilesPath)) {
    return;
  }

  await ensureDir(rootDir);
  await fs.writeFile(profilesPath, JSON.stringify({ profiles: {}, selectedProfile: "" }, null, 2), "utf-8");
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
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || outputTail.join("\n") || `Process exited with code ${exitCode}`);
  }
}

async function ensureNeoForgeVersion(release: PackRelease, javaPath: string) {
  if (release.loaderType !== "NeoForge") {
    throw new Error(`Unsupported loader type for NeoForge resolver: ${release.loaderType}`);
  }

  const versionJsonPath = getNeoForgeVersionJsonPath(release.loaderVersion);
  const cachedVersion = await exists(versionJsonPath);
  const runtimeArtifacts = getNeoForgeRuntimeArtifacts(release.loaderVersion);

  if (
    cachedVersion &&
    (await exists(runtimeArtifacts.universalJar)) &&
    (await exists(runtimeArtifacts.patchedClientJar))
  ) {
    writeLauncherLog("info", "loader", `Using cached NeoForge ${release.loaderVersion}`);
    return JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
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
  await downloadFile(NEOFORGE_INSTALLER_URL(release.loaderVersion), installerPath);
  await runCommand(
    javaPath,
    ["-jar", installerPath, "--install-client", getSharedMinecraftRoot()],
    getSharedMinecraftRoot(),
    "loader",
  );

  if (!(await exists(versionJsonPath))) {
    throw new Error(`NeoForge installer did not create ${path.basename(versionJsonPath)}`);
  }

  if (
    !(await exists(runtimeArtifacts.universalJar)) ||
    !(await exists(runtimeArtifacts.patchedClientJar))
  ) {
    throw new Error(`NeoForge ${release.loaderVersion} installation is incomplete`);
  }

  return JSON.parse(await fs.readFile(versionJsonPath, "utf-8")) as MinecraftVersionJson;
}

function getResolvedMinecraftVersionId(release: PackRelease, version: Pick<MinecraftVersionJson, "inheritsFrom" | "id">) {
  return version.inheritsFrom || release.minecraftVersion;
}

async function ensureVersionAliasJar(versionId: string, sourceJarPath: string) {
  const aliasJarPath = path.join(getSharedMinecraftRoot(), "versions", versionId, `${versionId}.jar`);
  await ensureDir(path.dirname(aliasJarPath));

  const sourceExists = await exists(sourceJarPath);
  if (!sourceExists) {
    throw new Error(`Source jar missing for alias ${versionId}: ${path.basename(sourceJarPath)}`);
  }

  if (await exists(aliasJarPath)) {
    const [sourceStat, aliasStat] = await Promise.all([fs.stat(sourceJarPath), fs.stat(aliasJarPath)]);
    if (sourceStat.size === aliasStat.size) {
      return aliasJarPath;
    }
  }

  await fs.copyFile(sourceJarPath, aliasJarPath);
  return aliasJarPath;
}

async function resolveLaunchVersion(release: PackRelease, javaPath?: string) {
  let loaderVersion: MinecraftVersionJson;

  if (release.loaderType === "Fabric") {
    loaderVersion = await resolveFabricVersion(release);
  } else if (release.loaderType === "NeoForge") {
    if (!javaPath) {
      throw new Error("NeoForge installation requires a resolved Java runtime");
    }
    loaderVersion = await ensureNeoForgeVersion(release, javaPath);
  } else {
    throw new Error(`Unsupported loader type: ${release.loaderType}`);
  }

  const resolvedMinecraftVersion = getResolvedMinecraftVersionId(release, loaderVersion);
  if (resolvedMinecraftVersion !== release.minecraftVersion) {
    writeLauncherLog(
      "warn",
      "loader",
      `Loader metadata targets Minecraft ${resolvedMinecraftVersion}, manifest declares ${release.minecraftVersion}`,
    );
  }

  const baseVersion = await resolveMojangVersion(resolvedMinecraftVersion);
  return mergeVersions(baseVersion, loaderVersion);
}

async function resolveJavaRuntime(javaMajor: number) {
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
  const zipPath = path.join(runtimeRoot, runtimeAsset.name);
  writeLauncherLog("info", "java", `Downloading runtime package ${runtimeAsset.name}`);
  await downloadFile(runtimeAsset.link, zipPath, {
    algorithm: "sha256",
    value: runtimeAsset.checksum,
  });

  const zip = new AdmZip(zipPath);
  writeLauncherLog("info", "java", `Extracting runtime ${runtimeAsset.name}`);
  zip.extractAllTo(runtimeRoot, true);
  await fs.writeFile(markerPath, runtimeAsset.link, "utf-8");

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
  const client = version.downloads?.client;
  if (!client) {
    throw new Error(`Client jar metadata missing for ${minecraftVersion}`);
  }

  const jarPath = path.join(getSharedMinecraftRoot(), "versions", minecraftVersion, `${minecraftVersion}.jar`);
  await downloadFile(client.url, jarPath, {
    algorithm: "sha1",
    value: client.sha1,
  });

  return jarPath;
}

async function ensureAssets(version: MinecraftVersionJson) {
  if (!version.assetIndex) {
    return;
  }

  const assetsRoot = path.join(getSharedMinecraftRoot(), "assets");
  const indexPath = path.join(assetsRoot, "indexes", `${version.assetIndex.id}.json`);
  writeLauncherLog("info", "assets", `Syncing asset index ${version.assetIndex.id}`);
  await downloadFile(version.assetIndex.url, indexPath, {
    algorithm: "sha1",
    value: version.assetIndex.sha1,
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
        const objectPath = path.join(
          assetsRoot,
          "objects",
          objectData.hash.slice(0, 2),
          objectData.hash,
        );
        const objectUrl = `https://resources.download.minecraft.net/${objectData.hash.slice(0, 2)}/${objectData.hash}`;
        await downloadFile(objectUrl, objectPath, {
          algorithm: "sha1",
          value: objectData.hash,
        });
      }),
    );
  }
}

async function ensureLoggingConfig(version: MinecraftVersionJson) {
  const clientLogging = version.logging?.client;
  if (!clientLogging?.file?.url || !clientLogging.file.id) {
    return null;
  }

  const loggingPath = path.join(
    getSharedMinecraftRoot(),
    "assets",
    "log_configs",
    clientLogging.file.id,
  );
  writeLauncherLog("info", "logging", `Syncing log config ${clientLogging.file.id}`);
  await downloadFile(clientLogging.file.url, loggingPath, {
    algorithm: "sha1",
    value: clientLogging.file.sha1,
  });
  return { argument: clientLogging.argument, path: loggingPath };
}

async function ensureLibraries(version: MinecraftVersionJson) {
  const librariesRoot = path.join(getSharedMinecraftRoot(), "libraries");
  const nativesDir = path.join(getSharedMinecraftRoot(), "natives", version.id);
  const classpath: string[] = [];
  const seenClasspath = new Set<string>();

  await ensureDir(nativesDir);
  writeLauncherLog("info", "libraries", `Resolving libraries for ${version.id}`);

  for (const library of version.libraries ?? []) {
    if (!evaluateRules(library.rules)) {
      continue;
    }

    const artifact = library.downloads?.artifact;
    const libraryPath = artifact?.path ?? mavenPathFromName(library.name);
    const libraryUrl =
      artifact?.url ??
      `${library.url ?? "https://libraries.minecraft.net/"}${libraryPath}`;
    const resolvedLibraryPath = path.join(librariesRoot, libraryPath.replace(/\//g, path.sep));

    await downloadFile(libraryUrl, resolvedLibraryPath, {
      algorithm: "sha1",
      value: artifact?.sha1,
    });
    if (!seenClasspath.has(resolvedLibraryPath)) {
      classpath.push(resolvedLibraryPath);
      seenClasspath.add(resolvedLibraryPath);
    }

    const nativesKey = library.natives?.[normalizeOsName()];
    const nativeSpec = nativesKey
      ? library.downloads?.classifiers?.[nativesKey.replace("${arch}", "64")]
      : undefined;

    if (nativeSpec?.url && nativeSpec.path) {
      const nativeArchivePath = path.join(
        librariesRoot,
        nativeSpec.path.replace(/\//g, path.sep),
      );
      await downloadFile(nativeSpec.url, nativeArchivePath, {
        algorithm: "sha1",
        value: nativeSpec.sha1,
      });

      const zip = new AdmZip(nativeArchivePath);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || entry.entryName.includes("META-INF")) {
          continue;
        }
        zip.extractEntryTo(entry, nativesDir, false, true);
      }
    }
  }

  return { classpath, nativesDir };
}

async function ensurePackFiles(release: PackRelease, instanceDir: string, repair = false) {
  let downloadedFiles = 0;
  writeLauncherLog(
    "info",
    "pack",
    `${repair ? "Repairing" : "Syncing"} pack ${release.packId}@${release.packVersion}`,
  );

  for (const file of release.files) {
    const targetPath = path.join(instanceDir, file.path);
    const expectedHash = file.sha256 || undefined;

    if (!repair && (await exists(targetPath)) && expectedHash) {
      const currentHash = await sha256OfFile(targetPath).catch(() => "");
      if (currentHash.toLowerCase() === expectedHash.toLowerCase()) {
        continue;
      }
    } else if (!repair && (await exists(targetPath)) && !expectedHash) {
      continue;
    }

    const changed = await downloadFile(file.sourceUrl, targetPath, {
      algorithm: "sha256",
      value: expectedHash,
    });
    if (changed) {
      downloadedFiles += 1;
    }
  }

  return downloadedFiles;
}

function parseResolution(value: string) {
  const [width, height] = value.split("x").map((part) => Number(part));
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720,
  };
}

function offlineUuidFromNickname(nickname: string) {
  return createHash("md5").update(`OfflinePlayer:${nickname}`).digest("hex");
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
  loaderClasspath?: string[];
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
    launcher_version: "0.2.3",
    classpath: [...input.classpath, ...(input.loaderClasspath ?? []), input.clientJarPath].join(classpathSeparator),
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
    `-Dminecraft.launcher.version=0.2.3`,
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

  if (input.release.serverBootstrap.autoConnect) {
    launchGameArgs.push(
      "--server",
      input.release.serverBootstrap.serverAddress,
      "--port",
      String(input.release.serverBootstrap.serverPort),
    );
  }

  return {
    executable: input.javaPath,
    args: [...jvmArgs, ...launchGameArgs],
    commandPreview: `${path.basename(input.javaPath)} ${jvmArgs.join(" ")} ...`,
  };
}

async function fetchRelease(packId: string) {
  return fetchJson<PackRelease>(`${API_BASE}/packs/${packId}/latest?channel=stable`);
}

async function fetchReleaseByVersion(packId: string, packVersion?: string) {
  if (!packVersion?.trim()) {
    return fetchRelease(packId);
  }

  return fetchJson<PackRelease>(
    `${API_BASE}/packs/${packId}/releases/${encodeURIComponent(packVersion)}?channel=stable`,
  );
}

function getInstanceDirForRelease(release: Pick<PackRelease, "packId">) {
  return path.join(getInstancesRoot(), release.packId);
}

export async function fetchClientBootstrap() {
  writeLauncherLog("info", "bootstrap", "Loading launcher bootstrap");
  const [launcherVersion, packs, notices] = await Promise.all([
    fetchJson<LauncherVersion>(`${API_BASE}/launcher/version`),
    fetchJson<PackSummary[]>(`${API_BASE}/packs`),
    fetchJson<Notice[]>(`${API_BASE}/notices`),
  ]);

  return {
    launcherVersion,
    packs,
    notices,
  };
}

export async function syncPack(packId: string, repair = false): Promise<SyncResult> {
  return syncPackVersion(packId, undefined, repair);
}

export async function launchPack(request: LaunchRequest): Promise<LaunchResult> {
  writeLauncherLog("info", "launch", `Launch requested for ${request.packId} as ${request.nickname}`);
  const syncResult = await syncPackVersion(request.packId, request.packVersion, false);
  const version = await resolveLaunchVersion(syncResult.release, syncResult.javaPath);
  const resolvedMinecraftVersion = getResolvedMinecraftVersionId(syncResult.release, version);
  const neoForgeArtifacts =
    syncResult.release.loaderType === "NeoForge"
      ? getNeoForgeRuntimeArtifacts(syncResult.release.loaderVersion)
      : null;
  const clientJarPath = neoForgeArtifacts?.versionJar ??
    path.join(
      getSharedMinecraftRoot(),
      "versions",
      resolvedMinecraftVersion,
      `${resolvedMinecraftVersion}.jar`,
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
  const logStream = createWriteStream(logFile, { flags: "a" });

  if (isPidRunning(activeMinecraftPid)) {
    throw new Error("Minecraft process is already running");
  }

  activeMinecraftProcess = null;
  activeMinecraftPid = null;

  const child = spawn(launchPlan.executable, launchPlan.args, {
    cwd: syncResult.instanceDir,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });

  if (!child.pid) {
    logStream.end();
    writeLauncherLog("error", "launch", "Minecraft process did not return a PID");
    throw new Error("Failed to start Minecraft process");
  }

  activeMinecraftProcess = child;
  activeMinecraftPid = child.pid;
  child.unref();
  logStream.end(
    `[launcher] Detached Minecraft process ${child.pid} started at ${new Date().toISOString()}\n`,
  );
  writeLauncherLog("info", "launch", `Minecraft started with PID ${child.pid}`);
  child.once("close", (code) => {
    activeMinecraftProcess = null;
    activeMinecraftPid = null;
    writeLauncherLog("info", "launch", `Minecraft exited with code ${code ?? -1}`);
  });
  child.once("error", (error) => {
    activeMinecraftProcess = null;
    activeMinecraftPid = null;
    writeLauncherLog("error", "launch", `Minecraft process error: ${String(error)}`);
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

export async function getLauncherDiagnostics(packId: string) {
  return getLauncherDiagnosticsForVersion(packId);
}

export async function syncPackVersion(packId: string, packVersion?: string, repair = false): Promise<SyncResult> {
  writeLauncherLog(
    "info",
    "sync",
    `${repair ? "Repair" : "Sync"} requested for ${packId}${packVersion ? `@${packVersion}` : ""}`,
  );
  const release = await fetchReleaseByVersion(packId, packVersion);
  const instanceDir = getInstanceDirForRelease(release);
  const { javaPath, runtimeDownloaded } = await resolveJavaRuntime(release.javaRequirements.majorVersion);
  const version = await resolveLaunchVersion(release, javaPath);
  const resolvedMinecraftVersion = getResolvedMinecraftVersionId(release, version);
  const resolvedClientJarPath = await ensureClientJar(version, resolvedMinecraftVersion);
  if (release.loaderType === "NeoForge") {
    await ensureVersionAliasJar(version.id, resolvedClientJarPath);
  }

  await Promise.all([
    ensureDir(instanceDir),
    ensureAssets(version),
    ensureLoggingConfig(version),
    ensureLibraries(version),
  ]);

  const downloadedFiles = await ensurePackFiles(release, instanceDir, repair);

  await fs.writeFile(path.join(instanceDir, ".hexloader-release.json"), JSON.stringify(release, null, 2), "utf-8");
  await fs.writeFile(
    path.join(instanceDir, ".hexloader-launch-version.json"),
    JSON.stringify(version, null, 2),
    "utf-8",
  );

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

export async function getLauncherDiagnosticsForVersion(packId: string, packVersion?: string) {
  writeLauncherLog(
    "info",
    "diagnostics",
    `Collecting diagnostics for ${packId}${packVersion ? `@${packVersion}` : ""}`,
  );
  const release = await fetchReleaseByVersion(packId, packVersion);
  const runtimeInfo = await getManagedRuntimeInfo(release.javaRequirements.majorVersion);
  const instanceDir = getInstanceDirForRelease(release);
  const instanceManifestPath = path.join(instanceDir, ".hexloader-release.json");
  const launchVersionPath = path.join(instanceDir, ".hexloader-launch-version.json");
  let installedManifestVersion = "";

  if (await exists(instanceManifestPath)) {
    try {
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
    packId,
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
  const release = await fetchRelease(packId);
  const instanceDir = getInstanceDirForRelease(release);

  if (isPidRunning(activeMinecraftPid)) {
    throw new Error("Minecraft process is already running");
  }

  await fs.rm(instanceDir, { recursive: true, force: true });
  writeLauncherLog("info", "storage", `Deleted local instance for ${packId}`);

  return {
    packId,
    instanceDir,
    deleted: true,
  };
}

export async function verifyPackFiles(packId: string, packVersion?: string) {
  writeLauncherLog("info", "verify", `Verifying files for ${packId}${packVersion ? `@${packVersion}` : ""}`);

  let release: PackRelease;
  try {
    release = await fetchReleaseByVersion(packId, packVersion);
  } catch {
    writeLauncherLog("warn", "verify", `Cannot reach backend to verify ${packId}, assuming ok`);
    return { status: "ok" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: 0, serverVersion: "" };
  }

  const instanceDir = getInstanceDirForRelease(release);
  const instanceManifestPath = path.join(instanceDir, ".hexloader-release.json");

  // Check if instance exists at all
  if (!(await exists(instanceDir)) || !(await exists(instanceManifestPath))) {
    writeLauncherLog("info", "verify", `Pack ${packId} is not installed locally`);
    return { status: "not_installed" as const, missingFiles: release.files.length, corruptedFiles: 0, newFiles: 0, totalFiles: release.files.length, serverVersion: release.packVersion };
  }

  // Read the full local manifest (with files array)
  let localManifest: { packVersion?: string; files?: PackFile[] } = {};
  try {
    const raw = await fs.readFile(instanceManifestPath, "utf-8");
    localManifest = JSON.parse(raw);
  } catch {
    // Can't read → treat as not installed
    return { status: "not_installed" as const, missingFiles: release.files.length, corruptedFiles: 0, newFiles: 0, totalFiles: release.files.length, serverVersion: release.packVersion };
  }

  const localVersion = String(localManifest.packVersion ?? "");

  // Different version on server → update available
  if (localVersion && localVersion !== release.packVersion) {
    writeLauncherLog("info", "verify", `Update available: local ${localVersion} → server ${release.packVersion}`);
    return { status: "update_available" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: release.files.length, serverVersion: release.packVersion, localVersion };
  }

  // Same version — check if server manifest has files that the local manifest didn't have
  // (i.e. files were added to the same version on the backend)
  const localFilePaths = new Set((localManifest.files ?? []).map((f) => f.path));
  const localFileHashes = new Map((localManifest.files ?? []).map((f) => [f.path, f.sha256 ?? ""]));
  let newFiles = 0;
  let manifestChanged = false;

  for (const serverFile of release.files) {
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

  for (const file of release.files) {
    const targetPath = path.join(instanceDir, file.path);

    if (!(await exists(targetPath))) {
      missingFiles += 1;
      continue;
    }

    if (file.sha256) {
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
      totalFiles: release.files.length,
      serverVersion: release.packVersion,
      localVersion,
    };
  }

  if (missingFiles > 0 || corruptedFiles > 0) {
    writeLauncherLog(
      "warn",
      "verify",
      `Pack ${packId}: ${missingFiles} missing, ${corruptedFiles} corrupted, ${newFiles} new out of ${release.files.length} files`,
    );
    return {
      status: "repair_required" as const,
      missingFiles,
      corruptedFiles,
      corruptedPaths,
      newFiles,
      totalFiles: release.files.length,
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
      totalFiles: release.files.length,
      serverVersion: release.packVersion,
      localVersion,
    };
  }

  writeLauncherLog("info", "verify", `Pack ${packId}@${release.packVersion} — all ${release.files.length} files verified OK`);
  return { status: "ok" as const, missingFiles: 0, corruptedFiles: 0, newFiles: 0, totalFiles: release.files.length, serverVersion: release.packVersion, localVersion };
}

