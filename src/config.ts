import { DEFAULT_API_BASE } from "../electron/sharedConfig.cts";

const getApiBase = (): string => {
  if (typeof window !== "undefined") {
    try {
      const stored = localStorage.getItem("launcher_settings");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.customApiUrl) {
          return parsed.customApiUrl;
        }
      }
    } catch {
      // Ignore storage read error
    }
  }
  return import.meta.env.VITE_API_BASE || DEFAULT_API_BASE;
};

/**
 * Global application configuration.
 * Change API_BASE to point to your backend server.
 */
export const CONFIG = {
  API_BASE: getApiBase(),
};
