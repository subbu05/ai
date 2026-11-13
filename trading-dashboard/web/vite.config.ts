import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // The API only accepts requests whose Origin matches its own host, so present the
      // dev page's requests as coming from the API's origin.
      "/api": { target: api, changeOrigin: true, configure: (p) => p.on("proxyReq", (r) => r.setHeader("origin", api)) },
      "/ws": { target: api.replace("http", "ws"), ws: true, changeOrigin: true,
        configure: (p) => p.on("proxyReqWs", (r) => r.setHeader("origin", api)) },
    },
  },
  build: { target: "es2022", sourcemap: false },
});
