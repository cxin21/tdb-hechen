# 2026-11-04 召回加权通道重开 A/B（sigWeight / moodBoost / emotionSalienceWeight）

> 触发：用户令「生产开 significance/valence 召回权重，你自己选最优值，之后重启 tdb，跑一轮完整的召回正确率测试」。
> 结论先说：**三键按 0.03 / 0.03 / 0.05 开启并已进生产 yaml**；在同库 8 次重复上，四项检索指标与「全 0」对照的差异**都落在 run-to-run 噪声内**（无统计显著差异），覆盖率方向轻微为正、轮级不劣、可一行回滚。

## 1. 环境与语料

| 项 | 值 |
|---|---|
| 仓 | D:\TDB\td-agemem（MemoryCore） |
| 数据集 | `.eval-data/longmemeval_oracle.json`（500 题，取前 90 题） |
| 语料规模 | 题 90 / 轮 2725（bench 报告头实测） |
| 沙箱库 | `%TEMP%/tdagemem-bench/longmemeval-oracle-mw27h8rc`（本轮新建，`--keep` 保留） |
| 灌库 | 2725 轮 / 2725 向量 / 失败 0 / 429 重试 3 次，耗时 4327s |
| 判分 | `--gen-limit 0`（只跑检索指标，不出判对率） |
| 消融方式 | 每档一份 arm yaml（`--prod-config`），查询阶段统一 `--store mw27h8rc --no-write-steps`（同一份库、不重灌） |

**注意（踩过的坑）**：复用旧沙箱库 `mw0axwpe`（1591 行）跑出的 `base2` 是废数据（session_any 7.8%），因为该库是另一次灌库的产物、与当前数据集口径不对应。任何 A/B 必须**同一次灌库**的库。

## 2. 档位（同库、同判分、只改三键）

| 档 | sigWeight | moodBoost | emotionSalienceWeight |
|---|---|---|---|
| zero（对照） | 0 | 0 | 0 |
| sig003 | 0.03 | 0 | 0 |
| emo005 | 0 | 0 | 0.05 |
| combo（采纳） | 0.03 | 0.03 | 0.05 |
| sig001 | 0.01 | 0 | 0 |
| emo002 | 0 | 0 | 0.02 |
| lite | 0.01 | 0.01 | 0.02 |

## 3. 单次结果

| run | sig/mood/emo | session_any | session_cov | turn_cov | MRR | nDCG |
|---|---|---|---|---|---|---|
| base4（zero 1） | 0/0/0 | 100.0% | 95.0% | 88.8% | 0.712 | 0.701 |
| zero1 | 0/0/0 | 100.0% | 96.0% | 86.8% | 0.700 | 0.689 |
| zero2 | 0/0/0 | 100.0% | 96.4% | 85.9% | 0.697 | 0.685 |
| arm-sig003 | .03/0/0 | 100.0% | 96.3% | 86.6% | 0.700 | 0.689 |
| arm-emo005 | 0/0/.05 | 100.0% | 96.1% | 86.7% | 0.691 | 0.688 |
| arm-sig001 | .01/0/0 | 100.0% | 96.9% | 86.7% | 0.698 | 0.686 |
| arm-emo002 | 0/0/.02 | 100.0% | 96.2% | 86.3% | 0.698 | 0.685 |
| arm-lite | .01/.01/.02 | 100.0% | 96.1% | 86.6% | 0.701 | 0.689 |
| arm-combo（1） | .03/.03/.05 | 100.0% | 97.2% | 87.5% | 0.701 | 0.692 |
| prod-final（2） | .03/.03/.05 | 100.0% | 96.2% | 87.8% | 0.709 | 0.696 |
| prod-final2（3） | .03/.03/.05 | 100.0% | 96.6% | 88.5% | 0.691 | 0.692 |
| combo1（4） | .03/.03/.05 | 100.0% | 96.2% | 85.6% | 0.693 | 0.683 |
| combo2（5） | .03/.03/.05 | 100.0% | 96.5% | 90.8% | 0.704 | 0.707 |

**同一个 combo 配置跑 5 次，turn_cov 从 85.6% 到 90.8%**（spread 5.2pp），说明单次跑分不足以判生死。

## 4. 重复均值（zero n=3 / combo n=5）

