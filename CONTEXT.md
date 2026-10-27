# CONTEXT.md — td-agemem 域词典与架构决定索引

> single-context 布局（见 docs/agents/domain.md）：本文件是全仓库唯一域词典；架构决定一律落 `docs/adr/`。动手改代码前先读相关词条。

## 域词典

- **价值锚（core_values / 锚）**：软取向轴——带权重（weight）与方向（valence）的稳定价值偏好，经四消费点间接生效（soul 注入 / fired 感受 / 召回加成+遗忘保护 / 张力检测）。**不是规则**；节点类型 theme（主题）/ person（人物）/ character（品格）。→ ADR-0002
- **严格规则（strict_rule 槽）**：硬约束层，人工全量裁决（全有或全无），永不自动写入；采纳合并保留既有行（V12-ADJ）。与价值锚分属规则层/取向层，不可混载。→ ADR-0002
- **身份槽（identity / self_identity）**：叙事层——用户画像与 agent 第一人称自我；单槽合并演化（version++），非结构化锚。渲染侧由 `renderIdentityNarrative`（单一源 `MemoryCore/src/core/hooks/identity-narrative.ts`）确定性组装身份叙事（Park 2411.10109 口径：条目存储+叙事渲染并存；溯源守门 ⊆ 模板常量∪slots 原文）。stage 2 确定性自动采纳门（autoAdopt，config 缺省关）：count≥N₂ ∧ 跨≥T₂ ∧ 无矛盾 → 自动采纳落槽（auto_adopted），版本守卫快照回滚，人转审计员。→ ADR-0005、ADR-0007
- **desc 内容合同 v2**：锚描述一句话（≤60 字）=「情境短语+行为取向」，禁纯定义句与事件叙述；单一源 `MemoryCore/src/core/hooks/anchor-desc.ts`（DESC_CONTRACT_V2 / descContractPromptLine / passesDescContractV2）。→ ADR-0002
- **pending 提案**：红线类（core_value/strict_rule）LLM 提案只入 `core_pending`，人工采纳；语义去重 0.75（宁漏勿错杀）；rejected 永久拦截，证据 ≥2×minEvidence 可走重提通道（#19，缺省关）。
- **soul 渲染门**：desc 为空或 episode 特征 → 整条跳过（宁缺毋滥，禁裸关键词入人格）；预算截断按整锚丢弃（#10）。
- **LLM 凭据 SoT（admin settings）**：LLM 秘密字段（llm.apiKey）运行时唯一可信来源 = admin settings（各服务 `{dataDir}/config-override.json`）；通道序 override > yaml > TDAI_LLM_* env(deprecated 回退+一次性弃用告警)；占位符（整串 `__X__` / `${X}`）视为未设置（`utils/credential.ts` 守卫；脚本域单一读取器 `MemoryCore/scripts/lib/read-llm-credential.ts`）。baseUrl/model 等非秘密字段 env 优先不受影响。→ ADR-0006
- **服务间鉴权（service key）**：KS 写/管理面的入站鉴权。`KNOWLEDGE_SERVICE_KEY` 为空 = **不启用**（内网信任，向后兼容本地/开发）；非空 = 除只读白名单（Agent 查询面：tools/list、tools/call、wiki/code-graph 查询、auto-sync/status）外的 `/v3` 端点必须带 `Authorization: Bearer <key>`，缺失/错误一律 401（fail-closed）；`/health`、`/docs`、`/openapi.json` 在 `/v3` 之外不受影响。同一个 key 三侧传播：校验侧 `KNOWLEDGE_SERVICE_KEY` / Panel 调用侧 `KNOWLEDGE_AUTH_TOKEN` / MCP 侧 `KNOWLEDGE_API_TOKEN`；部署脚本自动生成 `ks-svc-<hex48>` 并幂等回写 .env。→ ADR-0009
- **属性基数（cardinality / single·multi）**：#136 的写面契约——判断一条事实的属性是否函数依赖（同一时刻只有一个值）。single（计数/联系方式/个人档案）允许 supersession 失效旧值；multi（模态/意愿/泛化动词：consider/want/like/has/feels…）是 additive，新值只追加、永不失效。单一源 `MemoryCore/src/core/record/cardinality.ts`（谓词级 `classifyCardinality` + 内容级 `classifyContentCardinality`，显式 > 单值词表 > 多值词表 > 值结构线索 > 缺省 single）。→ ADR-0010
- **软失效（soft validity）**：读侧双时态策略——expired（valid_end ≤ now）不再硬删，而是 relevance × SOFT_VALIDITY_PENALTY 降权后继续参与精排；仅当查询显式问「现在/最新」且池里存在**内容相关**的更新行时才硬丢，future 恒丢。单一源 `MemoryCore/src/core/recall/validity-policy.ts`（`selectByValidity` / `excludeInvalidatedFor` / `SOFT_VALIDITY_PENALTY`），config `recall.validity.mode` 缺省 hard。→ ADR-0010
- **事实通道 / 多事实键（fact channel）**：#137 的 W1 形态——原文 embedding 主索引 `l1_vec` 逐位不动，事实短语（抽取侧 2-5 条 `metadata.facts`，可选 `factTriples`，dedup 的 `metadata.subject` 作单短语回退）单独 embed 进 `l1_fact_vec`，召回时作**平行通道**只扩召回：rrf 档只收池里没有的新候选（权重 `fusion.fact > recall.factChannel.weight > 0.6`），normalized 档才把通道内归一化分合成 relevance 作主序（`rrfScore` 退回平局兜底）。单一源 `MemoryCore/src/core/record/fact-key.ts`（归一化/键文本/`clampMaxFacts`）、`write-policy.ts`（写侧键）、`recall/fusion.ts`（权重与归一化融合）。缺省三开关全关。→ ADR-0011
- **Panel UI 小白优先原则**（2026-10-19 用户拍板）：MemoryPanel 一切界面以「第一次接触本系统的运维者」为基准用户，易用易懂优先——①白话标签，禁内部术语直达 UI（slot 名/门名/接口词翻译成人话，未知名的 slot 键也不许直达 UI，兜底「未知提案」，原始键名走悬停提示——如 self_identity → 「我是谁」提案、未知 slot → 「未知提案」）；②状态外显（生效/降级/关闭一眼可辨，配一句解释）；③渐进披露（默认简单视图，技术细节折叠进高级区）；④降级与错误用人话说明（如叙事兜底 → 「已自动回退到原文显示」，不静默）。落点：所有 Panel UI 票的验收标准（首个应用票=R3 叙事预览，待立票；#105 起两页待裁决区落地本词条）。

