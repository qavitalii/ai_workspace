import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runtime workspaces and provider caches can contain unrelated test files.
    include: ["tests/**/*.test.ts"],
  },
});
