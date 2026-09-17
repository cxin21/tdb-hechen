# 灵魂 P1：双槽 + 四段渲染 + 身份区只读展示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **协作铁律①（本仓库特别约束）：禁用子代理——全部编码/测试由执行者本人完成，采用 Inline Execution（executing-plans），不走 subagent-driven。**

**Goal:** 落地 DS-SOUL-MEMORY-002 的 P1——core_memory 增加 `self_identity` 槽（agent 自我层），identity-discovery 双视角提取，soul-assembler 四段渲染+段级预算，Memory Hub 身份区只读展示；一切新行为有开关、缺省=逐位现状。

**Architecture:** config-first 加开关组（coreMemory.selfIdentity / coreMemory.soulRender）；identity-discovery 在同一 worker 内按开关切换单视角/双视角 prompt（单一源，不建第二 worker）；soul-assembler 增加 opts 参数，缺省 undefined=旧渲染字节级一致；UI 走 BFF 透传（零新端点）。数据面零 schema 变更（core_memory 复用三元组主键）。

**Tech Stack:** TypeScript + vitest（MemoryCore 内嵌测试）；React（MemoryPanel/web）；SQLite（零迁移）；LLM 提案→确定性门裁决（分级门/stripIdentityStateResidue 单一源）。

**Spec:** `docs/superpowers/specs/2026-09-17-soul-memory-design.md`（本计划从 spec 论证，执行者两份都要读）

## Global Constraints

- **config-first 铁律**：一切新行为有开关；`selfIdentity.enabled` 缺省 `false`；关闭时渲染与 LLM prompt 双双逐位现状（字节级）。
- **单一源铁律**：`stripIdentityStateResidue` / `selectSampleRows` / `escapeXmlTags` 复用既有导出，**禁止**任何第二份实现（O15/O12 事故预防）。
- **LLM 只提议，确定性门裁决**：LLM 输出只经 parseProposals → strip 门 → merge → upsertCore，永不绕过。
- **宁缺毋滥**：无材料不注入空段/空小节；解析失败保留。
- **消毒**：写入 upsertCore 前 `escapeXmlTags`（现状语义保持）。
- **验证基线**：`npx tsc --noEmit` 错误数 = 0（当前 flat）；`npx vitest run` 全绿（当前 500 tests / 52 files）。
- **git 纪律**：远端操作 `sudo -H -u tdai git`；文件放置本地编辑→`scp`→`sudo -u tdai cp`（禁 sed -i 远端文件）。
- **测试数据**：seed 一律 `ev5_` 前缀、flowtest 租户、只增不删（清理需用户显式授权）。
- **BFF 权限口径**：读 `authorizeChatMemoryRead`；Owner-only 写与本组无关（P1 只读）。
- **本计划对 spec 的两处显式精化**（防死配置/死字段，spec 精神内）：
  1. P1 配置组**不含** `minEvidence`——P1 的 self 采纳走分级门（跳过证据重算），无消费方；P2 随 GROW-MAINT 引入；
  2. `metadata.agentAct` 字段**推迟到首个消费方出现的分期**——P1 只做 gated prompt 增补（LLM 把 agent 行为事实提为 L1 正文），不落无消费方的元数据字段。

---

### Task 1: config——selfIdentity/soulRender 配置组 + allowedSlots 缺省白名单扩展

**Files:**
- Modify: `MemoryCore/src/config.ts`（MemoryCoreMemoryConfig 接口 + parseConfig 的 coreMemory 块，锚点见下）
- Test: Create `MemoryCore/src/config.selfidentity.test.ts`

**Interfaces:**
- Produces: `parseConfig(raw).coreMemory.selfIdentity: { enabled: boolean; maxPerPass: number; intervalHours: number }`（缺省 `{enabled:false, maxPerPass:2, intervalHours:24}`）；`parseConfig(raw).coreMemory.soulRender: { budgetSelfChars: number; budgetIdentityChars: number }`（缺省 `{budgetSelfChars:600, budgetIdentityChars:900}`）；`allowedSlots` 缺省数组含 `"self_identity"`。Task 2/4/6 消费这三个形状。

- [ ] **Step 1: 写失败测试**

```typescript
// MemoryCore/src/config.selfidentity.test.ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("coreMemory.selfIdentity / soulRender（P1 双槽）", () => {
  it("缺省：selfIdentity.enabled=false（config-first 逐位现状）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.selfIdentity.enabled).toBe(false);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(2);
    expect(c.coreMemory.selfIdentity.intervalHours).toBe(24);
  });

  it("缺省：soulRender 预算 600/900", () => {
    const c = parseConfig({});
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(600);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(900);
  });

  it("缺省白名单含 self_identity（信任边界扩展，写入仍由 enabled 门控）", () => {
    const c = parseConfig({});
    expect(c.coreMemory.allowedSlots).toContain("self_identity");
  });

  it("yaml 值真实生效 + clamp", () => {
    const c = parseConfig({
      coreMemory: {
        selfIdentity: { enabled: true, maxPerPass: 99, intervalHours: 0 },
        soulRender: { budgetSelfChars: 100, budgetIdentityChars: 50 },
      },
    });
    expect(c.coreMemory.selfIdentity.enabled).toBe(true);
    expect(c.coreMemory.selfIdentity.maxPerPass).toBe(10); // clamp 上界 10（宁缺毋滥）
    expect(c.coreMemory.selfIdentity.intervalHours).toBe(1); // clamp 下界 1
    expect(c.coreMemory.soulRender.budgetSelfChars).toBe(100);
    expect(c.coreMemory.soulRender.budgetIdentityChars).toBe(50);
  });

  it("显式 allowedSlots 覆盖缺省（不含 self_identity 时写入将被信任边界拒绝——合法配置）", () => {
    const c = parseConfig({ coreMemory: { allowedSlots: ["identity"] } });
    expect(c.coreMemory.allowedSlots).toEqual(["identity"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryCore && npx vitest run src/config.selfidentity.test.ts`
