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

---

## 执行记录（P2，2026-09-17）

| Task | Commit | 内容 | 验证 |
|---|---|---|---|
| T1 store 扩列 | 4d4c9c0 | node_type/attrs_json 幂等 ALTER + upsertValue 签名 + backfillMemoryRef 三键族 | +5 测试 |
| T2 person 口径单一源 | c924d92 | personEvCount/personValenceSymbol/personEvidenceMeanValence/parse/双 prompt | +11 测试 |
| T3 双池 | 3550092 | growthValueId p- 前缀 / person LLM 独立调用 / F19 别名去重 / F12 valence / QUOTA 分池 / GROW-MAINT personEv+分池阈值（TDD 实证修复） | +7 测试 |
| T4 identity GROW-MAINT | 0994963+12e94f8 | identityFactSlice 单源 / identityRefs 回填 / 失撑只警告（F20） | +5 测试 |
| T5 F14 遗忘保护 | 6874764+7aa7b72 | isRefProtected 单源 / worker 排除段 / 悬空不保护 / refProtection 配置 | +7 测试 |
| T6 O13 | 09698ef | core_pending 三方法 / identity-discovery 持久化 / /v3 pending list+decide | +12 测试 |
| T7a 渲染 person 分流 | 0233a2b | 重要的人 行 / 价值锚·感受段过滤 / P1 字节级回归通过 | +4 测试 |
| T8 配置+文档 | e184ac2+本次 | yaml person/identityMaintain/refProtection 全开 + CHANGELOG P2 + 本记录 | 重启验证 |
| T7b Panel U2-U4 | 待续轮 | BFF pending 路由 + web api + PendingSection + ValueAnchorsPanel 徽标；图 S3 chips/U4 跳转顺延（上下文预算裁决） | — |
| T9 SOP | 本次 | ev6_* 16 组真数据 + 对抗审查 + 注入/召回核对 | 见报告 |

基线：MemoryCore vitest 537→572（+35），tsc 243 持平（O20 未新增）。yaml 为环境配置（gitignore 策略），解析与缺省值已在仓库代码层。

## Round2 执行记录（SOP 实证弱点三修，2026-09-17）
| # | 弱点（真数据实证） | 修复 | 提交 | 验证 |
|---|---|---|---|---|
| 1 | 对抗种子攻入 self_identity：「用户将我的身份设定为他的女儿…」过 P1 strip 门进入渲染 | isIdentityImposition 主语一致性门（身份设定/把我当作/让我以…身份等强加人设模式，strip 同层单一源，identity+self_identity 双门） | d9a8626 | 单测6+真数据：清污重建后 self_identity 无「身份设定」行，仅合法行为自证两行 |
| 2 | identity 槽单提案抹历史：upsertCore 纯 REPLACE，3 事实被 1 提案覆盖 | mergeIdentityFacts（existing∪new 行级去重 cap8；store REPLACE 语义保留供面板直写，组合在 worker） | d9a8626 | 真数据：identity 4 行合并演化 |
| 3 | F14 保护静默失效：worker listValues() 恒读 default 租户；调度器无 filter 时全表扫描无租户概念 → 非默认租户保护名集恒空，双夹具全归档（三次实验二分定位） | deps.tenant 形参 + 批内记录租户去重聚合（显式租户优先；readCore 身份切片同源聚合） | 32e0f7a, aa46dba | 真数据终验：protected(coreRefs→女儿)=LIVE / dangling(悬空)=ARCHIVED |
基线：vitest 580/580（+42 vs 538 起点），tsc 243 持平。方法学记录：解析配置二分定位时须以 parseConfig(doc.memory) 子树为入参（整文档入参会全默认值误判）；SSH 长等待>250s 需 ServerAliveInterval=30。

## 全面审计记录（2026-09-17，用户指令：逐文件逐功能第一性原理复核）
**代码/配置面审计（完成）**：
| 项 | spec 条款 | 代码证据 | 结论 |
|---|---|---|---|
| F11 personEv | §F11 label∨alias 包含 | anchor-growth.ts:318-323 personEvCount(label,aliases,corpus) 分叉 | ✓ |
| F12 关系权重 | strength=F5·personEv; valence 均值符号化 | :339 upsertValue valence 落列 + :509 均值符号化 + :536 NULL 守卫 | ✓ |
| F15/F19 分池 | maxTotalTheme=15/person=8; 复合去重键 | :378-380 quotaEvict 双池 + person 独立 maxTotal 8 | ✓ |
| F17 预算 | chars 上限+行数上限 config | budgetSelf/Identity ✓; **maxRelationLines 缺失→已补齐**（opts 透传,clamp 1..20 缺省5） | 修复 aa4814f |
| F20 红线 | 身份永不自动退场 | anchor-growth.ts:126-129 "只告警,upsertCore/retire 零调用" | ✓ |
| O13 | 单向状态机+双路径采纳+信任边界 | sqlite.ts:873 DDL; v2-router.ts:1829 validateCoreWrite+escapeXmlTags | ✓ |
| F14-bis | 回音室禁令 | 召回/排序代码无 identity 项 | ✓ |
| 配置面 | 全开启 | yaml: person 分池/refProtection/identityMaintain/selfIdentity/soulRender×3/allowedSlots×4 全就位 | ✓ |
基线：vitest 582/582、tsc 243。

