/**
 * useChatMemory 的 refreshNonce 回归测试（#124-B2）。
 *
 * 票面 bug：handleRefresh 只 setRefreshNonce，但列表/层计数两条 effect 用
 * fetchKeyRef 去重（key = team|tab|agent），参数没变时刷新等于没刷新。
 * 本测试锁三件事：
 *   1. handleRefresh 后列表请求被真正重发（即使筛选参数没变）；
 *   2. 选中块的 layerCounts 被清空 → 四层计数请求被重新触发（否则徽章永远显示旧数字）；
 *   3. 刷新不丢选中（selectedId 保留）。
 *
 * 环境说明：本仓 vitest 是 node 环境且没有 DOM 实现，这里用
 * tests/helpers/hook-runtime.ts 的极小 hooks 运行时替代 react 渲染器；
 * hook 的业务依赖（services / teamApi / constants / memory-utils）全部 vi.mock，
 * 这样测的是 hook 自身逻辑，不牵连 i18n 的浏览器全局依赖。
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createHookRenderer } from './helpers/hook-runtime';

// 见 use-resizable-restore.test.ts 顶部说明：react 只能按 web 侧真实解析路径 doMock。
const webRequire = createRequire(fileURLToPath(new URL('../web/package.json', import.meta.url)));

const h = vi.hoisted(() => ({
  agentFixed: vi.fn(),
  teamAssets: vi.fn(),
  layer: vi.fn(),
  notifyError: vi.fn(),
}));

const STABLE = vi.hoisted(() => ({
  teamAgents: [{ agent_id: 'a1', name: 'A1', owner_user_id: 'u1' }],
  activeTeam: { id: 't1', name: 'Team 1' },
  scopeLabels: { fixed: 'Agent 资产', team: '团队资产' },
  auth: { user_id: 'u1' },
  t: (key: string) => key,
}));

// web 侧依赖一律按「真实解析出的绝对路径」doMock：vi.mock('@/...') 与 vi.mock('react-i18next')
// 的键和 Vite 解析出的模块 id 对不上（见 use-resizable-restore.test.ts 顶部说明）。
const webSrc = (rel: string) =>
  fileURLToPath(new URL(`../web/src/${rel}`, import.meta.url)).replace(/\\/g, '/');

// react-i18next 的 require 入口是 dist/commonjs，而 Vite 走 dist/es，所以不能 webRequire.resolve，
// 必须按 ESM 入口的真实路径（pnpm realpath）mock。
const reactI18nextEsm = realpathSync(
  fileURLToPath(new URL('../web/node_modules/react-i18next/dist/es/index.js', import.meta.url)),
).replace(/\\/g, '/');

function mockWebDeps() {
  vi.doMock(reactI18nextEsm, () => ({
    useTranslation: () => ({ t: STABLE.t }),
  }));
  vi.doMock(webSrc('services/index.ts'), () => ({
    useTeams: () => ({ activeTeamId: 't1', activeTeam: STABLE.activeTeam }),
    useAgents: () => ({ agents: STABLE.teamAgents }),
  }));
  vi.doMock(webSrc('components/LoginGate.tsx'), () => ({ readAuth: () => STABLE.auth }));
  vi.doMock(webSrc('lib/tea-bridge.ts'), () => ({
    tea: { notify: { error: h.notifyError, success: vi.fn(), warning: vi.fn() } },
    confirmThenRun: vi.fn(),
  }));
  vi.doMock(webSrc('lib/teamApi.ts'), () => ({
    chatMemoryApi: {
      agentFixed: h.agentFixed,
      teamAssets: h.teamAssets,
      layer: h.layer,
      import: vi.fn(),
      unbind: vi.fn(),
      patchScope: vi.fn(),
      updateLayer: vi.fn(),
      searchLayer: vi.fn(),
    },
  }));
  vi.doMock(webSrc('pages/ChatMemoryPage/constants/constants.ts'), () => ({
    useScopeTabLabels: () => STABLE.scopeLabels,
  }));
  vi.doMock(webSrc('pages/ChatMemoryPage/utils/memory-utils.ts'), () => ({
    // 与 web/src/pages/ChatMemoryPage/utils/memory-utils.ts 的语义一致：只保留 >0 的真实计数
    buildInitialLayerCounts: (counts?: Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(counts ?? {})) if (typeof v === 'number' && v > 0) out[k] = v;
      return out;
    },
    defaultTimeRange: () => ({ start: '2026-10-30T00:00:00.000Z', end: '2026-10-31T00:00:00.000Z' }),
    isRangeTooLargeError: () => false,
    layerPageSize: () => 20,
    mapLayerItem: (item: unknown) => item,
  }));
  vi.doMock(webSrc('pages/ChatMemoryPage/utils/utils.ts'), () => ({
    getLayerCount: (block: any, layer: string) =>
      block.layerCounts[layer] ?? (block.layers[layer]?.length ?? 0),
  }));
}

const LAYER_TOTALS: Record<string, number> = { L0: 7, L1: 8, L2: 9, L3: 10 };

const BLOCK_FIXTURE = {
  id: 'b1',
  title: 'chat_memory-t1-a1',
  summary: '',
  updated_at_ms: 1_760_000_000_000,
  agent_id: 'a1',
  uploaded_by_user_id: 'u1',
  scope: 'team' as const,
  layer_counts: {} as Record<string, number>,
  bound_agent_count: 1,
};

let useChatMemory: typeof import('../web/src/pages/ChatMemoryPage/hooks/useChatMemory').useChatMemory;

beforeAll(async () => {
  mockWebDeps();
  vi.doMock(webRequire.resolve('react'), async () =>
    (await import('./helpers/hook-runtime')).fakeReactHooks,
  );
  ({ useChatMemory } = await import('../web/src/pages/ChatMemoryPage/hooks/useChatMemory'));
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 只挑「层计数」调用（limit=1, offset=0），排除详情加载（limit=pageSize） */
const countLayerCalls = () =>
  h.layer.mock.calls
    .filter((c) => c[2] === 1 && c[3] === 0)
    .map((c) => c[1])
    .sort();