Expected: FAIL（`selfIdentity`/`soulRender` undefined；allowedSlots 断言失败）

- [ ] **Step 3: 实现**

3a. 类型：在 `MemoryCoreMemoryConfig` 接口（config.ts，锚点：`/** K 核心记忆写入口信任边界… */ coreMemory: MemoryCoreMemoryConfig;` 上方的接口定义块）内新增两字段声明，并在同文件类型区新增：

```typescript
export interface SelfIdentityDiscoveryConfig {
  /** P1 双槽总开关；缺省 false=逐位现状（含 LLM prompt 行为）。 */
  enabled: boolean;
  /** 单轮 self 提案采纳上限（clamp 1..10）。 */
  maxPerPass: number;
  /** 冷却小时数（与 anchorDiscovery 同门语义；clamp 1..168）。 */
  intervalHours: number;
}

export interface SoulRenderConfig {
  /** self_identity 小节字符预算（F17；超限截断，宁缺毋滥）。 */
  budgetSelfChars: number;
  /** identity 小节字符预算。 */
  budgetIdentityChars: number;
}
```

并在 `MemoryCoreMemoryConfig` 中加：

```typescript
  /** DS-SOUL-MEMORY-002 P1：agent 自我层双视角（enabled 缺省 false=逐位现状）。 */
  selfIdentity: SelfIdentityDiscoveryConfig;
  /** F17 段级注入预算（chars 为 token 粗粒度近似）。 */
  soulRender: SoulRenderConfig;
```

3b. 解析：在 parseConfig 的 coreMemory 块（锚点：`anchorDiscovery: (() => {` 之前）加同款 IIFE：

```typescript
    // DS-SOUL-MEMORY-002 P1：agent 自我层（enabled 缺省 false=逐位现状；yaml 值真实生效+clamp）。
    selfIdentity: (() => {
      const g = obj(coreMemoryGroup, "selfIdentity");
      const clamp = (key: string, dflt: number, lo: number, hi: number) => {
        const raw = num(g, key);
        if (raw === undefined || !Number.isFinite(raw)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(raw)));
      };
      return {
        enabled: bool(g, "enabled") ?? false,
        maxPerPass: clamp("maxPerPass", 2, 1, 10),
        intervalHours: clamp("intervalHours", 24, 1, 168),
      };
    })(),
    soulRender: (() => {
      const g = obj(coreMemoryGroup, "soulRender");
      const clamp = (key: string, dflt: number, lo: number, hi: number) => {
        const raw = num(g, key);
        if (raw === undefined || !Number.isFinite(raw)) return dflt;
        return Math.min(hi, Math.max(lo, Math.floor(raw)));
      };
      return {
        budgetSelfChars: clamp("budgetSelfChars", 600, 100, 2000),
        budgetIdentityChars: clamp("budgetIdentityChars", 900, 100, 2000),
      };
    })(),
```

3c. 白名单：`allowedSlots: coreMemoryAllowedSlots ?? ["identity", "core_value", "strict_rule"],` 改为：

```typescript
    // P1：+self_identity（agent 自我层）。信任边界扩展无害——实际写入仍由
    // selfIdentity.enabled 门控；显式配置 allowedSlots 时不注入（用户白名单权威）。
    allowedSlots: coreMemoryAllowedSlots ?? ["identity", "core_value", "strict_rule", "self_identity"],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/config.selfidentity.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 无新增错误

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryCore/src/config.ts MemoryCore/src/config.selfidentity.test.ts
sudo -H -u tdai git commit -m "feat(config): P1 selfIdentity/soulRender 配置组（enabled 缺省 false=逐位现状）+ allowedSlots 缺省白名单 +self_identity"
```

---

