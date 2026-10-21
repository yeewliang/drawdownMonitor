import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Emulator tests run via `npm run test:rules`.
    exclude: ["**/node_modules/**", "test/emulator/**"],
  },
});
