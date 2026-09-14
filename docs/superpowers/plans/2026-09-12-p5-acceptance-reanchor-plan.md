# P@5 验收线重立 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当前语料快照上重锚基线、数据裁决基准工作点（精排 off vs on A/B）、立新线并写入漂移重锚协议。

**Architecture:** 新脚本 `reanchor-p5.ps1` 复用 calibrate-recall-scale.ps1 的 yaml 行级改写+YAML.parse 验证+sha256 终验范式，对"精排 off / 相关度主导 on"两配置各跑一次 eval-layered-recall 重放归档，产出工作点裁决表；随后人工登记新线与漂移协议。

**Tech Stack:** PowerShell（行级 yaml 编辑范式）、eval-layered-recall.ts 重放、golden runs 归档惯例。

**Spec:** `docs/superpowers/specs/2026-09-12-p5-acceptance-reanchor-design.md`（DS-P5-REANCHOR-001）

## Global Constraints

- 两配置 A/B 必须同语料快照（configSnapshot.corpus 一致）+ 同 gitSha 归档。
- yaml 改写行级精确 + 每步 YAML.parse 验证 + 结束 sha256 恢复终验（沿用 CAL C2 纪律）。
- 工作点由数据裁决：差 <0.02 平手取关；"开"胜出须附分层指标旁证无反向漂移。
- 分层指标（CC/CTR/SD）只建基线不设线（DS-EVAL-LAYERED-001 §4）。
- README 历史数字只追加不改史。

---

### Task 1: reanchor-p5.ps1 重锚脚本

**Files:**
- Create: `MemoryCore/scripts/reanchor-p5.ps1`（参数：`-Configs off,on`，复用 calibrate-recall-scale.ps1 的 yaml 编辑函数；调用 eval-layered-recall.ts 重放）
- Modify: 无（纯新增）

**Interfaces:**
- Consumes: `eval-layered-recall.ts` 重放入口（与 CAL C2 六档调用同形）、`tdai-gateway.yaml` rerankWeights / 精排开关行
- Produces: `docs/superpowers/evals/memory-recall-golden/reanchor-<timestamp>.json` 汇总（两配置 p5Mean/perQueryP5/CC/CTR/SD + corpus 快照 + gitSha + 裁决字段 workingPoint: "off"|"on"|"tie"）

- [ ] Step 1: 实现脚本（off = 精排开关置 0 或 rerankWeights 全零——以关断矩阵既有口径为准；on = 现行 yaml 值；各跑重放 + 归档 + sha256 恢复终验）
- [ ] Step 2: dry-run 校验 yaml 改写/恢复正确（diff 为空）
- [ ] Step 3: Commit `feat(memory): Task P5-1 reanchor-p5.ps1 — 工作点 A/B 重锚脚本（行级 yaml+sha256 终验）`

### Task 2: 执行重锚 + 裁决登记（队长驱动，需生产服务在场）

**Files:**
- Create: `docs/superpowers/evals/memory-recall-golden/reanchor-<timestamp>.json` + 两份 runs/
- Modify: `MemoryCore/tdai-gateway.yaml:88` 附近——旧 0.325 口径替换为新线（注明重锚日期/基线/换线原因）
- Modify: `docs/superpowers/evals/memory-recall-golden/README.md`——新增"漂移重锚协议"章节（三条触发条件：条目数漂移>2% / L1 排序语义配置变更 / golden 集变更；重锚操作指向 Task 1 脚本）
- Modify: `docs/superpowers/specs/2026-09-12-p5-acceptance-reanchor-design.md`——§6 待确认回填（margin 0.02 与 2% 阈值的观察记录登记）

- [ ] Step 1: 跑 Task 1 脚本 → 归档两配置 runs
- [ ] Step 2: 按 §4.1 判据出裁决（差值/平手/旁证三选一落档）
- [ ] Step 3: 新线 = 基线 − 0.02 写 yaml + README 漂移协议章节 + spec 回填
- [ ] Step 4: 全量回归绿 + Commit `docs(memory): Task P5-2 P@5 重锚收口 — 工作点裁决 + 新线 <值> + 漂移协议`
