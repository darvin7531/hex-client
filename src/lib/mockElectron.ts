import { ElectronAPI, PackState, ReleaseManifest, SyncProgress, GameState } from '../types';

// Mock system memory (e.g. 16GB)
const TOTAL_MEMORY = 16384; 

let syncProgressListeners: Array<(event: any, progress: SyncProgress) => void> = [];
let gameStateListeners: Array<(event: any, state: GameState) => void> = [];

function emitProgress(progress: SyncProgress) {
  syncProgressListeners.forEach(cb => cb({}, progress));
}

function emitGameState(state: GameState) {
  gameStateListeners.forEach(cb => cb({}, state));
}

function startFakeDownload(manifest: ReleaseManifest) {
  emitGameState({ status: 'installing' });
  let downloadedFiles = 0;
  const totalFiles = manifest.files.length > 0 ? manifest.files.length : 115;
  const totalBytes = totalFiles * 1024 * 1024 * 5; // Fake 5MB per file average
  let bytesProgress = 0;

  const interval = setInterval(() => {
    downloadedFiles += Math.floor(Math.random() * 5) + 1;
    if (downloadedFiles >= totalFiles) {
        downloadedFiles = totalFiles;
    }
    bytesProgress = (downloadedFiles / totalFiles) * totalBytes;
    
    emitProgress({
        status: 'Downloading files...',
        currentFile: `mod_payload_${downloadedFiles}.jar`,
        downloadedFiles,
        totalFiles,
        bytesProgress,
        totalBytes,
        speedMbSec: parseFloat((Math.random() * 10 + 15).toFixed(1))
    });

    if (downloadedFiles >= totalFiles) {
        clearInterval(interval);
        setTimeout(() => {
          localStorage.setItem(`pack_state_${manifest.packId}`, 'ready_to_launch');
          emitGameState({ status: 'ready_to_launch' });
        }, 500);
    }
  }, 200);
}

// Define the mock electron adapter
export const mockElectron: ElectronAPI = {
  getSystemInfo: async () => ({ totalMemory: TOTAL_MEMORY, platform: 'win32' }),
  selectDirectory: async () => {
    return new Promise((resolve) => setTimeout(() => resolve('C:\\Program Files\\Java\\jdk-17'), 500));
  },
  checkLocalPackState: async (packId, version) => {
    const stored = localStorage.getItem(`pack_state_${packId}`);
    return (stored as PackState) || 'not_installed';
  },
  verifyAndInstallPack: (manifest, userOptions) => {
    startFakeDownload(manifest);
  },
  repairPack: (manifest) => {
    startFakeDownload(manifest);
  },
  launchGame: (manifest, userOptions) => {
    emitGameState({ status: 'launching' });
    
    setTimeout(() => {
      if (Math.random() < 0.1) {
        emitGameState({ 
          status: 'launch_failed', 
          errorCode: 'ERR_JAVA_NOT_FOUND',
          diagnostics: ['Java OpenJDK 17 не найден', 'Проверьте путь в настройках лаунчера']
        });
      } else {
        emitGameState({ status: 'running' });
        setTimeout(() => {
           emitGameState({ status: 'ready_to_launch' });
        }, 8000);
      }
    }, 2000);
  },
  onSyncProgress: (cb) => {
    syncProgressListeners.push(cb);
    return () => {
      syncProgressListeners = syncProgressListeners.filter(l => l !== cb);
    };
  },
  onGameStateChanged: (cb) => {
    gameStateListeners.push(cb);
    return () => {
      gameStateListeners = gameStateListeners.filter(l => l !== cb);
    };
  }
};

