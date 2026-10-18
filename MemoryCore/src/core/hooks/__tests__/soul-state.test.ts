/**
 * #34（S13/R5，2026-10-16）：当下性 state 通道测试。
 *
 * 合同（r5-34）：
 * 1. state 更新**不改变 soulVersion 指纹**（指纹=slots+values+moodTier；state 混入
 *    指纹=每轮前缀缓存全失效——R5 修正 2，显式验收断言）；
 * 2. state 段位于尾块（soul-feeling，依赖 #37 分层接口——接口已落地）；呈现层翻修
 *    （2026-10-17 用户 m00227 终审，R2 调研 arXiv:2601.16087）：状态行=第一人称叙事
 *    散文（valencePhrase/arousalPhrase 分档词表），数值留代码层防伪造；首要锚折叠进
 *    「眼下最想推进的是X」子句；清单行（驱动/审慎）退役；段内仅基调+状态两行，
 *    双缺省整段省略（宁缺毋滥）；
 * 3. 会话级 state 不落库（本票只建通道与渲染；状态机数据源归 #28，不发明第二套情绪评估）；
 * 4. 事件 taxonomy 单一源（user_correction/tool_failure/task_switch，与 #37 漂移触发共用）；
 * 5. state=undefined → 逐位现状（config-first：无 state 通道时渲染字节与现状一致）；
 * 6. state 参与 cacheKey 但不参与 sv——同 sv 下 state 变化必须重渲染出新 state 行
 *   （进程内缓存正确性，否则尾块永远是旧 state）；
 * 7. 「眼下最想推进的是X」仅由 state.topValue 显式驱动（#52 P2：dirTop 回退删除——
 *    程序性锚名不作目标语义硬造；topValue 缺省→省略子句，宁缺毋滥）。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";
import {
  SOUL_STATE_EVENT_KINDS,
  clampState,
  renderStateLine,
  type SoulState,
} from "../soul-state.js";
import type { IMemoryStore, CoreTenant } from "../../../core/store/types.js";
import type { Logger } from "../../../core/types.js";

const CT = { selfIdentityEnabled: true, budgetSelfChars: 600, budgetIdentityChars: 900 };

function row(over: Partial<Record<string, unknown>> & { value_id: string; label: string; weight: number; valence: number }): Record<string, unknown> {
  return {
    state: "active",
    node_type: "theme",
    attrs_json: JSON.stringify({ description: over.value_id === "v1" ? "第一句锚。" : "次锚描述。" }),
    ...over,
  };
}

function makeStore(rows: Record<string, unknown>[]) {
  const store = {
    readCore: vi.fn(async () => [
      { slot: "self_identity", content: "我是测试者。" },
      { slot: "identity", content: "用户是工程师。" },
    ]),
    listValues: vi.fn(async () => rows),
  } as unknown as IMemoryStore;
  return store;
}

const LOG = { warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe("#34 soul-state taxonomy 与渲染行", () => {
  it("事件 taxonomy 单一源：user_correction/tool_failure/task_switch（与 #37 漂移触发共用）", () => {
    expect(SOUL_STATE_EVENT_KINDS).toEqual(["user_correction", "tool_failure", "task_switch"]);
  });

  it("clampState：valence 夹 [-1,1]、arousal 夹 [0,1]", () => {
    expect(clampState({ valence: 2, arousal: -1 })).toEqual({ valence: 1, arousal: 0 });
    expect(clampState({ valence: -3, arousal: 5 })).toEqual({ valence: -1, arousal: 1 });
  });

  it("renderStateLine：null/undefined → 空串（逐位现状）", () => {
    expect(renderStateLine(null)).toBe("");
    expect(renderStateLine(undefined)).toBe("");
  });

  it("renderStateLine：叙事化定性短语（防伪=数值留代码层；分档词表 valencePhrase/arousalPhrase 单一源）", () => {
    const line = renderStateLine({ valence: -0.4, arousal: 0.6, topValue: "根因" });
    // 呈现层翻修（m00227，R2 调研）：第一人称叙事散文——无「当下状态」头、零数字
    expect(line).not.toContain("当下状态");
    expect(line).not.toMatch(/-?0\.\d/);
    expect(line).toContain("有点受阻，心里偏紧"); // #52 P2 去 taxonomy 黑话
    expect(line).toContain("整个人紧绷而跃跃欲试");
    expect(line).toContain("眼下最想推进的是根因。");
  });
});

describe("#34 soul-assembler state 通道", () => {
  const rows = () => [
    row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 }),
    row({ value_id: "v2", label: "风险锚", weight: 0.6, valence: -1 }),
  ];

  it("state 更新不改变 soulVersion（指纹隔离，R5 修正 2），但尾块字节变化", async () => {
    const t = { teamId: "st1", userId: "u1", agentId: "a1" };
    const metaA: { soulVersion?: string } = {};
    const metaB: { soulVersion?: string } = {};
    const outA = await buildSoulPrefix(makeStore(rows()), t, LOG, { ...CT, state: { valence: -0.4, arousal: 0.6, topValue: "根因" } }, metaA);
    const outB = await buildSoulPrefix(makeStore(rows()), t, LOG, { ...CT, state: { valence: 0.8, arousal: 0.2, topValue: "根因" } }, metaB);
    expect(metaA.soulVersion).toBeTruthy();
    expect(metaA.soulVersion).toBe(metaB.soulVersion); // 指纹不含 state
    expect(outA).not.toBe(outB); // 尾块字节随 state 变化
    expect(outA).toContain("有点受阻，心里偏紧"); // #52 P2 去 taxonomy 黑话
    expect(outB).toContain("心里明亮，劲头正足");
  });

  it("state=undefined → 无状态行；无 moodTier 时感受段整段省略（m00227：段内仅基调+状态两行）", async () => {
    const out = await buildSoulPrefix(makeStore(rows()), { teamId: "st2", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    expect(out).not.toContain("当下状态");
    expect(out).not.toContain("<soul-feeling>"); // 清单行退役+无基调无状态 → 宁缺毋滥整段省略
  });

  it("同 sv 下 state 变化必须重渲染（state 入 cacheKey 不入 sv）", async () => {
    const store = makeStore(rows());
    const t = { teamId: "st3", userId: "u1", agentId: "a1" };
    const metaA: { soulVersion?: string } = {};
    const outA = await buildSoulPrefix(store, t, LOG, { ...CT, state: { valence: -0.4, arousal: 0.6, topValue: "根因" } }, metaA);
    const metaB: { soulVersion?: string } = {};
    const outB = await buildSoulPrefix(store, t, LOG, { ...CT, state: { valence: 0.8, arousal: 0.2, topValue: "根因" } }, metaB);
    expect(metaA.soulVersion).toBe(metaB.soulVersion);
    expect(outB).toContain("心里明亮，劲头正足"); // 缓存未吞掉新 state
    expect(outA).toContain("有点受阻，心里偏紧");
  });

  it("#52 P2：topValue 缺省→不回退不硬造（dirTop 已删——权重最高锚名非目标语义）；显式 topValue→子句在位", async () => {
    // topValue 缺省（即使「根因」锚在位）→ 省略推进子句，不回退 dirTop
    const out1 = await buildSoulPrefix(makeStore(rows()), { teamId: "st4", userId: "u1", agentId: "a1" }, LOG, { ...CT, state: { valence: -0.4, arousal: 0.6 } });
    expect(out1).toContain("此刻");
    expect(out1).not.toContain("眼下最想推进的是");
    // 显式 topValue（状态机写入通道）→ 子句照常渲染
    const out3 = await buildSoulPrefix(makeStore(rows()), { teamId: "st6", userId: "u1", agentId: "a1" }, LOG, { ...CT, state: { valence: -0.4, arousal: 0.6, topValue: "根因" } });
    expect(out3).toContain("眼下最想推进的是根因。");
    // 无任何锚 → state 行仍在但无推进子句（m00227：无「当下状态」头，「此刻」起句）
    const out2 = await buildSoulPrefix(makeStore([]), { teamId: "st5", userId: "u1", agentId: "a1" }, LOG, { ...CT, state: { valence: -0.4, arousal: 0.6 } });
    expect(out2).toContain("此刻");
    expect(out2).not.toContain("眼下最想推进");
  });
});

describe("#34 SoulState 形状", () => {
  it("state 接口字段（会话级，不落库）", () => {
    const s: SoulState = { valence: 0.1, arousal: 0.3, topValue: "定案", turnSeq: 7 };
    expect(s.topValue).toBe("定案");
    expect(s.turnSeq).toBe(7);
  });
});
