import { assertPackId, assertPackVersion, assertReleaseChannel, assertServerAddress, assertServerPort, assertSha256, normalizeManagedRelativePath } from "./validation.cjs";
import type { ManagedUpdatePolicy } from "./managedPolicy.cjs";

export type LauncherVersion = {
  currentVersion: string;
  minimumSupportedBackend: string;
  maintenanceMode: boolean;
  backendApiVersion: string;
  capabilities: string[];
};

export type Notice = {
  id: string;
  title: string;
  body: string;
  tone: "info" | "warning" | "success";
};

export type PackSummary = {
  packId: string;
  packName: string;
  description: string;
  releaseChannel: "stable" | "beta" | "test";
  latestVersion: string;
  minecraftVersion: string;
  loaderType: "Fabric" | "Forge" | "NeoForge";
  loaderVersion: string;
  javaVersion: number;
  heroTitle: string;
  heroSubtitle: string;
};

export type PackVersionSummary = {
  packId: string;
  packVersion: string;
  releaseChannel: "stable" | "beta" | "test";
  archived: boolean;
  publishedAt: string;
};

export type PackFile = {
  path: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  kind: string;
  updatePolicy: ManagedUpdatePolicy;
  required: boolean;
  preserveUserChanges: boolean;
};

export type PackRelease = {
  packId: string;
  packName: string;
  packVersion: string;
  archived: boolean;
  releaseChannel: "stable" | "beta" | "test";
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
    motd: string;
  };
  files: PackFile[];
  changelog: string[];
  publishedAt: string;
  manifestHash: string;
  signature: string;
  stateMachine: string[];
  diagnostics: string[];
};

export type LauncherUpdateManifest = {
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

function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a valid string`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function int(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function strings(value: unknown, label: string, maxItems = 256, maxItemLength = 4096): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array`);
  return value.map((item, index) => str(item, `${label}[${index}]`, maxItemLength, true));
}

const REQUIRED_BACKEND_CAPABILITIES = new Set([
  "fabric", "forge", "neoforge",
  "release_channels", "release_channel_snapshots", "version_selection", "artifact_policies",
  "server_bootstrap", "server_override", "server_motd", "quick_play_multiplayer",
  "launcher_updates", "signed_manifests", "maintenance_notices",
]);

export function parseLauncherVersion(value: unknown): LauncherVersion {
  const v = obj(value, "launcher version");
  const backendApiVersion = str(v.backendApiVersion, "backendApiVersion", 64);
  if (!/^2(?:\.|$)/.test(backendApiVersion)) {
    throw new Error(`Unsupported HexLoader backend API version: ${backendApiVersion}`);
  }
  const capabilities = strings(v.capabilities, "capabilities", 128, 128);
  const capabilitySet = new Set(capabilities);
  const missing = [...REQUIRED_BACKEND_CAPABILITIES].filter((capability) => !capabilitySet.has(capability));
  if (missing.length) {
    throw new Error(`Backend is missing required launcher capabilities: ${missing.join(", ")}`);
  }
  return {
    currentVersion: str(v.currentVersion, "currentVersion", 64),
    minimumSupportedBackend: str(v.minimumSupportedBackend, "minimumSupportedBackend", 64),
    maintenanceMode: bool(v.maintenanceMode, "maintenanceMode"),
    backendApiVersion,
    capabilities,
  };
}

export function parseNotices(value: unknown): Notice[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("notices must be an array");
  return value.map((item, index) => {
    const v = obj(item, `notice[${index}]`);
    const tone = str(v.tone, `notice[${index}].tone`, 16);
    if (!(["info", "warning", "success"] as const).includes(tone as Notice["tone"])) {
      throw new Error(`Invalid notice tone: ${tone}`);
    }
    return {
      id: str(v.id, `notice[${index}].id`, 128),
      title: str(v.title, `notice[${index}].title`, 256),
      body: str(v.body, `notice[${index}].body`, 8192, true),
      tone: tone as Notice["tone"],
    };
  });
}

function parseLoaderType(value: unknown, label: string): PackSummary["loaderType"] {
  const loader = str(value, label, 16);
  if (loader !== "Fabric" && loader !== "Forge" && loader !== "NeoForge") {
    throw new Error(`Unsupported loader type: ${loader}`);
  }
  return loader;
}

