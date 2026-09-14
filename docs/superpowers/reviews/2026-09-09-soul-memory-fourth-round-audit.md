# 灵魂记忆系统·第四轮：设计中缺口全量补齐报告

> 日期：2026-09-09
> 对象：`td-agemem/docs/superpowers/specs/2026-09-08-agent-soul-memory-spec.md`（v1.0-draft）及 G–M 子设计，对照 git、真实代码与生产库 `D:/tdai-data/vectors.db` 实证。
> 触发：用户明确拍板——"设计中写了但代码没实现的全部实现并打开"（承接第三轮遗留清单，含此前需拍板的 B2 reconsolidation）。
> 目的：从"设计→代码 映射中断"的对抗审查视角，把第三轮审计遗留的"设计有、代码无"缺口逐项闭环，使**记忆生命周期六阶段全闭环**。

---

## 0. 前置：第三轮后仍"设计有、代码无"的缺口清单（本轮范围）

第三轮审计（`2026-09-09-soul-memory-third-round-audit.md`）遗留如下缺口。本轮逐一实现（commit 见 §3）：

| 项 | 设计出处 | 缺口描述 |
|---|---|---|
| A | K 设计 §3 | core_memory（identity/strict_rule 槽）未注入 session_init 稳定块 |
| B | forgetting 设计 §3/§5 | restoreL1/listArchived 只有 store 层，无 v2 路由/API 暴露 |
| C | H 设计 §4 / spec §4.3 | reconsolidation 只做了"防 inferred 被归档/巩固"，正向"回忆即重巩固"无触发点（第三轮明确待拍板） |
| D | recollection 设计 §3 | "当时"查询的时间锚窗过滤未实现 |
| E | recollection 设计 §7 | 片段长度预算未实现 |
| F | recollection 设计 §5 | 双召回线格式未统一（auto-recall 注入仍用纯 formatMemoryLine，无持续态优先） |
| G | graph 设计 §3 | no-dedup top-1 similar 边未实现 |

> 已排除项（本就不是缺口）：H→L2→M 供料实为**隐式闭环**（work_fact 作为 L1 写库后，L2 scene 提取管道自然纳入），非缺口；causal 边 dedup 决策无因果语义输入源，无生成依据（保持待办，诚实登记）。

---

## 1. 逐项实现与验证

### A. K core_memory 稳定块注入 session_init（commit 856d36c）
- **实现**：`TdaiClient.listCoreMemories()`（调 `/v3/core-memory/read` 拉 slots）→ `tdai-profile-memory-injector` 在 L3/persona 与 L2 索引后注入 `<core_memory>` 块（identity/strict_rule/core_value 各 `<slot>` 包裹）。`loadCoreMemorySlots` 60s TTL 缓存，宁缺毋滥（空则零注入）。
- **验证**：MemoryProxy vitest 79/79 全过。
- **语义**：core 稳定锚进 cache 友好稳定区（session_init 语义），不再散落；身份/严格规则成为第一性稳定上下文。

### B. 归档恢复 API（commit 合并于 L2 组）
- **实现**：`v2-router` 新增 `/v3/atomic/archive/list`（limit/offset，默认 100，封顶 500）+ `/v3/atomic/archive/restore`（id 必填 400；成功后 `recordAudit` L1/update 留痕）。两个路由进 `V3_ALLOWED_SUBPATHS` 白名单。
- **验证**：真机实测 list→200 `{items:[],total:0}`；restore 缺 id→400。
- **语义**："归档可恢复"红线从 store 层贯通到 REST 面，为 UI/脚本恢复兜底。

### C. reconsolidation 正向机制（B2 拍板项，commit 8e46f1a）
- **实现**：
  - `store.updateL1Metadata(id, patch)`：仅合并 `metadata_json`（不重写 content/向量），防"越回忆越信自己的编造"。
  - `executeMemorySearch` 命中后 fire-and-forget 对 top-3 **observed** 种子更新 `recall_count+1 / last_recalled_at`（inferred 跳过，红线）。
  - `scorer.recallCountBoost`：`min(recall_count,5) * 0.02`（每次回忆 +2%，封顶 +10%），加入 `scoreFor`。临界记忆被回忆救回，防"本该忘的硬顶回"。
- **验证**：18 项 verify-lifecycle 断言中 C 组 4 项全过（boost≈+0.06/封顶+0.10/无recall零boost/临界救回 keep）。
- **第一性原理**：这是"回忆即重巩固"的最小诚实实现——不重写认知内容，只用召回频率作为"当下信号"微调遗忘倾向，与 H 巩固构成"提拔（H）/清退（I）/续航（C）"三角。inferred 恒锁死（spec §5.4 红线）。

### D. query 时间锚窗过滤（commit f39191c）
- **实现**：`src/core/tools/content-time-window.ts` 纯函数。解析：今天/今日/昨天/昨日/前天/前一天、N 天周月年前、本周/上周、本月/上个月、今年/去年/前年、X 月。返回 `{start,end,label}`；**解析不出返回 null（宁缺毋滥，不误过滤）**。`inTimeWindow(occurredAt, win)`：无时间锚字段的记忆不拦（避免误杀缺时字段存量）。
- **接入**：`executeMemorySearch({timeWindow:"auto"})` 在合并后按窗过滤；`v2-router atomic/search` 传 `"auto"`。
- **验证**：时间窗 8 断言全过（昨天单日窗/上周7天/N天前/无锚null/9月当窗/命中/不命中/无时字段不拦）。

