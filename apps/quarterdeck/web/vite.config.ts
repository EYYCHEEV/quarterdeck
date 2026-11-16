import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const browserProject = {
  extends: true,
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react({ compiler: true }), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    manifest: false,
    assetsInlineLimit: 0,
  },
  test: {
    projects: [defineProject(browserProject)],
  },
});
