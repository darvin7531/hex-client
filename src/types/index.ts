export interface LauncherVersion {
  currentVersion: string;
  minimumSupportedBackend: string;
  maintenanceMode: boolean;
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
  releaseChannel: 'stable' | 'beta';
  latestVersion: string;
  minecraftVersion: string;
  loaderType: 'Fabric' | 'Forge' | 'NeoForge';
  loaderVersion: string;
  javaVersion: number;
  heroTitle: string;
  heroSubtitle: string;
}

export interface FileArtifact {
  path: string;
  size: number;
  sha256: string;
  sourceUrl: string;
  kind: 'mod' | 'config' | 'resourcepack' | 'shaderpack' | 'loader' | 'other';
  updatePolicy: 'required_replace' | 'required_keep_if_same' | 'optional';
  required: boolean;
  preserveUserChanges: boolean;
  executable: boolean;
}

export interface ReleaseManifest {
  packId: string;
  packName: string;
  packVersion: string;
  archived: boolean;
  releaseChannel: string;
  minecraftVersion: string;
  loaderType: string;
  loaderVersion: string;
  javaRequirements: {
    majorVersion: number;
    vendor: string;
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
  files: FileArtifact[];
  changelog: string[];
  manifestHash: string;
  stateMachine: string[];
  diagnostics: string[];
}

export type PackState = 'not_installed' | 'installing' | 'updating' | 'update_available' | 'repair_required' | 'ready_to_launch' | 'launching' | 'running' | 'launch_failed';

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

export interface ElectronAPI {
  getSystemInfo: () => Promise<{ totalMemory: number; platform: string }>;
  selectDirectory: () => Promise<string | null>;
  checkLocalPackState: (packId: string, version: string) => Promise<PackState>;
  verifyAndInstallPack: (manifest: ReleaseManifest, userOptions: { ramAllocation: number }) => void;
  repairPack: (manifest: ReleaseManifest) => void;
  launchGame: (manifest: ReleaseManifest, userOptions: { ramAllocation: number, customJavaPath?: string, jvmArgs?: string }) => void;
  onSyncProgress: (callback: (event: any, progress: SyncProgress) => void) => () => void;
  onGameStateChanged: (callback: (event: any, state: GameState) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export interface LauncherSettings {
  ramAllocation: number;
  customJavaPath: string;
  jvmArgs: string;
  optionalMods: Record<string, boolean>;
  customApiUrl?: string;
}
