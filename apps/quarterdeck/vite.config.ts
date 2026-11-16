import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const unitProject = {
  extends: true,
  test: {
    name: "unit",
    include: [
      "packages/*/src/**/*.test.ts",
      "standin/src/**/*.test.ts",
      "tools/**/*.test.mjs",
    ],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
  root: import.meta.dirname,
  lint: {
    options: {
      denyWarnings: true,
    },
  },
  test: {
    projects: [defineProject(unitProject)],
  },
});
