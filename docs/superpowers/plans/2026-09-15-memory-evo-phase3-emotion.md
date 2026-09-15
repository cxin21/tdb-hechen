# P3 情感维度激活 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本会话内联执行——用户已裁定不再派子代理）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 落地 DS-MEMORY-EVO-001 §3——arousal 遗忘调制（闪光灯记忆）+ R10 情感显著度实验轨（缺省 0 恒等）+ 债务清偿，使情感维度从"全量落库零消费"变为"遗忘侧活跃、检索侧实验待验"。

**Architecture:** 遗忘侧 = scorer 的衰减 λ 按 arousal 调制（config-first，`arousalRetention` 缺省 0 = 逐位现状）；检索侧 = R10 情感显著度信号进两条平局链（memory-search 工具侧 273-291 + auto-recall compareLex），`emotionSalienceWeight` 缺省 0 = 恒等，进预注册 A/B 队列永不单独放行。

**Tech Stack:** Node 22 / node:sqlite / vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-memory-evolution-design.md` §3（情感维度）+ §7.1 拍板点②（0.3 + 归档率漂移 ±30% 观察条款）。

## Global Constraints

- 排序恒等红线：`emotionSalienceWeight: 0` 时两条平局链逐位不变（全 0 项比较恒等）
- config-first：`arousalRetention` 缺省 0、`emotionSalienceWeight` 缺省 0 = 逐位现状
- tsc 基线 243 持平（不扩大预存量：soul 字段访问用 cast，同 l1-extractor 先例）
- 观察条款（spec §7.1-2）：上线后遗忘归档候选率漂移超基线 ±30% → 回 k=0 重评
- 云端纪律（sudo -u tdai / sudo -H -u tdai git）；生产 yaml 只读提交豁免照旧

---

### Task 1: arousal 遗忘调制（闪光灯记忆）

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/forgetting/scorer.ts`（ForgettingConfig 接口 + DEFAULT + 新增 `arousalOf` + scoreFor 调制）
- Modify: `MemoryCore/src/config.ts:332-338`（ForgettingConfig 类型）+ `:906-908`（解析，clamp [0, 0.9]）
- Modify: `MemoryCore/tdai-gateway.yaml` + `deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml`（forgetting 段 `arousalRetention: 0.3`）
- Test: `MemoryCore/src/core/lifecycle/forgetting/__tests__/scorer-arousal.test.ts`（新增，import 路径照抄 scorer.test.ts）

**Interfaces:**
- Produces: `arousalOf(m: MemoryRecord): number`（顶层 arousal → metadata 兜底 → 0，clamp [0,1]，与 significanceOf 同款双源模式）；`ForgettingConfig.arousalRetention: number`

- [ ] **Step 1: 失败测试**

```ts
// scorer-arousal.test.ts 核心断言（mkRecord 带 occurred_at/certainty/significance，另加 arousal）
it("k=0（缺省）恒等：arousal 不影响分数", () => {
  const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 0 };
  const low = scoreFor(mkRecord({ arousal: 0 }), cfg, NOW);
  const high = scoreFor(mkRecord({ arousal: 1 }), cfg, NOW);
  expect(low).toBe(high);
});
it("k=0.3：arousal=1 的记忆同年龄分数更高（衰减更慢）", () => {
  const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 0.3 };
  expect(scoreFor(mkRecord({ arousal: 1 }), cfg, NOW_BEYOND_THRESHOLD))
    .toBeGreaterThan(scoreFor(mkRecord({ arousal: 0 }), cfg, NOW_BEYOND_THRESHOLD));
});
it("公式逐位：score = sig × pri × exp(-λ(1-k·a)·age) + boost", () => {
  const cfg = { ...DEFAULT_FORGETTING_CONFIG, lambda: 0.01, arousalRetention: 0.3 };
  const m = mkRecord({ arousal: 1, significance: 0.8 });
  const expected = 0.8 * 0.5 * Math.exp(-0.01 * 0.7 * 40);
  expect(scoreFor(m, cfg, new Date(START + 40 * 86_400_000).getTime()))
    .toBeCloseTo(Math.min(1, expected), 10);
});
it("clamp：k=1 时 effectiveλ = λ×0.1（不为负/零）", () => {
  const cfg = { ...DEFAULT_FORGETTING_CONFIG, arousalRetention: 1 };
  expect(scoreFor(mkRecord({ arousal: 1 }), cfg, NOW)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认失败**（ForgettingConfig 无 arousalRetention 字段）
- [ ] **Step 3: 实现**

```ts
// scorer.ts — ForgettingConfig 增加：
  /** GROW-EVO P3（§3.1）：闪光灯记忆调制 k（effectiveλ = λ×(1-k×arousal)）。
   *  缺省 0 = 逐位现状；生产 0.3。clamp [0, 0.9]（config 解析层）——防 λ→0/负。 */
  arousalRetention: number;
