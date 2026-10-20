# D2/D3 拍板决策包（只读取证 · 2026-10-20）

> 供用户拍板；本文档零代码改动。数据来源=生产 vectors.db readOnly 探针（10-20T19:35 前后，探针用后即删）+ Batch C/D 已落地代码。

## D2：存量 occurred_at 回填 vs 开关（互斥或并用）

**一手探针（work_fact 421 条）**：
- 空 occurred_at=355（84.3%），全部来自 reflection 写卡链（Batch C C-a=48f2406 已根治增量）
- **valid_start 有值率=0/355**（探针 emptyVsHas=0）——「valid_start 兜底回填」选项不成立
- content 前 200 字时间词（X月Y日/昨天/今天/明天）可解析率=**0/355**——parseOccurredAt 语义回填也不成立（结论卡天然无时间词）
- 失效 1/355

**可选路径对照**：

| 选项 | 动作 | 召回效果 | 风险 |
|---|---|---|---|
| A 回填写库 | 一次性 UPDATE 355 条 occurred_at=created_time | 与 B 等价 | 碰生产数据（P1 红线邻域），不可逆性需评估 |
| B 开 timeProxFallbackEnabled | 生产 yaml memory.recall 一行（C-b 已实现，缺省关） | 等价（composite timeProx 锚=occurred_at??created_at，memory-search.ts:618 同口径） | 零写库、软开关可逆、config-first |
| C 并用 | A+B | 同 A | 同 A |

**建议：B**（效果等价+零数据触碰+可逆，对齐软失效可逆设计偏好）。A 仅在 B 验证后仍需修正「严格 occurred_at 语义」时再议。

## D3：ageDecay 参数（C-b 已实现，缺省关）

**库龄现状（此前取证）**：0-1d 224 条、2-7d 840 条、无 >7d——衰减乘子=0.5^(ageDays/halfLifeDays)，timeProx 权重 0.15。

| halfLifeDays | 1d 龄 | 3d 龄 | 7d 龄 | 备注 |
|---|---|---|---|---|
| 30（MemOS 半衰期） | 0.977 | 0.933 | 0.851 | 现库全龄段几乎无区分度 |
| 14 | 0.952 | 0.861 | 0.707 | 折中 |
| 7 | 0.906 | 0.743 | 0.5 | 区分度最大，对 7d 内记录略激进 |

**建议：halfLifeDays=14 + enabled=true 随部署重启一并开**（D2 选 B 时两者同改 yaml 一处）；或保守先 off，待库里出现跨周记忆（观察窗发现 >7d 条目）后再开——两种都可逆，拍板即定。

## conclusionContract（Batch D few-shot 开关）

生产 yaml `memory.lifecycle.reflection.soulProposals.conclusionContract.enabled: true`（缺省 false=现状）。开启后反思 LLM 收到「一句话一件事/≤300 字/多事拆条/宁缺毋滥」引导；拒收门（≤300 码点机械门）已无条件生效，本开关只加 prompt 引导，降低拒收率。

**建议：开启**（与 D2/D3 同一次 yaml 变更+重启完成）。

## 拍板清单（一次定齐）
1. D2：A 回填 / **B 开关（建议）** / C 并用
2. D3：**14d+开（建议）** / 30d / 7d / 先 off
3. conclusionContract：**开（建议）** / 暂缓
4. yaml 变更属部署侧：拍板后由您或授权 AI 按部署 SOP 改 D:\TDB\td-agemem\MemoryCore\tdai-gateway.yaml（gitignore 部署侧配置，env-first 单一事实源口径；模板 deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml 同步）并重启四服务