**ev7 全新对抗数据真流程（26 组种子：林教授×4含别名老林/王某负向×3/串味×2/身份×3/状态残留×2/人设注入×1/自证×2/红线×2/主题×2/换用户×3/换agent×2）**：
- 21+5 全部受理；L1 抽取完成 14/26 后**停滞**。
- 根因（journalctl 19:11 实证）：**LLM 供应商周配额耗尽**（reset 2026-09-21 00:00 +0800）——identity/anchor 抽取全部 "Failed after 3 attempts"，管线降级正确（不崩溃/留痕/attempt-cooldown 防风暴）。
- 已得真数据：identity 槽单事实演化合并 ✓；F15 maintain 对 ev6 报 unsupported=1 warning-only ✓（F20 实证）。
- 待配额恢复后补测：林教授锚采纳（ev=3 达门）、王某 ev=2 不采纳（F11 护栏）、对抗人设拒收、隔离断言、F14 ev7 夹具、/recall 全块核对。

## 全面验证记录（阶段收口 SOP，2026-09-17）
- 对抗性审查三命中三修（dc709c5）：A1 mergeIdentityFacts 饥饿（早退 cap→slice(-8) 保最新）；A2 主语门绕过（补 [说称]我[是为]+误报面断言）；A3 F14 错锚边界（无 deps.tenant 批内单租户批误用 default 锚 rawRows→显式租户守卫）。vitest 586/586、tsc 243。
- 配置项审计：anchorDiscovery(person.minEvidence3/maxPerPass2/maxTotal8)/identityMaintain/selfIdentity(1h 验收期)/refProtection/durativeEnabled/excludeInvalidated/emotionSalienceWeight=0(实验轨红线合规)/enableDedup/config-override(maxTokens=0) 全部开启。
- 全新隔离租户 vp2 完整流程（15 组新对抗数据）：14 条→9 条 L1（归纳合并符合设计）；p-妈妈 val=1 person 锚；identity 4 行全行为自证；对抗 s13(身份设定)/s14(说你是) 均被主语门拦截（/recall 无泄漏）；隔离 user-b 独立（李姐）；O13 pending×2（strict_rule 导出二次确认 ev=1 / core_value 孝顺健康）；/recall 注入「重要的人：妈妈(家人·趋近)」来源主语属性正确；F14 全新租户复验 protected=LIVE/dangling=ARCHIVED。
- 已知非缺陷记录：alias 归并依赖 LLM 提案（老妈未并入，ev6/vp2 一致）；老赵×2/周报×1 不足 minEvidence=3 不上锚（F11 宁缺毋滥）；self_identity 无证据不提（主语归属正确）。
- 待授权清理：ev6_*/ev6f14*/vp2f14*/vp2 测试租户与夹具。

