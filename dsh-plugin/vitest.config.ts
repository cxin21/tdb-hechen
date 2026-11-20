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
    // Round26：把插件测试的证据日志钉到临时目录，避免夹具行（s-card/s-bypass…）写进生产
    // D:/TDB/data/logs/persona-injection.jsonl，污染 stats 的 noIdentityRows 与契约日志重数。
    setupFiles: ['test/setup-env.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
