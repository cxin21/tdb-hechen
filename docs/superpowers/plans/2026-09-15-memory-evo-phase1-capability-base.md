# P1 记忆验收底座 + 口径还债 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 DS-MEMORY-EVO-001 的三信号分层验收底座（构造式 fixture 能力道 + 不变量断言），并清偿时间过滤/召回计数两笔口径债。

**Architecture:** Lane 2 能力道 = hermetic 临时库（fixture 经 store.upsertL1 播种，BM25-only 确定性）+ 临时网关（端口 8423，复用 recall-anchor.mjs 的起停模式）+ HTTP 探针断言四能力与不变量，归档 runs/<ts>.capabilities.json。还债 = 快慢路时间过滤列对齐（occurred_at）+ bumpRecallCount 增 touchUpdatedTime 选项并接入 auto-recall 钩子路。

**Tech Stack:** Node 22 / node:sqlite (DatabaseSync) / tsx 直跑 / vitest / Hono 网关。

**Spec:** `docs/superpowers/specs/2026-09-15-memory-evolution-design.md`（DS-MEMORY-EVO-001 v3，§6.1 三信号分层）

## Global Constraints

- 排序路径零变更：不碰 memory-search.ts 排序逻辑、recall-signals.ts 权重、auto-recall 的排序组装
- config-first：一切新增开关缺省 = 逐位现状
- 生产 yaml（`/opt/tdai/etc/proxy-config.yaml`、`MemoryCore/tdai-gateway.yaml`）只读；临时 yaml 进 os.tmpdir 自清理
- 临时网关端口 **8423**（避让 8420/8421/8422/8123）
- 云端部署纪律：所有写盘 `sudo -u tdai`；git 操作 `sudo -H -u tdai git`
- 驱动 = node:sqlite（DatabaseSync），不引入新依赖
- tsc 预存量基线 diff 零新增（stash 前后对比法）；vitest 全绿
- 部署：src 变更后 `sudo systemctl restart tdai-core`，health 200 后继续

---

### Task 1: capability fixture 语料与播种模块

**Files:**
- Create: `MemoryCore/scripts/eval-capabilities-fixture.mjs`
- 参考（只读）：`MemoryCore/scripts/recall-anchor.mjs:40-72`（DB/网关常量与启动模式）、`MemoryCore/src/core/store/sqlite.ts:1547`（upsertL1 签名）、`MemoryCore/src/core/record/l1-writer.ts`（MemoryRecord 字段）

**Interfaces:**
- Produces: `buildFixtures(themeIndex = 0)` → `{ records: MemoryRecord[], expectations: { timeProbe: {queries: string[], windowMonths: [number, number]}, sessionProbe: {query: string, minSessions: number}, updateProbe: {query: string, newId: string, oldId: string}, noiseQueries: string[] } }`；`seedStore(store)` → 逐条 `store.upsertL1(record, undefined)`（undefined embedding = BM25-only 确定性道）

- [ ] **Step 1: 确认 store 类名与构造签名**

Run: `grep -n "export class" /opt/tdai/td-agemem/MemoryCore/src/core/store/sqlite.ts`
读构造参数（dataDir 或 dbPath）。后续步骤按实际签名实例化。

- [ ] **Step 2: 写 fixture 数据模块**

