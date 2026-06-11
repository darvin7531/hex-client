import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './components/Dashboard';
import { MaintenanceOverlay } from './components/MaintenanceOverlay';
import { fetchVersion } from './lib/mockApi';
import { initMockElectron } from './lib/mockElectron';
import './index.css';

function AppBootstrapper() {
  const [maintenance, setMaintenance] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initialize IPC bridge before anything else
    initMockElectron();

    // Check version
    fetchVersion().then(v => {
      if (v.maintenanceMode) {
        setMaintenance(true);
      }
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="w-screen h-screen bg-zinc-950 flex flex-col items-center justify-center">
        <div className="w-16 h-16 border-4 border-zinc-800 border-t-emerald-500 rounded-full animate-spin"></div>
        <p className="mt-6 font-mono text-xs text-zinc-600 uppercase tracking-widest">Инициализация ядра...</p>
      </div>
    );
  }

  if (maintenance) {
    return <MaintenanceOverlay />;
  }

  return <Dashboard />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBootstrapper />
  </StrictMode>,
);

