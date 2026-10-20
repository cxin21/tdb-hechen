# F3 candidates 扩池独立 A/B —— 实测报告（survey F3 · 台账末位批次）

> 2026-10-20 · 三档 candidates（12/24/36）× golden dataset 11 轮对照。零代码改动纯配置实测：
> override 副本注入变体（rerank.candidates=N，生产原件零改），DB 副本+临时网关 :8423 自起自停，
> 零注入零删除、结伴生全关（纪律同 golden runner）。归档 .tmp-gate/f3-ab-result.json + f3-ab.log（不入库）。

## 1. 结果（三档零红牌）

| candidates | highValueHitRate | strictHigh | memRows | blockChars | p50 | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| 12（现状） | 0.667（6/9） | 0.75（6/8） | 32 | 50232 | 2394ms | 3589ms |
| 24 | 0.667（6/9） | 0.75（6/8） | 32 | 50216 | 2483ms | 3607ms |
| 36 | 0.667（6/9） | 0.75（6/8） | 32 | 50234 | 2262ms | 3336ms |

v12 与 golden 基线（0.667/0.75）逐位一致 = 现状档交叉验证通过。

## 2. 判读（诚实口径）

- **三档输出逐位一致**：高价值率/strict/行数/注入字符完全相同，p50/p90 差异 ±200ms 在噪音带内（v36 反而最快）。
- **结论：扩池在当前 dataset 上无增益证据（也无劣化）**。memRows 恒 32 说明最终注入面不变——
  top-12 候选池已包含全部可命中行，池宽不是瓶颈。
- 与 survey 病灶定性互证：瓶颈在**粒度**（整包结论 vs 原子事实，#78 F4 主药）而非候选池宽度；
  F3 完成「排除池宽不足假设」的使命，病灶清单再减一项。

## 3. 机制侧事实（供拍板背景）

- 扩池机制**已实现**：auto-recall.ts:1025-1032（rerank active 时按 candidates 覆盖检索池 maxResults）；
  config.ts:1876 candidates=recallSignalBoost 缺省 12 clamp [1,100]；类型 config.ts:404。
- 生产实际生效值：config-override.json rerank={provider:local,enabled:true,idleUnloadMs:0}（candidates 未配=缺省 12）。

## 4. 建议（待拍板）

维持 candidates 缺省 12 不调值：无收益数据支撑调大，且 v36 无延迟恶化但也无质量收益——
参数口径保守原则（config-first，无证据不翻转）。F3 以本报告收束，不立实施票（零代码改动）。
后续若 #77 观察窗/F4 落地后 dataset 演进再复测（本报告为复测基线）。
