import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(root, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: false,
  },
  server: { port: 5200, strictPort: true },
});
