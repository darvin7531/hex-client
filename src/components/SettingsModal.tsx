import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { X, Server, MemoryStick as Memory, Code, FolderOpen, Settings } from 'lucide-react';
import { LauncherSettings } from '../types';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [totalMemory, setTotalMemory] = useState<number>(16384); // mock default
  const [settings, setSettings] = useState<LauncherSettings>({
    ramAllocation: 4096,
    customJavaPath: '',
    jvmArgs: '-XX:+UseG1GC -Dsun.rmi.dgc.server.gcInterval=2147483646',
    optionalMods: {}
  });

  useEffect(() => {
    window.electronAPI.getSystemInfo().then(info => {
      setTotalMemory(info.totalMemory);
    });
    
    const stored = localStorage.getItem('launcher_settings');
    if (stored) {
      setSettings(JSON.parse(stored));
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('launcher_settings', JSON.stringify(settings));
    onClose();
  };

  const handleSelectJava = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      setSettings(s => ({ ...s, customJavaPath: dir }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }} 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center justify-between p-6 border-b border-white/5 bg-zinc-900/50">
          <h2 className="text-xl font-medium text-white flex items-center gap-3">
             <Settings className="w-5 h-5 text-emerald-400" />
             Системные настройки
          </h2>
          <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-white/5 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-8 overflow-y-auto space-y-8 flex-1">
          
          {/* Section: RAM */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <Memory className="w-4 h-4 text-indigo-400" />
                Выделение оперативной памяти
              </label>
              <span className="text-sm font-mono text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">
                {settings.ramAllocation} МБ
              </span>
            </div>
            <input 
              type="range" 
              min={1024} 
              max={totalMemory} 
              step={512}
              value={settings.ramAllocation}
              onChange={(e) => setSettings(s => ({...s, ramAllocation: Number(e.target.value)}))}
              className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-zinc-500 font-mono">
              <span>1024 МБ</span>
              <span>Из {totalMemory} МБ</span>
            </div>
          </div>

          {/* Section: Java */}
          <div className="space-y-4">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Среда выполнения (Java)
            </label>
            <div className="flex gap-2">
              <input 
                 type="text" 
                 value={settings.customJavaPath}
                 onChange={(e) => setSettings(s => ({...s, customJavaPath: e.target.value}))}
                 placeholder="Автоматическое определение (Рекомендуется)"
                 className="flex-1 bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
              />
              <button 
                onClick={handleSelectJava}
                className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors flex items-center gap-2 text-sm"
              >
                <FolderOpen className="w-4 h-4" />
                Обзор
              </button>
            </div>
          </div>

          {/* Section: JVM */}
          <div className="space-y-4">
             <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Code className="w-4 h-4 text-indigo-400" />
              Аргументы JVM
            </label>
            <textarea 
               value={settings.jvmArgs}
               onChange={(e) => setSettings(s => ({...s, jvmArgs: e.target.value}))}
               className="w-full h-24 bg-black/40 border border-white/10 rounded-lg p-4 text-sm text-zinc-300 font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-none"
               placeholder="-XX:+UseG1GC ..."
            />
          </div>

          {/* Section: Custom API Server */}
          <div className="space-y-4">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-400" />
              Адрес API Бэкенда (Для разработчиков)
            </label>
            <input 
               type="text" 
               value={settings.customApiUrl || ''}
               onChange={(e) => setSettings(s => ({...s, customApiUrl: e.target.value}))}
               placeholder="http://127.0.0.1:4000/api"
               className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
            />
          </div>

        </div>

        <div className="p-6 border-t border-white/5 bg-zinc-900/50 flex justify-end gap-3">
          <button 
            onClick={onClose}
            className="px-6 py-2.5 rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors font-medium text-sm text-center"
          >
            Отмена
          </button>
          <button 
            onClick={() => {
              localStorage.setItem('launcher_settings', JSON.stringify(settings));
              onClose();
              window.location.reload();
            }}
            className="px-6 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold transition-colors text-sm text-center shadow-[0_0_15px_rgba(16,185,129,0.3)]"
          >
            Сохранить
          </button>
        </div>
      </motion.div>
    </div>
  );
}