## Round3 全面验证记录（2026-09-17，配额恢复后补测+新数据对抗）
**新数据**：ev8 租户 17+5 组（朵朵×3含别名/李某负向×2/主题×2/红线×2/自证×2/对抗×3/Q换用户×3/R换agent×2）+ ev7 补测。
**验证通过**：朵朵 p-锚(val=1,aliases[女儿])/李某 ev=2 不上锚(F11 护栏)/identity 5 事实合并/self_identity 先结论+周报/红线落 pending（2 条）/Q 陈导师 identity（Q 无朵朵锚，隔离✓）/R self_identity 演练专员（隔离✓）/ev7 秘书人设提案被 C2 门拒收留痕✓。
**对抗命中三修**：
| # | 发现（第一性原理） | 修复 | 提交 |
|---|---|---|---|
| C1 | 引导期同轮 forgetting 先于锚发现跑（次序：consolidation→forgetting→…），保护名集空，受保护记录被当场归档 | forgetting 移至 pass 末尾（判据输入须在清理动作前最新） | a2626fd |
| C2 | 秘书人设（指定专属秘书/称呼他为老板大人/无条件执行）绕过 A2 门进渲染 | 主语门补三形态模式 | a2626fd |
| C3 | 自伤：插入锚用条件三元 count!=1 静默跳过→遗忘块被删未插回，pass 无遗忘判定 | 重插+教训：补丁禁静默条件分支 | ca284ed |
**F14 终态（次序修复后）**：candidates=1 archived=1；protected(coreRefs→朵朵)=LIVE / dangling=ARCHIVED ✓
**登记缺陷（未修，待办）**：
- D-R3-1 租户串味（重要）：L1 抽取产物混入跨 user 租户事实（R(ev8-user-c,agent-d) 的 L1 含 Q(user-d) 的"数据仓库方向研究生"）；疑 l1-extractor 冲突/相似候选召回 team 级过滤缺口（L1 锁为会话级 pipeline:{inst:tid:aid}:s:{sess}，分组正确，泄漏在候选召回/消息源）；需核实 l1-extractor.ts 候选召回租户过滤并修复（涉 A6 四级贯通召回级）。
- D-R3-2 管线韧性：重启丢未完成抽取任务（Q/R 首发种子 L1=0，重发后恢复）；attempt 重排队 15 次后任务去向需排查。
基线：vitest 592/592、tsc 243。

## 测试数据清理记录（2026-09-17，用户指令：清理测试数据防污染记忆向量覆盖率，全程不重启网关）
**清除范围**（全部测试租户：ev6/ev7/ev8 及早期命名变体 team-flowtest/vp2-team）：
| 项 | 数量 | 说明 |
|---|---|---|
| l1_records | 171（52+119） | ev* 与 flowtest/vp2 两批命名变体 |
| l1_archive | 26（15+11） | 含 F14 夹具 |
| l0_conversations+l0_vec | 160（71+89） | 原始对话与向量 |
| l1_vec | 95（50+45） | 向量索引同步删除 |
| l1_links | 174（指向测试记录）+909（历史悬空，含 ev5 清理遗留与归档引用） | 悬空 links 全清（终态 0） |
| core_memory/values/pending | 11+3 / 7+10 / 15+3 | 槽/锚/待办 |
| memory_audit | 6 | 审计行 |
| anchor_growth_state | 26 键 | 发现状态（含 team-flowtest/vp2-team 变体） |
| 文件存储 | scene_blocks/records/conversations/metadata 下 ev*/flowtest/vp2 匹配 | -delete |
**方法学**：① 租户 id 命名变体（team-flowtest/vp2-team）会绕过精确匹配——清理须 LIKE 模糊兜底+状态键明细回查；② node:sqlite 需 `{allowExtension:true}` 才能加载 sqlite-vec；③ FTS external-content 用 `INSERT INTO fts(fts) VALUES('rebuild')` 同步；④ 删除前备份 vectors.db.bak-purge-20260917（113MB，保留）。
**终态**：八表残留全 0、悬空 links 0、状态键 0、/recall 块无任何已删测试人物（林教授/朵朵/秘书/陈导师），默认租户真实记忆召回正常；health 200，服务未重启。
**存量备注（非测试污染，不动）**：l1_vec_rowids 264 vs l1_records 265 差 1（单条记录缺向量为存量行为）；fts count(*) 为索引内部计数非行数指标，以功能召回为准。