// Define the real Electron IPC desktop bridge
export const realElectronBridge: ElectronAPI = {
  getSystemInfo: async () => {
    const mem = await window.hexloaderDesktop!.getSystemMemory();
    return { totalMemory: mem.totalMemoryMb, platform: window.hexloaderDesktop!.platform };
  },
  selectDirectory: async () => {
    // Falls back to mock path or user typing
    return 'C:\\Program Files\\Java\\jdk-17';
  },
  checkLocalPackState: async (packId, version) => {
    // First check if process is running (quick check)
    const diag = await window.hexloaderDesktop!.getLauncherDiagnostics({ packId, packVersion: version });
    if (diag.processRunning) return 'running';
    if (!diag.instanceInstalled) return 'not_installed';

    // Full file verification against backend manifest
    try {
      const result = await window.hexloaderDesktop!.verifyPackFiles({ packId, packVersion: version });
      if (result.status === 'not_installed') return 'not_installed';
      if (result.status === 'update_available') return 'update_available';
      if (result.status === 'repair_required') return 'repair_required';
      return 'ready_to_launch';
    } catch {
      // If verify fails (e.g. no network), fall back to basic check
      return 'ready_to_launch';
    }
  },
  verifyAndInstallPack: async (manifest, userOptions) => {
    emitGameState({ status: 'installing' });
    
    let progressPercent = 0;
    const interval = setInterval(() => {
      progressPercent += 5;
      if (progressPercent > 95) progressPercent = 95;
      emitProgress({
        status: 'Загрузка файлов сборки...',
        currentFile: 'Сканирование...',
        downloadedFiles: Math.floor(manifest.files.length * (progressPercent / 100)),
        totalFiles: manifest.files.length,
        bytesProgress: Math.floor(manifest.files.reduce((a, b) => a + b.size, 0) * (progressPercent / 100)),
        totalBytes: manifest.files.reduce((a, b) => a + b.size, 0),
        speedMbSec: 25.4
      });
    }, 200);

    try {
      await window.hexloaderDesktop!.syncPack({ packId: manifest.packId, repair: false });
      clearInterval(interval);
      emitGameState({ status: 'ready_to_launch' });
    } catch (err) {
      clearInterval(interval);
      emitGameState({ status: 'launch_failed', errorCode: 'SYNC_ERROR', diagnostics: ['Не удалось синхронизировать файлы сборки.'] });
    }
  },
  repairPack: async (manifest) => {
    emitGameState({ status: 'repair_required' });
    
    let progressPercent = 0;
    const interval = setInterval(() => {
      progressPercent += 8;
      if (progressPercent > 95) progressPercent = 95;
      emitProgress({
        status: 'Проверка и восстановление файлов...',
        currentFile: 'Проверка контрольных сумм...',
        downloadedFiles: Math.floor(manifest.files.length * (progressPercent / 100)),
        totalFiles: manifest.files.length,
        bytesProgress: Math.floor(manifest.files.reduce((a, b) => a + b.size, 0) * (progressPercent / 100)),
        totalBytes: manifest.files.reduce((a, b) => a + b.size, 0),
        speedMbSec: 45.1
      });
    }, 150);

    try {
      await window.hexloaderDesktop!.syncPack({ packId: manifest.packId, repair: true });
      clearInterval(interval);
      emitGameState({ status: 'ready_to_launch' });
    } catch (err) {
      clearInterval(interval);
      emitGameState({ status: 'launch_failed', errorCode: 'REPAIR_ERROR', diagnostics: ['Не удалось восстановить файлы сборки.'] });
    }
  },
  launchGame: async (manifest, userOptions) => {
    emitGameState({ status: 'launching' });
    try {
      const desktopSettings = await window.hexloaderDesktop!.getSettings();

      await window.hexloaderDesktop!.launchPack({
        packId: manifest.packId,
        packVersion: manifest.packVersion,
        nickname: desktopSettings.nickname || "HexPilot",
        memoryMb: userOptions.ramAllocation,
        resolution: desktopSettings.resolution,
        fullscreen: desktopSettings.fullscreen
      });
      emitGameState({ status: 'running' });

      // Poll diagnostics to detect when game stops
      const interval = setInterval(async () => {
        const diag = await window.hexloaderDesktop!.getLauncherDiagnostics({ packId: manifest.packId, packVersion: manifest.packVersion });
        if (!diag.processRunning) {
          clearInterval(interval);
          emitGameState({ status: 'ready_to_launch' });
        }
      }, 2000);
    } catch (err: any) {
      emitGameState({ 
        status: 'launch_failed', 
        errorCode: 'LAUNCH_ERROR', 
        diagnostics: [err.message || 'Ошибка запуска Minecraft. Проверьте логи консоли.'] 
      });
    }
  },
  onSyncProgress: (cb) => {
    syncProgressListeners.push(cb);
    return () => {
      syncProgressListeners = syncProgressListeners.filter(l => l !== cb);
    };
  },
  onGameStateChanged: (cb) => {
    gameStateListeners.push(cb);
    return () => {
      gameStateListeners = gameStateListeners.filter(l => l !== cb);
    };
  }
};

export const initMockElectron = () => {
  if (typeof window !== 'undefined' && !window.electronAPI) {
    if (window.hexloaderDesktop && window.hexloaderDesktop.isElectron) {
      window.electronAPI = realElectronBridge;
    } else {
      window.electronAPI = mockElectron;
    }
  }
};
