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

3a. 类型：`MemoryCoreMemoryConfig` 接口在 config.ts:270（实证）——**沿既有内联对象类型风格**（anchorDiscovery 即内联，不另立 interface），在接口体内 `anchorDiscovery: {...};` 字段后追加：

```typescript
  /**
   * DS-SOUL-MEMORY-002 P1：agent 自我层双视角（enabled 缺省 false=逐位现状，
   * 含 LLM prompt 行为）。maxPerPass clamp 1..10；intervalHours clamp 1..168。
   */
  selfIdentity: {
    enabled: boolean;
    maxPerPass: number;
    intervalHours: number;
  };
  /** F17 段级注入预算（chars 为 token 粗粒度近似；clamp 100..2000）。 */
  soulRender: {
    budgetSelfChars: number;
    budgetIdentityChars: number;
  };
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

3a-bis. **导出既有常量**（测试需断言旧 prompt 字节级）：`const DISCOVERY_SYSTEM_PROMPT = [` 改为 `export const DISCOVERY_SYSTEM_PROMPT = [`（仅加 export，内容零改动）。

3a-ter. **parseProposals slot 白名单扩展（计划 v2 实证关键项，:250）**：parseProposals 内硬编码 `const valid = new Set(["identity", "core_value", "strict_rule"]);`——**self_identity 提案会在解析层被直接丢弃**，不加此步 Task 2 全部双槽测试必失败。改为：

```typescript
  const valid = new Set(["identity", "core_value", "strict_rule", "self_identity"]);
```

（无条件扩展是安全的：enabled=false 时 LLM 走旧 prompt 不产 self 提案；若 LLM 幻觉产出，落入 else 分支 → recountEvidence + pending log——无害且诚实。）

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
- Modify: `MemoryCore/src/core/record/l1-extractor.ts:520`（composeMemorySystemPrompt 组装点传 gated 开关）
- Test: Create `MemoryCore/src/core/prompts/l1-extraction.agentact.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `selfIdentity.enabled`。
- Produces: `getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat", opts?: { selfIdentityEnabled?: boolean })`（v2 实证对齐真实签名——现签名 `(mode = "chat")` 只是常量选择器）；enabled=true 且 mode!=="code" 时返回 base+AGENT_ACT_BLOCK（块追加在 prompt **末尾**，不改既有常量体）；enabled=false 时返回值与现状**字符串相等**。`metadata.agentAct` 字段本任务不落（无消费方，防死字段——见 Global Constraints 精化 2）。

- [ ] **Step 1: 写失败测试**

```typescript
// MemoryCore/src/core/prompts/l1-extraction.agentact.test.ts
import { describe, it, expect } from "vitest";
import { getExtractMemoriesSystemPrompt } from "./l1-extraction.js";

describe("l1 提取 prompt 的 agent 行为视角（P1 gated）", () => {
  it("开关关（缺省）：prompt 与现状字符串相等（逐位现状）", () => {
    const legacy = getExtractMemoriesSystemPrompt();
    expect(legacy).not.toContain("agent 行为事实");
    expect(legacy).toBe(getExtractMemoriesSystemPrompt("chat", {}));
  });

  it("开关开（mode=chat）：prompt 含 agent 行为事实指令段（第一人称、宁缺毋滥）", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { selfIdentityEnabled: true });
    expect(p).toContain("agent 行为事实");
    expect(p).toContain("第一人称");
    expect(p).toContain("宁缺毋滥");
    expect(p.startsWith(getExtractMemoriesSystemPrompt("chat"))).toBe(true); // 块=追加，常量体零改动
  });

  it("mode=code：即使开关开也不注入（work 记忆与自我层无关）", () => {
    expect(getExtractMemoriesSystemPrompt("code", { selfIdentityEnabled: true })).not.toContain("agent 行为事实");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/prompts/l1-extraction.agentact.test.ts`
Expected: FAIL（第二用例：现签名只收 mode，对象被当 mode→返回 chat prompt 不含块）

- [ ] **Step 3: 实现**

3a. `l1-extraction.ts` 新增导出常量（文件尾部）：

```typescript
// DS-SOUL-MEMORY-002 P1：agent 行为事实视角（仅内置 chat prompt 追加；自定义 memoryPrompt
// 策略为用户权威，不篡改——见 l1-extractor.ts:520 组装点）。
export const AGENT_ACT_BLOCK = [
  "",
  "## agent 行为事实（可选类别，宁缺毋滥）",
  "样本中若有 agent 自己的行为证据——我做出的承诺、我执行的红线、我反复承担的职责、我稳定的工作风格——以第一人称提取为独立记忆（如「我在对话中承诺每周五出周报并坚持执行」）。",
  "硬约束：必须有 agent 侧行为或对话文本支撑；纯用户侧事实不要写成 agent 行为；证据不足不要提取。",
].join("\n");
```

3b. selector 加尾参（:389）：

```typescript
export function getExtractMemoriesSystemPrompt(
  mode: MemoryPromptMode = "chat",
  opts?: { selfIdentityEnabled?: boolean },
): string {
  const base = mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
  return opts?.selfIdentityEnabled && mode !== "code" ? base + AGENT_ACT_BLOCK : base;
}
```

3c. 注入点（**实证：l1-extractor.ts:520**——`const systemPrompt = composeMemorySystemPrompt(getExtractMemoriesSystemPrompt(promptMode), memoryPrompt);`）改为：

```typescript
  // DS-SOUL-MEMORY-002 P1：agent 行为事实视角（gated）。composeMemorySystemPrompt 的
  // 自定义 memoryPrompt 策略优先级不变——自定义时内置 base 被其覆盖，agentAct 块随之
  // 不生效（自定义策略=用户权威，不篡改）。
  const selfIdentityEnabled = params.config?.coreMemory?.selfIdentity?.enabled === true;
  const systemPrompt = composeMemorySystemPrompt(
    getExtractMemoriesSystemPrompt(promptMode, { selfIdentityEnabled }),
    memoryPrompt,
  );
```

（`params.config` 为 callLlmExtraction 入参既有字段——:206 实证调用处已传 `config`；若 :502 形参名不同，按其真实形参名对齐。）

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
        slot === "self_identity" ? "我是谁" : slot === "identity" ? "我心中的他" : "";
      for (const s of slots) {
        const budget = budgetFor(s.slot);
        const content = budget !== undefined && s.content.length > budget ? s.content.slice(0, budget) : s.content;
        const body = dual && labelFor(s.slot)
          ? `（${labelFor(s.slot)}）- [${s.slot}] ${content}`
          : `- [${s.slot}] ${s.content}`;
        // multi-line：仅首行带前缀（label 拼在首行），后续行已在 content 内原样跟随
        lines.push(body);
      }
```

（注意：非 dual 路径保持 `- [${s.slot}] ${s.content}` 原样且**不做截断**——逐位现状。dual 路径对非 identity/self_identity 槽（未来扩展）回落原样渲染。）

3b. 调用点（auto-recall.ts:635-637，实证：该处位于 performLayeredRecall 内，作用域已有全量配置 `cfg`——:530 `cfg.recall` 同源）：

```typescript
        const { buildSoulPrefix } = await import("./soul-assembler.js");
        soulPrefix = await buildSoulPrefix(
          vectorStore,
          { teamId: it.teamId ?? "default", userId: it.userId ?? "default", agentId: it.agentId ?? "default" },
          logger,
          {
            selfIdentityEnabled: cfg.coreMemory?.selfIdentity?.enabled === true,
            budgetSelfChars: cfg.coreMemory?.soulRender?.budgetSelfChars,
            budgetIdentityChars: cfg.coreMemory?.soulRender?.budgetIdentityChars,
          },
        );
```

（若作用域内真实变量名非 `cfg`——执行时 `grep -n "cfg\b\|config" src/core/hooks/auto-recall.ts | sed -n '1,20p'` 就近确认，语义=全量 MemoryTdaiConfig。）

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
- Modify: `MemoryPanel/web/src/lib/teamApi.ts`（`chatMemoryApi` 增 `identityRead`，与 `valuesList` :222 同型）
- Create: `MemoryPanel/web/src/pages/ChatMemoryPage/components/IdentitySection.tsx` + `identity-utils.ts`
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/ValueAnchorsPanel.tsx`（挂载 IdentitySection——实证：ValueAnchorsPanel 是独立视图（index.tsx:28 视图切换），且已有 blockId（:211 `chat_memory-${activeTeamId}-${agentId}`）与取数助手（:222 `chatMemoryApi.valuesList`））
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

3b. BFF 路由（chat-memory.ts，插在 values/list 路由之后，**镜像其真实 ctx 风格**（v2 实证：本文件路由为 `api.post(path, validatePanelMetaHeaders(deps), async (c) => {...})` + buildCtx/readJson/requiredBlockId/parseChatMemoryAssetId/resolveCallerUserId/asset/get/authorizeChatMemoryRead 前奏，非 express 风格））：

```typescript
  // POST /chat-memory/identity/read  body: { block_id }
  // DS-SOUL-MEMORY-002 U1：身份区只读透传——/v3/core-memory/read 返回的 slots
  // 被 values/list 丢弃（:1594 注释实证即此缺口）。零新端点（复用既有 read），P1 只读。
  api.post(
    "/chat-memory/identity/read",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");

      const parsed = parseChatMemoryAssetId(blockId);
      if (!parsed) return respondControlError(c, 400, "NOT_AGENT_MEMORY");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const assetEnv = await deps.metaKernel.invoke("asset/get", { asset_id: blockId }, ctx);
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory") return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      const canRead = await authorizeChatMemoryRead(deps, ctx, asset, meUserId, blockId);
      if (!canRead) return respondControlError(c, 403, "ASSET_NOT_ACCESSIBLE");

      // 数据面 user_id = asset owner（values/list 同款借用场景语义）
      const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
      const read = await /* 照抄 values/list 路由内 /v3/core-memory/read 的调用段：
        同 helper、同 idFields={team_id: parsed.teamId, agent_id: parsed.agentId,
        user_id: asset.owner_user_id, session_id: "default"}、同 cred；取其返回的 slots */;
      return respondEnvelope(c, { code: 0, data: { slots: read?.slots ?? [] } });
    },
  );
```

（网关调用段：打开本文件 values/list 路由，复制其 `/v3/core-memory/read` 调用语句（idFields 形状已在上注释给出）——**这是唯一需要照抄的段落**，禁止另发明 helper。若 respondEnvelope 形状与实际不符，以同文件相邻路由的返回形态对齐。）

3c-1. `teamApi.ts`：`chatMemoryApi` 对象内加（与 `valuesList` 同型）：

```typescript
  async identityRead(blockId: string): Promise<{ slots: Array<{ slot: string; content: string; version?: number; updated_at?: string; source?: string }> }> {
    return this.post("/chat-memory/identity/read", { block_id: blockId });
  },
```

（`this.post` 以 valuesList 的真实 HTTP 助手形态对齐——打开 valuesList 实现照抄其请求方式。）

3c. `IdentitySection.tsx`（只读，取数走 chatMemoryApi.identityRead）：

```tsx
import { useEffect, useState } from 'react';
import { chatMemoryApi } from '@/lib/teamApi';
import { splitIdentitySlots, identityEmpty, type CoreSlotRow } from './identity-utils';

export function IdentitySection(props: { blockId: string }) {
  const [slots, setSlots] = useState<CoreSlotRow[]>([]);
  useEffect(() => {
    let alive = true;
    chatMemoryApi
      .identityRead(props.blockId)
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

3d. 挂载（`ValueAnchorsPanel.tsx`：blockId 派生 :211 之后、values 列表渲染之前）：

```tsx
      {blockId ? <IdentitySection blockId={blockId} /> : null}
```

（import 行加 `import { IdentitySection } from './IdentitySection';`。）CSS：`chat-memory-anchors.css` 追加 `.identity-section/.identity-block/.identity-content` 三条（复用现有徽标/面板配色变量，不新造色板）。

- [ ] **Step 4: 跑测试确认通过 + 人工核**

Run: `npx vitest run tests/identity-section.test.ts && npx tsc --noEmit`
Expected: PASS。人工核：MemoryPanel dev 页面选中 flowtest 任意记忆块 → 身份区渲染（当前 identity 槽有 v4 内容）。

- [ ] **Step 5: Commit**

```bash
cd /opt/tdai/td-agemem && sudo -H -u tdai git add MemoryPanel/src/panel/http/routes/chat-memory.ts MemoryPanel/web/src/lib/teamApi.ts MemoryPanel/web/src/pages/ChatMemoryPage/components/IdentitySection.tsx MemoryPanel/web/src/pages/ChatMemoryPage/components/identity-utils.ts MemoryPanel/web/src/pages/ChatMemoryPage/components/ValueAnchorsPanel.tsx MemoryPanel/web/src/pages/ChatMemoryPage/styles/chat-memory-anchors.css MemoryPanel/tests/identity-section.test.ts
sudo -H -u tdai git commit -m "feat(panel): P1 身份区只读展示（U1 slots 透传零新端点；identity/self_identity 分组渲染；挂载于价值锚管理视图）"
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

`tdai-gateway.yaml` memory.coreMemory 组追加（**实证缩进：与 anchorDiscovery 同级=4 空格**，yaml 150-159 行实证；追加在 `anchorDiscovery:` 块之后）：

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
2. **占位符扫描**：Task 6 网关调用段为显式照抄指令（idFields 形状已实证给出），非 TBD；其余步骤均含实际代码/命令。
3. **类型一致性**：`SoulRenderOptions`/`selfIdentity`/`splitIdentitySlots` 命名各 Task 间一致；`buildSoulPrefix` 第四参在 Task 4 定义、调用点同形；fake store 方法名与 store/types.ts:736-737 实证一致。

## 计划 v2 实证复审记录（2026-09-17，结合 spec 与真实代码的第二轮计划审核）

审核方法：把计划中每段「将要写」的代码当假命题，对真实代码逐条验证（D1-D8/E1-E7/F1-F3 三批）。**抓出 9 处问题并已全部修入**——其中 2 处若不修，执行时测试必失败：

| # | 级别 | 发现（实证出处） | 修正 |
|---|---|---|---|
| 1 | **致命** | `parseProposals` 硬编码 slot 白名单 `Set(["identity","core_value","strict_rule"])`（:250）——self_identity 提案在**解析层即被丢弃**，原计划 Task 2 所有双槽测试必失败 | Task 2 增 3a-ter：valid 集合 +self_identity（无条件扩展安全：disabled 时幻觉提案落 else→pending log，无害且诚实） |
| 2 | **高** | `getExtractMemoriesSystemPrompt(mode)` 是常量选择器（:389-391），原计划的 opts 注入方式对不上真实签名 | Task 3 重写：selector 加尾参 + `AGENT_ACT_BLOCK` 运行时追加（常量体零改动）+ 注入点定为 **l1-extractor.ts:520**（composeMemorySystemPrompt 组装处，config 经 :206 既有入参流入）；mode=code 不注入；自定义 memoryPrompt 策略优先级不变（用户权威不篡改） |
| 3 | 高 | `DISCOVERY_SYSTEM_PROMPT` 未导出（C2 实证 `const`）——Task 2 测试 import 会编译失败 | Task 2 增 3a-bis：加 export（内容零改动） |
| 4 | 中 | BFF 路由真实风格是**自定义 ctx**（`api.post(path, validatePanelMetaHeaders(deps), async (c) => …)` + buildCtx/readJson/requiredBlockId/parseChatMemoryAssetId/…，E4 实证）——原计划 express 风格草稿全错 | Task 6 重写：前奏代码按实证逐行对齐；网关调用段为唯一照抄段（idFields 形状已给出） |
| 5 | 中 | ValueAnchorsPanel 是**独立视图**（index.tsx:28 视图切换）而非块详情内组件；取数走 `chatMemoryApi.valuesList`（:222）+ blockId 派生（:211） | Task 6 挂载点改为 ValueAnchorsPanel 内（blockId 现成）；前端取数改 `chatMemoryApi.identityRead`（teamApi 增 helper，与 valuesList 同型） |
| 6 | 中 | `MemoryCoreMemoryConfig` 既有风格是**内联对象类型**（anchorDiscovery 内联，D1 实证）——原计划引入两个新 interface 与仓库风格冲突 | Task 1 改内联字段 |
| 7 | 低 | yaml 实证缩进：anchorDiscovery 在 coreMemory 下 4 空格（:154） | Task 7 yaml 改 4 空格 |
| 8 | 低 | auto-recall 调用点作用域变量为全量 `cfg`（:530 `cfg.recall` 同源实证），非 `config` | Task 4 3b 改 `cfg.coreMemory?.…` |
| 9 | 低 | strip 分句语义（D2）：split `/(?<=[。；;！？\n])/` + P\d 结构判据——Task 2 测试用例「P1 阶段已完成，当前正在做收尾」整句命中→拒收，**预期成立**（复核通过，无需改） | 无（复核记录） |

结论：计划与 spec/真实代码的对齐问题已清零；v2 可执行。
