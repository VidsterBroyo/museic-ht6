import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" so the packaged app can load the bundle from file://
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist" },
});
