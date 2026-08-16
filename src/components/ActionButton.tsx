import { motion } from 'motion/react';
import { Download, Loader2, Wrench, RefreshCw, AlertTriangle, WifiOff } from 'lucide-react';
import type { GameState, SyncProgress } from '../types';
import { formatBytes, cn } from '../lib/utils';

export function ActionButton({
  state,
  progress,
  onClick,
}: {
  state: GameState;
  progress: SyncProgress | null;
  onClick: () => void;
}) {
  const config: Record<GameState['status'], {
    Text: string;
    Icon?: typeof Download;
    glowColor?: string;
    buttonClass: string;
    enabled: boolean;
  }> = {
    not_installed: { Text: 'INSTALL NOW', Icon: Download, glowColor: 'bg-indigo-500', buttonClass: 'bg-indigo-500 text-zinc-950 border-indigo-400 hover:bg-indigo-400', enabled: true },
    installing: { Text: 'DOWNLOADING...', Icon: Loader2, glowColor: 'bg-zinc-700', buttonClass: 'bg-zinc-800 text-zinc-300 border-zinc-700', enabled: false },
    updating: { Text: 'UPDATING...', Icon: Loader2, glowColor: 'bg-zinc-700', buttonClass: 'bg-zinc-800 text-zinc-300 border-zinc-700', enabled: false },
    update_available: { Text: 'UPDATE AVAILABLE', Icon: RefreshCw, glowColor: 'bg-indigo-500', buttonClass: 'bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-500', enabled: true },
    repair_required: { Text: 'REPAIR FILES', Icon: Wrench, glowColor: 'bg-amber-500', buttonClass: 'bg-amber-600 text-zinc-950 border-amber-500 hover:bg-amber-500', enabled: true },
    ready_to_launch: { Text: 'PLAY NOW', glowColor: 'bg-emerald-500', buttonClass: 'bg-emerald-500 text-zinc-950 border-emerald-400 hover:bg-emerald-400', enabled: true },
    launching: { Text: 'LAUNCHING...', Icon: Loader2, glowColor: 'bg-emerald-500', buttonClass: 'bg-emerald-500 text-zinc-950 border-emerald-400 opacity-80', enabled: false },
    running: { Text: 'GAME IS RUNNING', glowColor: 'bg-emerald-500', buttonClass: 'bg-zinc-900 border-emerald-500 text-emerald-400', enabled: false },
    launch_failed: { Text: 'RETRY LAUNCH', Icon: AlertTriangle, glowColor: 'bg-amber-500', buttonClass: 'bg-amber-500 text-zinc-950 border-amber-400 hover:bg-amber-400', enabled: true },
    backend_unavailable: { Text: 'PLAY OFFLINE', Icon: WifiOff, glowColor: 'bg-amber-500', buttonClass: 'bg-zinc-900 text-amber-300 border-amber-500/40 hover:bg-amber-500/10', enabled: true },
  };

  const currentConfig = config[state.status];
  const isProgressState = (
    state.status === 'installing'
    || state.status === 'updating'
    || state.status === 'repair_required'
  ) && Boolean(progress);

  if (isProgressState && progress) {
    const percent = progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesProgress / progress.totalBytes) * 100))
      : 0;

    return (
      <div className="w-full relative h-14 bg-zinc-900 rounded overflow-hidden border border-white/10 shadow-lg">
        <motion.div
          className="absolute inset-y-0 left-0 bg-indigo-600/30 border-r border-indigo-400/50"
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          transition={{ ease: 'linear', duration: 0.2 }}
        />
        <div className="absolute inset-0 flex items-center justify-between px-6 pointer-events-none">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-3">
              <span className="text-white text-sm font-bold tracking-widest uppercase">
                {state.status === 'repair_required' ? 'REPAIRING...' : 'SYNCING'}
              </span>
              <span className="text-zinc-500 text-xs font-mono">{percent}%</span>
            </div>
            {progress.currentFile && (
              <div className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">{progress.currentFile}</div>
            )}
          </div>
          <div className="text-right flex flex-col items-end flex-shrink-0">
            <span className="text-zinc-400 text-xs font-mono">{progress.speedMbSec.toFixed(1)} MB/s</span>
            <span className="text-zinc-600 text-[10px] font-mono">
              {formatBytes(progress.bytesProgress)} / {formatBytes(progress.totalBytes)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const TheIcon = currentConfig.Icon;

  return (
    <button
      disabled={!currentConfig.enabled}
      onClick={onClick}
      className={cn(
        'relative group w-full flex items-center justify-center transition-all',
        !currentConfig.enabled && 'cursor-not-allowed opacity-90 grayscale-[20%]',
      )}
    >
      <div className={cn('absolute inset-0 blur-xl opacity-20 group-hover:opacity-40 transition-opacity', currentConfig.glowColor)} />
      <div className={cn(
        'relative flex items-center justify-center w-full h-14 font-black text-xl tracking-tighter rounded border transition-colors shadow-lg',
        currentConfig.buttonClass,
      )}>
        {currentConfig.Text}
        {state.status === 'ready_to_launch' && (
          <svg className="ml-3 w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        )}
        {TheIcon && state.status !== 'ready_to_launch' && (
          <TheIcon className={cn('ml-3 w-6 h-6', (state.status === 'launching' || state.status === 'installing' || state.status === 'updating') && 'animate-spin')} />
        )}
      </div>
    </button>
  );
}
