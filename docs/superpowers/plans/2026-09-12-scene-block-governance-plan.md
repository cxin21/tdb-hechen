# 场景块治理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L2 场景块获得代码级超限守卫（蒸馏重写 + 硬截断兜底），存量 188K 块修复到上限内。

**Architecture:** 治理模块 `SceneGovernor` 插入 scene-extractor Phase 5c（文件名归一化后、索引同步前）；蒸馏复用 extractor 的 LLM runner 文本输出通道；fail-safe 复用 `truncateConclusionContent` 码点安全截断；storage(COS)/本地 FS 双模式沿用 Phase 5 清理分流。

**Tech Stack:** TypeScript (ESM/NodeNext)、vitest、既有 backup.ts / CleanContextRunner / parseSceneBlock。

**Spec:** `docs/superpowers/specs/2026-09-12-scene-block-governance-design.md`（DS-SCENE-GOV-001）

## Global Constraints

- 配置化不硬编码：代码缺省 `enabled=false`（现状逐位一致），仅 yaml 开启生效。
- 退化安全：enabled=false 或块体不超限 → 输出与现状逐位一致。
- 蒸馏失败/超时 → 保留原块 + loud 日志，**不静默降级**。
- 兜底硬截断必须码点安全（零 U+FFFD）。
- 不动检索层、不动注入端 CAL C1、不改提取 prompt 的既有规则文本。
- 每任务独立 commit、精确暂存；不碰 D:/tdai-data 生产进程（存量修复只写块文件，不重启服务）。

---

### Task 1: sceneGovernance 配置解析

**Files:**
- Modify: `MemoryCore/src/config.ts`（recall/scene 配置解析区，仿 conclusionLayer 解析+clamp 模式）
- Modify: `MemoryCore/src/core/types.ts` 或 config 类型声明处（`SceneGovernanceConfig`）
- Modify: `MemoryCore/tdai-gateway.yaml`（新增注释登记段，缺省值全注释掉——配置化纪律）
- Test: `MemoryCore/src/config/__tests__/config.governance.test.ts`（或既有 config 测试文件追加 describe）

**Interfaces:**
- Produces: `cfg.sceneGovernance?: { enabled: boolean(缺省 false); maxBlockChars: number(缺省 8000, clamp 500..100000); distillTimeoutMs: number(缺省 60000, 负值 clamp 0); hardCapChars: number(缺省 20000, clamp >= maxBlockChars) }`

- [ ] Step 1: RED——类型+解析测试（缺省四键、clamp 边界、enabled 缺省 false）
- [ ] Step 2: 跑测确认 FAIL
- [ ] Step 3: 实现 config.ts 解析 + 类型 + yaml 注释段
- [ ] Step 4: 全量 config 测试 PASS + tsc 零新错
- [ ] Step 5: Commit `feat(memory): Task GOV-1 sceneGovernance 配置解析 — enabled 缺省 false + clamp 边界`

### Task 2: 治理纯函数 + 蒸馏 prompt

**Files:**
- Create: `MemoryCore/src/core/scene/scene-governance.ts`
- Test: `MemoryCore/src/core/scene/__tests__/scene-governance.test.ts`

**Interfaces:**
- Consumes: `truncateConclusionContent`（recall-layered.ts:127，码点安全）、`parseSceneBlock`（scene-format.ts）
- Produces:
  - `countBlockChars(raw: string): number`（META 头除外，码点计数）
  - `needsGovernance(raw: string, maxBlockChars: number): boolean`
  - `buildDistillPrompts(blockContent: string, maxBlockChars: number): { systemPrompt: string; userPrompt: string }`——蒸馏 prompt 内嵌 §4.1 保留优先级：未闭合事项(待确认/矛盾点) > 演变轨迹 > 时近性(近期决策) > 已闭合叙事一句带过；要求输出含 META 头（created 保留、updated 刷新、summary 重写、heat 保留）
  - `hardCapFallback(raw: string, hardCapChars: number): string`——正文复用 truncateConclusionContent 族码点安全截断，META 头完整保留，零 U+FFFD
  - `validateDistilled(out: string, maxBlockChars: number): boolean`（≤上限 + 有 META + 非空正文）

