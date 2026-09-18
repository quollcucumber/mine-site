import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  resolve: {
    alias: {
      "randomx.js": path.resolve("node_modules/randomx.js/dist/web/index.js")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "es"
      }
    }
  },
  worker: {
    format: "es"
  }
});
