import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Info, Search, TerminalSquare, TriangleAlert, X } from 'lucide-react';
import type { GameLogEntry, LauncherLogEntry } from '../types';
import { cn } from '../lib/utils';

type LevelFilter = 'all' | LauncherLogEntry['level'];

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('ru-RU', { hour12: false });
}

export function LogsModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LauncherLogEntry[]>([]);
  const [gameEntries, setGameEntries] = useState<GameLogEntry[]>([]);
  const [tab, setTab] = useState<'launcher' | 'game'>('launcher');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const api = window.hexloaderDesktop;
    if (!api) {
      setError('Журнал доступен только в desktop-клиенте.');
      return;
    }

    let alive = true;
    void api.getLauncherLogs()
      .then((loaded) => {
        if (alive) setEntries(loaded.slice(-400));
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });

    void api.getGameLogs().then((loaded) => { if (alive) setGameEntries(loaded.slice(-1000)); }).catch(() => {});
    const unsubscribeGame = api.onGameLog((entry) => { if (alive) setGameEntries((current) => [...current, entry].slice(-1000)); });

    const unsubscribe = api.onLauncherLog((entry) => {
      if (!alive) return;
      setEntries((current) => [...current, entry].slice(-400));
    });

    return () => {
      alive = false;
      unsubscribe();
      unsubscribeGame();
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (tab === 'game') return gameEntries.filter((entry) => !needle || entry.message.toLowerCase().includes(needle));
    return entries.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (!needle) return true;
      return `${entry.scope}\n${entry.message}`.toLowerCase().includes(needle);
    });
  }, [entries, gameEntries, level, query, tab]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [filtered.length]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="launcher-log-title">
      <button aria-label="Закрыть журнал" className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-5xl h-[78vh] bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-white/10 bg-zinc-900/70">
          <div className="flex items-center gap-3 min-w-0">
            <TerminalSquare className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 id="launcher-log-title" className="text-sm font-semibold text-white">Журналы</h2>
              <p className="text-[10px] text-zinc-500">{tab === 'launcher' ? `Лаунчер: ${entries.length}` : `Игра: ${gameEntries.length}`} событий</p>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-2 px-3 pt-3 bg-zinc-900/30"><button onClick={() => setTab('launcher')} className={cn('px-4 py-2 rounded-lg text-xs', tab === 'launcher' ? 'bg-emerald-500/15 text-emerald-300' : 'text-zinc-500')}>Лаунчер</button><button onClick={() => setTab('game')} className={cn('px-4 py-2 rounded-lg text-xs', tab === 'game' ? 'bg-indigo-500/15 text-indigo-300' : 'text-zinc-500')}>Игра</button></div>
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-white/5 bg-zinc-900/30">
          <div className="relative flex-1 min-w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск по scope и сообщению"
              className="w-full bg-black/30 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50"
            />
          </div>
          {tab === 'launcher' && (['all', 'info', 'warn', 'error'] as const).map((value) => (
            <button
              key={value}
              onClick={() => setLevel(value)}
              className={cn(
                'px-3 py-2 rounded-lg border text-[10px] uppercase tracking-wider transition-colors',
                level === value ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-white/5 bg-white/[0.02] text-zinc-500 hover:text-zinc-300',
              )}
            >
              {value === 'all' ? 'Все' : value}
            </button>
          ))}
        </div>

        {error && <div className="px-4 py-3 text-xs text-red-300 bg-red-500/5 border-b border-red-500/20">{error}</div>}

        <div ref={listRef} className="flex-1 overflow-y-auto font-mono text-[11px] bg-black/35">
          {filtered.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-600">Событий по текущему фильтру нет.</div>
          ) : filtered.map((entry) => (
            <div key={entry.id} className="grid grid-cols-[72px_74px_minmax(90px,160px)_1fr] gap-3 px-4 py-2 border-b border-white/[0.035] hover:bg-white/[0.025]">
              <span className="text-zinc-600">{formatTimestamp(entry.timestamp)}</span>
              {'stream' in entry ? <span className={entry.stream === 'stderr' ? 'text-amber-400' : 'text-sky-400'}>{entry.stream}</span> : <span className={cn(entry.level === 'error' && 'text-red-400', entry.level === 'warn' && 'text-amber-400', entry.level === 'info' && 'text-sky-400')}>{entry.level}</span>}
              <span className="text-indigo-300 truncate">{'scope' in entry ? entry.scope : 'minecraft'}</span>
              <span className="text-zinc-300 whitespace-pre-wrap break-all select-text">{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
