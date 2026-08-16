import type { LauncherVersion, Notice, PackSummary, PackVersionSummary, ReleaseManifest } from '../types';
import { CONFIG } from '../config';

let electronBootstrapPromise: ReturnType<NonNullable<typeof window.hexloaderDesktop>["getBootstrap"]> | null = null;
let electronBootstrapAt = 0;

function getElectronBootstrap() {
  if (!window.hexloaderDesktop) throw new Error("Electron bridge is unavailable");
  const now = Date.now();
  if (!electronBootstrapPromise || now - electronBootstrapAt > 5000) {
    electronBootstrapAt = now;
    electronBootstrapPromise = window.hexloaderDesktop.getBootstrap();
    void electronBootstrapPromise.catch(() => { electronBootstrapPromise = null; });
  }
  return electronBootstrapPromise;
}

async function browserFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${CONFIG.API_BASE}${path}`);
  if (!res.ok) throw new Error(`Backend API unavailable (${res.status})`);
  return await res.json() as T;
}

export const fetchVersion = async (): Promise<LauncherVersion> => {
  if (window.hexloaderDesktop?.isElectron) return (await getElectronBootstrap()).launcherVersion;
  return browserFetch<LauncherVersion>('/launcher/version');
};

export const fetchNotices = async (): Promise<Notice[]> => {
  if (window.hexloaderDesktop?.isElectron) return (await getElectronBootstrap()).notices;
  return browserFetch<Notice[]>('/notices');
};

export const fetchPacks = async (): Promise<PackSummary[]> => {
  if (window.hexloaderDesktop?.isElectron) return (await getElectronBootstrap()).packs;
  return browserFetch<PackSummary[]>('/packs');
};

export const fetchVersions = async (packId: string, includeArchived = true): Promise<PackVersionSummary[]> => {
  if (window.hexloaderDesktop?.isElectron) {
    return window.hexloaderDesktop.getVersions({ packId, includeArchived });
  }
  return browserFetch<PackVersionSummary[]>(`/packs/${encodeURIComponent(packId)}/versions?includeArchived=${includeArchived ? 'true' : 'false'}`);
};

export const fetchManifest = async (
  packId: string,
  packVersion: string | undefined,
  releaseChannel: PackSummary['releaseChannel'],
): Promise<ReleaseManifest> => {
  if (window.hexloaderDesktop?.isElectron) {
    return window.hexloaderDesktop.getManifest({ packId, packVersion, releaseChannel });
  }
  const channel = encodeURIComponent(releaseChannel);
  const suffix = packVersion
    ? `/packs/${encodeURIComponent(packId)}/releases/${encodeURIComponent(packVersion)}?channel=${channel}`
    : `/packs/${encodeURIComponent(packId)}/latest?channel=${channel}`;
  return browserFetch<ReleaseManifest>(suffix);
};
