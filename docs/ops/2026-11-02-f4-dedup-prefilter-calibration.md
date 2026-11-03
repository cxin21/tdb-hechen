# F4：dedup 前置门槛（minCos）实测校准报告

- 日期：2026-11-02
- 工作区：`D:/TDB/td-agemem`（MemoryCore 模块），HEAD `b8ba3e0` 之上的未提交改动
- 票：task-5 / F4（MAJOR）
- 被问：`MemoryCore/src/core/record/l1-dedup.ts` 的 `DEFAULT_PREFILTER_MIN_COS = 0.9` 与本域 embedding 分布**是否匹配**

## 1. 结论先行

| 项 | 值 |
| --- | --- |
| 原缺省 | `0.9` |
| 实测后缺省 | **`0.82`** |
| 判据形态 | 绝对阈值 + 实测校准（**否掉**相对口径） |
| 应合并对放行 | 10/10（原 0.9 只有 9/10） |
| 无关对拦下 | 10/10 |
| 域内硬负例拦下 | 8/9 |
| 同值参照 | `lifecycle.consolidation.attributeGrouping.minCos` = 0.82 |

一句话：**0.9 会拦掉最弱的真重复（0.8587），代价是把重复记忆重新入库；0.82 落在 0.363 ~ 0.8587 的干净空窗里，两侧余量 0.039 / 0.457。**

## 2. 取证方法（只读）

- 生产库 `D:/TDB/data/vectors.db`，`node:sqlite` `DatabaseSync(path, { readOnly: true })`，**零写入**、零服务重启。
- 样本：3913 条 L1 向量，2048 维（生产 embedding 同维）。
- 口径：`topScore` = 该条新记忆在**排除本批自身**后的 top-1 cosine（与 `batchDedup` → `prefilterCandidateMatches` 里用的排序量完全同义）。
- 复测脚本（临时，不入库）：`.tmp-gate/f4-measure.mjs`（三组样本打分）、`.tmp-gate/f4-zscore.mjs`（相对口径可行性）、`.tmp-gate/f4-organic.mjs`（全库抽样两两 NN 分布）；原始结果 `.tmp-gate/f4-measure.json`。

样本构成：
1. **应合并对 10 组**：真实入库记录 + LLM 等义改写（改人称/换措辞/拆句），语义等价、字面不同。
2. **无关对 10 组**：域外生活文本（天气、购物、日程）对全库检索。
3. **域内模板克隆硬负例 9 组**：同一句式模板换实体/时间/数值，**字面高度相似但事实不同**（合法的两条独立记忆）。

## 3. 三组分布（实测）

应合并对 `topScore`（升序）：
```
0.8587  0.9017  0.9368  0.9393  0.9399  0.9419  0.9543  0.9559  0.9589  0.9918
```
min **0.8587** / max 0.9918。

无关对 `topScore`（升序）：
```
0.1938  0.2392  0.2429  0.2582  0.2607  0.2754  0.2924  0.3006  0.3160  0.3630
```
max **0.3630**。

域内模板克隆硬负例（升序）：
```
0.5670  0.5848  0.6326  0.6559  0.6752  0.6820  0.7307  0.7978  0.8568
```
最硬 **0.8568**。

全库 900 抽样两两最近邻（organic 分布，衡量"随便两条能有多像"）：

| cos ≥ | 对数 |
| --- | --- |
| 0.70 | 190 |
| 0.80 | 41 |
| 0.85 | 22 |
| 0.90 | 10 |
| 0.95 | 0 |

人工核对：库内真实重复（近同文入库）集中在 0.885 ~ 0.928。

## 4. 矩阵：各阈值下放行/拦下计数

放行 = `topScore >= minCos` → 进 LLM 判重；拦下 = 直接判"不重复"（store）。

| 阈值 | 应合并对放行 | 无关对放行 | 硬负例放行 | 评价 |
| --- | --- | --- | --- | --- |
| 0.90（原值） | **9/10** | 0/10 | 0/9 | 丢 1 条真重复（0.8587）→ 重复入库 |
| 0.86 | 9/10 | 0/10 | 0/9 | 仍丢同一条；且余量仅 0.001，压在噪声上 |
| 0.85 | 10/10 | 0/10 | 1/9 | 真重复全收，但下沿余量仅 0.0087 |
| **0.82（采用）** | **10/10** | **0/10** | **1/9** | 下沿 0.039、上沿 0.457，两侧都留足 |
| 0.80 | 10/10 | 0/10 | 1/9 | 与 0.82 同计数；放行面更大（全库 ≥0.80 有 41 对）无收益 |

## 5. 为什么不用相对口径

本域真实分布里，**真重复与最硬负例的相似度并非只差一个平移**，相对口径（同批 top-k 名次 / 分位数 / z-score）分不开：

- 应合并对 z-score：**6.02 ~ 12.10**
- 硬负例 z-score：**2.89 ~ 6.84**

两段区间在 6.02 ~ 6.84 **交叠**——即"很硬的负例"在批内相对位置比"较弱的真重复"更高。任何单调的相对口径（名次/分位数）在交叠区必然二选一错一边；而前置门槛的错法不对称（见 §6），所以相对口径在这里是**用更多机制换更差的判据**。

## 6. 决策理由（代价不对称）

前置门槛只有一个动作：**决定要不要花一次 LLM 判重**。

- **错拦真重复**（门槛偏高）：判"不重复"直接 store → 重复记忆入库，之后召回要长期与自己的影子竞争，且需要人工/后置去重。**有害、且不可即时撤销。**
- **放过非重复**（门槛偏低）：多花 1 次 LLM 调用，LLM 判 store —— **结果依然正确**，只损失成本。