### Task 2: identity-discovery 双视角（gated prompt + self_identity 采纳路由）

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/identity-discovery.ts`（SYSTEM_PROMPT 常量区 :38-51、deps 接口 :69-75、采纳循环 :150-176）
- Modify: `MemoryCore/src/core/lifecycle/lifecycle-scheduler.ts:128-136`（传参）
- Test: Create `MemoryCore/src/core/lifecycle/identity-discovery.self.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SelfIdentityDiscoveryConfig`；既有导出 `stripIdentityStateResidue` / `selectSampleRows` / `escapeXmlTags`（单一源，禁复制）。
- Produces: `runIdentityDiscovery(deps)` 的 deps 新增可选 `selfIdentity?: { enabled: boolean; maxPerPass: number }`；fake store 需实现 `readCore/upsertCore/queryL1Records/countL1/getIdentityDiscoveryState/setIdentityDiscoveryState`（store/types.ts:736-737 可选方法签名）。

- [ ] **Step 1: 写失败测试**

```typescript
// MemoryCore/src/core/lifecycle/identity-discovery.self.test.ts
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, DISCOVERY_SYSTEM_PROMPT } from "./identity-discovery.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeFakeStore(existing: Array<{ slot: string; content: string }> = []) {
  const coreUpserts: Array<{ slot: string; content: string; createdBy: string }> = [];
  return {
    coreUpserts,
    queryL1Records: () => [
      { record_id: "r1", content: "用户把体检安排在周五，全家一起吃晚饭", significance: 0.9 },
      { record_id: "r2", content: "我在对话中承诺每周五出周报并坚持执行", significance: 0.9 },
    ],
    countL1: () => 2,
    readCore: async () => existing,
    upsertCore: (slot: string, content: string, createdBy: string) => {
      coreUpserts.push({ slot, content, createdBy });
      return true;
    },
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const LLM_DUAL = JSON.stringify([
  { slot: "identity", content: "用户是家里的首席厨师，周末为全家掌勺", rationale: "多源一致" },
  { slot: "self_identity", content: "我在这个团队负责技术评审与交付把关", rationale: "agent 侧行为可证" },
]);

describe("identity-discovery 双视角（P1）", () => {
  it("selfIdentity.enabled=false：走旧单视角 prompt（字节级），self 提案不被采纳", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(LLM_DUAL);
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: false, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(run.mock.calls[0][0].systemPrompt).toBe(DISCOVERY_SYSTEM_PROMPT);
    expect(res.adopted).toBe(1); // 仅 identity
    expect(store.coreUpserts.map((u) => u.slot)).toEqual(["identity"]);
  });

  it("enabled=true：双视角一次调用，双槽分别 merge 落库，strip 门复用", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(LLM_DUAL);
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.adopted).toBe(2);
    const bySlot = Object.fromEntries(store.coreUpserts.map((u) => [u.slot, u]));
    expect(bySlot.identity.content).toContain("首席厨师");
    expect(bySlot.self_identity.content).toMatch(/^- /m); // bulleted merge
    expect(bySlot.self_identity.createdBy).toBe("identity-discovery");
  });

  it("enabled=true：self 提案全状态陈述 → strip 拒收，不落库", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "self_identity", content: "P1 阶段已完成，当前正在做收尾", rationale: "状态" },
    ]));
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.adopted).toBe(0);
    expect(store.coreUpserts).toEqual([]);
  });

  it("enabled=true：self 提案超 maxPerPass → 截断", async () => {
    const store = makeFakeStore();
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "self_identity", content: "我负责技术评审", rationale: "a" },
      { slot: "self_identity", content: "我承诺每周五出周报", rationale: "b" },
      { slot: "self_identity", content: "我坚持先给结论再给细节", rationale: "c" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    const self = store.coreUpserts.find((u) => u.slot === "self_identity");
    expect((self!.content.match(/^- /gm) ?? []).length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/lifecycle/identity-discovery.self.test.ts`
Expected: FAIL（`selfIdentity` 未在 deps 中；双槽断言失败）

- [ ] **Step 3: 实现**

3a. deps 接口（:69）加一行：

```typescript
  selfIdentity?: { enabled: boolean; maxPerPass: number };
```

3b. 常量区（DISCOVERY_SYSTEM_PROMPT 之后）新增双视角 prompt——**legacy prompt 一个字节都不改**：

```typescript
// DS-SOUL-MEMORY-002 P1 双视角：user prompt 主语修正（O15：「他是谁」）+ agent 自我层
// （行为可证=提案必须能被样本中的 agent 侧行为/对话文本支撑）。仅 selfIdentity.enabled
// 时使用；legacy prompt 保留原样（逐位现状含 LLM 行为）。
const DISCOVERY_SYSTEM_PROMPT_DUAL = [
  "你是团队身份提炼顾问。从样本记忆中同时提炼两组身份事实：用户身份（他是谁）与 agent 自我（我是谁）。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（用户身份：他是谁/他的职责/他的角色）或 "self_identity"（agent 自我：我反复承担的职责/我做出的承诺/我执行过的红线/我稳定的工作风格）或 "core_value"（价值观）或 "strict_rule"（红线规则）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. identity 只提炼用户身份层面的持续事实（他是谁/他信什么）；self_identity 只提炼 agent 自我的持续事实，第一人称产出（我……），且必须能在样本中找到 agent 侧行为或对话文本支撑——纯用户侧事实不要写成 self_identity。",
  "2. 【身份判据】会随任务完成/阶段推进而过时的内容（项目进度、阶段状态、当前待办）不是身份——不要写入；只提炼跨状态持续的事实（角色、职责、关系、工作纪律）。",
  "3. 已有身份事实如果仍然准确，不要重复提交；如果已经过时/不准确/有重要更新，提出修订版——content 给出修订后全文，rationale 说明变化原因。修订会以新版本替换旧内容（旧版本留痕）。",
  "4. 宁缺毋滥：证据不足的主题不要提。",
  "5. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"},…]（slot 取 identity/self_identity/core_value/strict_rule），无提议输出 []。",
].join("\n");
```

3c. run 内（:143 LLM 调用处）：

```typescript
        const dual = deps.selfIdentity?.enabled === true;
        const prompt = buildIdentityPrompt(sample, existingSummaries);
        const raw = await deps.llmRunner.run({
          prompt,
          systemPrompt: dual ? DISCOVERY_SYSTEM_PROMPT_DUAL : DISCOVERY_SYSTEM_PROMPT,
          taskId: "identity-discovery",
          timeoutMs: 0,
          maxTokens: 0,
        });
```

3d. 采纳循环（:152 `if (p.slot === "identity")` 分支重构为双槽路由，单一源复用 strip 门）：

```typescript
        const identityProps: string[] = [];
        const selfProps: string[] = [];
        const maxSelf = deps.selfIdentity?.enabled === true ? Math.max(1, deps.selfIdentity.maxPerPass) : 0;
        for (const p of proposals) {
          if (p.slot === "identity") {
            const cleaned = stripIdentityStateResidue(p.content);
            if (!cleaned) {
              logger?.info?.(`[identity-discovery] identity proposal rejected (state residue only): ${p.content.slice(0, 60)}`);
            } else {
              identityProps.push(cleaned);
            }
          } else if (p.slot === "self_identity" && dual) {
            // 同一 strip 门（单一源）；「行为可证」为 prompt 硬约束，确定性侧只做状态剥离弱校验
            const cleaned = stripIdentityStateResidue(p.content);
            if (!cleaned) {
              logger?.info?.(`[identity-discovery] self_identity proposal rejected (state residue only): ${p.content.slice(0, 60)}`);
            } else {
              selfProps.push(cleaned);
            }
          } else {
            const ev = recountEvidence(p.content, corpus);
            pendingThis++;
            logger?.info?.(`[identity-discovery] pending ${p.slot}: ${p.content.slice(0, 60)} (evidence=${ev})`);
          }
        }
```

（其后的 identity merge/upsert 块保持原样；紧随其后加 self merge + 留痕，Task 5 会扩展留痕——本任务先落最小版：）

```typescript
        // self_identity slot 单行语义与 identity 同构：bulleted 合并、version++ 演化
        if (selfProps.length > 0) {
          const mergedSelf = selfProps.slice(0, maxSelf).map((c) => "- " + c).join("\n");
          const okSelf = store.upsertCore("self_identity", escapeXmlTags(mergedSelf), "identity-discovery", tenant);
          if (okSelf) {
            adoptedThis += 1;
            logger?.info?.(`[identity-discovery] adopted self_identity (${Math.min(selfProps.length, maxSelf)} facts)`);
          }
        }
```

3e. scheduler 传参（lifecycle-scheduler.ts:129-134 的 runIdentityDiscovery 调用）：

```typescript
      const res = await runIdentityDiscovery({
        store: deps.store,
        llmRunner: deps.llmRunner,
        config: deps.config.anchorDiscovery,
        selfIdentity: deps.config.selfIdentity,
        logger: deps.logger,
      });
```

（`deps.config` 即 coreMemory 配置组——anchorDiscovery 嵌套其内为既有实证；selfIdentity 同组平级。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/lifecycle/identity-discovery.self.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryCore/src/core/lifecycle/identity-discovery.ts MemoryCore/src/core/lifecycle/identity-discovery.self.test.ts MemoryCore/src/core/lifecycle/lifecycle-scheduler.ts
sudo -H -u tdai git commit -m "feat(soul): P1 identity-discovery 双视角（gated 双 prompt；self_identity 采纳路由复用 strip 单一源；maxPerPass 截断）"
```

---

### Task 3: l1-extractor agent 行为事实视角（gated prompt 增补）

**Files:**
- Modify: `MemoryCore/src/core/prompts/l1-extraction.ts`（`getExtractMemoriesSystemPrompt` / `formatExtractionPrompt` 所在文件）
- Modify: `MemoryCore/src/core/record/l1-extractor.ts`（调用处传入 gated 开关）
- Test: Create `MemoryCore/src/core/prompts/l1-extraction.agentact.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `selfIdentity.enabled`。
- Produces: enabled=true 时提取 prompt 含「agent 行为事实」指令段（LLM 会把 agent 的承诺/红线执行/稳定风格提为 L1 正文，第一人称）；enabled=false 时 prompt 与现状**字符串相等**。`metadata.agentAct` 字段本任务不落（无消费方，防死字段——见 Global Constraints 精化 2）。

- [ ] **Step 1: 写失败测试**

```typescript
// MemoryCore/src/core/prompts/l1-extraction.agentact.test.ts
import { describe, it, expect } from "vitest";
import { getExtractMemoriesSystemPrompt } from "./l1-extraction.js";

describe("l1 提取 prompt 的 agent 行为视角（P1 gated）", () => {
  it("开关关：prompt 与现状字符串相等（逐位现状）", () => {
    const legacy = getExtractMemoriesSystemPrompt();
    expect(legacy).not.toContain("agent 行为事实");
  });

  it("开关开：prompt 含 agent 行为事实指令段（第一人称、宁缺毋滥）", () => {
    const p = getExtractMemoriesSystemPrompt({ selfIdentityEnabled: true });
    expect(p).toContain("agent 行为事实");
    expect(p).toContain("第一人称");
    expect(p).toContain("宁缺毋滥");
  });
});
```

（若 `getExtractMemoriesSystemPrompt` 现签名带必选参数，按其真实签名补齐缺省实参后再断言——以文件内现状签名为准，不改其既有调用方语义。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/prompts/l1-extraction.agentact.test.ts`
Expected: FAIL（签名无 opts / 内容不含指令段）

- [ ] **Step 3: 实现**

3a. `getExtractMemoriesSystemPrompt` 增加可选尾参 `opts?: { selfIdentityEnabled?: boolean }`；在返回模板的**记忆类别列表之后**追加：

```typescript
  const agentActBlock = opts?.selfIdentityEnabled
    ? [
        "",
        "## agent 行为事实（可选类别，宁缺毋滥）",
        "样本中若有 agent 自己的行为证据——我做出的承诺、我执行的红线、我反复承担的职责、我稳定的工作风格——以第一人称提取为独立记忆（如「我在对话中承诺每周五出周报并坚持执行」）。",
        "硬约束：必须有 agent 侧行为或对话文本支撑；纯用户侧事实不要写成 agent 行为；证据不足不要提取。",
      ].join("\n")
    : "";
```

并把它拼进既有返回模板（拼接点=类别列表段落末尾）。

3b. `l1-extractor.ts` 的 prompt 组装处（:209 附近 `promptMode` 传入链）透传开关：从 `params.config.coreMemory?.selfIdentity?.enabled` 取值传入（沿既有 config 流动路径，不新增第二份解析）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/prompts/l1-extraction.agentact.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryCore/src/core/prompts/l1-extraction.ts MemoryCore/src/core/prompts/l1-extraction.agentact.test.ts MemoryCore/src/core/record/l1-extractor.ts
sudo -H -u tdai git commit -m "feat(soul): P1 l1-extractor agent 行为事实视角（gated prompt 增补；metadata.agentAct 推迟到有消费方分期）"
```

---

### Task 4: soul-assembler 四段渲染 + F17 预算（gated，缺省字节级一致）

**Files:**
- Modify: `MemoryCore/src/core/hooks/soul-assembler.ts`（全文 63 行，现状已核）
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts:635-637`（调用点传 opts）
- Test: Create `MemoryCore/src/core/hooks/soul-assembler.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `soulRender`；既有 `escapeXmlTags`。
- Produces: `buildSoulPrefix(store, tenant, logger?, opts?: { selfIdentityEnabled?: boolean; budgetSelfChars?: number; budgetIdentityChars?: number })`。`opts` 缺省/`selfIdentityEnabled` 非 true → 输出与现状**逐字节相等**。enabled 时 soul-identity 块内渲染顺序：`（我是谁）- [self_identity] …` → `（我心中的他）- [identity] …` → `价值锚：…`（multi-line content 仅首行带前缀，后续行原样跟随；超预算对整段 content 做 slice 截断）。

- [ ] **Step 1: 写失败测试**

```typescript
// MemoryCore/src/core/hooks/soul-assembler.test.ts
import { describe, it, expect } from "vitest";
import { buildSoulPrefix } from "./soul-assembler.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeStore(slots: Array<{ slot: string; content: string }>, values: Array<{ label: string; weight?: number; valence?: number | null; state?: string }> = []) {
  return {
    readCore: async () => slots,
    listValues: async () => values,
  } as never;
}

