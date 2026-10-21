import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/emulator/**/*.test.ts"], testTimeout: 20_000, fileParallelism: false },
});