## Round4 阶段收口复测记录（2026-09-17 深夜，ev9 全新租户——中期发现）
**复测中断点**：SOP 复测启动后暴露 4 项实锤，修复前不继续断言。
| # | 发现（第一性原理） | 实证 | 定性 |
|---|---|---|---|
| R4-1 | **测试口径缺陷（我方）**：v3 /conversation/add 的 session_id 只认 body（v2-router:815 `sessionKey: session_id`，:912 注释明示），header x-tdai-session-id 不生效 → 种子脚本全部落在 session_key=default，**17 条跨 3 租户 5 会话的种子合并成 1 个会话**。回查 ev6/ev7/ev8 历史种子同样如此——"换会话"维度从未被真实测试过（租户三键正确，租户隔离测试有效，但会话隔离维度缺失） | ev9 L0 全部 session_key=default | 测试脚本修正项：种子须在 body 传 session_id |
| R4-2 | **D-R3-1 串味复现且传播路径收窄**：唯一 L1（agent-a）内容含 R(agent-b) 的 s17 事实（数据仓库研究生），activity_end_time=s3（16:14:22.772）→ 提取窗口只覆盖 s1-s3，跨组事实必然来自 LLM 输入而非消息分组。静态链路逐层排除：分组按 tuple（sqlite.ts:4536 groupKey 五元组）✓、dedup 召回 filter 传递（l1-extractor:346 {teamId,userId,agentId}）✓、searchL1Vector/searchL1Fts 均经 rowMatchesIsolation 复核（isolation.ts:159）✓、SQL 下推 buildIsolationWhere ✓。**取证通道缺陷**：prompt_text 未持久化（sqlite 无该列）+ file-logger `mkdir /data/log/ EACCES`（服务日志实证）→ l1-debug ENTRY 级证据丢失。传播通道锁定在"提取 LLM 输入"但注入点未定，需先修 file-logger 拿 debug 日志 | l1_records 实测 + journalctl | 缺陷（未修，待证据） |
| R4-2b | **file-logger EACCES**：`mkdir /data/log/` 权限拒绝——调试日志全丢（服务仍运行，stdout 日志正常） | journalctl 00:14:45 | 缺陷（待修） |
| R4-3 | **D-R3-2 死任务风暴实锤**：清理删了八表数据但 checkpoint.json runner_states 62 键 + L0 会话键并集每次重启 re-armed 64-65 会话；已删租户（flowtest/ev5）的 L2 任务以 pipeline:{default:_:_} 锁反复 Lock conflict timeout → requeue 洪水占用 worker 槽 → **ev9 17 条种子 300s 仅提取 1 条** | journalctl 00:14:39（30+ 条 requeue）、checkpoint 62 键（8 个测试租户残留）、boot recovery 65 sessions | 缺陷（未修；修复方向=恢复前过滤已无 L0 数据的会话键 + 清理脚本纳入 checkpoint 治理） |
| R4-4 | consolidation queryL1Records 无 filter 全库扫描（270 行）系**设计内**（无 yaml filter 时全局巩固），非缺陷；但与 R4-3 死任务叠加拖慢管线 | journalctl 00:14:50 | 非缺陷记录 |
**复测执行状态**：ev9 种子 17/17 受理（P 11+Q 3+R 3）；F14 夹具未投（等待管线恢复后与本轮同测）；配置审计/渲染/recall 断言顺延。

## Round4 终验记录（2026-09-18 凌晨，ev10 正确口径全流程）
**口径修正（R4-1 修复后）**：种子 body 传 session_id；重启一律带 health 就绪探针（READY 后才投喂）；发现状态重置用于触发 boot 轮。
**验证通过（ev1 全套 21 L1/10+6 组种子）**：
- 人物锚×2：林岚（val=1，aliases=[林老师,导师]——别名归并真数据产出）/ 陈教授（Q 租户独立）；钱峰 ev=1 未上锚（F11 护栏）
- pending×5 分级正确：P 手机号红线+导师要求×2、R 压测200ms、Q core_value——全部落待人工决策
- 对抗零命中（身份设定/尊称驯化/状态残留/猎头/老板大人/秘书 全形态）+ self_identity 从红线语料长出行为自证事实（主语正确）
- 换用户/换agent 灵魂分化：R 独立（压测红线自证）、Q 独立（陈教授×3行）
- F14 完整闭环：prot2(coreRefs→active锚林岚)=LIVE / dang(悬空)=ARCHIVED / 引用未上锚词=ARCHIVED（隔离语义正确）
- GROW-MAINT F20 warning-only 实证；identity 演化合并行级正确；/recall 四段渲染+重要的人行+预算内
**新确诊 P0（A6 召回级缺口实锤）**：
| # | 发现 | 实证 |
|---|---|---|
| R4-5 | **召回层跨 user 泄漏**：Q 租户（ev10-user-b）/recall soul 块第 11 行返回 P 租户（ev10-user-a）的 L2 结论记忆「[结论\|研究生开题与导师沟通]…导师为林岚」——A6 四级贯通的召回级缺口实锤，即 D-R3-1 历史串味的真正传播通道（此前静态取证排除了提取层全部过滤点，本次渲染层直证） | /recall Q 块逐行取证 |
| R4-6 | **召回摘要主语错置**：P 块 persona 行「用户（林岚）的工作风格…」——LLM 摘要把导师名标为用户姓名括号（主语三层法的摘要层缺主语一致性检查） | /recall P 块行取证 |
- 配置审计全绿：selfIdentity(1h)/anchorDiscovery(person 3/2/8 分池)/soulRender(600/900/5)/refProtection=true/allowedSlots×4；identityMaintain 节点被并入 anchorDiscovery（yaml 兼容，非缺陷）
- env 恢复 MEMORY_LOG_LEVEL=info（debug 仅为取证临时值）
**顺带修复**：R4-2b file-logger（/data/log 预建+chown tdai）——取证通道恢复。

