import type { GameLogEntry, GameProcessState, LauncherLogEntry, LauncherSettings, LauncherUpdateStatus, Notice, PackSummary, PackVersionSummary, ReleaseManifest, SyncProgress, VerifyResult } from './types';

declare global {
  interface Window {
    hexloaderDesktop?: {
      platform: string;
      isElectron: boolean;
      getBootstrap: () => Promise<{
        launcherVersion: {
          currentVersion: string;
          minimumSupportedBackend: string;
          maintenanceMode: boolean;
          backendApiVersion: string;
          capabilities: string[];
        };
        packs: PackSummary[];
        notices: Notice[];
        offline?: boolean;
      }>;
      getManifest: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) => Promise<ReleaseManifest>;
      getVersions: (payload: { packId: string; includeArchived?: boolean }) => Promise<PackVersionSummary[]>;
      getSettings: () => Promise<LauncherSettings>;
      updateSettings: (payload: Partial<Omit<LauncherSettings, 'canOverrideApi'>>) => Promise<LauncherSettings>;
      getLauncherUpdateStatus: () => Promise<LauncherUpdateStatus>;
      installLauncherUpdate: () => Promise<{
        currentVersion: string;
        targetVersion: string;
        installerPath: string;
      }>;
      syncPack: (payload: {
        packId: string;
        packVersion?: string;
        releaseChannel?: 'stable' | 'beta' | 'test';
        repair?: boolean;
        optionalFiles?: string[];
      }) => Promise<{
        release: ReleaseManifest;
        javaPath: string;
        instanceDir: string;
        versionId: string;
        downloadedFiles: number;
        runtimeDownloaded: boolean;
      }>;
      launchPack: (payload: {
        packId: string;
        packVersion?: string;
        releaseChannel?: 'stable' | 'beta' | 'test';
        nickname: string;
        memoryMb: number;
        resolution: string;
        fullscreen: boolean;
        optionalFiles?: string[];
      }) => Promise<{
        release: ReleaseManifest;
        javaPath: string;
        instanceDir: string;
        versionId: string;
        downloadedFiles: number;
        runtimeDownloaded: boolean;
        pid: number;
        logFile: string;
        commandPreview: string;
      }>;
      getLauncherDiagnostics: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) => Promise<{
        packId: string;
        instanceDir: string;
        instanceInstalled: boolean;
        installedManifestVersion?: string;
        processRunning: boolean;
        roots: {
          launcherRoot: string;
          instancesRoot: string;
          sharedMinecraftRoot: string;
          runtimesRoot: string;
        };
      }>;
      deleteLocalPack: (payload: { packId: string }) => Promise<{ packId: string; instanceDir: string; deleted: boolean }>;
      verifyPackFiles: (payload: { packId: string; packVersion?: string; releaseChannel?: "stable" | "beta" | "test" }) => Promise<VerifyResult>;
      getLauncherLogs: () => Promise<LauncherLogEntry[]>;
      onLauncherLog: (callback: (entry: LauncherLogEntry) => void) => () => void;
      getGameLogs: () => Promise<GameLogEntry[]>;
      getGameState: () => Promise<GameProcessState>;
      onGameLog: (callback: (entry: GameLogEntry) => void) => () => void;
      onGameState: (callback: (state: GameProcessState) => void) => () => void;
      onSyncProgress: (callback: (progress: SyncProgress) => void) => () => void;
      getSystemMemory: () => Promise<{ totalMemoryMb: number; recommendedMaxMemoryMb: number }>;
      minimizeWindow: () => void;
      toggleMaximizeWindow: () => Promise<boolean>;
      closeWindow: () => void;
      isWindowMaximized: () => Promise<boolean>;
    };
  }
}

export {};
