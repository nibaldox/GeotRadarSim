import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['bench/**/*.test.ts'], testTimeout: 300000 } });