- [ ] Step 1: RED——纯函数测试（计数排除 META / 超限判定 / prompt 含三条优先级关键句 / hardCap 对代理对边界文本零 U+FFFD 且 META 保留 / validate 拒绝超限与空正文）
- [ ] Step 2: 跑测 FAIL
- [ ] Step 3: 实现
- [ ] Step 4: PASS + tsc 零新错
- [ ] Step 5: Commit `feat(memory): Task GOV-2 场景治理纯函数 — 码点计数/蒸馏 prompt(不可重构性优先)/硬截断兜底`

### Task 3: SceneGovernor 模块 + extractor 接线

**Files:**
- Create: `MemoryCore/src/core/scene/scene-governor.ts`（`class SceneGovernor { govern(sceneBlocksDir, storage?, logger?): Promise<GovernReport> }`，注入 runner `{ run(p): Promise<string> }`）
- Modify: `MemoryCore/src/core/scene/scene-extractor.ts`（Phase 5b 之后插入 Phase 5c：`cfg.sceneGovernance?.enabled` 时 `await governor.govern(...)`；复用本类 `this.runner`/`this.storage`/`bm` backup 模式）
- Test: `MemoryCore/src/core/scene/__tests__/scene-governor.test.ts`（临时目录 fixture + fake runner）

**Interfaces:**
- Consumes: Task 2 全部纯函数、`bm.backupDirectory/restoreLatestDirectory`（backup.ts:68,110 模式）
- Produces: `GovernReport { scanned: number; distilled: string[]; hardCapped: string[]; skipped: string[]; errors: string[] }`

- [ ] Step 1: RED——五路径集成测试：①enabled=false 全 no-op（fixture 字节不变）②不超限 no-op ③超限+fake runner 合格产出 → 蒸馏写回、META created 保留 ④fake runner 抛错/超时 → 原块保留 + loud 日志 + report.errors 登记 ⑤fake runner 产出仍超限 → hardCapFallback 写回且零 U+FFFD；storage 模式用 in-memory fake storage 覆盖 ③⑤
- [ ] Step 2: 跑测 FAIL
- [ ] Step 3: 实现 SceneGovernor + extractor Phase 5c 接线（失败不阻断 extract 主流程——治理异常 catch + loud，extract 照常返回）
- [ ] Step 4: PASS + MemoryCore 全量 vitest 绿 + tsc 零新错
- [ ] Step 5: Commit `feat(memory): Task GOV-3 SceneGovernor 蒸馏治理 — Phase 5c 接线 + 五路径测试(关断/免治/蒸馏/失败保留/硬截兜底)`

### Task 4: 存量修复 + 收口验证

**Files:**
- Create: `MemoryCore/scripts/repair-scene-blocks.ts`（一次性：扫描生产 dataDir scene_blocks/，打印超限清单 → `--apply` 执行 Task 3 同款治理 → 复扫校验报告）
- Modify: `docs/superpowers/specs/2026-09-12-scene-block-governance-design.md`（§6 待确认项回填：maxBlockChars 定档记录）
- Test: 修复前后块体指标（大小/U+FFFD 计数/重复句计数）

- [ ] Step 1: dry-run 打印超限清单（预期含 TDB团队-技术架构文档.md ≈188K）
- [ ] Step 2: `--apply` 修复 + 复扫：≤8000、零 U+FFFD、抽样重复句=1
- [ ] Step 3: 重跑 eval-layered-recall 双锚对照，登记 CC 形态变更（预期假象消退）
- [ ] Step 4: 全量回归绿
- [ ] Step 5: Commit `feat(memory): Task GOV-4 存量块修复收口 — 188K→≤8K + 零坏字符 + CC 形态变更登记`
