import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { fs: { allow: [".."] } },
});
