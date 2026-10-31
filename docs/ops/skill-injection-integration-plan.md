# 技能注入：DSH 侧要不要接、怎么接（只读调研，2026-11-01）

口径：只读代码 + 真实调用（core 8420 活体，四头齐备，本轮无任何写操作）；不推断「语义检索已实现」这类票面说法，一律以代码与响应为准。资产基线：skills 表 2052 行 / is_head=1 且 active 284 行（本 agent agt-2m7buribzz 275 行）；近 7 天新增 head 19 条、30 天 284 条 ⇒ 写入侧仍在产出，读侧 0 消费（详见本仓 docs/ops/fullstack-test-read-injection.md F5）。

## 1. proxy 侧机制（skill-injector 8 条事实）

1. 注入点是**系统提示词固定段**，不是每轮消息：`point = "system.before_tools"`、`anchor = {slot:"skills", relation:"before"}`、`priority = HOOK_PRIORITY.SKILL`（MemoryProxy/src/injection/injectors/skill-injector.ts:151-157）。
2. 生命周期 `cacheStrategy = "session_init"`（同上 :159）：prewarm 跑一次、整会话复用，缓存 key 固定 `"skill-injector:catalog"`（:298）⇒ 命中缓存时**后续轮零成本**，这是它敢塞 7–10K 字符的前提。
3. 查询由 agent/task 描述拼成：agentDetail.description + prompt + taskDetail.description + goal（:120-131）；拼接结果去重后不足 3 个 ≥3 字符 token 就不传 query（:136-144），让 core 退回列表头。
4. 内容 = core `/v3/skill/listing` 预渲染的 `<available_skills>` 文本；`listing` 为空或含 `(none)` 直接不注入（:285-287）。
5. 包裹固定三段：英文强制加载指令 `SKILL_LISTING_HEADER`（:61-77）+ 中文 fallback/curl 提醒（:96-101）+ listing + footer（:79-80），一个 text block（:288-300）。
6. 体积实测（renderSkillToolsBlock 与活体 listing 双测）：`<skill_tools>` curl 配方块 2852 字符（allowLlmWrite=false）/ 4314 字符（true）；`<available_skills>` 20 条上限下 8004 字符（char_budget=8000）/ 9680 字符（20000）⇒ 一次会话 skill 面 ≈ 10.9–14K 字符。
7. 降级是「静默空块」：core 报错 → `console.warn` + `return []`（:278-283）；缺 team_id/agent_id → []（:248-253）；`assetCapabilities.skill === false` → []（:190/:213）。**永不失败请求**，但也没有「降级」标记进上下文。
8. 冷路径语义弱化：缓存 miss 时 `execute()` 只能以 `query: undefined` 重放（:187-204），落回 mode=full 的列表头 —— 与 prewarm 的检索结果不同（:174-181 注释自认是 accepted trade-off）。
   工具面另有 `<skill_tools>` 描述的 curl 配方（skill-tools-injector.ts:59-101，读=skill_search/skill_view/skill_files_read，写=skill_create/update/patch，由 `allowLlmWrite` 控制，缺省 true（skill-tools-injector.ts:61，写工具清单见 :16-18）），执行侧是 proxy 的 skill-bridge（MemoryProxy/src/skill/skill-bridge.ts 1097 行 + handler-glue.ts:73）。

## 2. core 侧端点与真实读数

