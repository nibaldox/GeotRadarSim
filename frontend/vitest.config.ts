/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Las pruebas de propiedad del optimizador y de paridad tardan entre 3 y 5 s en los runners de GitHub.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
