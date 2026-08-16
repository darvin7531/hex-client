import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULT_API_BASE } from "./electron/sharedConfig.cts";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-renderer",
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": {
        target: DEFAULT_API_BASE.replace(/\/api$/, ""),
        changeOrigin: true,
      },
    },
  },
});