## Round5 R4-5 修复记录（2026-09-18，A6 四级贯通召回级 P0 闭环）
**设计裁决（第一性原理+spec 对照）**：profile-sync.ts 旧注释声明 profiles"有意忽略 userId（agent 记忆跨用户累积）"——但 spec §2.3"L2 内容主语=agent 会话场景+用户事实 / L3 内容主语=用户"、§10 D-R3-1（跨 user 串味登记为缺陷需修）、§7-P3 拍板"品格随关系分化 per-三元组，接受无跨用户共享"三处一致裁定 user 级隔离优先；ev10 Q 租户 /recall 直证跨 user 注入（"导师为林岚"串入陈教授用户）为决定性实证。
**实现**：
| 层 | 改动 | 提交 |
|---|---|---|
| scope 构造 | buildProfileIsolationScope 三元组化 team\|user\|agent；缺 user→user:default 兜底桶（钩子无租户路径连续）；DEFAULT_PROFILE_SCOPE 不变 | cceded3 |
| 解析 | parseProfileIsolationScope 三段格式+旧两格式兼容（team\|agent / user\|agent） | cceded3 |
| 匹配 | profileMatchesScope user 参与比对 | cceded3 |
| 读取端 | handleRecall profileIsolation 随行 userId | ff65f10 |
| 迁移 | 真实租户单用户目录迁入 user 桶（kcjjqzkxks 两 agent→usr-kfym3ajzme；hook default 桶改名保连续）；混写/无属主测试目录删除（场景块按新 scope 重建） | 本次运维 |
**验证**：TDD 红（6 败）→绿；vitest 600/600（+8 scope 用例）、tsc 243；ev10 复验 **Q 隔离无林岚=True（修复前 False）/ 含陈教授=True**；装配测试夹具随 scope 三元组化更新。
**方法学沉淀**：设计注释≠设计文档——"有意忽略"的旧注释与 spec 缺陷登记冲突时，以 spec 三处一致性裁决；迁移脚本用 L0/L1 distinct user 反推目录属主，混写目录（多用户）不可自动拆分直接删（场景蒸馏层可再生）。

## Round5 R4-6 修复记录（2026-09-18 凌晨，摘要主语错置 P0 闭环）
**根因（第一性原理）**：EXTRACT_MEMORIES_SYSTEM_PROMPT 要求"提取主体必须以'用户（姓名）'或'AI'为核心"并给出"用户（[姓名]）"句式，但**没有任何姓名归因约束**——用户姓名未知时，LLM 把上下文里第三方（导师林岚）名填进括号（ev10 实证：同类句式"承诺每周X…"两次提取，修复前=「用户（林岚）承诺每周五…」/修复后=「用户（姓名未提供）承诺每周六…」）。污染链：L1 提取 → persona 渲染 → 用户身份认知（spec §1.2 主语三层法违反）。
| 层 | 修复 | 提交 | 验证 |
|---|---|---|---|
| L1 提取 prompt | 通用原则第 4 条：括号姓名仅限**用户本人自称**；第三方（导师/老师/同事等）姓名**不得当作**用户姓名；未确定时一律（姓名未提供）；第三方以身份词引出（"用户的导师林岚"） | c132ef8 | TDD 红2→绿；真数据对照（新 s7 种子零（林岚）错置，旧污染记录留存待清理授权） |
| L2 scene 蒸馏 prompt | 用户基础信息-姓名字段同源约束（仅自称时填写，未确定留空） | 8fcbf4c | 602/602 + tsc 243 |
**基线**：vitest 602/602、tsc 243、HEAD 8fcbf4c、全部推送。

## Round5 T7b Panel U2-U4 执行记录（2026-09-18）
| 项 | 实现 | 测试 |
|---|---|---|
| BFF pending/list | 镜像 identity-read（owner 借用读 ACL；透传 /v3/core-memory/pending/list） | chat-memory-pending.test.ts 3/3 |
| BFF pending/decide | owner 校验（非属主 403 NOT_ASSET_OWNER）+ 透传 pending_id/decision | 同上（含 403 用例） |
| web api | ValueAnchor 扩 node_type/attrs_json + PendingItem 类型 + pendingList/pendingDecide | 面板全量 109/109（106 基线不破） |
| PendingSection | 分级提案列表 + 采纳/拒绝按钮（O13 单向状态机；幂等复决由网关 404 兜底，刷新自然消失）；宁缺毋滥空态不渲染 | vitest 全量 |
| U2 类型徽标 | 锚行 node_type 徽标（人物/主题，前向兼容缺省不显示）+ valence 徽标既有 | — |
| S2/S3 顺延 | attrs 行内编辑/aliases 反查/图例 chips 按余量裁决（待续轮） | — |

