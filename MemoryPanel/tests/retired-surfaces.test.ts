/**
 * DSH 特化 Wave 2A：退役面的「不许复活」守卫。
 *
 * 背景：唯一接入方变成 DSH 插件后，面板删掉了三条「多 agent 编排 / 多 provider 中转」路由：
 *   - `POST /api/v1/task/list-with-agents`   （原 routes/task.ts，任务工作台）
 *   - `POST /api/v1/agent/delete-cascade`    （原 routes/agent-lifecycle.ts）
 *   - `GET|PUT|DELETE /api/v1/llm-providers` （原 routes/llm-providers.ts，→ MemoryProxy 8096）
 *   - `POST /api/v1/settings/proxy-pricing/*`（原 settings.ts 分支，→ MemoryProxy 8096）
 *
 * 本用例用**真实的 buildPanelApp 组装**（不是单路由挂载）断言这四条路由已不再注册，
 * 因此谁把它们接回 app.ts 或换个文件名复活，都会先红。
 *
 * 之所以新写这一个文件而不是留着原测试：被删的 task-source-type.test.ts 守的是
 * `task/list-with-agents` 响应里 source_type 的归一逻辑，路由整体退役后该断言已无对象；
 * 它原本防的「面板偷偷保留 task 面」由本文件以 404 形式继续守。
 */
import { describe, it, expect } from 'vitest';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { buildPanelApp } from '../src/panel/http/app.js';

function makeDeps(): PanelDeps {
  return {
    config: {
      server: { port: 8123, host: '127.0.0.1' },
      // 静态目录指向仓内已存在的目录：buildPanelApp 末尾挂了 `app.use('/*', serveStatic(...))`，
      // 指向不存在的 dist 会让任何未命中请求在静态层抛 ENOENT 而被 onError 包成 500，
      // 掩盖本用例要断言的 404。真实部署里 dist 是构建产物，不存在这个前提。
      ui: { distDir: '.' },
      knowledge: { baseUrl: 'http://ks-test:1', authToken: 'ks-tok', timeoutMs: 1000 },
      metadataRemoteTimeoutMs: 1000,
      agentTemplateDir: './data/agent-templates',
    },
    // requestLogger 中间件会调 logger.child()，stub 必须自洽，否则所有请求都 500。
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    instanceRegistry: {
      resolve: () => ({
        instance_id: 'inst-1',
        gateway_endpoint: 'http://core-test:2',
        api_key: 'core-key',
      }),
      listPublic: () => [],
    },
    metaKernel: { invoke: async () => ({ code: 0, message: 'ok', request_id: 'r', data: null }) },
    skillKernel: { invoke: async () => ({ code: 0, message: 'ok', request_id: 'r', data: null }) },
    knowledgeClientFactory: () => ({}) as never,
    knowledgeTaskRegistry: { get() {}, set() {}, delete() {} } as never,
    ingestProgressStore: { get() {}, set() {} } as never,
  } as unknown as PanelDeps;
}

function app() {
  // rateLimit:false —— 本用例只关心「路由是否存在」，不关心限速。
  return buildPanelApp(makeDeps(), { rateLimit: false });
}

describe('DSH 特化 Wave 2A：退役路由不再注册（404 守卫）', () => {
  it('POST /api/v1/task/list-with-agents → 404（任务工作台已随 WorkbenchPage 退役）', async () => {
    const res = await app().request('/api/v1/task/list-with-agents', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/agent/delete-cascade → 404（改走 meta/agent/archive + 前端逐条 skill/delete）', async () => {
    const res = await app().request('/api/v1/agent/delete-cascade', {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'agt_1' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/llm-providers → 404（多 provider 自服务面已退役，不再指向 MemoryProxy）', async () => {
    const res = await app().request('/api/v1/llm-providers?scope=me', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/settings/proxy-pricing/get → 404（Proxy 计费面已随 MemoryProxy 退役）', async () => {
    const res = await app().request('/api/v1/settings/proxy-pricing/get', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('保留面仍在：POST /api/v1/agent-overview/bootstrap 不是 404（观测面未被连带删除）', async () => {
    const res = await app().request('/api/v1/agent-overview/bootstrap', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).not.toBe(404);
  });
});