import { LauncherVersion, Notice, PackSummary, ReleaseManifest } from '../types';
import { CONFIG } from '../config';

const API_BASE = CONFIG.API_BASE;

export const fetchVersion = async (): Promise<LauncherVersion> => {
    if (window.hexloaderDesktop && window.hexloaderDesktop.isElectron) {
      try {
        const bootstrap = await window.hexloaderDesktop.getBootstrap();
        return bootstrap.launcherVersion;
      } catch (e) {
        // Fallback to fetch
      }
    }
    const res = await fetch(`${API_BASE}/launcher/version`);
    if (!res.ok) throw new Error("Backend API unavailable");
    return await res.json();
};

export const fetchNotices = async (): Promise<Notice[]> => {
    if (window.hexloaderDesktop && window.hexloaderDesktop.isElectron) {
      try {
        const bootstrap = await window.hexloaderDesktop.getBootstrap();
        return bootstrap.notices as Notice[];
      } catch (e) {
        // Fallback to fetch
      }
    }
    const res = await fetch(`${API_BASE}/notices`);
    if (!res.ok) return [];
    return await res.json();
};

export const fetchPacks = async (): Promise<PackSummary[]> => {
    if (window.hexloaderDesktop && window.hexloaderDesktop.isElectron) {
      try {
        const bootstrap = await window.hexloaderDesktop.getBootstrap();
        return bootstrap.packs as PackSummary[];
      } catch (e) {
        // Fallback to fetch
      }
    }
    const res = await fetch(`${API_BASE}/packs`);
    if (!res.ok) return [];
    return await res.json();
};

export const fetchManifest = async (packId: string): Promise<ReleaseManifest> => {
    const res = await fetch(`${API_BASE}/packs/${packId}/latest`);
    if (!res.ok) throw new Error(`Could not fetch manifest for pack ${packId}`);
    return await res.json();
};
