import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Windows CI runners with cold filesystem caches and Defender scanning can
    // push fs-heavy integration tests past the 5s default; bound them at 15s
    // so real hangs still fail fast while slow-but-fine runs stay green.
    testTimeout: 15_000,
  }
});
