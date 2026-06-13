import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Download, HardDrive, RefreshCw, Wrench, ChevronLeft, LayoutList, Puzzle, CheckCircle2, AlertTriangle, AlertCircle, User } from 'lucide-react';
import { PackSummary, ReleaseManifest, PackState, SyncProgress, GameState } from '../types';
import { fetchManifest } from '../lib/mockApi';
import { formatBytes, cn } from '../lib/utils';
import { ActionButton } from './ActionButton';

function generateRandomNickname(): string {
  const adjs = ["Hex", "Cyber", "Pixel", "Neon", "Void", "Quantum", "Retro", "Shadow", "Alpha", "Omega", "Glitch", "Cosmic", "Rogue", "Ghost", "Aero", "Delta"];
  const nouns = ["Pilot", "Runner", "Hunter", "Knight", "Ranger", "Slayer", "Reaper", "Phantom", "Nexus", "Titan", "Wraith", "Vortex", "Sentry", "Seeker", "Warden", "Forge"];
  const adj = adjs[Math.floor(Math.random() * adjs.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${adj}${noun}_${num}`;
}

export function PackView({ pack, onClose }: { pack: PackSummary, onClose: () => void }) {
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
  const [activeTab, setActiveTab] = useState<'changelog' | 'mods'>('changelog');
  const [gameState, setGameState] = useState<GameState>({ status: 'not_installed' });
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [nickname, setNickname] = useState<string>('HexPilot');
  
  // Local state for optional mods selected by user
  const [optionalMods, setOptionalMods] = useState<Record<string, boolean>>({});

  const handleNicknameChange = async (newNickname: string) => {
    setNickname(newNickname);
    
    // Save to localStorage
    const stored = localStorage.getItem('launcher_settings');
    const settings = stored ? JSON.parse(stored) : {};
    settings.nickname = newNickname;
    localStorage.setItem('launcher_settings', JSON.stringify(settings));

    // Save to Electron desktop settings
    if (window.hexloaderDesktop) {
      try {
        await window.hexloaderDesktop.updateSettings({
          nickname: newNickname
        });
      } catch (err) {
        console.error("Failed to update nickname in Electron settings:", err);
      }
    }
  };

  useEffect(() => {
    fetchManifest(pack.packId).then(m => {
       setManifest(m);
       
       // Initialize optional mods from storage or defaults
       const stored = localStorage.getItem('launcher_settings');
       const settings = stored ? JSON.parse(stored) : { optionalMods: {} };
       
       const initialMods: Record<string, boolean> = { ...settings.optionalMods };
       // Set default true for optional mods not explicitly disabled
       m.files.filter(f => f.updatePolicy === 'optional').forEach(f => {
         if (initialMods[f.path] === undefined) {
           initialMods[f.path] = false; // By default optional mods are off
         }
       });
       setOptionalMods(initialMods);

       let activeNickname = settings.nickname;
       if (!activeNickname || activeNickname === 'HexPilot') {
         activeNickname = generateRandomNickname();
         settings.nickname = activeNickname;
         localStorage.setItem('launcher_settings', JSON.stringify(settings));
         if (window.hexloaderDesktop) {
           window.hexloaderDesktop.updateSettings({ nickname: activeNickname });
         }
       }
       setNickname(activeNickname);
    });

    if (window.hexloaderDesktop) {
      window.hexloaderDesktop.getSettings().then(desktopSettings => {
        if (desktopSettings.nickname && desktopSettings.nickname !== 'HexPilot') {
          setNickname(desktopSettings.nickname);
        } else {
          const stored = localStorage.getItem('launcher_settings');
          const settings = stored ? JSON.parse(stored) : {};
          const activeNickname = settings.nickname || generateRandomNickname();
          setNickname(activeNickname);
          window.hexloaderDesktop!.updateSettings({ nickname: activeNickname });
        }
      });
    }

    // Determine initial state
    window.electronAPI.checkLocalPackState(pack.packId, pack.latestVersion).then(state => {
      setGameState({ status: state });
    });

    // Subscribe to IPC
    const unsubProgress = window.electronAPI.onSyncProgress((e, data) => {
      setSyncProgress(data);
    });

    const unsubGameState = window.electronAPI.onGameStateChanged((e, state) => {
      setGameState(state);
      if (state.status !== 'installing' && state.status !== 'updating' && state.status !== 'repair_required') {
        setSyncProgress(null);
      }
    });

    // Periodic background verification every 30s
    const verifyInterval = setInterval(async () => {
      // Only re-check in stable states, don't interfere with active operations
      const currentStatus = gameState.status;
      if (currentStatus === 'installing' || currentStatus === 'updating' || 
          currentStatus === 'launching' || currentStatus === 'running') {
        return;
      }
      try {
        const freshState = await window.electronAPI.checkLocalPackState(pack.packId, pack.latestVersion);
        setGameState(prev => {
          // Don't override active states with verification results
          if (prev.status === 'installing' || prev.status === 'updating' || 
              prev.status === 'launching' || prev.status === 'running') {
            return prev;
          }
          return { status: freshState };
        });
      } catch {
        // Silently ignore verification errors (e.g. network issues)
      }
    }, 30_000);

    return () => {
      unsubProgress();
      unsubGameState();
      clearInterval(verifyInterval);
    };
  }, [pack]);

  const handleActionClick = async () => {
    if (!manifest) return;
    
    const stored = localStorage.getItem('launcher_settings');
    const userOptions = stored ? JSON.parse(stored) : { ramAllocation: 4096 };

    switch(gameState.status) {
      case 'not_installed':
      case 'update_available':
        window.electronAPI.verifyAndInstallPack(manifest, userOptions);
        break;
      case 'repair_required':
        window.electronAPI.repairPack(manifest);
        break;
      case 'ready_to_launch':
      case 'launch_failed': {
        // Re-verify files before launching to catch any changes since page load
        const freshState = await window.electronAPI.checkLocalPackState(pack.packId, pack.latestVersion);
        if (freshState === 'not_installed' || freshState === 'update_available' || freshState === 'repair_required') {
          // Files changed — sync first, then auto-launch after sync completes
          setGameState({ status: freshState });
          
          const onStateChange = (e: any, state: GameState) => {
            if (state.status === 'ready_to_launch') {
              // Sync finished → auto-launch
              window.electronAPI.launchGame(manifest, userOptions);
            }
          };
          
          // Subscribe to state change to auto-launch after sync
          const unsub = window.electronAPI.onGameStateChanged(onStateChange);
          
          if (freshState === 'repair_required') {
            window.electronAPI.repairPack(manifest);
          } else {
            window.electronAPI.verifyAndInstallPack(manifest, userOptions);
          }
          
          // Cleanup listener after 5 minutes (safety)
          setTimeout(() => unsub(), 5 * 60 * 1000);
        } else {
          // All files verified — launch directly
          window.electronAPI.launchGame(manifest, userOptions);
        }
        break;
      }
      default:
        // Do nothing for running/installing
        break;
    }
  };

  const toggleOptionalMod = (path: string) => {
    setOptionalMods(prev => {
      const next = { ...prev, [path]: !prev[path] };
      // Save globally
      const stored = localStorage.getItem('launcher_settings');
      const settings = stored ? JSON.parse(stored) : { };
      settings.optionalMods = next;
      localStorage.setItem('launcher_settings', JSON.stringify(settings));
      return next;
    });
  };

  if (!manifest) {
    return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="h-full flex flex-col relative z-20">
       
      {/* Hero Header Section */}
      <div className="relative h-64 bg-zinc-800 overflow-hidden flex-shrink-0">
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent z-10"></div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,#4f46e533_0%,transparent_50%)]"></div>
        
        <button onClick={onClose} className="absolute top-6 left-8 z-30 flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-xs font-bold uppercase tracking-widest">
          <ChevronLeft className="w-4 h-4" />
          Назад
        </button>

        <div className="absolute bottom-0 left-0 p-8 z-20">
          <h1 className="text-5xl font-black italic tracking-tighter text-white drop-shadow-2xl mb-1 uppercase">
            {pack.heroTitle}
          </h1>
          <p className="text-indigo-400 font-medium text-lg tracking-tight">
            {pack.heroSubtitle}
          </p>
        </div>
      </div>

      <div className="flex-1 bg-zinc-950 px-8 pt-6 pb-24 flex flex-col gap-6 overflow-y-auto no-scrollbar">
      {/* Tabs */}
      <div className="flex gap-8 border-b border-white/5 flex-shrink-0">
        <button 
          onClick={() => setActiveTab('changelog')}
          className={cn("pb-4 px-1 text-sm font-bold border-b-2 uppercase", activeTab === 'changelog' ? "border-indigo-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300")}
        >
          Чейнджлог
        </button>
        <button 
          onClick={() => setActiveTab('mods')}
          className={cn("pb-4 px-1 text-sm font-bold border-b-2 uppercase", activeTab === 'mods' ? "border-indigo-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300")}
        >
          Опциональные
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-visible">
          
          <AnimatePresence mode="popLayout">
            {activeTab === 'changelog' && (
              <motion.div 
                key="changelog" 
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="max-w-3xl"
              >
                  <div className="bg-black/30 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                     <h3 className="text-lg font-medium text-white mb-4">Список изменений (v{manifest.packVersion})</h3>
                     <ul className="space-y-3">
                       {manifest.changelog.map((log, i) => (
                         <li key={i} className="flex gap-3 text-zinc-300">
                           <span className="text-emerald-500 mt-1">•</span>
                           <span className="leading-relaxed text-sm">{log}</span>
                         </li>
                       ))}
                     </ul>
                  </div>
                  
                  {gameState.status === 'launch_failed' && gameState.diagnostics && (
                     <div className="mt-6 bg-amber-950/30 border border-amber-500/30 rounded-2xl p-6 backdrop-blur-md mb-6">
                        <div className="flex items-center gap-2 text-amber-500 font-medium mb-4">
                           <AlertTriangle className="w-5 h-5"/>
                           Сбой запуска
                        </div>
                        <ul className="space-y-2">
                           {gameState.diagnostics.map((diag, i) => (
                             <li key={i} className="text-amber-200/80 text-sm flex gap-2"><AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0"/> {diag}</li>
                           ))}
                        </ul>
                     </div>
                  )}
              </motion.div>
            )}

            {activeTab === 'mods' && (
               <motion.div 
                 key="mods" 
                 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                 className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl"
               >
                 {manifest.files.filter(f => f.updatePolicy === 'optional').map(file => (
                   <label key={file.path} className="flex items-start gap-4 p-4 rounded-xl border border-white/5 bg-black/40 hover:bg-white/5 transition-colors cursor-pointer group">
                      <div className="relative flex items-center justify-center w-6 h-6 mt-0.5">
                         <input 
                           type="checkbox" 
                           className="peer appearance-none w-5 h-5 border border-white/20 rounded bg-white/5 checked:bg-indigo-500 checked:border-indigo-500 transition-colors"
                           checked={!!optionalMods[file.path]}
                           onChange={() => toggleOptionalMod(file.path)}
                         />
                         <CheckCircle2 className="w-3.5 h-3.5 text-white absolute inset-0 m-auto opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" />
                      </div>
                      <div className="flex-1">
                         <span className="block text-sm font-medium text-white group-hover:text-indigo-300 transition-colors">{file.path.split('/').pop()}</span>
                         <span className="block text-xs text-zinc-500 mt-1 uppercase tracking-wider">{file.kind} • {formatBytes(file.size)}</span>
                      </div>
                   </label>
                 ))}
                 
                 {manifest.files.filter(f => f.updatePolicy === 'optional').length === 0 && (
                   <div className="col-span-full py-10 text-center text-zinc-500">
                     Дополнительных файлов для этой версии не предусмотрено.
                   </div>
                 )}
               </motion.div>
            )}
          </AnimatePresence>

      </div>
      </div>

      {/* Bottom Action Bar */}
      <footer className="h-24 bg-zinc-950 border-t border-white/10 px-8 flex items-center justify-between backdrop-blur-xl absolute bottom-0 inset-x-0 z-30">
        <div className="flex items-center gap-8">
          <div className="space-y-0.5">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Version</div>
            <div className="text-sm font-semibold text-zinc-200">{pack.latestVersion} / {pack.minecraftVersion}</div>
          </div>
          <div className="h-8 w-px bg-white/5"></div>
          <div className="space-y-0.5">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Release Channel</div>
            <div className="text-sm font-semibold text-zinc-200 uppercase">{pack.releaseChannel} / {pack.loaderType}</div>
          </div>
          <div className="h-8 w-px bg-white/5"></div>
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-indigo-400" />
              Игровой никнейм
            </div>
            <input
              type="text"
              value={nickname}
              onChange={(e) => handleNicknameChange(e.target.value)}
              className="bg-black/50 border border-white/10 rounded-lg px-3 py-1 text-sm font-semibold text-zinc-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all w-40 font-mono shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
              placeholder="Nickname"
            />
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right flex flex-col items-end">
            <div className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest">
                {gameState.status === 'ready_to_launch' ? 'Status: Ready' : (gameState.status === 'not_installed' ? 'No updates pending' : 'Status: ' + gameState.status)}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono">Total size: {formatBytes(manifest.files.reduce((a, b: any) => a + b.size, 0))}</div>
          </div>
          <div className="w-64">
            <ActionButton 
              state={gameState} 
              progress={syncProgress} 
              onClick={handleActionClick} 
            />
          </div>
        </div>
      </footer>

    </div>
  );
}
