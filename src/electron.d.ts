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
        };
        packs: Array<{
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
        }>;
        notices: Array<{
          id: string;
          title: string;
          body: string;
          tone: "info" | "warning" | "success";
        }>;
      }>;
      getSettings: () => Promise<{
        nickname: string;
        memoryMb: number;
        resolution: string;
        fullscreen: boolean;
        showArchivedBuilds: boolean;
      }>;
      updateSettings: (payload: {
        nickname?: string;
        memoryMb?: number;
        resolution?: string;
        fullscreen?: boolean;
        showArchivedBuilds?: boolean;
      }) => Promise<{
        nickname: string;
        memoryMb: number;
        resolution: string;
        fullscreen: boolean;
        showArchivedBuilds: boolean;
      }>;
      getLauncherUpdateStatus: () => Promise<{
        currentVersion: string;
        serverVersion: string;
        outdated: boolean;
        available: boolean;
        remote: null | {
          version: string;
          notes: string;
          fileName: string;
          installerUrl: string;
          sha256: string;
          silentArgs: string[];
          mandatory: boolean;
          publishedAt: string;
        };
      }>;
      installLauncherUpdate: () => Promise<{
        currentVersion: string;
        targetVersion: string;
        installerPath: string;
      }>;
      syncPack: (payload: {
        packId: string;
        packVersion?: string;
        repair?: boolean;
      }) => Promise<{
        release: unknown;
        javaPath: string;
        instanceDir: string;
        versionId: string;
        downloadedFiles: number;
        runtimeDownloaded: boolean;
      }>;
      launchPack: (payload: {
        packId: string;
        packVersion?: string;
        nickname: string;
        memoryMb: number;
        resolution: string;
        fullscreen: boolean;
      }) => Promise<{
        release: unknown;
        javaPath: string;
        instanceDir: string;
        versionId: string;
        downloadedFiles: number;
        runtimeDownloaded: boolean;
        pid: number;
        logFile: string;
        commandPreview: string;
      }>;
      getLauncherDiagnostics: (payload: { packId: string; packVersion?: string }) => Promise<{
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
      deleteLocalPack: (payload: { packId: string }) => Promise<{
        packId: string;
        instanceDir: string;
        deleted: boolean;
      }>;
      verifyPackFiles: (payload: { packId: string; packVersion?: string }) => Promise<{
        status: 'ok' | 'not_installed' | 'update_available' | 'repair_required';
        missingFiles: number;
        corruptedFiles: number;
        newFiles: number;
        totalFiles: number;
        serverVersion: string;
        localVersion?: string;
        corruptedPaths?: string[];
      }>;
      getLauncherLogs: () => Promise<Array<{
        id: string;
        timestamp: string;
        level: "info" | "warn" | "error";
        scope: string;
        message: string;
      }>>;
      onLauncherLog: (callback: (entry: {
        id: string;
        timestamp: string;
        level: "info" | "warn" | "error";
        scope: string;
        message: string;
      }) => void) => () => void;
      openPath: (payload: { path: string }) => Promise<string>;
      openOrRevealPath: (payload: { path: string }) => Promise<string>;
      getSystemMemory: () => Promise<{
        totalMemoryMb: number;
        recommendedMaxMemoryMb: number;
      }>;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<boolean>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
    };
  }
}

export {};