function mount() {
  return createHookRenderer(() => useChatMemory({ activeTeamId: 't1' }));
}

beforeEach(() => {
  h.agentFixed.mockReset().mockResolvedValue({ items: [BLOCK_FIXTURE], total: 1 });
  h.teamAssets.mockReset().mockResolvedValue({ items: [], total: 0 });
  h.layer.mockReset().mockImplementation((_id: string, layer: string) =>
    Promise.resolve({ layer, items: [], total: LAYER_TOTALS[layer] }),
  );
  h.notifyError.mockReset();
});

describe('useChatMemory refreshNonce', () => {
  it('首屏只请求一次；参数不变时 rerender 不重复请求（key 去重仍在）', async () => {
    const r = mount();
    await tick();
    expect(h.agentFixed).toHaveBeenCalledTimes(1);
    r.rerender();
    await tick();
    expect(h.agentFixed).toHaveBeenCalledTimes(1);
  });

  it('handleRefresh 绕过去重，真正重发列表请求并递增 refreshNonce', async () => {
    const r = mount();
    await tick();
    expect(h.agentFixed).toHaveBeenCalledTimes(1);
    expect(r.current.refreshNonce).toBe(0);
    r.current.handleRefresh();
    await tick();
    expect(h.agentFixed).toHaveBeenCalledTimes(2);
    expect(r.current.refreshNonce).toBe(1);
    // 连续刷新每次都生效（不是只放行一次）
    r.current.handleRefresh();
    await tick();
    expect(h.agentFixed).toHaveBeenCalledTimes(3);
    expect(r.current.refreshNonce).toBe(2);
  });

  it('handleRefresh 静默重拉：保留选中与已验证的层计数，不再发废计数请求', async () => {
    const r = mount();
    await tick();
    r.current.setSelectedId('b1');
    await tick();
    // 选中块后并行拉四层「计数」（limit=1）——effect 的详情加载也会打一次 layer，
    // 所以只统计计数调用（limit=1, offset=0）。这一轮是唯一一轮。
    expect(countLayerCalls()).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(r.current.selected?.layerCounts).toEqual({ L0: 7, L1: 8, L2: 9, L3: 10 });

    h.layer.mockClear();
    h.agentFixed.mockClear();
    r.current.handleRefresh();
    // 同步快照：静默刷新不清列表、不清 layerCounts、不清选中
    expect(r.current.blocks.map((b: any) => b.id)).toEqual(['b1']);
    expect(r.current.selectedId).toBe('b1');
    expect(r.current.selected?.layerCounts).toEqual({ L0: 7, L1: 8, L2: 9, L3: 10 });
    await tick();
    // 列表只重拉一次；计数 effect 因 refreshNonce 重跑但四层都已有真实计数 → 一次都不发
    expect(h.agentFixed).toHaveBeenCalledTimes(1);
    expect(countLayerCalls()).toEqual([]);
    // 当前层详情仍会重拉一次（limit=pageSize），这是刷新该看到的更新
    expect(h.layer.mock.calls.some((c) => c[2] === 20 && c[3] === 0)).toBe(true);
    expect(r.current.selectedId).toBe('b1');
    expect(r.current.selected?.layerCounts).toEqual({ L0: 7, L1: 8, L2: 9, L3: 10 });
  });

  it('handleRefresh 后选中块若真被删除，回落到无选中', async () => {
    const r = mount();
    await tick();
    r.current.setSelectedId('b1');
    await tick();
    expect(r.current.selectedId).toBe('b1');

    h.agentFixed.mockResolvedValue({ items: [], total: 0 });
    r.current.handleRefresh();
    await tick();
    expect(r.current.blocks).toEqual([]);
    expect(r.current.selectedId).toBeNull();
    expect(r.current.selected).toBeNull();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('没有选中块时刷新不清 blocks、不抛异常', async () => {
    const r = mount();
    await tick();
    expect(r.current.selected).toBeNull();
    r.current.handleRefresh();
    await tick();
    expect(r.current.blocks.map((b: any) => b.id)).toEqual(['b1']);
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});