## 架构决定（ADR）

- [ADR-0001 值信号租户口径与维持现状裁决](docs/adr/0001-值信号租户口径与维持现状裁决.md) —— 值信号 default 桶契约、G-SIMMERGE/q 截断/R4 否定盲区维持现状、coreRef 精排因子 tie-breaker 定位。
- [ADR-0002 价值锚定位与 desc 内容合同](docs/adr/0002-价值锚定位与desc内容合同.md) —— 三层分工（叙事/取向/规则）、锚≠规则论证、合同 v2 单一源、锚级时效不做。
- [ADR-0005 身份叙事层：确定性叙事组装](docs/adr/0005-身份叙事层-确定性叙事组装.md) —— 条目存储+叙事渲染并存、A 案确定性组装单一源、双路同源、真实性三闸、nv 模板指纹（ADR-0003 §5 批次纪律）。
- [ADR-0006 LLM 凭据 SoT 收敛](docs/adr/0006-LLM凭据-SoT收敛-admin-settings.md) —— 秘密字段唯一 SoT=admin settings、通道序 override>yaml>env(deprecated)、占位符守卫、脚本域 readLlmCredential 单一读取器。
- [ADR-0007 身份槽确定性自动采纳门](docs/adr/0007-身份槽确定性自动采纳门.md) —— stage 2 终局形态：三重门（N₂=4/T₂=72h/矛盾线 0.60/重复线 0.75，2026-10-25 拍板）、config 缺省关、快照+版本守卫回滚、采纳链单一源镜像人审 merge-on-adopt。
- [ADR-0008 召回门限刻度治理：剔词退役与地板相对化](docs/adr/0008-召回门限刻度治理-剔词退役与地板相对化.md) —— 候选集占比剔词退役（自指病灶）、bm25 地板 α×topRel 相对化（legacy 双轨兜底）、local rerank sigmoid 归一 + all-below 降级不清零；未迁移 yaml 逐位不变。
- [ADR-0010 双时态属性契约与软失效](docs/adr/0010-双时态属性契约与软失效.md) —— supersession 只在单值属性成立（cardinality 契约，多值 additive 永不失效）、效期从硬过滤改为融合特征降权（仅当下意图 + 内容相关的更新行才硬丢）、三路读口径按能力分层、零删除不变。
- [ADR-0011 事实键平行召回通道与多事实键](docs/adr/0011-事实键平行召回通道与多事实键.md) —— W1 键替换形态无净收益（#147），改平行通道：原文主索引不动、事实单独向量表、只扩召回；多事实来源 + 单条归一化 clamp；rrf 档只收新候选（双命中不反超）、normalized 档通道归一化分作主序；缺省三开关全关。
- [ADR-0009 服务间鉴权：KNOWLEDGE_SERVICE_KEY fail-closed](docs/adr/0009-服务间鉴权-KNOWLEDGE_SERVICE_KEY.md) —— 空 key=不启用/非空=写管理面 401、只读白名单口径（补齐上游漏掉的 code-graph 8 个动态只读查询）、code-graph 查询名单单一真相源、真实路由表护栏、key 三侧传播与部署侧自动生成。
