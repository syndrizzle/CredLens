import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
    // Only the app needs watching; docs, captures, agent tooling and the backend virtualenv exhaust inotify (EMFILE).
    watch: {
      ignored: [
        "backend",
        "docs",
        "dist",
        "tests",
        ".agents",
        ".devin",
        ".claude",
        ".cursor",
        ".github",
        ".ui-review",
      ].map((dir) => `**/${dir}/**`),
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
