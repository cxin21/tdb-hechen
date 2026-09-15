# P2 失效语义（知识更新）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本会话内联执行——用户已裁定不再派子代理）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 落地 DS-MEMORY-EVO-001 §2 失效语义——conflict 自动失效 + durative 效期提取 + 召回默认排除 + 时间旅行查询，使 Lane 2 知识更新探针从 known-FAIL 转 GREEN。

**Architecture:** 写入侧三口（dedup conflict 回写 / 提取 prompt 增 durative / update API 显式失效）→ 存储层（valid_* 列已有，MemoryRecord 字段已有）；读侧一个过滤器 `filterInvalidated` 消费 `memory.recall.excludeInvalidated`（缺省 true，升级安全：现存库无失效行 = 逐位不变）。

**Tech Stack:** Node 22 / node:sqlite / tsx / vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-memory-evolution-design.md` §2（失效语义）+ §7.1 拍板点复审。

## Global Constraints

- 排序语义零变更：失效是**过滤层**（进过滤不进排序），基线语料无失效行 → 召回逐位不变
- 失效不删除：只写 `valid_end`，永不物理删、不改 content
- 方向性守卫（spec §7.1-5）：仅新记忆 `certainty='observed'` 才自动失效旧记忆；`inferred` 只记边
- config-first：`excludeInvalidated` 缺省 true（spec 拍板①）；`durativeEnabled` 缺省 false（生产 yaml 显式开）
- 失效判定本身硬编码（spec §2.5：conflict→valid_end 是确定后效，无调参意义）
- tsc 基线 244 持平；vitest 全绿；云端纪律（sudo -u tdai / sudo -H -u tdai git）

---

### Task 1: dedup conflict → 自动失效（写入侧核心）

**Files:**
- Modify: `MemoryCore/src/core/store/sqlite.ts`（新增 `invalidateL1(id, validEndIso, nowIso): boolean`——UPDATE valid_end（WHERE 已失效行不覆盖：`AND (valid_end IS NULL OR valid_end = '')`），失败显式 false）
- Modify: `MemoryCore/src/core/store/types.ts`（IMemoryStore 可选方法声明）
- Modify: `MemoryCore/src/core/record/l1-extractor.ts:824-826`（conflict 分支：addLink 后回写失效）
- Test: `MemoryCore/src/core/store/__tests__/invalidate-l1.test.ts`（模式照抄 recall-count-bump.test.ts）

**Interfaces:**
- Produces: `invalidateL1(id: string, validEndIso: string, nowIso?: string): boolean`；Task 3 过滤器、Task 4 update API 消费

- [ ] **Step 1: 失败测试**——三例：①invalidate 后 `getL1ByIds` 行 valid_end = 传入值；②已失效行二次 invalidate 不覆盖原 valid_end；③不存在的 id → false
- [ ] **Step 2: 跑测试确认失败**（方法不存在）
- [ ] **Step 3: 最小实现**（sqlite.ts：UPDATE 语句 + types.ts 声明 `invalidateL1?(...)`）
- [ ] **Step 4: conflict 分支接线**（l1-extractor.ts:824-826）：

```ts
} else if (decision.action === "conflict") {
  for (const t of decision.target_ids) vectorStore.addLink?.(record.id, t, "conflict", 1);
  // GROW-EVO P2（§2.2 方向性守卫）：仅新记忆 observed 才自动失效旧记忆；
  // inferred → 只记 conflict 边（推断不许冒充事实——红线对称应用）。
  if ((record as { certainty?: string }).certainty === "observed") {
    const invalidEnd = record.occurred_at || record.createdAt;
    for (const t of decision.target_ids) vectorStore.invalidateL1?.(t, invalidEnd);
  }
}
```

- [ ] **Step 5: 测试全绿 + tsc 持平**
- [ ] **Step 6: Commit** `feat(P2): dedup conflict 自动失效（方向性守卫 + invalidateL1）`

---

### Task 2: durative 效期提取（提取侧）

**Files:**
- Modify: `MemoryCore/src/core/prompts/l1-extraction.ts:84-99`（灵魂字段清单旁增加 durative 判定指令）
- Modify: `MemoryCore/src/core/record/l1-extractor.ts:246/631`（字段映射透传 valid_start/valid_end）
- Modify: `MemoryCore/src/config.ts`（`memory.extraction.durativeEnabled`，缺省 false）
- Test: `MemoryCore/src/core/record/__tests__/durative-mapping.test.ts`

**Interfaces:**
- Produces: LLM 输出契约增加 `"durative": true|false`（true 时随带 `valid_start`）；extractor 映射进 MemoryRecord.valid_start

- [ ] **Step 1: prompt 增量**（l1-extraction.ts 灵魂字段段后追加）：

```
6. durative 判定：该记忆是"持续状态"（如"服务部署在 X"、"用户使用 Y 仓库"——会在一段时间内保持为真）
   还是"一次性事件"（如"今天开了会"）。持续状态给 "durative": true 并填 "valid_start"（= occurred_at）；
   一次性事件给 "durative": false、不填 valid_start。宁缺毋滥：判定不了给 false。