export function parsePackSummaries(value: unknown): PackSummary[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("packs must be an array");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const v = obj(item, `pack[${index}]`);
    const packId = assertPackId(v.packId);
    const key = packId.toLowerCase();
    if (ids.has(key)) throw new Error(`Duplicate pack id: ${packId}`);
    ids.add(key);
    return {
      packId,
      packName: str(v.packName, `pack[${index}].packName`, 256),
      description: str(v.description, `pack[${index}].description`, 4096, true),
      releaseChannel: assertReleaseChannel(v.releaseChannel),
      latestVersion: assertPackVersion(v.latestVersion)!,
      minecraftVersion: assertPackVersion(v.minecraftVersion)!,
      loaderType: parseLoaderType(v.loaderType, `pack[${index}].loaderType`),
      loaderVersion: assertPackVersion(v.loaderVersion)!,
      javaVersion: int(v.javaVersion, `pack[${index}].javaVersion`, 8, 99),
      heroTitle: str(v.heroTitle, `pack[${index}].heroTitle`, 256, true),
      heroSubtitle: str(v.heroSubtitle, `pack[${index}].heroSubtitle`, 512, true),
    };
  });
}

export function parsePackVersions(value: unknown): PackVersionSummary[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("versions must be an array");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const v = obj(item, `version[${index}]`);
    const packId = assertPackId(v.packId);
    const packVersion = assertPackVersion(v.packVersion)!;
    const key = packVersion.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate pack version: ${packVersion}`);
    seen.add(key);
    return {
      packId,
      packVersion,
      releaseChannel: assertReleaseChannel(v.releaseChannel),
      archived: bool(v.archived, `version[${index}].archived`),
      publishedAt: typeof v.publishedAt === "string" ? str(v.publishedAt, `version[${index}].publishedAt`, 128, true) : "",
    };
  });
}

export function parsePackRelease(value: unknown): PackRelease {
  const v = obj(value, "release");
  const packId = assertPackId(v.packId);
  const packVersion = assertPackVersion(v.packVersion)!;
  const java = obj(v.javaRequirements, "javaRequirements");
  const server = obj(v.serverBootstrap, "serverBootstrap");

  if (!Array.isArray(v.files) || v.files.length > 50_000) {
    throw new Error("release.files must be an array with at most 50000 entries");
  }

  const pathKeys = new Set<string>();
  let totalBytes = 0;
  const files = v.files.map((item, index): PackFile => {
    const f = obj(item, `files[${index}]`);
    const filePath = normalizeManagedRelativePath(f.path);
    const key = filePath.toLowerCase();
    if (pathKeys.has(key)) throw new Error(`Duplicate managed path: ${filePath}`);
    pathKeys.add(key);

    const size = int(f.size, `files[${index}].size`, 0, 8 * 1024 * 1024 * 1024);
    totalBytes += size;
    if (totalBytes > 64 * 1024 * 1024 * 1024) {
      throw new Error("Release exceeds client safety limit of 64 GiB");
    }

    const updatePolicy = str(f.updatePolicy, `files[${index}].updatePolicy`, 32);
    if (!(["required_replace", "required_keep_if_same", "optional"] as const).includes(updatePolicy as PackFile["updatePolicy"])) {
      throw new Error(`Unsupported update policy: ${updatePolicy}`);
    }

    const required = bool(f.required, `files[${index}].required`);
    if (updatePolicy === "optional" && required) {
      throw new Error(`Optional file must have required=false: ${filePath}`);
    }
    if (updatePolicy !== "optional" && !required) {
      throw new Error(`Required file policy must have required=true: ${filePath}`);
    }

    return {
      path: filePath,
      size,
      sha256: assertSha256(f.sha256, false),
      sourceUrl: str(f.sourceUrl, `files[${index}].sourceUrl`, 4096),
      kind: str(f.kind, `files[${index}].kind`, 64),
      updatePolicy: updatePolicy as PackFile["updatePolicy"],
      required,
      preserveUserChanges: bool(f.preserveUserChanges, `files[${index}].preserveUserChanges`),
    };
  });

  const release: PackRelease = {
    packId,
    packName: str(v.packName, "packName", 256),
    packVersion,
    archived: typeof v.archived === "boolean" ? v.archived : false,
    releaseChannel: assertReleaseChannel(v.releaseChannel),
    minecraftVersion: assertPackVersion(v.minecraftVersion)!,
    loaderType: parseLoaderType(v.loaderType, "loaderType"),
    loaderVersion: assertPackVersion(v.loaderVersion)!,
    javaRequirements: {
      majorVersion: int(java.majorVersion, "javaRequirements.majorVersion", 8, 99),
      vendor: typeof java.vendor === "string" ? str(java.vendor, "javaRequirements.vendor", 64, true) : undefined,
      arch: str(java.arch, "javaRequirements.arch", 32),
      os: str(java.os, "javaRequirements.os", 32),
      runtimePackageId: str(java.runtimePackageId, "javaRequirements.runtimePackageId", 128),
      sha256: typeof java.sha256 === "string" ? assertSha256(java.sha256, false) : "",
    },
    serverBootstrap: {
      serverName: str(server.serverName, "serverBootstrap.serverName", 256),
      serverAddress: assertServerAddress(server.serverAddress),
      serverPort: assertServerPort(server.serverPort),
      autoConnect: bool(server.autoConnect, "serverBootstrap.autoConnect"),
      allowUserOverride: bool(server.allowUserOverride, "serverBootstrap.allowUserOverride"),
      motd: typeof server.motd === "string" ? str(server.motd, "serverBootstrap.motd", 512, true) : "",
    },
    files,
    changelog: strings(v.changelog, "changelog", 1000, 4096),
    publishedAt: typeof v.publishedAt === "string" ? str(v.publishedAt, "publishedAt", 128, true) : "",
    manifestHash: typeof v.manifestHash === "string" ? str(v.manifestHash, "manifestHash", 256, true) : "",
    signature: typeof v.signature === "string" ? str(v.signature, "signature", 1024, true) : "",
    stateMachine: Array.isArray(v.stateMachine) ? strings(v.stateMachine, "stateMachine", 128, 128) : [],
    diagnostics: Array.isArray(v.diagnostics) ? strings(v.diagnostics, "diagnostics", 256, 4096) : [],
  };

  if (release.javaRequirements.os.toLowerCase() !== "windows" || release.javaRequirements.arch.toLowerCase() !== "x64") {
    throw new Error(`Unsupported runtime target: ${release.javaRequirements.os}/${release.javaRequirements.arch}`);
  }
  const expectedRuntimePackageId = `temurin-${release.javaRequirements.majorVersion}-win-x64`;
  if (release.javaRequirements.runtimePackageId !== expectedRuntimePackageId) {
    throw new Error(`Unsupported Java runtime package: ${release.javaRequirements.runtimePackageId}`);
  }
  const requiredStates = [
    "not_installed", "installing", "update_available", "updating", "repair_required",
    "ready_to_launch", "launching", "running", "launch_failed",
  ];
  const stateSet = new Set(release.stateMachine);
  const missingStates = requiredStates.filter((state) => !stateSet.has(state));
  if (missingStates.length) {
    throw new Error(`Backend release contract is missing launcher states: ${missingStates.join(", ")}`);
  }
  return release;
}

export function parseLauncherUpdate(value: unknown): LauncherUpdateManifest {
  const v = obj(value, "launcher update");
  return {
    version: assertPackVersion(v.version)!,
    notes: typeof v.notes === "string" ? str(v.notes, "notes", 64 * 1024, true) : "",
    fileName: str(v.fileName, "fileName", 256, true),
    installerUrl: str(v.installerUrl, "installerUrl", 4096),
    sha256: assertSha256(v.sha256, true),
    silentArgs: Array.isArray(v.silentArgs) ? v.silentArgs.map((x, i) => str(x, `silentArgs[${i}]`, 256, true)) : [],
    mandatory: bool(v.mandatory, "mandatory"),
    publishedAt: typeof v.publishedAt === "string" ? str(v.publishedAt, "publishedAt", 128, true) : "",
    platform: typeof v.platform === "string" ? str(v.platform, "platform", 32, true) : undefined,
  };
}