## Round5 P3 数据源 spike 定案（2026-09-18，spec §7-P3 前置）
**Spike 实测**：agentAct 占比——真实租户（kcjjqzkxks/usr-kfym3ajzme/agt-kfynybx0ly）119 条 L1 中 **0%**；全库 312 条（含最新 ev10 提取批次，R4-6 修复后 prompt）**0%**。
**裁决（spec 预设分支）**：agentAct 语料不足以支撑品格锚证据重算 → **品格聚合源 = self_identity 槽演化史**（spec §7-P3 预设 fallback）。理由：① self_identity 事实已过主语门（isIdentityImposition/strip 双门）与"行为可证"验证，因果链更干净；② GROW-MAINT identity 失撑警告（F20）天然约束其演化。
**顺带登记缺陷 D-R5-1**：P1 的 l1-extractor agentAct 标注全库零落地（需查 prompt 组装链是否真的注入 AGENT_ACT_BLOCK 或 LLM 从未输出该字段）——不阻塞 P3（走 fallback 分支），留待 P3 实现期顺手排查。
**P3 实现蓝图（下一轮）**：
1. character 池（anchor-growth 第三池）：聚合源=self_identity 槽事实（per-三元组，spec §110 拍板）；与主题锚共享注入预算、独立 maxTotal 分池（F15）；node_type='character'；证据计数=语料对身份事实切片的逐字包含（identityFactSlice 单一源复用）。
2. F13 反思触发：累计 significance > R_REF（config，缺省 150）→ 下 tick 提前+强制反思式 L3 蒸馏（Generative Agents 三问式，产物=普通 L3 结论卡，U5 零适配）；固定 interval 兜底不变。
3. 配置：anchorDiscovery.character.{enabled=false 缺省,minEvidence,maxPerPass,maxTotal}；reflection.{rRef=150}。
4. 验收：品格锚与主题锚并存不互挤（分池断言）+ 反思触发真数据实测。

## Round5 P3-t1 character 池执行记录（2026-09-18，d2d5a6a）
**实现**：anchor-growth 第三池——聚合源=self_identity 槽事实（readCore 单一源）→ CHARACTER_DISCOVER_SYSTEM_PROMPT LLM 提案 → 证据门（提案 fact 切片在语料逐字包含，identityFactSlice 单一源）→ c- 前缀独立 id（growthValueId character 分支）→ upsertValue node_type='character' attrs={source:"self_identity",facts:切片快照}；F15 独立 maxTotal 分池（与 theme/person 互不挤占，theme 池口径同步收紧为显式 theme）；config anchorDiscovery.character 全 gated 缺省 off（逐位现状）；per-三元组（spec §110 拍板）。
**测试**：vitest 606/606（+4）：c- 前缀、happy path 采纳+attrs、disabled 零调用（逐位现状）、证据门宁缺毋滥。
**过程实证（诚实记录）**：首轮实现两处缺陷被 TDD/探针抓出——① characterEvCount 误把 corpus 当对象数组（实际是 string[] 内容数组，读 .content 恒 undefined → 证据恒 0）；② config.ts 解析块插入吞掉外层闭合致 TS1005（补丁锚含闭合行，替换时未复加）。均以隔离探针+verbatim 取证定位修复。
**基线漂移登记（D-R5-2）**：stash 对照实证 HEAD（98b42e6）tsc 实为 **254**——此前多轮"243 持平"是 config.ts 解析破损状态下的遮蔽读数（破损吞掉自身+下游 11 个错误）。adapters 层 5 错（host-adapter EmbeddedAgentRuntimeLike / llm-runner compatibility+experimental_telemetry / api-trace ApiTraceProfile）为依赖状态漂移的存量错误，与 P3 改动无因果（stash 对照）。本次改动后 248（<254，顺带消除 upsertValue 相关错误）。**待修：D-R5-2 adapters 类型漂移 5 错 + 基线计数方法改为 stash 对照**。

