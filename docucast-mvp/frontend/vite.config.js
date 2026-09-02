import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Allow proxied preview hosts (e2b/codespaces/tunnels)
    allowedHosts: true,
    // The browser talks to the frontend origin only; /api is proxied to the
    // backend so previews / tunnels work without exposing localhost URLs.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
