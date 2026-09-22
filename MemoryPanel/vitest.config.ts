import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// F-T4-1 测试基建（2026-09-22）：web 源码内的 `@/` 别名在根 vitest（node 环境，
// 走 tests/**/*.test.ts）默认不解析——跨包直测 memory-utils 等纯函数需要它。
// 仅影响测试解析，不影响 web/ 自身构建（web 侧 tsconfig 别名不动）。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
});
