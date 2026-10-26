/**
 * #102 统一 409 分类器测试。
 *
 * 三处提取器（conflictOf / promiseConflictOf / rollbackRefusedOf）收敛到 classify409Of
 * 单一分类入口；结构化字段（网关 409 data.rollbackRefused 等）优先识别，message 文案
 * 正则仅作旧网关兼容回退——网关文案改动不再破坏前端识别（验收①）。
 *
 * 另覆盖 base.ts 信封解析 data 保留修复（#102：结构化 409 detail 不再被 request 层丢弃）。
 */
import { describe, it, expect, vi } from 'vitest';

// base.ts 依赖链里的 i18n 会在模块初始化时触 localStorage/navigator（node 测试环境没有）——
// 这里只测错误分类与信封解析纯逻辑，mock 掉 i18n 实例即可。
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

import { ApiError, parseMetaErrorEnvelope } from '@/lib/api/base';
import {
  classify409Of,
  conflictOf,
  promiseConflictOf,
  rollbackRefusedOf,
} from '@/lib/api/chat-memory';

const LEGACY_ROLLBACK_MSG =
  'auto-adopt rollback refused: slot-version-changed (current=3 != adopt-time=2) — slot changed since auto-adopt; handle manually';

function apiErr(opts: { code?: number | string; rawMessage?: string; data?: unknown; status?: number }) {
  return new ApiError(opts.status ?? 200, 'Conflict', '', {
    code: opts.code,
    requestId: 'req-test',
    rawMessage: opts.rawMessage,
    data: opts.data,
  });
}

describe('classify409Of（#102 统一 409 分类器）', () => {
  it('非 ApiError → null', () => {
    expect(classify409Of(new Error('plain'))).toBeNull();
    expect(classify409Of(null)).toBeNull();
    expect(classify409Of('rollback refused')).toBeNull();
  });

  it('结构化 data.rollbackRefused 优先识别——文案再怎么改都不破坏（验收①回归）', () => {
    const err = apiErr({
      code: 409,
      // 故意写一条与旧文案完全不同的 message（模拟网关改文案）
      rawMessage: 'auto-adopt rollback DENIED (v2 copy changed): guard failed',
      data: { rollbackRefused: { reason: 'slot-version-changed (current=3 != adopt-time=2)' } },
    });
    expect(classify409Of(err)).toEqual({
      kind: 'rollback-refused',
      reason: 'slot-version-changed (current=3 != adopt-time=2)',
    });
  });

  it('结构化 detail 缺 reason → 仍识别为 rollback-refused（reason undefined）', () => {
    expect(classify409Of(apiErr({ code: 409, data: { rollbackRefused: {} } }))).toEqual({
      kind: 'rollback-refused',
      reason: undefined,
    });
  });

  it('兼容回退：旧网关无结构化 detail，message 正则仍能提取 reason（业务码 409）', () => {
    expect(
      classify409Of(apiErr({ code: 409, rawMessage: LEGACY_ROLLBACK_MSG })),
    ).toEqual({ kind: 'rollback-refused', reason: 'slot-version-changed (current=3 != adopt-time=2)' });
  });

  it('兼容回退同时携带 HTTP status=409 与业务码 409 时仍命中（两码并存回归）', () => {
    expect(
      classify409Of(apiErr({ status: 409, code: 409, rawMessage: LEGACY_ROLLBACK_MSG })),
    ).toEqual({ kind: 'rollback-refused', reason: 'slot-version-changed (current=3 != adopt-time=2)' });
  });

  it('仅 HTTP status=409、无业务码 → null（回退路只认业务码，与旧实现一致）', () => {
    expect(classify409Of(apiErr({ status: 409, rawMessage: LEGACY_ROLLBACK_MSG }))).toBeNull();
  });

  it('回退文案缺 " — " 尾段 → 仍分类为 rollback-refused，reason undefined（与旧实现逐位一致）', () => {
    expect(
      classify409Of(apiErr({ code: 409, rawMessage: 'rollback refused: reason-1' })),
    ).toEqual({ kind: 'rollback-refused', reason: undefined });
  });

  it('业务码非 409 + 含 rollback refused 文案 → null（回退路保留旧码闸）', () => {
    expect(
      classify409Of(apiErr({ code: 422, rawMessage: 'rollback refused: x — y' })),
    ).toBeNull();
  });

  it('409 但无结构化无文案命中 → null', () => {
    expect(classify409Of(apiErr({ code: 409, rawMessage: 'some other 409' }))).toBeNull();
    expect(classify409Of(apiErr({ code: 409 }))).toBeNull();
  });

  it('data.conflict 形状完好 → conflict 分类（载荷原样）', () => {
    const conflict = { value_id: 'auto-x', label: '取证先行', weight: 0.62, state: 'active' as const };
    expect(classify409Of(apiErr({ code: 409, data: { conflict } }))).toEqual({
      kind: 'conflict',
      conflict,
    });
  });

  it('data.promiseTransition.ok=false → promise-conflict 分类（剥掉 ok）', () => {
    expect(
      classify409Of(
        apiErr({ code: 409, data: { promiseTransition: { ok: false, promiseId: 'p1', to: 'cancelled', reason: 'gone' } } }),
      ),
    ).toEqual({ kind: 'promise-conflict', conflict: { promiseId: 'p1', to: 'cancelled', reason: 'gone' } });
  });

  it('形状不符的 data → null（前向兼容）', () => {
    expect(classify409Of(apiErr({ code: 409, data: { conflict: { label: '缺 value_id' } } }))).toBeNull();
    expect(
      classify409Of(apiErr({ code: 409, data: { promiseTransition: { ok: true, promiseId: 'p', to: 'x' } } })),
    ).toBeNull();
    expect(classify409Of(apiErr({ code: 409, data: 'not-an-object' }))).toBeNull();
  });
});