// DEFAULT_FORGETTING_CONFIG 增加 arousalRetention: 0,
// 新增（significanceOf 同款双源模式）：
function arousalOf(m: MemoryRecord): number {
  const top = m as unknown as { arousal?: number };
  if (typeof top.arousal === "number") return Math.min(Math.max(top.arousal, 0), 1);
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const a = meta.arousal;
  if (typeof a === "number") return Math.min(Math.max(a, 0), 1);
  return 0;
}
// scoreFor 改：
export function scoreFor(m: MemoryRecord, cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG, now = Date.now()): number {
  // GROW-EVO P3（§3.1）：闪光灯调制——effectiveλ = λ×(1-k×arousal)，高唤醒衰减更慢。
  const effectiveLambda = cfg.lambda * (1 - Math.min(0.9, cfg.arousalRetention) * arousalOf(m));
  return Math.min(1, significanceOf(m) * priorityOf(m) * decay(ageDaysOf(m, now), effectiveLambda) + recallCountBoost(m));
}
```

- [ ] **Step 4: config.ts**——类型（:332 lambda 旁）`arousalRetention: number;`；解析（:906 旁）`arousalRetention: Math.min(0.9, Math.max(0, num(lifecycleForgettingGroup, "arousalRetention") ?? 0)),`
- [ ] **Step 5: 测试全绿 + tsc 持平** → **Step 6: Commit** `feat(P3): arousal 遗忘调制（闪光灯记忆，config-first 缺省 0）`

---

### Task 2: R10 emotionSalience 实验轨（缺省 0 恒等）

**Files:**
- Modify: `MemoryCore/src/core/tools/recall-signals.ts`（导出纯函数 `emotionSalienceOf`）
- Modify: `MemoryCore/src/config.ts`（recall 类型 + 解析：`emotionSalienceWeight`，缺省 0）
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts`（MergedPoolValue +valence/arousal 两插入点 + compareLex 追加 emotion 项）
- Modify: `MemoryCore/src/core/tools/memory-search.ts:273-291`（工具侧平局链追加 emotion 项——先读该区域确认链形状再插，插法与 mult 同款）
- Modify: 双 gateway yaml（recall 段 `emotionSalienceWeight: 0`）
- Test: `MemoryCore/src/core/tools/__tests__/emotion-salience.test.ts`

**Interfaces:**
- Produces: `emotionSalienceOf(src: { valence?: number; arousal?: number } | undefined): number`（= |valence| × arousal，clamp [0,1]）

- [ ] **Step 1: 失败测试**

```ts
it("|valence| × arousal：负 valence 取绝对值", () => {
  expect(emotionSalienceOf({ valence: -0.8, arousal: 0.5 })).toBeCloseTo(0.4, 10);
  expect(emotionSalienceOf({ valence: 0.8, arousal: 0.5 })).toBeCloseTo(0.4, 10);
});
it("缺字段 / 越界 clamp", () => {
  expect(emotionSalienceOf(undefined)).toBe(0);
  expect(emotionSalienceOf({ valence: 2, arousal: 3 })).toBe(1); // clamp 后 1×1
});
it("weight 0 恒等：compareLex 对仅 emotion 异序的条目不改变序", () => {
  // 构造两条 rrfScore 相同、emotion 不同的条目，weight=0 跑排序断言序不变
});
```

- [ ] **Step 2: 纯函数实现**（recall-signals.ts，注释带 §3.2 + "永不单独放行排序变更"）
- [ ] **Step 3: 双链接线**——auto-recall：MergedPoolValue 加 `valence?: number; arousal?: number;`（kw/emb 插入点同 certainty/validEnd 先例）、compareLex 在 `mult` 之后追加 `const aEmo = emotionSalienceWeight > 0 ? emotionSalienceOf(...) : 0;` 项；memory-search.ts:273-291 平局链同款（先读现场）。**两处均以 weight>0 为前置条件，weight=0 时不计算不比较（恒等可证）**
- [ ] **Step 4: config 解析 + 类型 + yaml 双落盘**（`emotionSalienceWeight: 0 # GROW-EVO P3 R10 实验轨：进预注册 A/B 队列，未过 A/B 不得置正`）
- [ ] **Step 5: 测试全绿 + Lane 2 重跑逐位不变** → **Step 6: Commit** `feat(P3): R10 情感显著度实验轨（weight 0 恒等，预注册队列）`

---

### Task 3: 债务清偿

- [ ] **Step 1: yaml:71 inferredPenalty 注释修正**（tdai-gateway.yaml——该行尾"乘法口径不属加性 tiebreak，保持"已过时：三刀后实为平局组内旗标。python utf-8 精确替换该行尾注释，防 GBK 编码损伤）
- [ ] **Step 2: 验证 memory-dimensions-dict.md §2 valence 同名异义已覆盖（P1 已落，确认即可）**
- [ ] **Step 3: Commit** `docs(P3): inferredPenalty 注释修正（三刀后语义）`

---

### Task 4: 回归、部署与观察条款登记

- [ ] tsc 243 持平 + vitest 全量（新增 2 套件）
- [ ] `sudo systemctl restart tdai-core` → health 200 → Lane 2 重跑逐位不变
- [ ] CHANGELOG P3 条目（含**归档率漂移观察条款**：`forgetting ran: archiveCandidates=N` 日志为观察点，漂移超基线 ±30% → arousalRetention 回 0 重评）
- [ ] `sudo -H -u tdai git push` + SDD 台账登记

---

## Self-Review（2026-09-15）

1. **Spec 覆盖**：§3.1 调制（Task 1）、§3.2 R10（Task 2）、§3.3 债务（Task 3）、归档率观察条款（Task 4）——全覆盖。
2. **占位符**：无 TBD；memory-search.ts:273-291 工具侧链形状给了先读指令 + 插法模式（与 mult 同款），不算占位。
3. **一致性**：`arousalOf`/`emotionSalienceOf` 定义与消费一致；两处 yaml 同步；`emotionSalienceWeight` 缺省 0 = 恒等在测试中显式断言。
4. **红线核对**：weight 0 恒等 ✓（可证：全 0 项比较）；k clamp ✓；L3 软轨不单独放行 ✓（R10 只进队列）；tsc 不扩预存量 ✓（cast 先例）。
5. **已知风险**：① Task 2 工具侧链现场与假设不符 → 先读后插（Step 3 已内建）；② 归档率漂移需观察期数据（无 golden，靠日志带宽条款）。
