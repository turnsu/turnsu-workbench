import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { featureStylePlugin } from "./build/feature-style-plugin.mjs";

export default defineConfig({
  base: process.env.LOOP_WORKBENCH_OFFLINE_BUILD === "1" ? "./" : "/",
  build: {
    manifest: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    proxy: {
      "/api/workbench/v1": {
        target: "http://127.0.0.1:8798",
        changeOrigin: false,
        headers: {
          "Sec-Fetch-Site": "same-origin",
        },
      },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [featureStylePlugin(), react()],
});
