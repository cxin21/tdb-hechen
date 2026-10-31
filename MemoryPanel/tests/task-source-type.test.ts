/**
 * #127：TaskSourceType 收窄的回归测试。
 *
 * 票面（#127）：上游把来源枚举从 `manual|github|tapd|other` 收窄为
 * `manual|external|other`，具体提供方改读 metadata_json.external.provider；
 * 本仓 MemoryPanel 曾有 3 份分叉定义 + backendStore.ts:253 唯一字面值分支
 * （`bt.source_type === 'tapd' ? 'tapd' : 'manual'`），会把 external 折叠成 manual。
 *
 * 本测试锁三件事：
 *   1. canonical 三值（manual | external | other）在 normalize 里原样通过；
 *   2. 历史值 tapd / github / jira 归一成 external（不再折叠成 manual）；
 *   3. adaptTask 端到端不再折叠 external —— 这是票面点名的 bug。
 *
 * 环境说明：web/src 是浏览器代码（i18n 模块顶层读 localStorage/navigator），
 * 这里先用 vi.stubGlobal 铺最小桩，再动态 import，避免 node 环境直接 import 抛错。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

interface BackendTaskLike {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string;
  source_type: string;
  source_url?: string;
  status: 'running' | 'completed';
  auto_assign_floating_assets: number;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

let normalizeTaskSourceType: (raw: unknown) => string;
let adaptTask: (bt: BackendTaskLike, linkedAgents: string[]) => { source_type: string; title: string };

beforeAll(async () => {
  // 最小浏览器桩：i18n/index.ts 顶层会读 localStorage + navigator.language，
  // stores/backend.ts 顶层会建 zustand store（不触 DOM，只要 window 存在即可）。
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal('navigator', {
    language: 'zh-CN',
    // popper.js（tea-component 的传递依赖）顶层读 navigator.userAgent.indexOf(...)
    userAgent: 'node',
    platform: 'node',
  });
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    localStorage: globalThis.localStorage,
  });
  vi.stubGlobal('document', {
    documentElement: { style: {}, classList: { add: () => {}, remove: () => {} } },
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  const tasksMod = await import('../web/src/lib/api/tasks');
  normalizeTaskSourceType = tasksMod.normalizeTaskSourceType as (raw: unknown) => string;

  // backendStore.ts ↔ stores/backend.ts 是既有循环依赖（backendStore 顶层 import
  // invalidateBackendCache，stores/backend 顶层又 import adaptTask）。浏览器里入口先加载
  // stores/backend，循环可解；测试里必须先把它拉起来，否则 backendStore 先初始化会让
  // stores/backend 拿到半成品（readActiveTeamId is not a function）。
  await import('../web/src/stores/backend');
  const storeMod = await import('../web/src/services/backendStore');
  adaptTask = storeMod.adaptTask as unknown as typeof adaptTask;
});

function backendTask(source_type: string): BackendTaskLike {
  return {
    task_id: 'tsk-1',
    team_id: 'tm-1',
    creator_user_id: 'u-1',
    title: '任务标题',
    description: '描述',
    source_type,
    source_url: source_type === 'external' ? 'https://tapd.example.com/1' : '',
    status: 'running',
    auto_assign_floating_assets: 0,
    created_at: '2026-10-31T00:00:00Z',
    updated_at: '2026-10-31T00:00:00Z',
    metadata_json: '{}',
  };
}

describe('#127 TaskSourceType 收窄为 manual | external | other', () => {
  it('canonical 三值原样通过（external 不再被折叠）', () => {
    expect(normalizeTaskSourceType('external')).toBe('external');
    expect(normalizeTaskSourceType('manual')).toBe('manual');
    expect(normalizeTaskSourceType('other')).toBe('other');
  });

  it('历史外部来源 tapd / github / jira 归一成 external', () => {
    expect(normalizeTaskSourceType('tapd')).toBe('external');
    expect(normalizeTaskSourceType('github')).toBe('external');
    expect(normalizeTaskSourceType('jira')).toBe('external');
  });

  it('未知 / 空值回落 manual（兜住脏数据，不产生非法枚举）', () => {
    expect(normalizeTaskSourceType(undefined)).toBe('manual');
    expect(normalizeTaskSourceType(null)).toBe('manual');
    expect(normalizeTaskSourceType('')).toBe('manual');
    expect(normalizeTaskSourceType('whatever')).toBe('manual');
    expect(normalizeTaskSourceType(42)).toBe('manual');
  });

  it('adaptTask：内核返回 external 时，前端 Task.source_type 仍是 external（票面点名的折叠 bug）', () => {
    const t = adaptTask(backendTask('external'), []);
    expect(t.source_type).toBe('external');
    expect(t.title).toBe('任务标题');
  });

  it('adaptTask：other 保留，不再被折叠成 manual', () => {
    expect(adaptTask(backendTask('other'), []).source_type).toBe('other');
  });

  it('adaptTask：历史 tapd 行读出来是 external（读写口径一致）', () => {
    expect(adaptTask(backendTask('tapd'), []).source_type).toBe('external');
  });

  it('adaptTask：manual 保持 manual（不误伤）', () => {
    expect(adaptTask(backendTask('manual'), []).source_type).toBe('manual');
  });
});
