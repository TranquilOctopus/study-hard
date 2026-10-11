import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the built site works from any folder or static host.
  base: "./",
  build: { target: "es2022" },
  test: { environment: "node" },
});
