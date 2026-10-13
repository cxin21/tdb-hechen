# P1 实施计划：召回质量与上下文体积（M1 reranker / M2 wiki JIT / M3 worthiness / M4 bi-temporal）

- 日期：2026-10-13
- 设计稿（spec，唯一契约源）：`docs/superpowers/specs/2026-10-13-p1-recall-quality-design.md`（r3，commit 232a124）
- Tickets：cxin21/tdb-hechen #3 (M1) / #4 (M2) / #5 (M3) / #6 (M4)
- 执行方式：subagent-driven-development；两个并行流——M1 流（Task 1→2→3→4，MemoryCore 主导）与 M2 流（Task 5→6，MemoryKnowledge/MemoryProxy 主导）。Task 4 与 Task 6 都动 MemoryPanel/web，控制器按到达顺序串行执行这两个 panel 任务。

## Global Constraints（对每个 Task 生效，审稿按此核对）

1. shadow-first：一切行为变更默认关闭（`enabled:false`、`shadowMode:true`），独立 flag 可回滚；不改默认行为。
2. 宁缺毋滥：召回/注入任何路径宁可少注入，不可注入噪音。
3. 降权存储：任何路径不删记忆；遗忘 worker 既有红线不变。
4. 不回退 P0 门控（nativeMinRRF / minInjectFtsScore / skipQuery / maxTotalChars / anchor-desc 质量门）。
5. 配置命名空间：rerank 全部在 `memory.recall.rerank.*`；journal gates 复用现有 `gates` 通道扩展。
6. sqlite fallback 与 native TCVDB 两路行为不得分叉（本机是 sqlite fallback，测试必须覆盖 fallback 路）。
7. TDD 先行；提交前跑目标包全量测试，输出 pristine（无 stray warning）。
8. 禁用 transformers.js 内建下载器（hf-mirror 429 实测）；下载器=fetch 直链+浏览器 UA+指数退避+Range 断点续传，主源 hf-mirror 备源 ModelScope。
9. 提交信息 conventional commits（本仓先例：`fix(recall): …`、`docs(spec): …`）；禁止把 `.superpowers/` 带进提交（已自 gitignore）。
10. 控制器提交制（Ruling）：实现者**不执行 git commit**（两流共享同一工作树，避免 index.lock 竞争）；实现者完成并通过任务审稿后由控制器按任务分别提交。

## Task 1: MemoryReranker 接口 + provider adapter + 配置面（M1 #3）

- Scope：`MemoryReranker` 接口（`rerank(query, docs): Promise<Array<{index,score}>|null>`，null=降级原序）；siliconflow adapter 首发（POST `{baseUrl}/v1/rerank`，Cohere/Jina 兼容 `{model,query,documents,top_n}`→`results[].relevance_score`，默认 `Qwen/Qwen3-Reranker-0.6B`）；dashscope adapter（POST `/api/v1/services/rerank/text-rerank/text-rerank`，自有 schema；gte-rerank v1 2026-05-30 已下线不得选）；`none` 直通；配置面 `tdai-gateway.yaml → memory.recall.rerank.*` 解析+校验（schema 见设计稿 §4.3：enabled/provider/apiKey/baseUrl/model/timeoutMs 800/candidates 12/minScore -2.0/local.modelDir/local.idleUnloadMs 600000/shadowMode true）；provider 工厂与 `none`/未配置=跳过。
- 文件建议（按仓库既有模式落位）：MemoryCore `src/core/recall/` 新增 reranker 模块；config 解析进 config.ts `memory.recall` 组；类型进 types.ts。provider 详情以官网文档核实为准。
- 测试（TDD）：配置解析/校验（缺省、非法 provider、超时/候选数边界）；adapter 合同测试（mock fetch：正常、429、超时、5xx、畸形响应→null）；工厂路由。
- 验收：不接线时零行为变化；`pnpm -C MemoryCore test` 全绿。

## Task 2: performLayeredRecall 接入 + 熔断 + shadow journal（M1 #3，依赖 Task 1）

- Scope：接入 `performLayeredRecall`（MemoryCore/src/core/hooks/auto-recall.ts:360）——searchMemories 候选池扩到 `rerank.candidates`(12)，精排后取回 `maxResults`(5)；位置在 foldNearDuplicates/applyRecallBudget 之前；结构行（R7 结论行/灵魂行/锚行）不精排始终保留；失败语义 null+warn，连续 3 次失败熔断 60s（熔断期跳过精排不吃延迟）；journal `gates.rerank: { provider, ms, kept, dropped, topScore, shadow }`（MemoryCore/src/core/recall/recall-journal.ts:35 同级扩展）；`shadowMode:true` 只记录不改注入。
- 测试（TDD）：接入顺序（精排后 fold/budget）、结构行豁免、shadow 断言（注入结果与不精排一致+journal 有记录）、生效模式断言、熔断状态机（3 败→60s 跳过→恢复）、sqlite fallback 路覆盖。
- 验收：默认配置（enabled:false）下 golden 与既有测试全绿；开启 shadow 后 journal 出现 gates.rerank。

## Task 3: local provider + 模型下载器（M1 #3，依赖 Task 1）