所以最优取舍是"贴近真重复分布的下沿，但留出 cosine 抖动余量"。0.8587 是本批最弱真重复，0.86 以上开始丢它，故取 0.82（与 `attributeGrouping.minCos` 同值，减少一处魔数）。**未把门槛调 0**：0 等价于"关掉前置过滤、每对都问 LLM"，与本票要修的东西（门槛不匹配）不是一回事；有专门的 `enabled: false` 开关表达这个意图。

## 7. 代码改动

- `MemoryCore/src/core/record/l1-dedup.ts`：`DEFAULT_PREFILTER_MIN_COS` `0.9` → `0.82`，并把上面全部实测数字写进常量注释（防止后人凭直觉改回 0.9）；`resolvePrefilterMinCos` 注释改为"回落到 DEFAULT_PREFILTER_MIN_COS"。
- 新用例 `MemoryCore/src/core/record/l1-dedup.prefilter-calibration.test.ts`（5 例）：缺省值断言 + 三组样本矩阵 + 0.9 反证 + 空窗余量守卫。
- 存量 `MemoryCore/src/core/record/l1-dedup.prefilter.test.ts`：`resolvePrefilterMinCos(NaN/undefined)` 的两条断言从字面量 `0.9` 改为常量 `DEFAULT_PREFILTER_MIN_COS`（行为不变，避免下次校准再改测试）。

## 8. 诚实边界 / 已知未落地

1. **本改动只改代码缺省，不改生产行为**。`MemoryCore/src/config.ts:2224` 的解析是 `Math.min(1, Math.max(0, minRaw ?? 0.9))`——config 未设时仍回落 0.9，而该文件在本次任务里**禁改**。生产生效需要二选一：
   - `config-override.json` 设 `extraction.dedupPrefilter.minCos = 0.82`；或
   - 由 Lead 把 `config.ts:2224` 的 `?? 0.9` 改成 `?? 0.82`（推荐，单一事实源）。
2. `config.ts:2224` 的 clamp 是 **0..1**，而 `attributeGrouping` 的 clamp 是 0.5..1——两处口径不一致，本次未改动（禁改文件），仅记录。
3. 校准基于 `ark doubao-embedding-vision` 当前模型+2048 维。**换模型/换 provider 必须重测**（cosine 分布随模型漂移，本次 0.82 不是普适常数）。
4. 样本量：应合并对 10 组、无关对 10 组、硬负例 9 组（人工构造，非全量标注）；organic 分布用 900 抽样。判据是"空窗位置"，不是精确最优阈值——0.80 ~ 0.85 区间在计数上等价，取 0.82 是为了与既有常量对齐。
5. 前置门槛默认 `enabled: false`（config-first，逐位现状），本次不改变开关状态。

## 9. 验证留档（F3 + F4 一并）

### RED → GREEN
- F4 新用例首次跑（实现仍为 0.9）：`Tests 4 failed / 1 passed (5)`，留档 `.tmp-gate/f4-red.log`；改 0.82 后 `5 passed`。
- F3 新用例首次跑（实现仍写死 256）：`Test Files 1 failed / Tests 5 failed / 5 passed`，留档 `.tmp-gate/f3-red.log`；实现落地后 `10 passed`。

### 变异抽查（每次改实现 → 红 → 还原 → grep 证无残留）
| 编号 | 变异 | 结果 | 还原证据 |
| --- | --- | --- | --- |
| M1 | 分批循环改回 `_callApi`（绕开折半路径） | `2 failed / 8 passed`（两条折半用例） | `embedding.ts:540` 回到 `_callApiChunk` |
| M2 | 构造函数忽略配置：`this.maxBatchSize = DEFAULT_MAX_BATCH_SIZE` | `3 failed / 7 passed`（10+5、clamp、dedup 链路） | `embedding.ts:476` 回到 `Math.min(MAX_BATCH_SIZE_LIMIT, Math.max(1, rawBatch))` |
| M3 | `DEFAULT_PREFILTER_MIN_COS` 改回 `0.9` | `4 failed / 11 passed`（F4 校准 4 例） | `l1-dedup.ts:74` 回到 `0.82` |

### 门禁读数（2026-11-02 17:2x，共享工作区）
- `npm test`（MemoryCore）：`Test Files 2 failed / 382 passed (384)`、`Tests 3 failed / 3755 passed (3758)`。**本域全绿**；2 个红文件（`config.memory-layering.test.ts`、`settings-override.memory-sections.test.ts`）都是未跟踪新文件，solo 复跑可复现，断言 `persona.l2Gate` 只应 3 键、实际多出 `bootRecoveryWarnSessions/maxRunsPerHour/maxSessionsPerRound`（`git diff src/config.ts | grep -c bootRecoveryWarnSessions` = 3，别人的 l2Gate 新字段），非本域。
- `npm run typecheck:gate`：`204 errors / 32 files`，Δ=+2；两条新增均在别人未跟踪的测试文件里（`auto-recall-validity-observability.test.ts:44` TS2345、`consolidation-validity-open.test.ts:100` TS2339）。**本域 Δ=0** 的独立证据：用 `.tmp-tsconfig.f3f4.json`（只含本票 7 个文件，跑完即删）单跑 `tsc`，闭包内只有 `src/core/store/sqlite.ts` 的 3 条——与 `typecheck-baseline.json` 里 `sqlite.ts TS2769=2 / TS2353=1` 逐条对上，我的 6 个文件 0 错。
- 新增 `.ts` 两个测试文件 `npx prettier --check` 全绿；存量文件未 `--write`（`embedding.ts`/`l1-dedup.ts` 的 prettier 差异全部是既有未格式化行，与本次插入行无关）。

