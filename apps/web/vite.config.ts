import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In production Firebase Hosting rewrites /api/** to the Cloud Run API,
    // so the app always calls same-origin /api.
    proxy: { "/api": "http://localhost:8080" },
  },
});
