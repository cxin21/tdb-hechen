# ADR-0014 删除 rerank「融合序 × 精排」加权混排，精排单信号生效

- 状态：接受
- 日期：2026-10-29
- 关联：#164（实施票：机制与残留清零）、#145（收尾复评与生产定档）、#137-F（当年引入锚点与混排的票）、ADR-0013（rerank 配置面，被本 ADR 收窄）、ADR-0008（§F2 clamp/回落口径、§F3 降级）
- 取代：`docs/optimization-results.md` §13.5 中「生产建议 blend≈0.9」的结论、§21.1/§21.6 的判决
- 落点：`MemoryCore/src/core/recall/rerank/anchor.ts`（原 `blend.ts`，现只留 `anchorRerankOrder(order, cap)`）、`MemoryCore/src/core/hooks/auto-recall.ts`（接线与 gate）、`MemoryCore/src/config.ts`（键删除）、`MemoryCore/scripts/lib/bench/fusion-fit.mjs`（旋钮表）

## 背景

#137-F 为修「W3 结论层把经验层预算吃到只剩 1 行、精排把融合主序 top-1 换掉」引入三件事叠加的一档：融合锚点（cap 内必须留融合 top-1）、floor 降级补位、以及**融合序 × 精排归一化分的加权混排**（α，配置键 `recall.rerank.blend`，缺省钉 0.9）。

当时的证据是浅池口径（`candidates: 12` + 硬 floor `minScore: -2`）：纯精排 77.6% turnCov / nDCG 0.818 / MRR 0.719 → 三项叠加档 80.5% / 0.838 / 0.761。但该对比一次性改了三件事，**没隔离混排自己的贡献**。

#145 把生产缺省改成深池（`candidates: 32` + `minScore` 按 provider 刻度 ≈ 不剪），池内噪声行变多、精排有更多候选可读，混排的前提（精排会把 gold 切没）不再成立：#145 收尾在深池扫 α∈{0, 0.1, 0.2, 0.9}，n=90 同库同 judge 配对，α>0 三档全负（turnCov −1.15pp / −3.83pp / −3.64pp；判对 −5.6 / −7.8 / −6.7pp）。为堵「α 在它原本的浅池锚点是否仍净赚」这个缺口，又回浅池（12 / −2）做了一次只差该键的配对：**−1.15pp**（判对 −2.22pp，E2 门禁 FAIL）——§13.5 的 +2.9pp 实际来自锚点与补位，混排是搭便车的第三方。

## 决定

1. **删除混排机制，不只是撤生产钉子**：`blendRerankOrder` / `rankPriorScores` / 配置键 `recall.rerank.blend` / `RerankWiring.blend` 接线 / `gates.rerank.blend` 观测字段 / bench 的 `--rerank-blend` 旗标与旋钮表项，全部移除。精排结果原样生效。
2. **保留同批引入、且已单独证明有效的两件**：融合锚点 `anchorRerankOrder`（cap 内必须含融合 top-1，cap≥2 时精排仍可改第 2..cap 名次）与 floor 降级补位；`minScore` 的 provider 刻度感知照 ADR-0013。`blend.ts` 改名为 `anchor.ts`。
3. **观测与配置面同步收缩**：journal/dump 不再有该字段；`gateway/settings-override.ts` 从未认过该键，无需迁移；旧 yaml 里残留该键属未知键，静默忽略。
4. **bench 不再把它当旋钮**：旧报告里的该字段被忽略，历史档按原配置理解（读数见 docs §13.5 / §21.1 / §21.6）；按档复现需 `git checkout 8168e1a`。回归测试钉住「旧字段不被旋钮表拾取」。

## 理由

- **两池同向即判死**：深池 −3.64pp、浅池 −1.15pp，两个池深都在噪声带内偏负且方向一致；MRR/nDCG 微涨而判对下降，重复了 §17.9「检索序改善不同步到答案」的现象——没有一格是净收益。
- **「无收益」不等于「无害」**：留下一个缺省关闭、但随时可被重新打开、且每次 bench 会静默继承的旋钮，会让后续每轮实验都带着它、也诱使别人再扫一遍 α。开关要有实测作用，否则就是死配置（docs §21.3 台账原则）。
- **保留锚点不矛盾**：混排改的是**排序信号**（把精排分和位次先验加权），锚点改的是**窗口保位**（不管分数，只保证 top-1 不入冷宫）。前者被两个池深证否，后者在浅池隔离对比里是收益来源。
- **被否决的替代方案**：①只把缺省 α 从 0.9 改 0、保留逻辑（缺省 Silent、代码仍存两套排序，后人仍会打开）；②保留逻辑但标 deprecated 注释（同样会被 bench 静默继承）；③按 provider/池深分支启用 α（无证据支持，且池深是运行期推断，判定不可归因）。

## 后果

- **配置面**：`recall.rerank` 只剩 `enabled / provider / candidates / minScore / mode / filterRule / filterMarginTop / filterKeepRatio / local`。生产口径见 docs §2 与 §21.3：只钉 `enabled: true` 与两个防漂移型钉子（`candidates: 32`、`candidateK: 32`）。
- **行为不变性**：锚点、floor 补位、MMR、smallToBig、validity soft 全部不变；`cap=0/1/2` 的锚点边界仍由 `anchor.test.ts` 钉住。
- **历史分析的可复现性下降**：旧报告的混排字段不再进旋钮向量，§21.1 四档在新表里不可区分、配对被跳过。这是有意的取舍（那些档已被判否），代价是要按档复核必须回 `8168e1a`。
- **文档与数据**：`docs/optimization-results.md` §2（推荐配置）、§21 全节（四档表 + 台账 + 删除清单 + 删净审计）、§13.5（结论加修正块）、§17.9、§19.9、§20.4/§20.5、§18.7.4 均已同步；`CONTEXT.md` 词条改写为单信号并指向本 ADR。
- **回归保护**：`MemoryCore/src/core/recall/rerank/__tests__/anchor.test.ts`（锚点边界）、`MemoryCore/__tests__/bench-fusion-fit.test.ts`（旧字段不当旋钮）、`MemoryCore/__tests__/bench-stages.test.ts`（档位表无该键）。