```js
// eval-capabilities-fixture.mjs 核心（其余为样板导出）
const T = (m, d) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T10:00:00.000Z`;
// 主题包 0：部署迁移叙事；主题包 1：数据管道叙事（程序化演化 = 换主题包重跑）
const THEME_PACKS = [
  {
    domain: "部署迁移",
    timeSpread: [ // 12 条，跨 2-9 月，每条 occurred_at 唯一月
      { content: "2月完成旧版向量库选型对比记录", occurred_at: T(2, 12) },
      { content: "3月敲定 sqlite-vec 作为本地向量引擎", occurred_at: T(3, 15) },
      { content: "4月完成 BM25 中文分词接入", occurred_at: T(4, 20) },
      { content: "5月梳理租户隔离三元组方案", occurred_at: T(5, 11) },
      { content: "6月部署第一版记忆网关", occurred_at: T(6, 8) },
      { content: "7月完成召回分层预算切分", occurred_at: T(7, 19) },
      { content: "8月上线价值锚自发现流水线", occurred_at: T(8, 23) },
      { content: "9月初完成云端部署与验证", occurred_at: T(9, 3) },
      /* …另 4 条同格式分散在 3/5/6/8 月，主题各异… */
    ],
    conflictPairs: [ // 3 组：old → new 同 subject，new 更晚
      { old: { content: "服务部署在阿里云杭州", occurred_at: T(4, 1) },
        new: { content: "服务已整体迁移到腾讯云上海", occurred_at: T(8, 1) } },
      /* …2 组同构（数据库引擎更换 / 主模型更换）… */
    ],
    multiSession: [ // 4 个 session × 2 条，同主题"数据库选型"
      { session: "sess-db-1", items: ["数据库选型第一轮讨论记录", "数据库选型补充了延迟数据"] },
      { session: "sess-db-2", items: ["数据库选型第二轮引入成本维度", "数据库选型最终结论归档"] },
      /* …sess-db-3 / sess-db-4 同构… */
    ],
    noise: [ /* 10 条与全部 query 无词面/语义交集的内容：花卉养护、菜谱、星座 */ ],
  },
  /* THEME_PACKS[1] 同构，领域词全换 */
];
```

每条 record 补齐 soul 字段：`certainty: "observed"`, `significance: 0.6`, `valence: 0`, `arousal: 0.3`, `source: "fixture"`, `type: "episodic"`, `session_id` 按组, `occurred_at` 如上, `metadata_json: "{}"`；冲突对 new/old 同 `subject` 值（写进 metadata）。

- [ ] **Step 3: 写 seedStore + 期望导出**

```js
export function buildFixtures(themeIndex = 0) { /* 按 THEME_PACKS[themeIndex] 生成 records + expectations */ }
export async function seedStore(store, records) {
  for (const r of records) {
    const ok = store.upsertL1(r, undefined); // undefined embedding：BM25-only 确定性道
    if (!ok) throw new Error(`seed failed: ${r.record_id}`);
  }
}
```

- [ ] **Step 4: 冒烟验证播种**

Run: `cd /opt/tdai/td-agemem/MemoryCore && sudo -u tdai node --import tsx -e "import('./scripts/eval-capabilities-fixture.mjs').then(async m => { const { buildFixtures } = m; const f = buildFixtures(0); console.log('records:', f.records.length); })"`
Expected: `records: 30`（12+6+8+10，按主题包实际数）

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/scripts/eval-capabilities-fixture.mjs
git commit -m "feat(P1): capability fixture 语料模块（主题包可轮换）"
```

---

### Task 2: eval-capabilities.mjs 主评估脚本

**Files:**
- Create: `MemoryCore/scripts/eval-capabilities.mjs`
- Create: `MemoryCore/scripts/eval-capabilities.tmp-yaml.mjs`（或内联函数：生成临时 yaml）
- 参考（只读）：`scripts/recall-anchor.mjs:72-140`（临时网关 spawn/health 等待/自停——照抄该实现）

**Interfaces:**
- Consumes: Task 1 的 `buildFixtures` / `seedStore`
- Produces: 归档 `docs/superpowers/evals/capabilities/runs/<ts>.capabilities.json`；exit code（全过=0；仅 expectedRed 失败=0 带 `"baseline": true`；意外失败=1）

- [ ] **Step 1: 临时网关启动器**

照抄 recall-anchor.mjs 的 spawn/等待/清理（临时 yaml：port 8423、`data.baseDir` 指向 `fs.mkdtempSync`、lifecycle/capture/extraction/skill.extraction 全 false、复用生产 server.apiKey 供 ISO 鉴权）。fixture 租户三元组：`{ team_id: "team-fix", user_id: "usr-fix", agent_id: "agt-fix" }`（写进临时 yaml 便于面板隔离）。

- [ ] **Step 2: 播种 + 探针**

```js
// 顺序：boot 网关（建 schema）→ 停网关 → seedStore（直连 store 类实例写 temp DB，避开跨进程写）
//      → 再 boot 网关 → HTTP 探针 → 归档 → 自停
const probes = {
  time: { queries: ["上个月的部署安排", "6月做了什么"], assert: (items, win) => items.every(i => inWindow(i.occurred_at, win)) },
  session: { query: "数据库选型的讨论", assert: items => new Set(items.map(i => i.session_id)).size >= 2 },
  update: { query: "现在服务部署在哪个云", assert: items => items.findIndex(i => i.id === NEW_ID) < items.findIndex(i => i.id === OLD_ID), expectedRed: true }, // P1 known-FAIL：无失效语义
  abstain: { queries: NOISE_QUERIES, assert: (items, stats) => !items.length || items[0].score < stats.top1P50 },
  invariants: {
    determinism: "同 query 双跑逐位一致",
    tenantClosure: "跨租户 query → 0 结果",
  },
};
```