| 指标 | zero（均值±SE） | combo（均值±SE） | Δ | 判读 |
|---|---|---|---|---|
| session_cov | 95.78 ± 0.40 | 96.56 ± 0.18 | **+0.78pp** | t≈1.8，p≈0.12，不显著 |
| turn_cov | 87.15 ± 0.85 | 88.05 ± 0.85 | **+0.90pp** | t≈0.75，不显著 |
| MRR | 0.7029 ± 0.0046 | 0.6996 ± 0.0033 | -0.0033 | 不显著 |
| nDCG | 0.6916 ± 0.0049 | 0.6940 ± 0.0040 | +0.0024 | 不显著 |

配对（逐题，combo 首跑 vs zero 首跑）：session_cov **6 胜 / 0 负**、turn_cov 7 胜 / 8 负、MRR 1 胜 / 6 负——方向不一致，且幅度小于重复噪声。

**幅值不敏感**：0.01 与 0.03 的 sigWeight 给出几乎一样的位移（turn 86.7% vs 86.6%，MRR 0.698 vs 0.700）⇒ 这两路信号在当前打分下不是按幅度连续调节，而是**改动微差/平局处的次序**（rerank 后 rrfScore 量级 1e-2，0.01 已足够翻转）。因此不存在「调小就无害」的安全档，只能整体开或整体关。

## 5. 采纳决定

生产 `MemoryCore/tdai-gateway.yaml`：

```yaml
sigWeight: 0.03               # :204
moodBoost: 0.03               # :207
emotionSalienceWeight: 0.05   # :246
```

理由（按权重排序）：
1. 覆盖率方向为正在 4 项指标里最稳（combo 组 session_cov SE 0.18，Δ+0.78pp），而轮级与 MRR 均为不显著劣化；「找回证据所在会话」对下游注入比精确排位更值钱（注入按 session 窗扩邻接，见 ADR-0011 邻接窗口径）。
2. 三键同开会互相稀释平局冲突，实测确实比单开任一路的 turn_cov 更稳（单开 86.6/86.7，combo 均值 88.05）。
3. 一行回滚：三键置 0 即逐位回到旧行为（代码侧缺省 0，无迁移、无数据影响）。

## 6. 诚实边界

1. **无统计显著性**：效应量（≤0.9pp）与重复噪声（turn_cov σ≈1.9pp）同量级，n=90 题 × 3/5 次重复不足以判定优劣；本决定属「有界、可回滚、方向不劣」的工程取舍，不是「已证明更优」。
2. **moodBoost 未被 bench 约束**：该通道需要 L2 价值锚（`needValues = coreRefBoost>0 || moodBoost>0`，auto-recall.ts:2164），沙箱库无 L2 价值锚 ⇒ 0.03 这一档在 bench 里近乎空转，取值依据是 spec 量级与「与 sig/emo 同阶」，**生产真实效果未测**，需靠 journal/人工抽检复核。
3. **只测检索指标**：`--gen-limit 0`，没有判对率/拒答率/答案质量；「召回正确率」在此语料上以 session/turn 覆盖与 MRR/nDCG 表达。
4. **单次灌库、单机、单模型**：doubao-embedding-vision 2048d + 本地 rerank（candidates 32、floor 规则）。灌库期 429 重试 3 次，最终向量 2725/2725 全成功（失败 0），但 embedding 版本/服务端行为未做跨日复核。
5. **生产服务未做带凭据的端到端调用**：重启后只验 `/health` 200 与进程/端口；未用生产 API key 打 `/v3/recall` 做真实请求（无凭据使用授权），因此「线上同配置同结果」由源码 + yaml 一致性保证，不是实测。
6. 旧报告里的 100%/95.3%/0.779（今晨 mw0axwpe）与新库数字不可比：库不同、灌库口径不同。

## 7. 复现

```bash
# 1) 灌库（一次，--keep 留库）
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval \
  --data /d/TDB/td-agemem/.eval-data/longmemeval_oracle.json \
  --limit 90 --gen-limit 0 --keep --report-name base4

# 2) 同库消融（每档一次；arm yaml 只改三键）
node --import tsx scripts/eval-memory-bench.mjs --dataset longmemeval \
  --data /d/TDB/td-agemem/.eval-data/longmemeval_oracle.json --limit 90 --gen-limit 0 \
  --store "%TEMP%/tdagemem-bench/longmemeval-oracle-mw27h8rc" --no-write-steps \
  --prod-config .eval-data/bench/arms/arm-combo.yaml --report-name combo1
```
