import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, MonitorPlay, X, AlertTriangle, RefreshCw, Download, Loader2, TerminalSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { LauncherUpdateStatus, PackSummary, Notice } from '../types';
import { fetchNotices, fetchPacks } from '../lib/clientApi';
import { SettingsModal } from './SettingsModal';
import { PackView } from './PackView';
import { LogsModal } from './LogsModal';
import { cn } from '../lib/utils';

export function Dashboard({ updateStatus }: { updateStatus: LauncherUpdateStatus | null }) {
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selectedPack, setSelectedPack] = useState<PackSummary | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoadError('');
    Promise.all([fetchPacks(), fetchNotices()])
      .then(([loadedPacks, loadedNotices]) => {
        if (!alive) return;
        setPacks(loadedPacks);
        setNotices(loadedNotices);
      })
      .catch((reason) => {
        if (alive) setLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { alive = false; };
  }, [reloadToken]);

  return (
    <div className="flex flex-col h-screen w-full bg-zinc-950 text-zinc-100 overflow-hidden font-sans border border-white/10">
      {/* Top System Bar */}
      <header 
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="h-10 flex items-center justify-between px-4 bg-zinc-950/80 border-b border-white/5 backdrop-blur-sm select-none z-20"
      >
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 bg-gradient-to-br from-emerald-500 to-indigo-600 rounded-sm rotate-45 flex-shrink-0"></div>
          <span className="text-[10px] font-bold tracking-widest uppercase opacity-70">HexLoader // Client</span>
        </div>
        <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="flex items-center gap-2 px-2 py-0.5 rounded border border-white/5 bg-white/5">
            <span className="text-[9px] uppercase tracking-tighter opacity-50">System Status</span>
            <div className={cn("w-1.5 h-1.5 rounded-full", loadError ? "bg-amber-500" : "bg-emerald-500 animate-pulse")} />
          </div>
          
          {/* Custom Window Control Buttons for Electron */}
          {window.hexloaderDesktop && (
            <div className="flex items-center border-l border-white/10 pl-3 h-5 gap-1.5">
              <button 
                onClick={() => window.hexloaderDesktop?.minimizeWindow()}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors text-zinc-400 hover:text-white cursor-pointer"
                title="Свернуть"
              >
                <div className="w-2.5 h-[1px] bg-current" />
              </button>
              <button 
                onClick={() => window.hexloaderDesktop?.toggleMaximizeWindow()}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-colors text-zinc-400 hover:text-white cursor-pointer"
                title="Развернуть"
              >
                <div className="w-2 h-2 border border-current rounded-sm" />
              </button>
              <button 
                onClick={() => window.hexloaderDesktop?.closeWindow()}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 transition-colors text-zinc-400 cursor-pointer"
                title="Закрыть"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

      {updateStatus?.available && updateStatus.remote && !updateStatus.remote.mandatory && (
        <div className="px-4 py-2 bg-indigo-500/10 border-b border-indigo-500/20 flex items-center justify-between gap-4 text-xs">
          <div className="min-w-0">
            <span className="text-indigo-300 font-semibold">Доступен HexLoader {updateStatus.remote.version}</span>
            {updateError && <span className="ml-3 text-red-300">{updateError}</span>}
          </div>
          <button
            disabled={installingUpdate}
            onClick={() => {
              if (!window.hexloaderDesktop) return;
              setInstallingUpdate(true);
              setUpdateError('');
              void window.hexloaderDesktop.installLauncherUpdate().catch((reason) => {
                setInstallingUpdate(false);
                setUpdateError(reason instanceof Error ? reason.message : String(reason));
              });
            }}
            className="flex-shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded bg-indigo-500 text-white hover:bg-indigo-400 disabled:opacity-60"
          >
            {installingUpdate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Обновить
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden relative z-0">
        {/* Sidebar */}
        <div className="w-72 flex-shrink-0 bg-zinc-900/50 border-r border-white/5 flex flex-col justify-between relative z-10">
          
          {/* Header */}
          <div className="p-4">
            <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest mb-4">Ваши сборки</h2>
          </div>

          {/* Packs List */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2 no-scrollbar">
            {packs.map((pack) => (
              <button
                key={pack.packId}
                onClick={() => setSelectedPack(pack)}
                className={cn(
                  "w-full text-left p-3 rounded-lg border transition-colors cursor-pointer group",
                  selectedPack?.packId === pack.packId 
                    ? "bg-indigo-500/10 border-indigo-500/40" 
                    : "hover:bg-white/5 border-transparent"
                )}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className={cn(
                    "font-medium text-sm transition-colors",
                    selectedPack?.packId === pack.packId ? "text-indigo-100 font-bold" : "text-zinc-400 group-hover:text-zinc-200"
                  )}>{pack.packName}</span>
                  <span className={cn(
                    "text-[9px] px-1.5 py-0.5 rounded border font-mono",
                    selectedPack?.packId === pack.packId 
                      ? "bg-indigo-500/20 text-indigo-400 border-indigo-500/30" 
                      : "bg-zinc-800 text-zinc-500 border-white/5"
                  )}>
                    {pack.releaseChannel.toUpperCase()}
                  </span>
                </div>
                <div className="flex gap-2 text-[10px] opacity-60">
                  <span className={selectedPack?.packId === pack.packId ? "text-indigo-200" : "text-zinc-400"}>{pack.minecraftVersion}</span>
                  <span className="opacity-30">|</span>
                  <span className={selectedPack?.packId === pack.packId ? "text-indigo-200" : "text-zinc-400"}>{pack.loaderType}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Sidebar Footer */}
          <div className="mt-auto p-4 border-t border-white/5 space-y-1">
            <button
              onClick={() => setIsLogsOpen(true)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded transition-all"
            >
              <span>Журнал</span>
              <TerminalSquare className="w-3.5 h-3.5" />
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded transition-all"
            >
              <span>Настройки</span>
              <SettingsIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative bg-zinc-950 overflow-hidden z-0">
        <div className="relative z-10 w-full h-full">
          <AnimatePresence mode="wait">
            {selectedPack ? (
              <motion.div 
                key="pack"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.3 }}
                className="h-full"
              >
                <PackView 
                  pack={selectedPack} 
                  onClose={() => setSelectedPack(null)} 
                />
              </motion.div>
            ) : (
              <motion.div 
                key="notices"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full p-10 overflow-y-auto"
              >
                <div className="max-w-3xl mx-auto mt-12">
                  <div className="flex items-center gap-3 mb-8">
                    <MonitorPlay className="w-8 h-8 text-emerald-400" />
                    <h2 className="text-3xl font-light text-white tracking-tight">Информационный Центр</h2>
                  </div>
                  
                  <div className="space-y-4">
                    {loadError && (
                      <div className="p-4 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-200">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold">Не удалось обновить данные</p>
                            <p className="text-[11px] text-zinc-500 mt-1 break-words">{loadError}</p>
                          </div>
                          <button onClick={() => setReloadToken((value) => value + 1)} className="p-2 rounded hover:bg-white/5" title="Повторить">
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}
                    {notices.map(notice => (
                      <div 
                        key={notice.id} 
                        className={cn(
                          "p-4 rounded-lg bg-zinc-900 border-l-2 relative overflow-hidden",
                          notice.tone === 'success' && "border-emerald-500 bg-emerald-500/5",
                          notice.tone === 'info' && "border-indigo-500 bg-indigo-500/5",
                          notice.tone === 'warning' && "border-amber-500 bg-amber-500/5"
                        )}
                      >
                         <div className="relative z-10">
                          <h4 className={cn(
                            "text-[10px] font-bold uppercase tracking-widest mb-1",
                            notice.tone === 'success' && "text-emerald-400",
                            notice.tone === 'info' && "text-indigo-400",
                            notice.tone === 'warning' && "text-amber-400"
                          )}>{notice.title}</h4>
                          <p className="text-xs text-zinc-400">{notice.body}</p>
                         </div>
                      </div>
                    ))}
                    
                    {notices.length === 0 && (
                      <div className="text-center py-20 text-zinc-500">
                        <p>Нет активных оповещений</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>

      {/* Settings Modal overlay */}
      <AnimatePresence>
        {isSettingsOpen && (
           <SettingsModal onClose={() => setIsSettingsOpen(false)} />
        )}
        {isLogsOpen && (
          <LogsModal onClose={() => setIsLogsOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
