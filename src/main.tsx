import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { Dashboard } from './components/Dashboard';
import { MaintenanceOverlay } from './components/MaintenanceOverlay';
import { fetchVersion } from './lib/clientApi';
import type { LauncherUpdateStatus } from './types';
import './index.css';

function AppBootstrapper() {
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<LauncherUpdateStatus | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setMaintenance(false);
    setUpdateStatus(null);

    Promise.all([
      fetchVersion(),
      window.hexloaderDesktop?.getLauncherUpdateStatus().catch(() => null) ?? Promise.resolve(null),
    ])
      .then(([version, updater]) => {
        if (!alive) return;
        setMaintenance(Boolean(version.maintenanceMode));
        setUpdateStatus(updater);
      })
      .catch((reason) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => { alive = false; };
  }, [attempt]);

  const installMandatoryUpdate = async () => {
    if (!window.hexloaderDesktop) return;
    setInstallingUpdate(true);
    setUpdateError('');
    try {
      await window.hexloaderDesktop.installLauncherUpdate();
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
      setInstallingUpdate(false);
    }
  };

  if (loading) {
    return (
      <div className="w-screen h-screen bg-zinc-950 flex flex-col items-center justify-center">
        <div className="w-16 h-16 border-4 border-zinc-800 border-t-emerald-500 rounded-full animate-spin" />
        <p className="mt-6 font-mono text-xs text-zinc-600 uppercase tracking-widest">Инициализация ядра...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-screen h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-8">
        <div className="max-w-lg w-full border border-amber-500/20 bg-zinc-900/70 rounded-xl p-8 shadow-2xl">
          <AlertTriangle className="w-10 h-10 text-amber-400 mb-5" />
          <h1 className="text-xl font-semibold mb-2">Не удалось запустить HexLoader</h1>
          <p className="text-sm text-zinc-400 leading-relaxed mb-3">Не удалось получить или проверить данные запуска. Это может быть проблема сети, backend либо проверок целостности.</p>
          <pre className="text-[11px] text-zinc-500 font-mono whitespace-pre-wrap break-words bg-black/30 rounded p-3 mb-6">{error}</pre>
          <button onClick={retry} className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500 text-zinc-950 rounded font-semibold text-sm hover:bg-emerald-400 transition-colors">
            <RefreshCw className="w-4 h-4" /> Повторить
          </button>
        </div>
      </div>
    );
  }

  if (maintenance) return <MaintenanceOverlay />;

  const mandatoryUpdate = updateStatus?.available && updateStatus.remote?.mandatory ? updateStatus.remote : null;
  if (mandatoryUpdate) {
    return (
      <div className="w-screen h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-8">
        <div className="max-w-xl w-full border border-indigo-500/20 bg-zinc-900/80 rounded-xl p-8 shadow-2xl">
          <Download className="w-10 h-10 text-indigo-400 mb-5" />
          <div className="text-[10px] uppercase tracking-widest text-indigo-400 mb-2">Обязательное обновление</div>
          <h1 className="text-2xl font-semibold mb-2">HexLoader {mandatoryUpdate.version}</h1>
          <p className="text-sm text-zinc-400 whitespace-pre-wrap leading-relaxed mb-5">{mandatoryUpdate.notes || 'Для продолжения необходимо обновить лаунчер.'}</p>
          {updateError && <div className="text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded p-3 mb-4">{updateError}</div>}
          <button
            disabled={installingUpdate}
            onClick={() => void installMandatoryUpdate()}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-500 text-white rounded font-semibold text-sm hover:bg-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {installingUpdate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {installingUpdate ? 'Проверка и запуск установщика...' : 'Обновить HexLoader'}
          </button>
        </div>
      </div>
    );
  }

  return <Dashboard updateStatus={updateStatus} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrapper />
  </StrictMode>,
);
