import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { UNIFI_SPEC_DIR: fileURLToPath(new URL('test/.specs', import.meta.url)) },
    include: ['test/**/*.spec.ts'],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/index.ts'], thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } },
  },
});