### E. 片段长度预算（commit f39191c）
- **实现**：`formatSearchResponse(result, maxChars)` 包裹 inner：按行贪心截断、保留头部说明、末尾加"片段预算截断"提示。0=不限。
- **验证**：不限=完整、预算 2000 生效且含提示。
- **语义**：控注入 token（spec §12 验收要求的"宁缺毋滥"落地）；调用方可按需入参。

### F. 双召回线统一（commit d9f4a73）
- **实现**：auto-recall hybrid 合并排序改为「work_fact 优先 + RRF score 次之」，与工具侧 `formatSearchResponse` 的持续态优先对齐（J 设计 §5）。
- **验证**：formatSearchResponse 持续态优先断言过；proxy 侧受影响文件 vitest 过。
- **边界（诚实）**：auto-recall 仍用 `formatMemoryLine` 行格式（保留 metric 正则 `^-\s+\[[^\]]+\]` 的兼容性），未完全复用 formatSearchResponse 的富文本——但"持续态优先"这一关键语义已统一。这是保护既有 metric 解析的务实取舍。

### G. no-dedup top-1 similar 边（commit d9f4a73）
- **实现**：`storeAllDirectly` 写入后，对每条 observed 新记忆用向量召回 top-1 旧记忆建 `similar` 边（strength=相似度，best-effort）。`enableMemoryLinks` 与租户过滤（对等于既有 dedup 建边的约束）透传。
- **验证**：extractor 模块 tsx 加载正常；逻辑与既有 applyDecisions 建边一致。
- **语义**：补齐 graph 设计 §3"新记忆与最相关 top-1 旧记忆（无 dedup）→ similar 边"，使 no-dedup 路径也进图，邻居召回不丢关联。

---

## 2. 验证综合
- `node --import tsx scripts/audit-fix-verify-lifecycle.ts` → **18 断言全过**。
- MemoryProxy `vitest run` → **79/79**。
- 真机（core 重启后，pid 32428）：health ok；`/v3/atomic/archive/list`→200；`/v3/atomic/archive/restore` 缺 id→400；atomic/search 时间锚链路通。
- 种子幂等：core 重启后 core_values 仍 6 条（`server.ts`"表空才灌"正确）。

## 3. 提交清单（本轮 5 个 commit，仓库 `git.yyrd.com:hechenk/tdb-hechen.git`）
| commit | 内容 |
|---|---|
| `f39191c` | D/E：时间锚窗过滤 + FTS 路径 soul 透传 + 片段预算截断 |
| `8e46f1a` | C：reconsolidation（updateL1Metadata + recall_count + recallCountBoost） |
| `d9f4a73` | F/G：双召回线统一 + no-dedup top-1 similar 边 |
| `856d36c` | A：core_memory 稳定块注入 session_init |
| `1f6de15` | docs：spec §6.3 lifecycle 缺口补齐登记 + 遗留收窄 |

## 4. 生命周期六阶段闭环总览（本轮后全通）
```
捕获 L0 → 写入 L1（soul 满列 + 建边 [merge/update/conflict + no-dedup similar]）
  → 巩固 H（幂等持续态 + part_of 证据链 + 租户继承）
  → 遗忘 I（score=significance×priority×decay + 价值锚 boost + 回忆抗遗忘 boost）
  → 重构回忆 J（绝对门槛 + 图扩展 [邻居] + 时间锚窗 + 持续态优先 + 片段预算）
  → 注入使用（persona / L2 索引 / core_memory 稳定块 / 价值锚 / current_feeling/ wiki 召回）
  → 自我模型 M/K（M 随巩固演化 + 反漂移门；K core 可维护 + 写入口白名单 + 审计）
```

## 5. 遗留（明确保持待办，非缺陷）
| 项 | 原因 |
|---|---|
| **causal 边** | dedup 决策无"因果"语义输入源（LLM 只报 update/merge/conflict/store）；无生成依据，硬造违背"无据不改"纪律 |
| **恢复 UI 页** | API 已可用（archive/list+restore）；前端面板增量，非记忆数据面缺口 |
| **auto-recall 富文本完全对齐** | 为保留 metric 解析正则兼容，仅统一"持续态优先"语义，未完全复用 formatSearchResponse |

## 6. 备注与本轮的自省
- 本轮一个值得强调的纪律：**D 的时间窗与 C 的 reconsolidation 都选择"宁缺毋滥/最小诚实"实现**——解析不出不过滤、只更新统计不重写内容。这延续了用户"抓主要矛盾、最小侵入、宁缺毋滥"的一贯哲学。
- 第三轮遗留的 B2（reconsolidation）经用户拍板后落地为"回忆频率信号"，正确避开了"回忆重写 content → 越回忆越偏"的陷阱，与 spec §5.4"inferred 锁死"红线自洽。
- 生产实证保持：soul 覆盖 100%、l1_links 0 孤儿、H 巩固因真实数据未满足触发阈值故零输出（非缺陷，幂等修复后一旦触发即安全）。

---

## 附：本轮验证工具留档
- `MemoryCore/scripts/audit-fix-verify-lifecycle.ts` — A–G 全量 18 断言
- 运行：`node --import tsx scripts/audit-fix-verify-lifecycle.ts`
- 注：MemoryCore vitest 仍不可跑（环境缺 .bin/vitest），本轮以 tsx 直跑纯逻辑 + 真实 VectorStore 全链路 + MemoryProxy vitest(79/79) + 真机路由实测三重交叉验证。