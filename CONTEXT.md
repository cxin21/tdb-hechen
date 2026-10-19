# CONTEXT.md — td-agemem 域词典与架构决定索引

> single-context 布局（见 docs/agents/domain.md）：本文件是全仓库唯一域词典；架构决定一律落 `docs/adr/`。动手改代码前先读相关词条。

## 域词典

- **价值锚（core_values / 锚）**：软取向轴——带权重（weight）与方向（valence）的稳定价值偏好，经四消费点间接生效（soul 注入 / fired 感受 / 召回加成+遗忘保护 / 张力检测）。**不是规则**；节点类型 theme（主题）/ person（人物）/ character（品格）。→ ADR-0002
- **严格规则（strict_rule 槽）**：硬约束层，人工全量裁决（全有或全无），永不自动写入；采纳合并保留既有行（V12-ADJ）。与价值锚分属规则层/取向层，不可混载。→ ADR-0002
- **身份槽（identity / self_identity）**：叙事层——用户画像与 agent 第一人称自我；单槽合并演化（version++），非结构化锚。渲染侧由 `renderIdentityNarrative`（单一源 `MemoryCore/src/core/hooks/identity-narrative.ts`）确定性组装身份叙事（Park 2411.10109 口径：条目存储+叙事渲染并存；溯源守门 ⊆ 模板常量∪slots 原文）。→ ADR-0005
- **desc 内容合同 v2**：锚描述一句话（≤60 字）=「情境短语+行为取向」，禁纯定义句与事件叙述；单一源 `MemoryCore/src/core/hooks/anchor-desc.ts`（DESC_CONTRACT_V2 / descContractPromptLine / passesDescContractV2）。→ ADR-0002
- **pending 提案**：红线类（core_value/strict_rule）LLM 提案只入 `core_pending`，人工采纳；语义去重 0.75（宁漏勿错杀）；rejected 永久拦截，证据 ≥2×minEvidence 可走重提通道（#19，缺省关）。
- **soul 渲染门**：desc 为空或 episode 特征 → 整条跳过（宁缺毋滥，禁裸关键词入人格）；预算截断按整锚丢弃（#10）。
- **LLM 凭据 SoT（admin settings）**：LLM 秘密字段（llm.apiKey）运行时唯一可信来源 = admin settings（各服务 `{dataDir}/config-override.json`）；通道序 override > yaml > TDAI_LLM_* env(deprecated 回退+一次性弃用告警)；占位符（整串 `__X__` / `${X}`）视为未设置（`utils/credential.ts` 守卫；脚本域单一读取器 `MemoryCore/scripts/lib/read-llm-credential.ts`）。baseUrl/model 等非秘密字段 env 优先不受影响。→ ADR-0006
- **Panel UI 小白优先原则**（2026-10-19 用户拍板）：MemoryPanel 一切界面以「第一次接触本系统的运维者」为基准用户，易用易懂优先——①白话标签，禁内部术语直达 UI（slot 名/门名/接口词翻译成人话，如 identity/self_identity → 「我是谁」「我心中的他」）；②状态外显（生效/降级/关闭一眼可辨，配一句解释）；③渐进披露（默认简单视图，技术细节折叠进高级区）；④降级与错误用人话说明（如叙事兜底 → 「已自动回退到原文显示」，不静默）。落点：所有 Panel UI 票的验收标准（首个应用票=R3 叙事预览，待立票）。

## 架构决定（ADR）

- [ADR-0001 值信号租户口径与维持现状裁决](docs/adr/0001-值信号租户口径与维持现状裁决.md) —— 值信号 default 桶契约、G-SIMMERGE/q 截断/R4 否定盲区维持现状、coreRef 精排因子 tie-breaker 定位。
- [ADR-0002 价值锚定位与 desc 内容合同](docs/adr/0002-价值锚定位与desc内容合同.md) —— 三层分工（叙事/取向/规则）、锚≠规则论证、合同 v2 单一源、锚级时效不做。
- [ADR-0005 身份叙事层：确定性叙事组装](docs/adr/0005-身份叙事层-确定性叙事组装.md) —— 条目存储+叙事渲染并存、A 案确定性组装单一源、双路同源、真实性三闸、nv 模板指纹（ADR-0003 §5 批次纪律）。
- [ADR-0006 LLM 凭据 SoT 收敛](docs/adr/0006-LLM凭据-SoT收敛-admin-settings.md) —— 秘密字段唯一 SoT=admin settings、通道序 override>yaml>env(deprecated)、占位符守卫、脚本域 readLlmCredential 单一读取器。