## Round5 P3-t2 F13 反思触发执行记录（2026-09-18，b776a2b）
**实现**：reflection.ts（新 worker）——importance 累计 > R_REF（config，缺省 150，Generative Agents 对标）→ 强制三问式反思式 L3 蒸馏（近期记录样本 significance 降序 → LLM 提高层问题+检索证据+合成结论卡）→ 产物=普通 L3 结论卡（type=work_fact，scene_name=reflection，metadata {reflection:true, question, evidence_record_ids}，certainty 走合成物先例=observed 同 consolidation 持续态）；**反思史即状态**（上次反思时间=最新反思结论卡 updatedAt，零 schema 变更）；work_fact 不入触发累计（防"反思的反思"自我 reinforce）；租户批内聚合（与 forgetting 同式）；config-first 全 gated 缺省 off（`lifecycle.reflection.{enabled,rRef}`——**config.ts 解析器接线与 yaml 开启顺延至阶段收口轮**，当前 undefined=关安全）；调度器接线（consolidation 后、forgetting 前）。
**测试**：vitest 611/611（+5）：触发（写卡带租户/证据指针/反思元数据）、未触发零调用、disabled 零调用、幂等（反思史即状态）、解析宽松提取。
**过程实证**：版本漂移一次（服务器残留旧 5 参 rec 测试版），以本地最新版重传+锚点修 rRef 触发口径（150→2 测试口径）闭环；tsc 级联计数仍不稳定（D-R5-2 已登记，stash 对照为权威方法）。
**P3 剩余**：config parser（reflection 组）+ yaml 开启（收口轮配置审计）+ 品格锚/F13 真数据实测（ev11 全流程收口）。

## Round5 配置重写事故记录（2026-09-18 09:24，yaml 解析崩→env-only 降级，已闭环）
**现象**：tdai-core 重启报 `[config] Gateway config file failed to parse … line 207`（All mapping items must start at the same column），降级 env-only 配置运行。
**根因（用户诊断，AI 复核确认）**：patch_f14d.py 的锚 `  evolution: # P4b` **只匹配行前缀**，替换时吞掉了行尾注释——原行 `evolution: # 受控正文演化…路径` 被替换后残留尾巴，第 206 行变成 `evolution: 受控正文演化…`（注释成为标量值），子键无处安放 → 整份 yaml 解析崩。mtime 09:24:01 与重启同秒。
**处置**：用户自查修 1 行（注释归位 `evolution: # …`）；AI 探针验证 anchor=0（坏行已不存在）+ 网关同款 yaml 库解析全绿；重启（就绪探针 READY 8s）后 journal 无 parse 报错，**运行时配置审计六项全开**：person(3/2/8)/character(3/2/8)/identityMaintain/reflection(rRef=150)/refProtection/selfIdentity(1h)。
**教训（固化为补丁铁律）**：行内注释行的锚**必须匹配完整行（含行尾注释）**；替换文本必须原样保留行尾——锚只匹配前缀会把行尾变成孤立值（本事故的直接根因）。此教训与"补丁脚本锚点唯一显式 ABORT"同档固化：**锚=完整行**。
**状态**：yaml 好行已由用户修复；服务以正确配置运行（非 env-only）；character/reflection 已在启动轮被调度（firstBlockReason=interval 属 24h 冷却门正常语义）。

