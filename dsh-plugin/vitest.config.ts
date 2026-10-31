import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Host-provided peer (ships with the DSH profile, not with this repo):
      // unit tests resolve it to a structural stub so importing src/index.ts
      // does not require a profile install. See test/fixtures/schemastery.stub.ts.
      '@deepseek-ai/schemastery': fileURLToPath(
        new URL('./test/fixtures/schemastery.stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