- [ ] **Step 3: 跑基线并归档**

Run: `sudo -u tdai node --import tsx scripts/eval-capabilities.mjs`
Expected: time/session/abstain/invariants PASS；update **known-FAIL**（baseline 记录 new/old 实际名次）；归档 JSON 含 fixture sha、themeIndex、逐探针明细。

- [ ] **Step 4: Commit**

```bash
git add MemoryCore/scripts/eval-capabilities.mjs docs/superpowers/evals/capabilities
git commit -m "feat(P1): 三信号 Lane2 能力道评估脚本（四能力+不变量，基线归档）"
```

---

### Task 3: 快慢路时间过滤列对齐

**Files:**
- Modify: `MemoryCore/src/gateway/v2-router.ts:1262-1264`（legacy fallback 两行）

**Interfaces:**
- 对齐目标：`sqlite.ts:4404-4418` TIMEFIX-v2 语义（occurred_at 过滤、空值行不命中）

- [ ] **Step 1: 改 fallback 过滤**

```ts
// TIMEFIX-v2 对齐（P1 债务③）：快慢路同键——业务时间 occurred_at；
// occurred_at 为空串的行在过滤激活时不命中（宁缺毋滥，同 fast path 语义）。
if (time_start) filtered = filtered.filter((r) => (r.occurred_at || "") !== "" && r.occurred_at >= time_start);
if (time_end) filtered = filtered.filter((r) => (r.occurred_at || "") !== "" && r.occurred_at <= time_end);
```

- [ ] **Step 2: 验证**

Run: 部署后（Task 6 一并重启）`curl -sX POST http://127.0.0.1:8420/v3/atomic/query -H 'Authorization: Bearer '$KEY -H 'x-tdai-service-id: default' -H 'x-tdai-team-id: team-fix' -H 'x-tdai-user-id: usr-fix' -H 'x-tdai-agent-id: agt-fix' -H 'content-type: application/json' -d '{"type":"episodic","time_start":"2026-06-01","time_end":"2026-06-30"}'`
Expected: 仅返回 6 月 occurred_at 行（fixture 时间道交叉验证）。

- [ ] **Step 3: Commit**

```bash
git add MemoryCore/src/gateway/v2-router.ts
git commit -m "fix(P1): atomic/query fallback 时间过滤对齐 occurred_at（快慢路统一）"
```

---

### Task 4: bumpRecallCount 拆分 + 钩子路接入

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts:3336`（UPDATE 语句）
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts`（分层召回返回处，grep `performLayeredRecall` 调用返回点）
- Test: `MemoryCore/src/core/store/__tests__/recall-count-bump.test.ts`（新建，模式照抄同目录 values-cache.test.ts 的临时库初始化）

**Interfaces:**
- Produces: `bumpRecallCount(id: string, now?: string, opts?: { touchUpdatedTime?: boolean }): boolean`（缺省 true = 逐位现状）

- [ ] **Step 1: 写失败测试**

```ts
it("touchUpdatedTime:false 只加计数不刷 updated_time", () => {
  const store = makeTempStore(); // 临时 dataDir 实例化（照 values-cache.test.ts 模式）
  store.upsertL1(makeRecord({ record_id: "r1", occurred_at: "2026-01-01T00:00:00.000Z", certainty: "observed" }), undefined);
  const before = store.getL1ByIds?.(["r1"])?.[0]?.updated_time;
  store.bumpRecallCount("r1", "2026-09-15T00:00:00.000Z", { touchUpdatedTime: false });
  const after = store.getL1ByIds(["r1"])[0];
  expect(JSON.parse(after.metadata_json).recall_count).toBe(1);
  expect(after.updated_time).toBe(before); // 关键断言
});
```

- [ ] **Step 2: 跑测试确认失败**（现签名无 opts → updated_time 被刷）

- [ ] **Step 3: 实现**

```ts
bumpRecallCount(id: string, now?: string, opts?: { touchUpdatedTime?: boolean }): boolean {
  // …前半（degraded/json 校验）不变…
  const touch = opts?.touchUpdatedTime !== false; // 缺省 true = 逐位现状
  const res = touch
    ? this.db.prepare(`UPDATE l1_records SET metadata_json = json_set(...) , updated_time = ? WHERE record_id = ? AND (metadata_json IS NULL OR json_valid(metadata_json))`).run(nowIso, nowIso, id)
    : this.db.prepare(`UPDATE l1_records SET metadata_json = json_set(...) WHERE record_id = ? AND (metadata_json IS NULL OR json_valid(metadata_json))`).run(nowIso, id);
  return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
}
```

