# 灵魂 P2：人物锚 + 维护链 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（铁律①禁子代理 → 本人逐任务内联执行）。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 落地 spec §7 P2——core_values 人物锚双节点（node_type/attrs_json）+ anchor-growth 双池（单一源策略化分叉 F11/F12）+ personRefs/identityRefs 回填 + identity GROW-MAINT（只警告，F20 红线）+ F14 遗忘保护 + O13 pending 落点闭环 + UI U2-U4。

**Architecture:** 存储层扩列（幂等 ALTER，T12 先例）→ 证据口径单一源（core-values-discover.ts 新增 personEv 族）→ anchor-growth 同 worker 内 person 池（theme 路径字节级不动）→ 遗忘保护（候选排除 + refs 重验）→ pending 持久化 + /v3 API → 渲染 + Panel。

**Tech Stack:** TypeScript / node:sqlite / vitest / React (MemoryPanel web)。

**Spec:** docs/superpowers/specs/2026-09-17-soul-memory-design.md（§2.6/§2.7/§5 F11-F15/F19/F20/§6.5 U2-U4/§7 P2）

## Global Constraints

- 铁律：禁子代理；TDD 红绿；config-first 缺省逐位现状（新行为默认关、yaml 开启）；docs/code 同步；SSH 文件写 `sudo -u tdai`、git `sudo -H -u tdai`；补丁脚本二进制安全（MemoryCore 是 LF，MemoryPanel 是 CRLF——O19）。
- theme 锚既有路径**字节级不动**（27 个既有测试为回归基线）；person 分叉按 spec §2.6「一份 GROW worker 按 node_type 分叉证据口径（if 策略化）」。
- 分池名额：maxTotalTheme=15（现状值）/ maxTotalPerson=8（spec F15），各自独立计数。
- F20 红线：身份事实永不自动退场——GROW-MAINT 身份分支只 warn。
- 灵魂渲染 person 行数据驱动（空则省略），价值锚行必须过滤 node_type='person'（防串行）。
- 回归基线：MemoryCore 521 通过 / typecheck 243 行（O20，新增零容忍）/ MemoryPanel 106 通过。

---

### Task 1: 存储层——core_values 扩列 + 读路扩列 + 通用 refs 回填

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（:862-868 ALTER 块后加两列；upsertValue :2352；listValues :2384；listValuesAnyState :2428；valuesCache :516；backfillCoreRef）
- Modify: `MemoryCore/src/core/store/types.ts`（可选方法签名同步）
- Test: `MemoryCore/src/store.corevalues-p2.test.ts`（新建）

**Interfaces（Produces）:**
- `upsertValue(valueId, label, weight, createdBy?, tenant?, valence?, origin?, nodeType?: "theme"|"person", attrs?: { role?: string; aliases?: string[] }): boolean`
- listValues/listValuesAnyState 行多 `node_type: "theme"|"person"` 与 `attrs_json: string`（旧库行由 ALTER 缺省补齐）
- `backfillCoreRef(recordId, label, tenant?)` 签名不变（内部委托通用实现）；新增 `backfillMemoryRef(recordId, key: "coreRefs"|"personRefs"|"identityRefs", label, tenant?): boolean`

- [ ] **Step 1 失败测试**（真实临时 sqlite 库）：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { VectorStore } from "./core/store/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });
function makeStore() { const dir = mkdtempSync(join(tmpdir(), "p2-")); cleanup.push(dir); return new VectorStore(join(dir, "v.db"), 8); }
const T = { teamId: "t", userId: "u", agentId: "a" };