describe('三处提取器收敛到分类器（#102 ③）', () => {
  it('rollbackRefusedOf：结构化与回退两路都识别（新增结构化路）', () => {
    expect(
      rollbackRefusedOf(apiErr({ code: 409, rawMessage: 'changed copy', data: { rollbackRefused: { reason: 'r1' } } })),
    ).toEqual({ reason: 'r1' });
    expect(rollbackRefusedOf(apiErr({ code: 409, rawMessage: LEGACY_ROLLBACK_MSG }))).toEqual({
      reason: 'slot-version-changed (current=3 != adopt-time=2)',
    });
    expect(rollbackRefusedOf(new Error('x'))).toBeNull();
  });

  it('conflictOf：conflict 载荷照旧；rollback 场景不误报', () => {
    const conflict = { value_id: 'v1', label: 'L' };
    expect(conflictOf(apiErr({ code: 409, data: { conflict } }))).toEqual(conflict);
    expect(conflictOf(apiErr({ code: 409, rawMessage: LEGACY_ROLLBACK_MSG }))).toBeNull();
    expect(conflictOf(null)).toBeNull();
  });

  it('promiseConflictOf：promiseTransition 载荷照旧；rollback 场景不误报', () => {
    expect(
      promiseConflictOf(apiErr({ code: 409, data: { promiseTransition: { ok: false, promiseId: 'p', to: 't' } } })),
    ).toEqual({ promiseId: 'p', to: 't' });
    expect(promiseConflictOf(apiErr({ code: 409, rawMessage: LEGACY_ROLLBACK_MSG }))).toBeNull();
  });
});

describe('parseMetaErrorEnvelope（#102 data 保留修复）', () => {
  it('信封含 data → 原样带回（结构化 409 detail 不再被丢）', () => {
    const text = JSON.stringify({
      code: 409,
      message: 'auto-adopt rollback refused: r — m',
      request_id: 'req-1',
      data: { rollbackRefused: { reason: 'r' } },
    });
    expect(parseMetaErrorEnvelope(text)).toEqual({
      code: 409,
      requestId: 'req-1',
      rawMessage: 'auto-adopt rollback refused: r — m',
      data: { rollbackRefused: { reason: 'r' } },
    });
  });

  it('信封无 data → 不产生 data 键（旧语义不变）', () => {
    const text = JSON.stringify({ code: 404, message: 'nope', request_id: 'req-2' });
    const parsed = parseMetaErrorEnvelope(text);
    expect(parsed).toEqual({ code: 404, requestId: 'req-2', rawMessage: 'nope' });
    expect('data' in parsed).toBe(false);
  });

  it('非 JSON / 缺 message → {}（旧语义不变）', () => {
    expect(parseMetaErrorEnvelope('oops')).toEqual({});
    expect(parseMetaErrorEnvelope(JSON.stringify({ code: 500 }))).toEqual({});
  });
});