describe("soul-assembler 四段渲染（P1）", () => {
  const IDENTITY_ONLY = [{ slot: "identity", content: "用户是家里的首席厨师" }];

  it("opts 缺省：渲染与现状逐字节一致（无（我是谁）标注、无预算）", async () => {
    const out = await buildSoulPrefix(makeStore(IDENTITY_ONLY) as never, TENANT);
    expect(out).toBe("<soul-identity>\n## 此刻的你\n- [identity] 用户是家里的首席厨师\n</soul-identity>\n\n");
  });

  it("enabled=true：self 与 identity 分行标注", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        { slot: "identity", content: "用户是家里的首席厨师" },
        { slot: "self_identity", content: "我在这个团队负责技术评审" },
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    expect(out).toContain("（我是谁）- [self_identity] 我在这个团队负责技术评审");
    expect(out).toContain("（我心中的他）- [identity] 用户是家里的首席厨师");
    expect(out.indexOf("（我是谁）")).toBeLessThan(out.indexOf("（我心中的他）"));
  });

  it("enabled=true：multi-line content 仅首行带前缀，后续行原样", async () => {
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content: "- 我负责技术评审\n- 我承诺每周五出周报" }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out).toContain("（我是谁）- [self_identity] - 我负责技术评审\n- 我承诺每周五出周报");
  });

  it("F17 预算：超限截断（宁缺毋滥，无省略号）", async () => {
    const long = "我负责技术评审".repeat(200); // 1400 chars
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content: long }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out).not.toContain("……");
    expect(out.indexOf("我负责技术评审".repeat(200))).toBe(-1);
    expect((out.match(/我负责技术评审/g) ?? []).length).toBeLessThan(200);
  });

  it("enabled=true 但 self 槽空：（我是谁）小节整段省略（宁缺毋滥）", async () => {
    const out = await buildSoulPrefix(makeStore(IDENTITY_ONLY) as never, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).not.toContain("（我是谁）");
    expect(out).toContain("（我心中的他）");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/hooks/soul-assembler.test.ts`
Expected: FAIL（opts 未实现）

- [ ] **Step 3: 实现**

`buildSoulPrefix` 签名与身份段循环改为：

```typescript
export interface SoulRenderOptions {
  selfIdentityEnabled?: boolean;
  budgetSelfChars?: number;
  budgetIdentityChars?: number;
}

export async function buildSoulPrefix(
  store: IMemoryStore,
  tenant: CoreTenant,
  logger?: Logger,
  opts?: SoulRenderOptions,
): Promise<string> {
```

身份段内（现状 :38-41 的 `for (const s of slots)` 循环）改为：

```typescript
      const dual = opts?.selfIdentityEnabled === true;
      const budgetFor = (slot: string): number | undefined =>
        !dual ? undefined
          : slot === "self_identity" ? (opts?.budgetSelfChars ?? 600)
          : slot === "identity" ? (opts?.budgetIdentityChars ?? 900)
          : undefined;
      const labelFor = (slot: string): string =>
        slot === "self_identity" ? "（我是谁）" : slot === "identity" ? "（我心中的他）" : "";
      for (const s of slots) {
        const budget = budgetFor(s.slot);
        const content = budget !== undefined && s.content.length > budget ? s.content.slice(0, budget) : s.content;
        const body = dual ? `（${labelFor(s.slot).slice(1, -1)}）- [${s.slot}] ${content}` : `- [${s.slot}] ${s.content}`;
        // multi-line：仅首行带前缀（label 拼在首行），后续行已在 content 内原样跟随
        lines.push(body);
      }
```

（注意：非 dual 路径保持 `- [${s.slot}] ${s.content}` 原样且**不做截断**——逐位现状。）

3b. 调用点（auto-recall.ts:635-637）：

```typescript
        const { buildSoulPrefix } = await import("./soul-assembler.js");
        soulPrefix = await buildSoulPrefix(
          vectorStore,
          { teamId: it.teamId ?? "default", userId: it.userId ?? "default", agentId: it.agentId ?? "default" },
          logger,
          {
            selfIdentityEnabled: config.coreMemory?.selfIdentity?.enabled === true,
            budgetSelfChars: config.coreMemory?.soulRender?.budgetSelfChars,
            budgetIdentityChars: config.coreMemory?.soulRender?.budgetIdentityChars,
          },
        );
```

（以调用点作用域内 config 的真实变量名为准——`grep -n "config" src/core/hooks/auto-recall.ts | head` 确认后替换 `config`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/hooks/soul-assembler.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryCore/src/core/hooks/soul-assembler.ts MemoryCore/src/core/hooks/soul-assembler.test.ts MemoryCore/src/core/hooks/auto-recall.ts
sudo -H -u tdai git commit -m "feat(soul): P1 soul-assembler 四段渲染+F17 段级预算（opts gated；缺省逐位字节级一致）"
```

---

### Task 5: 身份修订旧文留痕（O14 缓解，P1 最小版）

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/identity-discovery.ts`（self/identity merge 块，Task 2 之后紧跟）
- Test: Modify `MemoryCore/src/core/lifecycle/identity-discovery.self.test.ts`

**Interfaces:**
- Consumes: 采纳循环里已有的 `existing`（readCore 结果）。
- Produces: 槽内容将变化时，logger.info 记录 `[identity-discovery] replacing <slot> (old content): <旧文>`——零 store 变更、零新表。

- [ ] **Step 1: 写失败测试**（追加用例）

```typescript
  it("修订替换：旧文留痕（logger.info 含旧内容，O14 缓解）", async () => {
    const infos: string[] = [];
    const store = makeFakeStore([{ slot: "identity", content: "- 旧身份事实" }]);
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "identity", content: "用户是家里的首席厨师，周末为全家掌勺", rationale: "修订" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run },
      logger: { info: (m: string) => infos.push(m) },
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(infos.some((m) => m.includes("replacing identity") && m.includes("旧身份事实"))).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/lifecycle/identity-discovery.self.test.ts`
Expected: FAIL（无 replacing 日志）

- [ ] **Step 3: 实现**（identity 与 self 两处 upsert 前各加一段，统一小函数防第二份）：

```typescript
        // O14 缓解（P1 最小版）：修订替换前旧文整行留痕（审计可查，不建 history 表防双源）
        const logReplacing = (slot: string, merged: string) => {
          const prev = existing.find((s) => s.slot === slot);
          if (prev && prev.content !== merged) {
            logger?.info?.(`[identity-discovery] replacing ${slot} (old content): ${prev.content}`);
          }
        };
```

在 `store.upsertCore("identity", ...)` 前调 `logReplacing("identity", merged)`；在 `store.upsertCore("self_identity", ...)` 前调 `logReplacing("self_identity", mergedSelf)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/lifecycle/identity-discovery.self.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryCore/src/core/lifecycle/identity-discovery.ts MemoryCore/src/core/lifecycle/identity-discovery.self.test.ts
sudo -H -u tdai git commit -m "feat(soul): P1 身份修订旧文留痕（O14 缓解；logger.info 审计，不建 history 表防双源）"
```

---

### Task 6: Memory Hub 身份区只读展示（U1：slots 透传 + IdentitySection）

**Files:**
- Modify: `MemoryPanel/src/panel/http/routes/chat-memory.ts`（values 面板路由区 :1590 附近新增 identity/read BFF 路由）
- Create: `MemoryPanel/web/src/pages/ChatMemoryPage/components/IdentitySection.tsx`
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/index.tsx`（挂载 IdentitySection，与 ValueAnchorsPanel 同区）
- Test: Create `MemoryPanel/tests/identity-section.test.ts`

**Interfaces:**
- Consumes: 网关 `/v3/core-memory/read`（已返回 slots，UI 现丢弃——chat-memory.ts:1594 注释实证）。
- Produces: BFF `POST /chat-memory/identity/read` body `{ block_id }` → `{ slots: Array<{ slot: string; content: string; version?: number; updated_at?: string; source?: string }> }`；前端 `<IdentitySection blockId={...} />`。

- [ ] **Step 1: 写失败测试（纯函数部分——槽拆分与展示行）**

```typescript
// MemoryPanel/tests/identity-section.test.ts
import { describe, it, expect } from "vitest";
import { splitIdentitySlots, identityEmpty } from "../web/src/pages/ChatMemoryPage/components/identity-utils.js";

describe("IdentitySection 工具（U1 身份区）", () => {
  it("按 slot 分组：identity / self_identity 各自成行组", () => {
    const { user, self } = splitIdentitySlots([
      { slot: "identity", content: "- 用户是首席厨师" },
      { slot: "self_identity", content: "- 我负责技术评审" },
      { slot: "core_value", content: "- 诚实" },
    ]);
    expect(user).toEqual(["- 用户是首席厨师"]);
    expect(self).toEqual(["- 我负责技术评审"]);
  });

  it("空槽判据：两槽皆空 → identityEmpty=true（渲染整块隐藏）", () => {
    expect(identityEmpty([], [])).toBe(true);
    expect(identityEmpty(["- x"], [])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd MemoryPanel && npx vitest run tests/identity-section.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

3a. `MemoryPanel/web/src/pages/ChatMemoryPage/components/identity-utils.ts`：

```typescript
export interface CoreSlotRow {
  slot: string;
  content: string;
  version?: number;
  updated_at?: string;
  source?: string;
}

export function splitIdentitySlots(slots: CoreSlotRow[]): { user: string[]; self: string[] } {
  const user: string[] = [];
  const self: string[] = [];
  for (const s of slots) {
    if (s.slot === "identity") user.push(s.content);
    else if (s.slot === "self_identity") self.push(s.content);
  }
  return { user, self };
}

export function identityEmpty(user: string[], self: string[]): boolean {
  return user.length === 0 && self.length === 0;
}
```

3b. BFF 路由（chat-memory.ts，插在 values/list 路由之后，**镜像其模式**：authorize → 租户反解 → 网关读 → 透传）：

```typescript
  // POST /chat-memory/identity/read  body: { block_id }
  // DS-SOUL-MEMORY-002 U1：身份区只读透传——/v3/core-memory/read 的 slots
  // （values/list 丢弃 slots 的既有注释即此缺口）。零新端点（复用既有 read），P1 只读。
  api.post("/chat-memory/identity/read", async (req, reply) => {
    const body = (req.body ?? {}) as { block_id?: string };
    const blockId = String(body.block_id ?? "");
    if (!blockId) return reply.code(400).send({ error: "block_id required" });
    if (!(await authorizeChatMemoryRead(req))) return reply.code(403).send({ error: "forbidden" });
    const tenant = coreTenantFromBlockId(blockId); // 与 values/list 同款反解；以该路由真实实现替换此行
    const read = await gatewayPost("/v3/core-memory/read", tenant); // 与 values/list 同款网关调用；以真实 helper 替换
    return reply.send({ slots: read?.slots ?? [] });
  });
```

（两处「以真实实现替换」：打开 values/list 路由 :1606-1660 照抄其 authorize/租户反解/网关调用三段的真实代码形态——模式实证存在，禁止另发明。）

3c. `IdentitySection.tsx`（只读，复用面板徽标风格）：

```tsx
import { useEffect, useState } from "react";
import { splitIdentitySlots, identityEmpty, type CoreSlotRow } from "./identity-utils.js";

export function IdentitySection(props: { blockId: string }) {
  const [slots, setSlots] = useState<CoreSlotRow[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/chat-memory/identity/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_id: props.blockId }),
    })
      .then((r) => r.json())
      .then((d) => { if (alive) setSlots(Array.isArray(d.slots) ? d.slots : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [props.blockId]);
  const { user, self } = splitIdentitySlots(slots);
  if (identityEmpty(user, self)) return null; // 宁缺毋滥
  return (
    <section className="identity-section" aria-label="agent 身份区（只读）">
      {self.length > 0 && (
        <div className="identity-block">
          <h4>我是谁（agent 自我）</h4>
          <pre className="identity-content">{self.join("\n")}</pre>
        </div>
      )}
      {user.length > 0 && (
        <div className="identity-block">
          <h4>我心中的他（用户身份）</h4>
          <pre className="identity-content">{user.join("\n")}</pre>
        </div>
      )}
    </section>
  );
}
```

3d. `ChatMemoryPage/index.tsx`：在 ValueAnchorsPanel 挂载点旁加 `<IdentitySection blockId={selectedBlockId} />`（以该页真实的选中 block state 变量名传入——grep `ValueAnchorsPanel` 的挂载行对齐）。CSS：`chat-memory-panel.css` 追加 `.identity-section/.identity-block/.identity-content` 三条（复用现有徽标/面板配色变量，不新造色板）。

- [ ] **Step 4: 跑测试确认通过 + 人工核**

Run: `npx vitest run tests/identity-section.test.ts && npx tsc --noEmit`
Expected: PASS。人工核：MemoryPanel dev 页面选中 flowtest 任意记忆块 → 身份区渲染（当前 identity 槽有 v4 内容）。

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryPanel/src/panel/http/routes/chat-memory.ts MemoryPanel/web/src/pages/ChatMemoryPage/components/IdentitySection.tsx MemoryPanel/web/src/pages/ChatMemoryPage/components/identity-utils.ts MemoryPanel/web/src/pages/ChatMemoryPage/index.tsx MemoryPanel/web/src/pages/ChatMemoryPage/styles/chat-memory-panel.css MemoryPanel/tests/identity-section.test.ts
sudo -H -u tdai git commit -m "feat(panel): P1 身份区只读展示（U1 slots 透传零新端点；identity/self_identity 分组渲染）"
```

---

### Task 7: 逐位现状回归 + flowtest 真数据 SOP 验收

**Files:**
- Modify: `MemoryCore/tdai-gateway.yaml`（deployment-local，gitignored：追加 selfIdentity/soulRender 开启段——仅 flowtest 验收期）
- 无新代码；本任务是验证门。

**Interfaces:**
- Consumes: Task 1-6 全部交付物；远端服务 `tdai-core`（`sudo systemctl restart tdai-core`）。

- [ ] **Step 1: 开关关=逐位现状回归**

```bash
cd MemoryCore && npx tsc --noEmit && npx vitest run
```
Expected: tsc 0 错误；vitest 全绿（≥500 tests 基线 + 本计划新增用例）。再对 flowtest 做一次 `/v3/recall`（`x-tdai-service-id: default` 头），抓 soul-identity 段与升级前快照比对——**字节级一致**（enabled=false 路径）。

- [ ] **Step 2: flowtest 开启 + 重启**

`tdai-gateway.yaml` memory.coreMemory 组追加（yaml 缩进对齐 anchorDiscovery）：

```yaml
      selfIdentity:
        enabled: true
        maxPerPass: 2
        intervalHours: 1   # 验收期缩短冷却；验收后回 24
      soulRender:
        budgetSelfChars: 600
        budgetIdentityChars: 900
```

```bash
sudo systemctl restart tdai-core && sleep 5 && systemctl is-active tdai-core
```

- [ ] **Step 3: 真数据 SOP（≥12 组新鲜对抗种子，ev5_ 前缀，换用户/换 agent 双测试）**

1. 播种（本地脚本→远端执行，模式同 ev4）：三组三元组——flowtest 主租户、flowtest 第二用户（换用户）、flowtest 主用户第二 agent（换 agent）；各组 ≥4 组对话材料（含 agent 侧承诺/风格文本：如「我承诺每周五出周报」「我坚持先给结论」），`occurred_at` 相对时间戳。
2. 触发两轮 identity-discovery（intervalHours=1 + restart 即时 tick），`journalctl -u tdai-core | grep identity-discovery` 确认 adopted≥2（identity + self_identity）且 `replacing` 留痕只在真修订时出现。
3. `/v3/recall` 读回：soul-identity 段含 `（我是谁）- [self_identity]` 与 `（我心中的他）- [identity]` 两小节；主租户与换用户租户的 self_identity **事实清单 diff 各有独有事实**（换用户测试 §8 判据）；换 agent 租户灵魂不同（换 agent 测试）。
4. 预算截断：播种一条 >600 字 self 材料，确认渲染截断无省略号、无空段。
5. 写读回铁律：每个 upsert 后 `sqlite3` 读回 core_memory 行（slot/content/version）。
6. UI：Memory Hub 选 flowtest 记忆块 → 身份区两小节可见（U1）；截断材料对应行无溢出。

- [ ] **Step 4: SOP 结果回写**

`docs/superpowers/plans/2026-09-17-soul-p1-dual-slot.md` 本节下追加 SOP 实测记录（逐项证据行）；CHANGELOG 增 P1 小节（含两次精化说明：minEvidence 推迟、agentAct 字段推迟）；v5 台账 O16 标注 P1 落地、O15 prompt 修正闭环。

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add docs/superpowers/plans/2026-09-17-soul-p1-dual-slot.md CHANGELOG.md docs/superpowers/plans/2026-09-16-remaining-work-v5.md
sudo -H -u tdai git commit -m "docs(soul): P1 验收 SOP 实测回写（换用户/换agent 双测试+逐位回归+预算截断+UI 身份区）"
```

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：spec §7 P1 六项——self_identity slot（Task 2/1）、双视角 prompt+主语修正（Task 2，O15 顺手闭环）、四段渲染+F17（Task 4）、旧文留痕（Task 5）、UI U1（Task 6）、验收双测试（Task 7）——全部有任务；agentAct 视角（Task 3）。两处精化（minEvidence/agentAct 字段推迟）已在 Global Constraints 显式声明。
2. **占位符扫描**：Task 6 两处「以真实实现替换」为显式锚点指令（照抄既有路由真实代码形态），非 TBD；其余步骤均含实际代码/命令。
3. **类型一致性**：`SoulRenderOptions`/`selfIdentity`/`splitIdentitySlots` 命名各 Task 间一致；`buildSoulPrefix` 第四参在 Task 4 定义、调用点同形；fake store 方法名与 store/types.ts:736-737 实证一致。
