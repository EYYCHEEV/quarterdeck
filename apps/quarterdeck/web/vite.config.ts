import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const browserArgs = ["--enable-precise-memory-info"];

function pinnedChrome(): string {
  const path = process.env.QD_CHROME;
  if (path === undefined || path === "") {
    throw new Error(
      "QD_CHROME is not set: point it at the pinned Chrome for Testing headless shell (see docs/operations/CI.md)",
    );
  }
  return path;
}

const browserProject = () => ({
  extends: true,
  optimizeDeps: {
    include: ["zustand", "zustand/vanilla", "vite-plus/test/browser"],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { args: browserArgs, executablePath: pinnedChrome() },
        contextOptions: { permissions: ["clipboard-write"] },
      }),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
  },
}) satisfies TestProjectInlineConfiguration;

export default defineConfig(({ mode }) => ({
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
    projects: mode === "test" ? [defineProject(browserProject())] : [],
  },
}));