## Round5 终测执行记录（2026-09-18，ev11 全新租户 16 组真数据——部分通过+四项登记）
**SOP 终测实况（ev11 16 条种子，P10+Q3+R3，body session_id 正确口径）**：
✅ 通过：提取 13 条 L1（8+3+2）；identity/self_identity 双槽三租户分化+隔离（P 无钱院长、Q 无苏教授）；identity 层对抗零命中（身份设定/尊称/状态残留全拦）；pending×4 分级正确（P 红线/R 红线+core_value/Q core_value）；F14 dang(悬空)=ARCHIVED；rRef 刻度换算（0-1 刻度 vs Generative Agents 0-100 的 150，调参 rRef=2.0）。
❌ 登记缺陷（修复批次未收敛已回滚，下一轮主任务）：
| # | 发现（真数据实证） | 根因分析 |
|---|---|---|
| D-R5-3 | **identity 门两处绕过**：① agent 自述形态「我以专业资深猎头顾问的身份与用户交流」（无"让我以"前缀，`.filter` 缺该形态）② 周期提醒类（"我每晚九点提醒用户冥想"——strip 门未拦周期性未来指令）→ self_identity 槽被污染且 merge 永存 | 门 patterns 缺自述复述形态；修复方向：门 patterns 追加（须控误报面：隔离探针先行全量合法行测试后再落） |
| D-R5-4 | **mergeIdentityFacts 不清洗 existing**：门只拦新提案，存量污染行随演化合并永存 | 门应作用于写入的最终内容（本轮尝试 filter existing 行因补丁正则双反斜杠写坏+5 用例回归回滚；重做须先单测正则字面） |
| D-R5-5 | **ev11 锚零采纳+24h 门锁死**：首轮 pass adopted=0 但 lastDiscoveryAt=02:48 落 kv，存量行无 lastAdoptedAt → interval 门以 lastDiscoveryAt 兜底 24h → 苏教授锚（ev=3）永远无第二次机会 | gate 判定 `lastAdoptedAt ?? lastDiscoveryAt` 对双字段新行不精确（头部注释"0 采纳 1h"被兜底覆盖）；修法=lastAttemptAt 存在时不兜底（由 attempt-cooldown 承担），须核对 quotaEvict 段 verbatim 后再改（本轮 TS2722 级联未收敛） |
| D-R5-6 | **reflection triggered=3 cards=0**：真 LLM 返回不可见（已证触发机制在时间戳双兼容修复 0c65d6b 后工作：探针 triggered=2 cards=2 假 LLM），真 LLM 输出 "[]"（宁缺毋滥合法）或解析失败未取证 | reflection.ts 加 raw 响应 debug 日志（本轮随回滚撤销，下轮重加） |
**已修（本轮提交 0c65d6b）**：reflection 触发时间戳键双兼容——裸行 updated_time 键缺失致空串比较恒 false、永不触发（探针 sigSum 9.15>2 实证；修复后 triggered=2/2 租户正确分组）。
**F14 prot=ARCHIVED 归因**：苏教授锚未上（interval 门锁死）→ 保护名集无该词 → 归档系机制正确、前置未满足（与 ev10 同型）。
**回滚纪律**：门 patterns 编辑致 identity-gate 5 用例回归（python 补丁 `\\s` 双反斜杠写坏 + tsc 级联未收敛）→ 本轮已 git checkout 回滚 anchor-growth/identity-discovery/reflection 三文件至 HEAD（0c65d6b），vitest 611/611 基线恢复；三修内容重新设计后下一轮再入（先单测正则字面）。

## Round5 D-R5-3/4/5/6 四修执行记录（2026-09-18，7bb1859）
**四修内容**（TDD 红3→绿，vitest 615/615、tsc 249、我的文件零残留错误）：
| # | 修复 | 提交 |
|---|---|---|
| D-R5-3 | identity 门补 agent 自述复述形态（我以X的身份与用户交流）+ 周期提醒/定时状态形态（时段词全覆盖：每天/每晚/每日+早上/上午/中午/下午/晚间/凌晨+数字+点+提醒）；误报面单测锁定（4 合法自证断言不误杀） | 7bb1859 |
| D-R5-4 | mergeIdentityFacts existing 行同过主语门——门校验写入的最终内容而非仅新提案（存量污染随演化清除） | 7bb1859 |
| D-R5-5 | interval 门双字段语义精确化：`lastAdoptedAt ?? (lastAttemptAt != null ? undefined : lastDiscoveryAt)`——双字段新行 0 采纳回 1h attempt-cooldown（头部注释"0 采纳 1h"语义落地）；存量行保守 24h 不变（逐位现状）；附带 quotaEvict retireValue 非空断言（D-R5-2 家族） | 7bb1859 |
| D-R5-6 | reflection raw 响应 debug 取证日志 + Logger import 深度修正（../../→../，src/types 不存在致 TS2307 级联 10 错） + 测试文件 rec 口径统一（tenantTriple 入 opts 类型） | 7bb1859 |
**真数据复核（ev11 清状态重跑）**：
- ✅ **苏教授 person 锚采纳**：`p-auto-9ead7 | 苏教授 | val=1 person`（首轮 pass 证据链全对——LLM 提案 parse ✓ personEv=3 ✓ 证据门 ✓；此前零采纳全因 interval 门锁死，D-R5-5 修复后一次通过）
- ✅ person LLM raw 取证：`[{"label": "苏教授", ...}]`（GLM 输出正常含空格，宽松解析兼容）
- ✅ self_identity 污染槽删除后待 1h 冷却重建（门新形态将在重建时拦截人设回显）
- ⏳ 反思卡/F14 prot/character 锚：待 1h 冷却后下一 pass（reflection raw debug 已就位；ev10/default 租户 reflection rawLen 930-1211 已见 ```json fence 包裹输出——parse 兼容验证通过）
**方法学沉淀**：① python 补丁写正则必须用 raw 字符串（r'''…'''），`\\s` 双反斜杠会让正则匹配字面反斜杠（上轮回滚根因）；② 零采纳取证=给 worker 加 raw 响应 debug（reflection 同款先行）；③ state 语义修复前先读设计注释对照（"0 采纳 1h"与实现兜底矛盾即缺陷）。
