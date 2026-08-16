export interface LauncherVersion {
  currentVersion: string;
  minimumSupportedBackend: string;
  maintenanceMode: boolean;
  backendApiVersion: string;
  capabilities: string[];
}

export interface LauncherUpdate {
  version: string;
  notes: string;
  fileName: string;
  installerUrl: string;
  sha256: string;
  silentArgs: string[];
  mandatory: boolean;
  publishedAt: string;
}

export interface LauncherUpdateStatus {
  currentVersion: string;
  serverVersion: string;
  outdated: boolean;
  available: boolean;
  remote: LauncherUpdate | null;
}

export interface Notice {
  id: string;
  title: string;
  body: string;
  tone: 'success' | 'info' | 'warning';
}

export interface PackSummary {
  packId: string;
  packName: string;
  description: string;
  releaseChannel: 'stable' | 'beta' | 'test';
  latestVersion: string;
  minecraftVersion: string;
  loaderType: 'Fabric' | 'Forge' | 'NeoForge';
  loaderVersion: string;
  javaVersion: number;
  heroTitle: string;
  heroSubtitle: string;
}

export interface PackVersionSummary {
  packId: string;
  packVersion: string;
  releaseChannel: 'stable' | 'beta' | 'test';
  archived: boolean;
  publishedAt: string;
}

export interface FileArtifact {
  path: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  kind: 'mod' | 'config' | 'resourcepack' | 'shaderpack' | 'loader' | 'data' | 'other' | string;
  updatePolicy: 'required_replace' | 'required_keep_if_same' | 'optional';
  required: boolean;
  preserveUserChanges: boolean;
}

export interface ReleaseManifest {
  packId: string;
  packName: string;
  packVersion: string;
  archived: boolean;
  releaseChannel: 'stable' | 'beta' | 'test';
  minecraftVersion: string;
  loaderType: 'Fabric' | 'Forge' | 'NeoForge';
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
  files: FileArtifact[];
  changelog: string[];
  publishedAt: string;
  manifestHash: string;
  signature: string;
  stateMachine: string[];
  diagnostics: string[];
}

export type PackState =
  | 'not_installed'
  | 'installing'
  | 'updating'
  | 'update_available'
  | 'repair_required'
  | 'ready_to_launch'
  | 'launching'
  | 'running'
  | 'launch_failed'
  | 'backend_unavailable';

export interface SyncProgress {
  status: string;
  currentFile: string;
  downloadedFiles: number;
  totalFiles: number;
  bytesProgress: number;
  totalBytes: number;
  speedMbSec: number;
}

export interface GameState {
  status: PackState;
  errorCode?: string;
  diagnostics?: string[];
}


export interface LauncherLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface GameLogEntry { id: string; timestamp: string; stream: 'stdout' | 'stderr'; message: string; }
export type GameProcessState = { status: 'idle' } | { status: 'launching'; packId: string } | { status: 'running'; packId: string; pid: number } | { status: 'exited'; packId: string; exitCode: number | null; signal?: string } | { status: 'error'; packId: string; message: string };

export interface LauncherSettings {
  nickname: string;
  nicknameHistory: string[];
  memoryMb: number;
  resolution: string;
  fullscreen: boolean;
  customApiUrl: string;
  optionalFilesByPack: Record<string, string[]>;
  selectedVersionsByPack: Record<string, string>;
  serverOverridesByPack: Record<string, { address: string; port: number }>;
  canOverrideApi: boolean;
}

export interface VerifyResult {
  status: 'ok' | 'not_installed' | 'update_available' | 'repair_required' | 'backend_unavailable';
  missingFiles: number;
  corruptedFiles: number;
  newFiles: number;
  totalFiles: number;
  serverVersion: string;
  localVersion?: string;
  corruptedPaths?: string[];
}
