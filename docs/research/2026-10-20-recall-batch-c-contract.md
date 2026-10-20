# Batch C 合同：时效根治（F6a/F6b/F5）——#77

日期：2026-10-20 · 依据：#77 定量取证 + survey（docs/research/2026-10-20-recall-precision-survey.md）· 授权：m00637 台账链

## §1 范围

### C-a 写链 soul 合标统一（F6a 根因修复）
- 新增 `bindSoulAtWrite(rec)` 导出于 `content-soul.ts`：内部 `patchSoulFromContent(rec.content ?? "", rec)` 只填空字段（既有语义零变化），随后最小兜底 `if (!rec.occurred_at) rec.occurred_at = rec.createdAt || new Date().toISOString()`（与 l1-writer.ts:330 同款语义：occurred_at=真实记录时刻，非内容时间猜测）。纯函数、无 IO。
- 六个写点接线（upsertL1 调用前）：consolidation-worker.ts:205,221 / reflection.ts:162,243,266 / evolution-worker.ts:289,291。
- l1-writer.ts:320-330 choke point 零变化（已合标，二次调用幂等）。

### C-b F6b 检索期衰减因子（预防性接线，缺省关）
- config 新增 `recall.ageDecay`（enabled 缺省 false / halfLifeDays 缺省 30，负与非有限→30）与 `recall.timeProxFallbackEnabled`（缺省 false）。
- memory-search.ts composite：enabled 时 score 乘 `0.5^(ageDays/halfLifeDays)`；ageDays 时间锚=occurredAt（缺失不衰减=无实证不惩罚，R1 同口径）；never-a-filter：乘子下限 clamp 0.05（D3 拍板可调）。
- timeProxFallbackEnabled=true 时 occurredAt 缺失回退 created_time（存量 work_fact 吃到时近因子）；false=逐位现状。

### C-c F5 零代码声明
- supersession 管线全链在位（invalidateL1 软失效可逆+restore+两路读面），代码零增量；仅产出部署拍板清单与存量回填声明（D2 域，不执行）。

## §2 非目标
- 不碰 invalidateL1/restore 语义、不碰 R-A 情绪通道（valence/arousal/mood 绝不入召回信号，coreRef 既有价值锚通道不动）。
- 存量 occurred_at 回填不执行（D2 拍板域）；生产 yaml 翻转属部署侧。
- 不碰九通道排序权重缺省值（0.70/0.15/0.10/0.05）。

## §3 验收
1. RED 先行：新用例 feature-missing 失败确认（bindSoulAtWrite 缺失→写链测试红；config 新键缺失→parse 测试红）。
2. GREEN：vitest-core 全绿零回归（基线 2037+新增）；vitest-proxy 47/368 全绿；typecheck error TS=243 守恒。
3. 对抗审查（独立代理或降级自审：证伪优先）。
4. surgical commit+push（m00637 授权链：只读盘点+diff 纯净核查，绝不裹挟外来 WIP）。
5. golden runner 复跑对照（C-a 后新写入 work_fact occurred_at 满、timeProx 生效；不强求高价值率提升，观察项）。