import { DEFAULT_API_BASE } from "../electron/sharedConfig.cts";

export const CONFIG = {
  API_BASE: import.meta.env.VITE_API_BASE || DEFAULT_API_BASE,
};