- [ ] **Step 4: 钩子路接入（auto-recall.ts 分层召回返回点）**

```ts
// GROW-EVO P1：钩子路 recall_count 计数补齐（R8 数据前提）。只加计数、不刷
// updated_time（防扰动 ORDER BY updated_time 的既有排序）。仅 observed（红线）。
const recallNow = new Date().toISOString();
for (const m of selectedMemories.slice(0, 3)) {
  if ((m as { certainty?: string }).certainty !== "observed") continue;
  try { store.bumpRecallCount?.((m as { record_id: string }).record_id, recallNow, { touchUpdatedTime: false }); } catch { /* best-effort */ }
}
```

定位：grep `performLayeredRecall` 的调用返回处，插入在"最终入选记忆列表确定之后、注入块组装之前"（feature-detect `store.bumpRecallCount`，tcvdb 等旧后端安静跳过）。

- [ ] **Step 5: 跑测试全绿 + tsc 基线 diff 零新增**

Run: `node --import tsx node_modules/vitest/vitest.mjs run src/core/store/__tests__/recall-count-bump.test.ts` → PASS；stash 法 tsc 对比（见 spec §7）→ 零新增。

- [ ] **Step 6: Commit**

```bash
git add MemoryCore/src/core/store/sqlite.ts MemoryCore/src/core/hooks/auto-recall.ts MemoryCore/src/core/store/__tests__/recall-count-bump.test.ts
git commit -m "feat(P1): recall_count 钩子路补齐（touchUpdatedTime 选项，防排序扰动）"
```

---

### Task 5: 口径对照表 + 常数注释

**Files:**
- Create: `MemoryCore/docs/memory-dimensions-dict.md`
- Modify: `MemoryCore/src/core/tools/memory-search.ts:166,1412`（RRF_K 注释）

- [ ] **Step 1: 写维度口径对照表**——三节：时间三代同堂（timestamp_str/start/end 一代｜metadata.activity_* 二代｜occurred_at/valid_* 三代：展示混用、过滤只用三代、遗忘兜底横跨三代的现状与演进方向）；valence 同名异义（core_values -1/0/1 枚举 vs l1_records -1..1 连续）；硬编码常数清单及判定（RRF_K=60 协议常数 / recallCountBoost min(c,5)×0.02 待 P5 校准 / neighborExpand 邻居分 0.2 / DEFAULT_COMPOSITE_WEIGHTS 待 C 轨取代 / firedThreshold 0.4 已在 proxy config）。

- [ ] **Step 2: RRF_K 注释**（两处同文案）：`// RRF K=60：Cormack et al. (2009) 原论文标准常数——协议不变量，硬编码不配置化（GOLD-EVO 判定 2026-09-15）`

- [ ] **Step 3: Commit**

```bash
git add MemoryCore/docs/memory-dimensions-dict.md MemoryCore/src/core/tools/memory-search.ts
git commit -m "docs(P1): 维度口径对照表 + RRF_K 协议常数注释化"
```

---

### Task 6: 回归、部署与收尾

- [ ] **Step 1: 全量回归**：MemoryCore vitest 全量 + tsc stash 基线 diff 零新增
- [ ] **Step 2: 部署**：`sudo systemctl restart tdai-core` → health 200 → Task 3 的 curl 验证 → `eval-capabilities.mjs` 重跑 PASS
- [ ] **Step 3: CHANGELOG 登记**（`[Unreleased]` 加 P1 条目：三信号分层底座 + 两笔债务清偿 + Lane 1 退役说明）
- [ ] **Step 4: 提交推送 + 观察一周**：capability run 隔日一跑留基线序列；conflict 频率观察期开始计时（P4 前置）

---

## Self-Review 记录（2026-09-15）

1. **Spec 覆盖**：§6.1 L1 构造式（Task 1/2）、L2 不变量（Task 2 probes.invariants + Task 4）、口径还债 §6.2（Task 3/4/5）、LongMemEval 五能力映射（Task 2 probes）——全覆盖。L3 判官流水线不在 P1（spec 未承诺，属漂移越线后触发）✓。
2. **占位符扫描**：Task 2 fixture 第二主题包、Task 4 钩子插入点带 grep 定位锚 + 完整代码——无 "TBD/类似 Task N"。
3. **类型一致性**：`bumpRecallCount` 新签名在 Task 4 定义、Task 4 钩子调用与 sqlite 实现一致；`buildFixtures/seedStore` 签名 Task 1 定义、Task 2 消费一致。
