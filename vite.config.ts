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
    proxy: {
      "/api": {
        target: DEFAULT_API_BASE.replace(/\/api$/, ""),
        changeOrigin: true,
      },
    },
  },
});
