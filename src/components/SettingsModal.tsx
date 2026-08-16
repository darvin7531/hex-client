import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { X, Server, MemoryStick as Memory, Monitor, Settings, UserRound, Trash2 } from 'lucide-react';
import type { LauncherSettings } from '../types';
import { DEFAULT_API_BASE } from '../../electron/sharedConfig.cts';

const fallback: LauncherSettings = {
  nickname: 'HexPilot',
  nicknameHistory: ['HexPilot'],
  memoryMb: 4096,
  resolution: '1920x1080',
  fullscreen: false,
  customApiUrl: '',
  optionalFilesByPack: {},
  selectedVersionsByPack: {},
  serverOverridesByPack: {},
  canOverrideApi: false,
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [totalMemory, setTotalMemory] = useState(16384);
  const [recommendedMax, setRecommendedMax] = useState(12288);
  const [settings, setSettings] = useState<LauncherSettings>(fallback);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      window.hexloaderDesktop?.getSettings() ?? Promise.resolve(fallback),
      window.hexloaderDesktop?.getSystemMemory() ?? Promise.resolve({ totalMemoryMb: 16384, recommendedMaxMemoryMb: 12288 }),
    ]).then(([loaded, memory]) => {
      if (!alive) return;
      setSettings(loaded);
      setTotalMemory(memory.totalMemoryMb);
      setRecommendedMax(memory.recommendedMaxMemoryMb);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, []);

  const handleSave = async () => {
    if (!window.hexloaderDesktop) return;
    setSaving(true);
    setError('');
    try {
      const saved = await window.hexloaderDesktop.updateSettings({
        nickname: settings.nickname,
        nicknameHistory: settings.nicknameHistory,
        memoryMb: settings.memoryMb,
        resolution: settings.resolution,
        fullscreen: settings.fullscreen,
        customApiUrl: settings.canOverrideApi ? settings.customApiUrl : undefined,
        optionalFilesByPack: settings.optionalFilesByPack,
        selectedVersionsByPack: settings.selectedVersionsByPack,
        serverOverridesByPack: settings.serverOverridesByPack,
      });
      setSettings(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Настройки HexLoader">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div ref={dialogRef} initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <h2 className="text-xl font-medium text-white flex items-center gap-3"><Settings className="w-5 h-5 text-emerald-400" />Системные настройки</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Закрыть настройки" className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-white/5"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-8 overflow-y-auto space-y-8 flex-1">
          <div className="space-y-4">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2"><UserRound className="w-4 h-4 text-indigo-400" />Игровой ник</label>
            <input value={settings.nickname} maxLength={16} onChange={(e) => setSettings((s) => ({ ...s, nickname: e.target.value }))} className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200 font-mono" />
            <div className="flex flex-wrap gap-2">
              {settings.nicknameHistory.map((nickname) => (
                <div key={nickname} className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${nickname === settings.nickname ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-black/30'}`}>
                  <button type="button" onClick={() => setSettings((s) => ({ ...s, nickname }))} className="text-xs font-mono text-zinc-300 hover:text-white">{nickname}</button>
                  {settings.nicknameHistory.length > 1 && nickname !== settings.nickname && (
                    <button type="button" aria-label={`Удалить ник ${nickname}`} onClick={() => setSettings((s) => ({ ...s, nicknameHistory: s.nicknameHistory.filter((item) => item !== nickname) }))} className="p-0.5 text-zinc-600 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500">HexLoader хранит до 10 последних корректных Minecraft-ников локально.</p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2"><Memory className="w-4 h-4 text-indigo-400" />Оперативная память</label>
              <span className="text-sm font-mono text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">{settings.memoryMb} МБ</span>
            </div>
            <input type="range" min={1024} max={recommendedMax} step={512} value={Math.min(settings.memoryMb, recommendedMax)} onChange={(e) => setSettings((s) => ({ ...s, memoryMb: Number(e.target.value) }))} className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
            <div className="flex justify-between text-xs text-zinc-500 font-mono"><span>1024 МБ</span><span>Рекомендуемый максимум {recommendedMax} / всего {totalMemory} МБ</span></div>
          </div>

          <div className="space-y-4">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2"><Monitor className="w-4 h-4 text-indigo-400" />Окно игры</label>
            <div className="grid grid-cols-2 gap-3">
              <select value={settings.resolution} onChange={(e) => setSettings((s) => ({ ...s, resolution: e.target.value }))} className="bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200">
                {['1280x720','1600x900','1920x1080','2560x1440','3840x2160'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <label className="flex items-center gap-3 px-4 rounded-lg bg-black/40 border border-white/10 text-sm text-zinc-300"><input type="checkbox" checked={settings.fullscreen} onChange={(e) => setSettings((s) => ({ ...s, fullscreen: e.target.checked }))} />Полный экран</label>
            </div>
          </div>

          {settings.canOverrideApi && (
            <div className="space-y-3">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2"><Server className="w-4 h-4 text-amber-400" />Backend override (developer mode)</label>
              <input type="text" value={settings.customApiUrl} onChange={(e) => setSettings((s) => ({ ...s, customApiUrl: e.target.value }))} placeholder={DEFAULT_API_BASE} className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200 font-mono" />
              <p className="text-xs text-amber-400/80">В production эта настройка отключена по умолчанию: подмена backend может менять скачиваемый контент.</p>
            </div>
          )}

          {error && <div className="text-sm text-red-300 bg-red-950/30 border border-red-500/30 rounded-lg p-3">{error}</div>}
        </div>

        <div className="p-6 border-t border-white/5 flex justify-end gap-3">
          <button onClick={onClose} className="px-6 py-2.5 rounded-lg border border-white/10 text-zinc-400 hover:text-white">Отмена</button>
          <button disabled={saving} onClick={handleSave} className="px-6 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 font-semibold">{saving ? 'Сохранение…' : 'Сохранить'}</button>
        </div>
      </motion.div>
    </div>
  );
}