describe("P2 core_values 扩列", () => {
  it("upsertValue person：node_type/attrs_json 落库且读回", () => {
    const s = makeStore();
    expect(s.upsertValue("v1", "女儿", 0.6, "auto-growth", T, 1, "auto", "person", { role: "家人", aliases: ["闺女"] })).toBe(true);
    const rows = s.listValues(T);
    expect(rows[0]!.node_type).toBe("person");
    expect(JSON.parse(rows[0]!.attrs_json)).toEqual({ role: "家人", aliases: ["闺女"] });
  });
  it("DO UPDATE 不碰 node_type/attrs_json（theme 升权重不改类型）", () => {
    const s = makeStore();
    s.upsertValue("v1", "女儿", 0.6, "auto-growth", T, 1, "auto", "person", { role: "家人" });
    s.upsertValue("v1", "女儿", 0.9, "auto-growth", T, 1, "auto"); // 未传 nodeType/attrs
    const row = s.listValues(T)[0]!;
    expect(row.node_type).toBe("person");
    expect(JSON.parse(row.attrs_json)).toEqual({ role: "家人" });
    expect(row.weight).toBe(0.9);
  });
  it("缺省 node_type='theme'/attrs_json='{}'（theme 调用方零改动）", () => {
    const s = makeStore();
    s.upsertValue("t1", "数据隐私", 0.5, "manual", T);
    const row = s.listValues(T)[0]!;
    expect(row.node_type).toBe("theme");
    expect(row.attrs_json).toBe("{}");
  });
  it("backfillMemoryRef 三键族写入 metadata + FTS 同步、去重不重复追加", () => {
    const s = makeStore();
    s.addL1Record?.({ record_id: "r1", content: "女儿今天月考", teamId: "t", userId: "u", agentId: "a" } as never);
    expect(s.backfillMemoryRef!("r1", "personRefs", "女儿", T)).toBe(true);
    expect(s.backfillMemoryRef!("r1", "personRefs", "女儿", T)).toBe(false);
    const row = (s as unknown as { db: { prepare: (q: string) => { get: (...a: unknown[]) => { metadata_json: string } } } }).db
      .prepare("SELECT metadata_json FROM l1_records WHERE record_id='r1'").get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).personRefs).toEqual(["女儿"]);
  });
});
```

- [ ] **Step 2** `npx vitest run src/store.corevalues-p2.test.ts` → FAIL（node_type 不存在/方法缺）
- [ ] **Step 3 实现**（锚点补丁）：

sqlite.ts 在 `:868`（state ALTER 行）后追加：
```ts
    // DS-SOUL-MEMORY-002 P2（spec §2.6）：人物锚双节点列——幂等 ALTER（T12 模式），
    // 缺省 'theme'/'{}' = 逐位现状；sqlite 不可删列，回滚策略=列保留无害。
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN node_type TEXT NOT NULL DEFAULT 'theme'"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE core_values ADD COLUMN attrs_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
```

upsertValue 替换为（签名扩展；INSERT 增列；DO UPDATE 不碰 node_type/attrs_json——保留原类型；attrs 传入时才更新 attrs_json）：
```ts
  upsertValue(valueId: string, label: string, weight: number, createdBy = "manual", tenant?: CoreTenant, valence?: number, origin: "seed" | "manual" | "auto" = "manual", nodeType: "theme" | "person" = "theme", attrs?: { role?: string; aliases?: string[] }): boolean {
    const t = normalizeCoreTenant(tenant);
    const v = valence === undefined ? null : Math.min(1, Math.max(-1, Math.round(valence)));
    const attrsJson = attrs === undefined ? null : JSON.stringify({ ...(attrs.aliases === undefined ? {} : { aliases: attrs.aliases }), ...(attrs.role === undefined ? {} : { role: attrs.role }) });
    try {
      this.db.prepare(
        "INSERT INTO core_values (value_id, label, weight, created_by, valence, origin, pinned, state, team_id, user_id, agent_id, node_type, attrs_json) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?) " +
        "ON CONFLICT(value_id, team_id, user_id, agent_id) DO UPDATE SET label=excluded.label, weight=excluded.weight, state='active'" +
        (v === null ? "" : ", valence=excluded.valence") +
        (attrsJson === null ? "" : ", attrs_json=excluded.attrs_json"),
      ).run(valueId, label, weight, createdBy, v, origin, t.teamId, t.userId, t.agentId, nodeType, attrsJson ?? "{}");
      this.invalidateValuesCache();
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [core_values] upsertValue failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
```

listValues/listValuesAnyState：SELECT 列表加 `node_type, attrs_json`，行类型加 `node_type: "theme" | "person"; attrs_json: string`（cache 类型 :516 同步）。

backfillCoreRef 重构（公共主体抽 `backfillMemoryRef`，原签名保留委托 `backfillMemoryRef(recordId, "coreRefs", label, tenant)`；body 同原实现，键名参数化，FTS 同步保留）。

types.ts：IMemoryStore 可选 `upsertValue`/`backfillMemoryRef` 签名同步（可选性保持——旧后端 feature-detect 不破）。

- [ ] **Step 4** 测试 PASS + 全量 `npx vitest run` 521 基线不破
- [ ] **Step 5** commit `feat(p2-t1): core_values node_type/attrs_json 扩列 + 读路扩列 + backfillMemoryRef 通用键族`

### Task 2: person 证据口径单一源（core-values-discover.ts）

**Files:**
- Modify: `MemoryCore/src/gateway/core-values-discover.ts`
- Test: `MemoryCore/src/core-values-discover.person.test.ts`

**Interfaces（Produces）:**
- `personEvCount(label: string, aliases: string[], corpus: string[]): number` —— F11：`|{ r : content 包含 label 或任一 alias }|`
- `personValenceSymbol(mean: number): 1 | 0 | -1` —— F12：≥+0.2→1，≤-0.2→-1，否则 0
- `personEvidenceMeanValence(label, aliases, corpusRows: Array<{ content: string; valence?: number | null }>): number | null` —— 命中行 valence 均值（无 valence 行 → null）
- `PERSON_DISCOVER_SYSTEM_PROMPT`（人物视角硬约束：行为可证/提及次数/宁缺毋滥/禁状态陈述）
- `buildPersonDiscoverPrompt(sampleContents: string[], existingLabelsAndAliases: string[]): string`
- `parsePersonProposals(raw: string): Array<{ label: string; role: string; aliases: string[] }>` —— 复用 parseProposalsJson 的 JSON 提取；label 非空、role∈{家人,同事,朋友,其他}（外值归"其他"）、aliases 规范为 string[] 去空去重去同 label

- [ ] **Step 1 失败测试**（关键断言）：

```ts
it("F11 personEv：label 或任一 alias 命中去重", () => {
  const corpus = ["女儿今天月考", "闺女要去图书馆", "老周下棋", "女儿的房间"];
  expect(personEvCount("女儿", ["闺女"], corpus)).toBe(3);
});
it("F12 符号化边界", () => {
  expect(personValenceSymbol(0.2)).toBe(1);
  expect(personValenceSymbol(-0.2)).toBe(-1);
  expect(personValenceSymbol(0.19)).toBe(0);
});
it("parse：role 白名单外归其他、aliases 去重去空去同 label", () => {
  const rows = parsePersonProposals('[{"label":"女儿","role":"boss","aliases":["闺女","","女儿"]}]');
  expect(rows[0]).toEqual({ label: "女儿", role: "其他", aliases: ["闺女"] });
});
it("parse：非法 JSON/缺 label → []（宁缺毋滥）", () => {
  expect(parsePersonProposals("not json")).toEqual([]);
  expect(parsePersonProposals('[{"role":"家人"}]')).toEqual([]);
});
```

- [ ] **Step 2** FAIL → **Step 3 实现**（新常量+函数，追加文件尾；prompt 硬约束含：只提案经历中反复出现的真实人物、给出 role、aliases=用户实际称呼变体、从不在语料中的人物禁止提案、输出 JSON 数组）→ **Step 4** PASS + commit `feat(p2-t2): person 证据口径/valence 符号化/人物发现 prompt 单一源`

### Task 3: anchor-growth 双池（theme 字节不动 + person 池策略化分叉）

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/anchor-growth.ts`
- Modify: `MemoryCore/src/config.ts`（anchorDiscovery.person 子组解析）
- Test: `MemoryCore/src/core/lifecycle/anchor-growth.person.test.ts`

**Interfaces:**
- `AnchorDiscoveryConfig` + `person: { enabled: boolean; minEvidence: number; maxPerPass: number; maxTotal: number }`（DEFAULT：enabled **false**=逐位现状，minEvidence 5，maxPerPass 1，maxTotal 8）
- `growthValueId(label: string, nodeType: "theme" | "person" = "theme")` —— person → `"p-" + slug/hash`（跨类命名空间，spec §2.6）
- person 行 attrs 读取 helper：`attrsOf(row): { role?: string; aliases: string[] }`（attrs_json 损坏 → `{aliases: []}` 宽松）

- [ ] **Step 1 失败测试**（fake store 带 node_type 行；关键场景）：

```ts
it("person 采纳：p- 前缀 id + attrs/valence(F12) 落库 + personRefs 回填", async () => { /* LLM 返回人物提案，语料 5 条含"女儿/闺女" → upsertValue 收到 (p-女儿, person, {role,aliases}, valence=1)；证据行 backfill personRefs */ });
it("别名去重：提案 alias 命中既有 person label/alias（全态）→ 拒", async () => { /* 既有 person 女儿(aliases 闺女)；新提案 label 小女 aliases [女儿] → veto */ });
it("跨类命名空间：theme 已有"咖啡"不挡 person"咖啡"，p- 前缀独立", async () => { ... });
it("QUOTA 分池：person maxTotal=8 独立计数，theme 满 15 不挤 person", async () => { ... });
it("GROW-MAINT personEv：alias 支撑的 person 锚不因 theme 口径误退场；reweight 保留 attrs", async () => { ... });
it("person.enabled=false（缺省）：零 person LLM 调用、theme 路径计数与现状一致（快照断言）", async () => { ... });
```

- [ ] **Step 2** FAIL → **Step 3 实现**：
  1. `growthValueId(label, nodeType)`：person 分支 `("p-" + 原 slug/hash 逻辑)`（theme 分支字节不变）。
  2. maint 循环（:239-256）分叉：`const aliases = a.node_type === "person" ? attrsOf(a).aliases : []; const ev = a.node_type === "person" ? personEvCount(a.label, aliases, corpus) : recountEvidence(a.label, corpus);`；reweight 调用补 `a.node_type` 与 `attrsOf(a)`（person 保留 attrs）；`if (a.node_type === "person" ? !cfg.person.enabled : true)` 守卫——person 池关闭时 person 行不参与 maint（数据缺列=undefined → 旧行为）。
  3. GROW-QUOTA 分池：`themeRows = activeNow.filter(node_type!=="person")`、`personRows = activeNow.filter(==="person")`；theme overLimit 用 cfg.maxTotal（行集改为 themeRows，无 person 行时数值恒等=现状）；person overLimit 用 cfg.person.maxTotal（enabled=false 时 personRows 恒空 → 零行为差）。
  4. person 池块（theme 采纳后、state 写之前，`if (cfg.person.enabled)`）：person LLM 调用（`buildPersonDiscoverPrompt(sampleContents, personLabelsAndAliases)`，taskId `"person-discover-growth"`，timeoutMs 0/maxTokens 0）→ `parsePersonProposals` → 去重（提案 label 或任一 alias 命中该 agent 全态 person 的 label/alias → 拒，warn 留痕）→ `personEvCount ≥ cfg.person.minEvidence` → 强度序 `slice(0, cfg.person.maxPerPass)` → 名额（pinned person + auto person 非钉 < cfg.person.maxTotal）→ 挤出（person 域内，同刻度 personEv）→ 采纳 `upsertValue(growthValueId(label,"person"), label, suggestAnchorWeight(ev, corpus.length), "auto-growth", tenant, valenceSymbol, "auto", "person", { role, aliases })`，valence= `personEvidenceMeanValence(...)` 命中行均值符号化（null → undefined 走 C2 derive 钩子）→ personRefs 回填（命中行 backfillMemoryRef(rid,"personRefs",label)）。person 采纳计入 `adoptedThisAgent`（lastAdoptedAt 语义）。
  5. config.ts：interface + 解析（`person: { enabled: bool ?? false, minEvidence: clamp 5/1/50, maxPerPass: clamp 1/1/5, maxTotal: clamp 8/1/50 }`）。
  6. server.ts 接线核验：`anchorDiscovery` 整对象透传（含 person 自动携带；FLOW-E 断言 grep）。
- [ ] **Step 4** 新测试 PASS + 既有 anchor-growth 27 用例全 PASS + commit `feat(p2-t3): anchor-growth person 双池（F11/F12/QUOTA 分池，theme 路径字节不动）`

### Task 4: identity GROW-MAINT（F20 只警告）+ identityRefs 回填

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/identity-discovery.ts`（采纳后回填）
- Modify: `MemoryCore/src/core/lifecycle/anchor-growth.ts`（`maintainIdentityFacts`，person 块后调用）
- Modify: `MemoryCore/src/config.ts`（`anchorDiscovery.identityMaintain: { enabled: boolean }` 缺省 false）
- Test: `MemoryCore/src/core/lifecycle/identity-maintain.test.ts`

**Interfaces:** `identityFactSlice(fact: string): string` —— 去掉 "- " 前缀后取前 20 字（弱口径单源）；`maintainIdentityFacts(store, tenant, corpus, logger): number`（返回失撑数，永不写库）

- [ ] **Step 1 失败测试**：

```ts
it("失撑事实只 warn 不退场（F20）：store.upsertCore 不被调用", () => { /* identity 槽 2 事实，1 条语料零命中 → warn 1 次 + upsertCore 零调用 */ });
it("仍被语料支撑的事实不告警", () => { ... });
it("采纳回填：identity 事实采纳后命中语料行 identityRefs = 20 字切片", () => { ... });
```

- [ ] **Step 2** FAIL → **Step 3 实现**：identity-discovery 采纳块（`if (ok)` 内）对每条 identityProp 计算切片并回填命中行 `backfillMemoryRef(rid, "identityRefs", slice, tenant)`；anchor-growth per-agent 循环 person 块后 `if (cfg.identityMaintain?.enabled) maintainIdentityFacts(...)`（readCore identity slot → split("\n") → 每行 ev=corpus 含切片计数 → ev===0 → `logger.warn("[GROW-MAINT] identity fact unsupported (warning-only, F20): ...")`）→ **Step 4** PASS + commit `feat(p2-t4): identity GROW-MAINT 只警告（F20）+ identityRefs 回填`

### Task 5: F14 遗忘保护

**Files:**
- Modify: `MemoryCore/src/core/lifecycle/forgetting/scorer.ts`（`ForgettingConfig` + `refProtection?: boolean` 缺省 false + `DEFAULT_FORGETTING_CONFIG.refProtection = false`）
- Modify: `MemoryCore/src/core/lifecycle/forgetting/forgetting-worker.ts`（候选排除段）
- Test: `MemoryCore/src/core/lifecycle/forgetting/forgetting-refprotection.test.ts`

**语义（spec F14 verbatim）:** forget 候选排除 coreRefs/personRefs/identityRefs **指向仍 active 的锚或现行身份事实**的记录；排除前重验 refs 有效性（锚 state='active'、身份事实仍在现行 identity 槽内容中）；悬空 refs（锚 retired/vetoed、事实已被修订替换）不保护。

- [ ] **Step 1 失败测试**（四个场景：活跃锚 refs 保护 / retired 锚悬空不保护 / person alias 保护 / identityRefs 仅当事实仍现行）：
  fake store：listValues 返回带 node_type/attrs_json/state 的行；readCore 返回 identity 槽现行内容；候选记录 metadata 携带三键族。
- [ ] **Step 2** FAIL → **Step 3 实现**：worker 在 `action === "archive"` 分支后、push 前插入（`cfg.refProtection === true` 时）：
```ts
      if (cfg.refProtection === true && isRefProtected(m, values, identityFacts)) continue;
```
  `isRefProtected` 单源放 scorer.ts：读 `metadata.coreRefs/personRefs/identityRefs`（宽松解析），coreRefs/personRefs 命中 active 锚 label 或 person alias → true；identityRefs 命中现行 identity 槽事实切片集 → true。identityFacts 由 worker 从 `store.readCore?.(filter)` 现取（runForgettingOnStore 传 filter 三元组）。
- [ ] **Step 4** PASS + 全量回归 + commit `feat(p2-t5): F14 遗忘保护（refs 指向 active 锚/现行身份事实的记录免归档，悬空不保护）`

### Task 6: O13 pending 落点（store + /v3 API + identity-discovery 持久化）

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（core_pending 表 + 三方法）
- Modify: `MemoryCore/src/core/store/types.ts`（可选方法）
- Modify: `MemoryCore/src/core/lifecycle/identity-discovery.ts`（pendingThis 块持久化，feature-detect）
- Modify: `MemoryCore/src/gateway/v2-router.ts`（路由 + 两 handler）
- Test: `MemoryCore/src/store.pending.test.ts` + `MemoryCore/src/gateway/pending-routes.test.ts`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS core_pending (
  pending_id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,              -- 'core_value' | 'strict_rule'
  content TEXT NOT NULL,
  evidence INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | adopted | rejected
  team_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  decided_at TEXT
)
```
**Methods:** `upsertPendingCore(slot, content, evidence, tenant?): boolean`（pending 状态同 (slot, content, tenant) 幂等——已有 pending 更新 evidence 不重复插；adopted/rejected 不复活）；`listPendingCore(tenant?, opts?: { includeDecided?: boolean }): Array<...>`；`decidePendingCore(pendingId, decision: "adopted" | "rejected", tenant?): { slot: string; content: string } | null`。

**Routes:** `/core-memory/pending/list`（isolation 租户，只回该租户）、`/core-memory/pending/decide`（body `{pending_id, decision}`；adopt：slot==='strict_rule' → validateCoreWrite + escapeXmlTags + `upsertCore('strict_rule', sanitized, 'panel-adopt', tenant)`；slot==='core_value' → `upsertValue(growthValueId(content), content, 0.5, 'panel-adopt', tenant, undefined, 'manual')`；标记 adopted；reject 只标记）。v3 严格隔离同款 collectV3Missing。

- [ ] **Step 1 失败测试**（store：幂等/状态机/list 过滤；routes：鉴权 401/隔离 422/adopt 落 strict_rule/decide 幂等）→ **Step 3 实现** → **Step 4** PASS + commit `feat(p2-t6): O13 闭环——core_pending 落点 + /v3 pending list|decide + identity-discovery 持久化（分级门计数保留）`

### Task 7: 渲染 person 行 + Panel BFF/身份区 pending + U2-U4

**Files:**
- Modify: `MemoryCore/src/core/hooks/soul-assembler.ts`（价值锚行过滤 person + 新「重要的人」行）
- Modify: `MemoryPanel/src/panel/http/routes/chat-memory.ts`（pendingList/pendingDecide BFF，mirror identity/read）
- Modify: `MemoryPanel/web/src/lib/api/chat-memory.ts`（ValueAnchor 类型 +node_type/attrs_json；pendingList/pendingDecide）
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/IdentitySection.tsx`（+PendingSection：列表+采纳/拒绝）
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/ValueAnchorsPanel.tsx`（U2：类型徽标/attrs 展示/aliases 反查计数/U4 查看关联记忆）
- Modify: `MemoryPanel/web/src/pages/ChatMemoryPage/components/MemoryGraphView.tsx` + `memory-graph-semantic.ts`（U3：人物节点色+图例；detail 卡 personRefs/identityRefs chips）
- Test: `MemoryPanel/tests/chat-memory-pending.test.ts` + `MemoryCore/src/core/hooks/soul-assembler.person.test.ts`

**渲染规格（spec §2.7）:** `重要的人：女儿(家人·趋近)、老周(棋友·中性)` —— listValues active 且 node_type==='person'，weight DESC cap 5；方向=valence ≥0.2 趋近 / ≤-0.2 回避 / 否则中性；空则省略整行；**价值锚行 filter node_type !== 'person'**（undefined 视作 theme，兼容旧 store）。multi-line 无——单行，置于价值锚行之后。

- [ ] **Step 1 失败测试**（soul：person 行渲染/方向标注/cap 5/空省略/价值锚行不含人物）+（Panel：pendingList 透传 idFields/decide POST 传参/403）→ **Step 2** FAIL → **Step 3 实现** → **Step 4** PASS + MemoryPanel vitest 106 基线不破 + commit `feat(p2-t7): 灵魂渲染「重要的人」+ Panel pending 闭环 + U2-U4`

### Task 8: yaml 配置落地 + 文档

- `MemoryCore/tdai-gateway.yaml`：anchorDiscovery 加 `person: {enabled: true, maxPerPass: 1, maxTotal: 8}` + `identityMaintain: {enabled: true}`；forgetting 加 `refProtection: true`（先查 forgetting 配置节名，随 Task 5 落点定）。
- CHANGELOG.md 前插 P2 条目；计划文档追加执行记录；v5 O13 标注 P2 落地。
- commit `docs(p2): 配置落地+CHANGELOG+O13 落地标注`

### Task 9: P2 SOP 实机验收（ev6_* 新对抗数据 ≥12 组）

- 种子（新前缀 ev6-，幂等直插 + 全管线对话混合）：租户 P=人物事实×6（女儿 3 条[含 1 条用别名"闺女"]、老周 2 条[负向 valence 语料]、无关名"张三"1 条[F11 弱点实测]）+ 主题锚语料×4 + agent 行为×2 + 对抗（纯状态/XML 注入/串味人物"AI 是女儿"）×3；租户 Q（换用户）=异人物×3；租户 R（换 agent）=仅 agent 行为×2。**合计 ≥16 组**。
- 重启 → tick → 断言：person 锚采纳（p- id/role/aliases/valence 符号）、别名归并（张三虚增不上锚——若上锚则按 F19 已登记弱点记录实证）、QUOTA 分池、personRefs/identityRefs 落 metadata、pending strict_rule 落库且 /v3 决策回路 adopt→strict_rule 槽渲染、recall 注入「重要的人」行+方向、F14：造一条老记录（updated_time 回拨+refs 指向 active 锚）→ 不归档；悬空 refs 对照 → 归档。
- 换用户 Q/换 agent R：人物零串租户。
- 全量回归（521+ / 106+ / 243）+ web build + panel 重启 + intervalMs 还原。
- evidence 表 → 文档执行记录 → goal 完成判定。

## Self-Review

1. **Spec 覆盖**：§2.6（双列/双池/跨类命名空间/读路扩列/单一源）→T1/T3；§2.7 渲染→T7；F11/F12→T2/T3；F14→T5；F15 分池+身份分支→T3/T4；F19 双门实例化→T3；F20→T4；O13→T6；U2-U4→T7；U1 编辑入口（P2）→T7 身份区 pending+槽编辑（pending 采纳即人工写入入口；槽直编辑仍走既有 core-memory/write 面板通道，不新增）。✓
2. **占位符扫描**：无 TBD/TODO；所有代码块可编译级。
3. **类型一致性**：node_type `"theme"|"person"` 贯穿 T1/T3/T5/T7；`attrsOf` 单源 T3；`backfillMemoryRef` 键族枚举 `"coreRefs"|"personRefs"|"identityRefs"` 贯穿 T1/T4/T3。✓