```

- [ ] **Step 2: 映射透传**——l1-extractor.ts 两处记忆构造（246 主路 / 631 回填路）增加：

```ts
valid_start: cfg.extraction?.durativeEnabled && mem.durative === true ? (mem.valid_start || mem.occurred_at) : undefined,
valid_end: undefined, // 开放区间——失效只能由 conflict/手动写入（§2.2）
```

（`mem.durative` 非布尔 → 视 false，宁缺毋滥）
- [ ] **Step 3: config 解析**（config.ts extraction 组，仿既有 bool 解析）+ 生产 yaml `MemoryCore/tdai-gateway.yaml` `extraction.durativeEnabled: true` 显式落盘
- [ ] **Step 4: 单测**——prompt 契约含 durative 指令；mapping：durative true→valid_start 落、false/缺失→不落、开关关→不落
- [ ] **Step 5: 测试全绿** → **Step 6: Commit** `feat(P2): durative 效期提取（config-first，缺省关）`

---

### Task 3: 读侧失效排除（filterInvalidated + 三消费点）

**Files:**
- Create: `MemoryCore/src/core/recall/filter-invalidated.ts`（纯函数）
- Modify: `MemoryCore/src/config.ts`（`memory.recall.excludeInvalidated`，**缺省 true**——spec 拍板①）
- Modify: `MemoryCore/src/core/tools/memory-search.ts`（executeMemorySearch 结果池过滤）
- Modify: `MemoryCore/src/core/hooks/auto-recall.ts`（searchMemoriesWithDetails 返回前过滤 lines 对应 records——records 在 searchMemories hybrid 尾部 `top` 处仍带 soul；**在 searchMemories 返回前按 top 过滤**，与 P1 bump 同点）
- Test: `MemoryCore/src/core/recall/__tests__/filter-invalidated.test.ts`

**Interfaces:**
- Consumes: Task 1 的 invalidateL1（测试造数用）
- Produces: `filterInvalidated<T extends { valid_end?: string | null }>(items: T[], now?: Date): T[]`（valid_end 非空且 ≤ now → 剔除；时间旅行语义 = 调用方传 now=查询时点，窗口相交判定由调用方负责）

- [ ] **Step 1: 失败测试**——①valid_end 未来 → 保留；②valid_end 过去 → 剔除；③null/空 → 保留；④开关关 → 全保留（函数不带开关，开关在调用方——测调用方）
- [ ] **Step 2: 纯函数实现**（一行语义：`valid_end 存在且 new Date(valid_end) <= now → 剔除`；Date 解析失败 → 保留，宁缺毋滥）
- [ ] **Step 3: 三消费点接线**（config flag 经既有 cfg 管道传入；flag 关 = 不调用过滤器 = 逐位现状）：
  - memory-search.ts executeMemorySearch：候选池（mergedMap 定稿后 / results 映射处）过滤，`now = rank?.now ?? new Date()`
  - auto-recall.ts searchMemories hybrid 尾部：`top = top.filter(...)`（在 P1 bump **之前**过滤——失效记忆不计数）
  - handleAtomicSearch：items 过滤（`time_point` 缺省 now）
- [ ] **Step 4: yaml 显式落盘**：`memory.recall.excludeInvalidated: true`（生产 + 云模板 tdai-gateway.cloud.yaml 同步）
- [ ] **Step 5: 测试全绿 + golden Lane 2 重跑**（fixture 无失效行 → 既有探针逐位不变）+ **失效排除新不变量**：播种 1 条 valid_end 已过期的记录 → 断言默认召回不含它（Lane 2 不变量组扩充）
- [ ] **Step 6: Commit** `feat(P2): 召回默认排除失效记忆（filterInvalidated + excludeInvalidated）`

---

### Task 4: API 表达力（死参数激活 + 显式失效 + 时间旅行）

**Files:**
- Modify: `MemoryCore/src/gateway/v2-router.ts`（handleAtomicSearch:1356 激活 time_start/end；handleRecall:1548 增 time_point；handleAtomicUpdate:1127 增 valid_end 写入；conversation/search:1001 同款激活）
- Test: `MemoryCore/src/gateway/__tests__/time-params.test.ts`（或 curl 探针步骤替代——handler 级测试若无既有 harness，用部署后 curl 清单替代并在计划中列明命令）

**Interfaces:**
- Consumes: Task 1 invalidateL1、Task 3 filterInvalidated

- [ ] **Step 1: handleAtomicSearch**——解构 `time_start/time_end` → 传入 executeMemorySearch（其 IsolationFilter/timeWindow 既有管道；fallback 路已对齐 occurred_at）
- [ ] **Step 2: conversation/search** 同款激活（对照 queryL1Paginated 的 occurred_at 语义）
- [ ] **Step 3: handleAtomicUpdate**——body 允许 `valid_end`（ISO 校验）→ `store.invalidateL1(id, valid_end)`，租户校验沿用既有 update 路径；响应回显失效时间
- [ ] **Step 4: handleRecall**——body 允许 `time_point`（ISO）→ 透传 performLayeredRecall params（`validityNow`），失效过滤与时间窗解析以 time_point 为"当前"
- [ ] **Step 5: curl 探针清单**（部署后逐条跑，命令写入本计划附录）：①atomic/search 带 time_start/end；②recall 带 time_point；③atomic/update 写 valid_end 后 recall 不再返回该条
- [ ] **Step 6: Commit** `feat(P2): 查询 API 时间参数激活 + 显式失效 + recall 时间旅行`

---

### Task 5: Lane 2 知识更新探针转绿 + 收尾

**Files:**
- Modify: `MemoryCore/scripts/eval-capabilities.mjs`（updateProbe：断言升级为 "new 命中且 old 不出现（被失效排除）"；去掉 expectedRed）
- Modify: `docs/superpowers/evals/capabilities/README.md`（known-FAIL 基线 → GREEN 登记）
- Modify: `CHANGELOG.md`（P2 条目：失效语义三口 + excludeInvalidated/durativeEnabled 配置 + 升级须知）

- [ ] **Step 1: fixture 冲突对播种时由 Task 1 invalidateL1 的生产等价路径覆盖**（评估脚本播种直接经 dedup？否——fixture 直写 store，须显式调 `store.invalidateL1(oldId, newOccurrence)` 模拟 dedup 效果，归档 JSON 登记"播种期模拟 conflict 失效"）
- [ ] **Step 2: 重跑能力道**——update 探针 GREEN（new 在、old 不在）→ exit 0
- [ ] **Step 3: conflict 频率观察期开始计时**（P4 前置；l1-dedup conflict 解析失败率同步统计——Task 报告已知存在 JSON 截断噪声）
- [ ] **Step 4: Commit** `feat(P2): 知识更新探针转绿（失效语义闭环）+ P4 观察期启动`

---

### Task 6: 回归与部署

- [ ] tsc 244 持平 + vitest 全量（新增 3 套件）+ Lane 2 重跑（全绿含 update）
- [ ] `sudo systemctl restart tdai-core` → health 200 → Task 4 curl 探针清单逐条
- [ ] CHANGELOG/README 检查同步；`sudo -H -u tdai git push`
- [ ] 观察登记：conflict 边计数、durative 命中计数（P4 观察期数据源）

## Self-Review（2026-09-15）

1. **Spec 覆盖**：§2.2 三写入方（Task 1/2/4）、§2.3 读取语义（Task 3/4）、§2.4 API（Task 4）、§2.5 配置判定（Task 2/3 yaml 落盘）、§2.6 验收（各 Task + Task 5）——全覆盖。
2. **占位符**：无 TBD；锚点均 file:line。
3. **一致性**：`invalidateL1(id, validEndIso, nowIso?)` Task 1 定义、Task 4 消费一致；`filterInvalidated` Task 3 定义、Task 3/4 消费一致；known-FAIL→GREEN 链路 Task 2→5 闭合。
4. **红线核对**：失效不删除 ✓（只写 valid_end）；方向性守卫 ✓（Task 1 Step 4）；排序零变更 ✓（过滤层，基线逐位）；excludeInvalidated 缺省 true ✓（spec 拍板①）。
