import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { env: { GCLOUD_PROJECT: "demo-drawdown" }, include: ["test/emulator/**/*.test.ts"], testTimeout: 20_000, fileParallelism: false },
});
