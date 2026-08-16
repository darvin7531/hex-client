import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, LayoutList, Puzzle, CheckCircle2, AlertTriangle, AlertCircle, User, ShieldCheck, Server, History } from 'lucide-react';
import type { GameState, LauncherSettings, PackState, PackSummary, PackVersionSummary, ReleaseManifest, SyncProgress } from '../types';
import { fetchManifest, fetchVersions } from '../lib/clientApi';
import { formatBytes } from '../lib/utils';
import { ActionButton } from './ActionButton';

function stateFromVerify(status: string): PackState {
  switch (status) {
    case 'ok': return 'ready_to_launch';
    case 'not_installed': return 'not_installed';
    case 'update_available': return 'update_available';
    case 'repair_required': return 'repair_required';
    case 'backend_unavailable': return 'backend_unavailable';
    default: return 'launch_failed';
  }
}

export function PackView({ pack, onClose }: { pack: PackSummary; onClose: () => void }) {
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
  const [versions, setVersions] = useState<PackVersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState(pack.latestVersion);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [activeTab, setActiveTab] = useState<'changelog' | 'mods'>('changelog');
  const [gameState, setGameState] = useState<GameState>({ status: 'not_installed' });
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');

  const selectedReleaseChannel = useMemo(
    () => versions.find((item) => item.packVersion === selectedVersion)?.releaseChannel ?? pack.releaseChannel,
    [versions, selectedVersion, pack.releaseChannel],
  );
  const optionalFiles = useMemo(() => settings?.optionalFilesByPack?.[pack.packId] ?? [], [settings, pack.packId]);
  const optionalSet = useMemo(() => new Set(optionalFiles), [optionalFiles]);
  const serverOverride = settings?.serverOverridesByPack?.[pack.packId];

  const refreshState = useCallback(async () => {
    if (!window.hexloaderDesktop) return;
    try {
      const diag = await window.hexloaderDesktop.getLauncherDiagnostics({ packId: pack.packId, packVersion: selectedVersion, releaseChannel: selectedReleaseChannel });
      if (diag.processRunning) {
        setGameState({ status: 'running' });
        return;
      }
      const result = await window.hexloaderDesktop.verifyPackFiles({ packId: pack.packId, packVersion: selectedVersion, releaseChannel: selectedReleaseChannel });
      setGameState({ status: stateFromVerify(result.status) });
    } catch (e) {
      setGameState({ status: 'launch_failed', diagnostics: [e instanceof Error ? e.message : String(e)] });
    }
  }, [pack.packId, selectedReleaseChannel, selectedVersion]);

  useEffect(() => {
    let alive = true;
    setError('');
    setManifest(null);
    void Promise.all([
      fetchManifest(pack.packId, selectedVersion, selectedReleaseChannel),
      window.hexloaderDesktop?.getSettings(),
      fetchVersions(pack.packId, true).catch(() => [{ packId: pack.packId, packVersion: selectedVersion, releaseChannel: selectedReleaseChannel, archived: false, publishedAt: '' }]),
    ]).then(([release, loadedSettings, loadedVersions]) => {
      if (!alive) return;
      setManifest(release);
      if (loadedSettings) {
        setSettings(loadedSettings);
        const preferred = loadedSettings.selectedVersionsByPack?.[pack.packId];
        if (preferred && preferred !== selectedVersion && loadedVersions.some((item) => item.packVersion === preferred)) {
          setSelectedVersion(preferred);
        }
      }
      setVersions(loadedVersions);
    }).catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    void refreshState();
    const unsubscribe = window.hexloaderDesktop?.onSyncProgress((progress) => { if (alive) setSyncProgress(progress); });
    const unsubscribeGame = window.hexloaderDesktop?.onGameState((state) => {
      if (!alive || ('packId' in state && state.packId !== pack.packId)) return;
      if (state.status === 'launching' || state.status === 'running') setGameState({ status: state.status });
      else if (state.status === 'exited') setGameState({ status: 'ready_to_launch' });
      else if (state.status === 'error') setGameState({ status: 'launch_failed', diagnostics: [state.message] });
    });
    return () => {
      alive = false;
      unsubscribe?.();
      unsubscribeGame?.();
    };
  }, [pack.packId, selectedReleaseChannel, selectedVersion, refreshState]);

  const updateSettings = async (patch: Partial<Omit<LauncherSettings, 'canOverrideApi'>>) => {
    if (!window.hexloaderDesktop) return;
    const saved = await window.hexloaderDesktop.updateSettings(patch);
    setSettings(saved);
  };

  const saveNickname = async (nickname: string) => {
    if (!settings) return;
    try { await updateSettings({ nickname }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const toggleOptional = async (filePath: string) => {
    if (!settings) return;
    const next = optionalSet.has(filePath) ? optionalFiles.filter((item) => item !== filePath) : [...optionalFiles, filePath];
    try {
      await updateSettings({ optionalFilesByPack: { ...settings.optionalFilesByPack, [pack.packId]: next } });
      if (gameState.status === 'ready_to_launch') setGameState({ status: 'update_available' });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const selectVersion = async (version: string) => {
    setSelectedVersion(version);
    setGameState({ status: 'not_installed' });
    if (!settings) return;
    try {
      await updateSettings({ selectedVersionsByPack: { ...settings.selectedVersionsByPack, [pack.packId]: version } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setServerOverrideEnabled = async (enabled: boolean) => {
    if (!settings || !manifest) return;
    const next = { ...settings.serverOverridesByPack };
    if (enabled) next[pack.packId] = { address: manifest.serverBootstrap.serverAddress, port: manifest.serverBootstrap.serverPort };
    else delete next[pack.packId];
    try { await updateSettings({ serverOverridesByPack: next }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const saveServerOverride = async (address: string, port: number) => {
    if (!settings) return;
    try {
      await updateSettings({ serverOverridesByPack: { ...settings.serverOverridesByPack, [pack.packId]: { address, port } } });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const sync = async (repair: boolean) => {
    if (!manifest || !window.hexloaderDesktop) return;
    setError('');
    setGameState({ status: repair ? 'repair_required' : gameState.status === 'not_installed' ? 'installing' : 'updating' });
    setSyncProgress(null);
    try {
      await window.hexloaderDesktop.syncPack({ packId: manifest.packId, packVersion: manifest.packVersion, releaseChannel: selectedReleaseChannel, repair, optionalFiles });
      setGameState({ status: 'ready_to_launch' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setGameState({ status: 'launch_failed', diagnostics: [message] });
      setError(message);
    }
  };

  const launch = async () => {
    if (!manifest || !settings || !window.hexloaderDesktop) return;
    setError('');
    setGameState({ status: 'launching' });
    try {
      await window.hexloaderDesktop.launchPack({
        packId: manifest.packId,
        packVersion: manifest.packVersion,
        releaseChannel: selectedReleaseChannel,
        nickname: settings.nickname,
        memoryMb: settings.memoryMb,
        resolution: settings.resolution,
        fullscreen: settings.fullscreen,
        optionalFiles,
      });
      setGameState({ status: 'running' });

    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setGameState({ status: 'launch_failed', diagnostics: [message] });
      setError(message);
    }
  };

  const handleActionClick = async () => {
    switch (gameState.status) {
      case 'not_installed':
      case 'update_available': return sync(false);
      case 'repair_required': return sync(true);
      case 'backend_unavailable': return launch();
      case 'ready_to_launch':
      case 'launch_failed': {
        if (window.hexloaderDesktop) {
          const verify = await window.hexloaderDesktop.verifyPackFiles({ packId: pack.packId, packVersion: selectedVersion, releaseChannel: selectedReleaseChannel });
          const next = stateFromVerify(verify.status);
          if (next === 'not_installed' || next === 'update_available') return sync(false);
          if (next === 'repair_required') return sync(true);
          if (next === 'backend_unavailable') { setGameState({ status: 'backend_unavailable' }); return; }
        }
        return launch();
      }
      default: return;
    }
  };

  if (error && !manifest) return <div className="h-full flex items-center justify-center text-red-300 p-8 text-center">Не удалось загрузить сборку: {error}</div>;
  if (!manifest || !settings) return <div className="h-full flex items-center justify-center"><div className="w-8 h-8 border-4 border-zinc-800 border-t-emerald-500 rounded-full animate-spin" /></div>;

  const optional = manifest.files.filter((f) => f.updatePolicy === 'optional');
  const totalSize = manifest.files.filter((f) => f.updatePolicy !== 'optional' || optionalSet.has(f.path)).reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="h-full flex flex-col relative z-20">
      <div className="relative h-64 bg-zinc-800 overflow-hidden flex-shrink-0">
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent z-10" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,#4f46e533_0%,transparent_50%)]" />
        <button onClick={onClose} className="absolute top-6 left-8 z-30 flex items-center gap-2 text-zinc-400 hover:text-white text-xs font-bold uppercase tracking-widest"><ChevronLeft className="w-4 h-4" />Назад</button>
        <div className="absolute bottom-0 left-0 p-8 z-20">
          <h1 className="text-5xl font-black italic tracking-tighter text-white uppercase">{pack.heroTitle || pack.packName}</h1>
          <p className="text-indigo-400 font-medium text-lg">{pack.heroSubtitle}</p>
        </div>
        <div className="absolute right-8 bottom-8 z-20 flex items-center gap-2 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-500/20 px-3 py-2 rounded-lg"><ShieldCheck className="w-4 h-4" />Manifest: {manifest.signature ? 'signed' : (/^[a-f0-9]{64}$/i.test(manifest.manifestHash) ? 'SHA-256' : 'legacy')}</div>
      </div>

      <div className="flex-1 overflow-y-auto pb-32">
        <div className="border-b border-white/5 px-8 flex gap-8 sticky top-0 bg-zinc-950/95 z-20">
          <button onClick={() => setActiveTab('changelog')} className={`py-4 text-xs font-bold uppercase tracking-wider border-b-2 ${activeTab === 'changelog' ? 'border-emerald-500 text-white' : 'border-transparent text-zinc-500'}`}><LayoutList className="inline w-4 h-4 mr-2" />Изменения</button>
          <button onClick={() => setActiveTab('mods')} className={`py-4 text-xs font-bold uppercase tracking-wider border-b-2 ${activeTab === 'mods' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-500'}`}><Puzzle className="inline w-4 h-4 mr-2" />Дополнительно ({optional.length})</button>
        </div>

        <div className="p-8 max-w-5xl space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/5 bg-black/30 p-4">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2 flex items-center gap-2"><History className="w-3.5 h-3.5" />Версия сборки</div>
              <select value={selectedVersion} onChange={(e) => void selectVersion(e.target.value)} className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-sm">
                {(versions.length ? versions : [{ packId: pack.packId, packVersion: manifest.packVersion, releaseChannel: manifest.releaseChannel, archived: manifest.archived, publishedAt: manifest.publishedAt }]).map((v) => <option key={v.packVersion} value={v.packVersion}>{v.packVersion}{v.archived ? ' • archived' : v.packVersion === pack.latestVersion ? ' • latest' : ''}</option>)}
              </select>
              <div className="text-xs text-zinc-500 mt-2">Канал: <span className="text-zinc-300">{manifest.releaseChannel}</span> • {manifest.loaderType} {manifest.loaderVersion}</div>
            </div>
            <div className="rounded-xl border border-white/5 bg-black/30 p-4">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2 flex items-center gap-2"><Server className="w-3.5 h-3.5" />{manifest.serverBootstrap.serverName}</div>
              <div className="text-sm text-zinc-200 font-mono">{manifest.serverBootstrap.serverAddress}:{manifest.serverBootstrap.serverPort}</div>
              {manifest.serverBootstrap.motd && <div className="text-xs text-zinc-400 mt-2">{manifest.serverBootstrap.motd}</div>}
              <div className="text-xs mt-2 text-zinc-500">Автовход: {manifest.serverBootstrap.autoConnect ? 'включён' : 'выключен'}</div>
              {manifest.serverBootstrap.allowUserOverride && (
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={Boolean(serverOverride)} onChange={(e) => void setServerOverrideEnabled(e.target.checked)} />Использовать свой адрес</label>
                  {serverOverride && <div className="flex gap-2"><input value={serverOverride.address} onChange={(e) => setSettings({ ...settings, serverOverridesByPack: { ...settings.serverOverridesByPack, [pack.packId]: { ...serverOverride, address: e.target.value } } })} onBlur={(e) => void saveServerOverride(e.target.value, serverOverride.port)} className="min-w-0 flex-1 bg-zinc-950 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono" /><input type="number" min={1} max={65535} value={serverOverride.port} onChange={(e) => setSettings({ ...settings, serverOverridesByPack: { ...settings.serverOverridesByPack, [pack.packId]: { ...serverOverride, port: Number(e.target.value) } } })} onBlur={(e) => void saveServerOverride(serverOverride.address, Number(e.target.value))} className="w-24 bg-zinc-950 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono" /></div>}
                </div>
              )}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {activeTab === 'changelog' ? (
              <motion.div key="changelog" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <h3 className="text-lg font-medium text-white mb-4">Версия {manifest.packVersion}</h3>
                <ul className="space-y-3">{manifest.changelog.length ? manifest.changelog.map((log, i) => <li key={i} className="flex gap-3 text-zinc-300 text-sm"><span className="text-emerald-500">•</span>{log}</li>) : <li className="text-zinc-500">Список изменений пуст.</li>}</ul>
                {(error || gameState.diagnostics?.length) && <div className="mt-6 bg-amber-950/30 border border-amber-500/30 rounded-2xl p-5"><div className="flex items-center gap-2 text-amber-400 mb-3"><AlertTriangle className="w-5 h-5" />Диагностика</div>{(gameState.diagnostics ?? [error]).filter(Boolean).map((d, i) => <div key={i} className="text-sm text-amber-200/80 flex gap-2"><AlertCircle className="w-4 h-4 mt-0.5" />{d}</div>)}</div>}
              </motion.div>
            ) : (
              <motion.div key="mods" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {optional.map((file) => <label key={file.path} className="flex items-start gap-4 p-4 rounded-xl border border-white/5 bg-black/40 hover:bg-white/5 cursor-pointer"><div className="relative w-6 h-6"><input type="checkbox" className="peer appearance-none w-5 h-5 border border-white/20 rounded checked:bg-indigo-500" checked={optionalSet.has(file.path)} onChange={() => void toggleOptional(file.path)} /><CheckCircle2 className="w-3.5 h-3.5 text-white absolute inset-0 m-auto opacity-0 peer-checked:opacity-100 pointer-events-none" /></div><div><span className="block text-sm text-white">{file.path.split('/').pop()}</span><span className="text-xs text-zinc-500">{file.kind} • {formatBytes(file.size)}{file.preserveUserChanges ? ' • preserve' : ''}</span></div></label>)}
                {!optional.length && <div className="col-span-full py-10 text-center text-zinc-500">Дополнительных файлов нет.</div>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <footer className="h-28 bg-zinc-950 border-t border-white/10 px-8 flex items-center justify-between absolute bottom-0 inset-x-0 z-30">
        <div className="flex items-center gap-8">
          <div><div className="text-[10px] text-zinc-500 uppercase tracking-widest">Version</div><div className="text-sm text-zinc-200">{manifest.packVersion} / MC {manifest.minecraftVersion}</div></div>
          <div className="h-8 w-px bg-white/5" />
          <div><div className="text-[10px] text-zinc-500 uppercase tracking-widest">Nickname</div><div className="flex items-center gap-2 mt-1"><User className="w-4 h-4 text-indigo-400" /><input list={`nicknames-${pack.packId}`} value={settings.nickname} onChange={(e) => setSettings({ ...settings, nickname: e.target.value })} onBlur={(e) => void saveNickname(e.target.value)} className="bg-black/50 border border-white/10 rounded-lg px-3 py-1 text-sm text-zinc-200 w-40 font-mono" /><datalist id={`nicknames-${pack.packId}`}>{settings.nicknameHistory.map((nick) => <option key={nick} value={nick} />)}</datalist>{settings.nicknameHistory.length > 1 && <select aria-label="Сохранённые ники" value={settings.nickname} onChange={(e) => { setSettings({ ...settings, nickname: e.target.value }); void saveNickname(e.target.value); }} className="bg-black/50 border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-300">{settings.nicknameHistory.map((nick) => <option key={nick} value={nick}>{nick}</option>)}</select>}</div></div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right"><div className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest">{syncProgress?.currentFile || `Status: ${gameState.status}`}</div><div className="text-[9px] text-zinc-500 font-mono">{syncProgress ? `${formatBytes(syncProgress.bytesProgress)} / ${formatBytes(syncProgress.totalBytes)}${syncProgress.speedMbSec ? ` • ${syncProgress.speedMbSec} MB/s` : ''}` : `Managed size: ${formatBytes(totalSize)}`}</div></div>
          <div className="w-64"><ActionButton state={gameState} progress={syncProgress} onClick={() => void handleActionClick()} /></div>
        </div>
      </footer>
    </div>
  );
}