- Scope：local provider=transformers.js（onnxruntime-node）+ `Xenova/bge-reranker-base` INT8 q8，worker_threads 内懒加载 + `local.idleUnloadMs`(600000) 空闲卸载，OOM 不连坐主服务（worker 崩溃→provider 置失败→null 降级）；自动下载器（仅 provider=local 且模型缺失时触发）：文件清单 config.json/tokenizer.json(17MB)/tokenizer_config.json/special_tokens_map.json/onnx/model_quantized.onnx(266.4MB)，fetch 直链+浏览器 UA+指数退避+Range 断点续传，主 `https://hf-mirror.com` 备 ModelScope，落盘 `dataDir/models/reranker/`，校验总大小后置 ready；下载状态可查询（供 panel 轮询，接口形态自定但须无推送依赖）。Spike 资产复用：`D:\TDB\data\models\reranker-spike-local\Xenova\bge-reranker-base\`（已下载 266.4MB）与 `D:\TDB\data\spikes\reranker-spike\test-rerank-local.mjs`（编码要点：pair 必须 `tokenizer(q,{text_pair:d})`；logits 用 `out.logits.data[0]`）。
- 测试（TDD）：下载器（mock HTTP：429 重试、断点续传 Range、校验失败回滚）；local provider 懒加载/卸载状态机（不依赖真模型权重，可用 tiny mock 或跳过权重断言）；OOM/worker 崩溃降级。
- 验收：真实模型冒烟（用 spike 已下载资产跑一次 8 对精排 ≤300ms）；下载器单测全绿。

## Task 4: panel reranker 配置 UI + 下载进度轮询（M1 #3，依赖 Task 1-3）

- Scope：panel 配置表单（与 embedding 配置同款交互）：enabled 勾选→provider 下拉（siliconflow/dashscope/local/none）→按 provider 显隐 apiKey/baseUrl/model→local 显示模型状态（已下载/未下载/下载中 xx%，**轮询**，panel 无推送通道）；服务端配置读写走 panel 现有配置通道。i18n 中英。
- 测试：表单渲染/显隐逻辑组件测试；后端配置往返测试。
- 验收：本机 panel 打开可完成「开启 rerank→选 provider→保存」全流程。

## Task 5: wiki_fetch knowledge tool（M2 #4）

- Scope：Knowledge 服务（8421）`/tools/list`、`/tools/call` 面新增 `wiki_fetch`：入参 `{ doc_path | title, section? }`（doc_path=KS 页面 path，对应 WikiSearchHit.path；无独立 doc_id 字段；title 兜底按标题精确匹配），出参正文单次 ≤4000 chars 截断（section 命中时优先返回该节）；身份/allowlist 语义沿用 knowledge tool 既有模型；knowledge-tools-injector 渲染新增工具的说明（供 agent 发现）。
- 文件：MemoryKnowledge tool 注册处 + MemoryProxy knowledge-tools-injector 渲染清单。
- 测试（TDD）：/tools/list 出现 wiki_fetch；/tools/call by doc_path / by title / section 截断 / 不存在→明确错误；只读（无写副作用）。
- 验收：本机 KS 打起后 curl 实测 list+call 成功。

## Task 6: wiki JIT 注入瘦身 + meta 能力位（M2 #4，依赖 Task 5）

- Scope：注入块瘦身（wiki-recall-injector.ts:354-355 applyRecallBudget 处）：单条=标题+一行摘要(≤80 chars)+`[详情: tool wiki_fetch]`，单条 ≤100 chars、整块 ≤500 chars（现 ≤1200）；例外：原文 ≤160 chars 直接注全文；per-agent `jit=false` 降级回现行；放量开关=meta 能力位 AssetCapabilityFlags（同 llm_wiki.enabled 模式）+per-team/per-agent 维度；panel 开关 UI；journal 记录每次注入 chars 与「若 JIT 会注入 chars」对比；摘要行来源：核实 knowledge_item 是否已有 summary 字段，没有就用首段首句截断。
- 测试（TDD）：瘦身断言（条数/chars 上限/例外直注）、jit=false 降级、能力位开关（开/关/无位=缺省行为）、shadow 对比 journal。
- 验收：注入体积 P50/P95 降 ≥60%（种子数据）；tool 往返成功率 ≥99%。

## Task 7: worthiness importance（M3 #5，M1/M2 合并后）

- Scope：设计稿 §6 全量——同一 LLM 调用打 importance 1-10+理由（l1-extractor 单次调用可挂）；`l1_records.importance TINYINT NULL`（幂等迁移参考 l1_fts 17→25）；recall-signals `importancePenalty` 仅 ≤4 惩罚、NULL 不罚；significance 全链路不动；shadow journal 分别记录两分量；panel 展示+手动调级（来源=manual）；无 LLM 字段不写行为=P0 现状。
- 红线：不删记忆；遗忘红线不变。
- 验收：种子会话寒暄 ≤3/决策 ≥7；召回 A/B journal 对比；TDD；独立 flag。

## Task 8: bi-temporal 补口（M4 #6，Task 7 后）

- Scope：设计稿 §7 全量——`/v3/atomic/invalidate {record_id, valid_end?, mode?: "invalidate"|"restore"}`=handleAtomicUpdate 既有 valid_end 写路（v2-router.ts:1263-1275→invalidateL1）语义化薄封装；restore=清空 valid_end（放开 v2-router.ts:1249 拷贝限制）；钩子路 filter-invalidated.ts（MemoryCore/src/core/recall/filter-invalidated.ts:6）对齐工具路 filterByValidity 完整区间语义（解析失败保留）；panel「标记失效/撤销失效」。
- 验收：失效/未来生效记忆两路（钩子/工具）都不召回 E2E；撤销可恢复；TDD。
