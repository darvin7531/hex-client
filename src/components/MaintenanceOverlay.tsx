import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';

export function MaintenanceOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-xl">
       <motion.div 
         initial={{ opacity: 0, scale: 0.9 }}
         animate={{ opacity: 1, scale: 1 }}
         className="max-w-md w-full bg-zinc-900 border border-white/10 p-8 rounded-3xl shadow-2xl flex flex-col items-center text-center relative overflow-hidden"
       >
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-amber-500 to-amber-700"/>
          
          <div className="w-20 h-20 bg-amber-500/10 rounded-full flex items-center justify-center mb-6">
            <ShieldAlert className="w-10 h-10 text-amber-500" />
          </div>
          
          <h2 className="text-2xl font-bold text-white mb-3 tracking-tight">Технические работы</h2>
          <p className="text-zinc-400 text-sm leading-relaxed mb-6">
            Сервер обслуживания временно недоступен. Мы проводим плановое обновление инфраструктуры. Пожалуйста, подождите или проверьте наш Discord для получения статуса.
          </p>
          
          <div className="w-full bg-black/40 rounded-xl p-4 border border-white/5">
             <div className="flex items-center justify-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="font-mono text-xs text-amber-500/80 uppercase tracking-wider">Соединение разорвано</span>
             </div>
          </div>
       </motion.div>
    </div>
  );
}
