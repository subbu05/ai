import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/ws": { target: api.replace("http", "ws"), ws: true, changeOrigin: true },
    },
  },
  build: { target: "es2022", sourcemap: false },
});