- `POST /v3/skill/search`：body `{team_id, agent_id, query, top_k, scope?}`，`scope="team"` 去掉 agent 过滤（MemoryCore/src/gateway/skill-handlers.ts:544-565）；返回 `items[{...summary, score, snippet}]`，`score=-bm25`。**纯 FTS5 BM25**：`searchSkills` 只实现 BM25，mode=embedding/hybrid 一律降级并 warn（MemoryCore/src/core/skill/skill-store.ts:557-574），且 `skill-core.search()` 从不传 `queryEmbedding`（MemoryCore/src/core/skill/skill-core.ts:503-517）⇒ proxy 说的「关键词 + 语义检索」（skill-tools-injector.ts:78）**不成立**。
- `skill_vec` 是空表：vec0 影子表 skill_vec_rowids / skill_vec_chunks / skill_vec_vector_chunks00 各 **0 行**（vectors.db 直查），skill_fts 284 行 ⇒ 向量索引从未建过，降级不是偶发是常态。
- `POST /v3/skill/listing`：有 query → search(`routing.searchTopK`，缺省 20，skill-config.ts:232），无 query → list head；渲染 `- name: description`，按 `char_budget`（缺省 8000、schema 上限 64000）截断并加 `... [truncated]`（skill-handlers.ts:671-741）。实测 char_budget=8000→8004 字符/20 条、20000→9680/20 条（20 条是硬上限，再大也只多 1.6K）、100000→40001 `char_budget: Too big`。
- `POST /v3/skill/get`（skill_id + include_content/manifest）与 `/v3/skill/get-by-name`（name exact match）给全文+manifest（:504-527 / :443-502）；实测返回 1071–30318 字符，全库 head 正文平均 6074 字符（最小 549、最大 53872）。
- 检索质量与延迟（本品实测，8 条真实 query，top_k=3，scope=team）：延迟 7–56ms；**7/8 条 top-1 精确命中**（采购订单行号→ncc-crowno-filling-vorownoutils、云文库上传→yonbip-ec-file-api-surface、供应商价目→purp-askbill-supplierprice-chain、SSH 部署→dev-machine-ssh-git-auth…），弱项是「写周报总结进展」（返回批量 issue 工作流）。⇒ 资产内容是真的，不是死档案。
- 载荷成本：top_k=3 响应 3474 字符（name+description 压缩后 2081）；把 description 裁到 200 字符可压到 ~700 字符。名称+描述全库 284 条合计 87116 字符（本 agent 275 条 85991）。

## 3. 三种接入形态对比

| 形态 | 每轮/每次成本 | 发现能力 | 与 DSH 注入模型的关系 | 实现面 |
|---|---|---|---|---|
| ① 每轮拼进 user message（学 volatile） | 每轮固定 +N 字符，且 append-only 永不回收（dsh-plugin/src/volatile.ts:7-15、:232-256）；实测 1200 预算下 k=3→k=10 只多 1 条记忆 | 只覆盖 top N：800 字符 ≈ 2.5 条（平均 313 字符/条）→ 275 条里 1% | 逆着 DSH 的 append-only 语义，破坏 KV 前缀 | 最省事，但成本随轮数线性增长 |
| ② 按需工具（memory_recall 同构） | 工具定义常驻 ≈250 字符（tools 段稳定，不破坏 cache）；调用一次 0.7–2K 字符输出；core 延迟 7–56ms | 全量 275/284 条可达，query 由模型自撰 | 与 DSH 原生 skill 机制同构（提示词只列能力名，正文按需 load） | 新增 2 个 tool definition + client 方法，参照 dsh-plugin/src/tools.ts:38-81 |
| ③ head pack 加技能索引 | 系统段一次/session（dsh-plugin/src/index.ts:572-582，refreshMs=300000） | 只能静态 head：无任务描述可作 query，按 updated_at 取前 N | 与 persona/场景索引争预算：现 4939/8000 字符，余 ~3K ≈ 9 条 | 改 composeHeadPack 或独立 section |

## 4. 推荐：② 按需工具，③ 作为后续可选项

理由：① 的性价比已被实测否掉（每轮 800 字符换 ~2.5 条技能，且 append-only 累积）；③ 受 headPack.maxChars=8000 硬约束（现 4939 字符），最多再放 9 条且与任务无关；② 只在模型真需要时花钱，且 8420 侧延迟 7–56ms、输出可裁到 ~700 字符，与 `memory_recall` 完全同构（同一 tools.register 通道、同一 fail-open 约定）。

配置键草案（新增 `skill` 段，缺省关，符合本仓 shadow-first 惯例）：
```yaml
skill:
  enabled: false          # 缺省关；开了才注册工具
  searchTopK: 5           # 单次 search 返回条数（core 侧上限 20）
  descriptionChars: 200   # 渲染时截断 description，防 2K 载荷
  maxResultChars: 2000    # 单次工具输出上限（含 wrapper）
  timeoutMs: 2500         # 复用 volatile 的预算口径，不与 recall 抢
  paths: { search: /v3/skill/search, get: /v3/skill/get }
  allowWrite: false       # skill_create/patch 一律不接（写侧已有 conversation/add）
```
工具面：`skill_search{query, limit?}` → 渲染 `- name (id) — 描述`；`skill_view{skill_id}` → 全文（>maxResultChars 时截断并给 `truncated` 提示，参照 head-pack 的 TRUNCATION_MARKER 惯例）。

失败隔离（三条，缺一不可）：① 工具自身 `try/catch` → 返回字符串 `skill unavailable: <reason>`，绝不 throw（同 tools.ts:73-79）；② 不接入 volatile/head-pack 链路，core 挂了只影响这两个工具；③ `enabled=false` 时不注册、不请求、不留 agent 侧依赖。
观测：沿用 index.ts:1027 的 debug 行风格，加 `skill=on calls=N hits=M chars=K ms=T`；失败单独计数 `skill_fail=N`（区分超时/4xx/5xx）。

## 5. 验收判据（能证明「接上了」的最小证据）

1. 工具出现在会话 tools 列表，且 `definition.parameters` 是合法 JSON Schema（root `type:'object'`、`required` 为数组）—— 这一条必须查，历史上 `memory_recall` 正是因 schema 非法而「静默不存在」（dsh-plugin/src/tools.ts:4-19）。
2. 真实会话里模型自发调用 `skill_search` 一次，返回 hits ≥1，且 name 与 `/v3/skill/search` 直连结果一致（可对拍请求 id / 时间）。
3. `skill_view` 返回正文字符数与 `/v3/skill/get` 的 `content.length` 相等（或按 maxResultChars 显式截断并标注）。
4. 停 core（或注入 400）时，工具返回字符串、会话继续、volatile 与 head pack 字符数**不变**。
5. 回归：同一会话前后 `volatile` 注入字符数与 token 估算不变（证明没有偷偷变成形态①）。

## 6. 不接的实际影响

- 284 条团队技能（87KB 名称+描述、平均 6KB 正文）在 DSH 会话里**不可达**：模型只能用 DSH 原生 skills（本会话 ~30 个）+ 记忆召回。写入侧仍在增长（7 天 +19 条），形成「只写不读」的资产黑洞。
- 代价不是「答错」，而是**重复劳动**：本轮实测 8 条真实 query 有 7 条能精确命中对应 SOP（NCC 客开链路、云文库端点面、供应商价目语义），这些结论现在只能靠人记得「以前写过」再手动翻。
- 反向证据也要写明：技能检索纯 BM25、且长尾 query 会跑偏（周报 query 返回批量 issue 工作流），所以**不建议**接成每轮注入（错误技能比没有技能更贵）；只接按需工具时，跑偏成本 = 一次工具调用。

## 7. 未证实项

- proxy 在真实 CodeBuddy/Claude 会话里的注入效果（本轮 proxy 未运行，只读码 + 实测 core 端点）。
- `<skill_tools>` curl 配方在 DSH 里是否也该出现：DSH 有原生 tools 通道，本方案判定不需要，但没有做过对照实验。
- 「9 条静态索引能覆盖多少真实任务」没有数据（需要按实际会话 query 分布统计）。
- 8421 wiki 面与技能面是否该合并成一次检索，未评估。