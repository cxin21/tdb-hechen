# 重构式回忆（Reconstructive Recollection）· 设计

> 触底：spec 支柱「重构式回忆(C5)」+ 红线「召回是重构不是取件」。依赖 G（记忆图）+ P2a（时空字段）。
> 原则（承前讨论）：召回不是 top-k 取件，而是**沿时空轴+关联网络，把相关记忆+场景+时间线组装成"对此刻有用"的片段**。

## 1. 目标
- 查询时产出"回忆片段"，而非孤立孤儿 top-k：
  - 相关记忆（按 semantic + 图邻居）
  - 所属场景（L2 scene）
  - 时间线（事件先后、持续）
- 门控宁缺毋滥 + 绝对相关度 + priority；入口真实（只剩 `certainty/source` 可信、过门槛的进上下文）。

## 2. 组装流程
1. **语义种子**：query → embedding/FTS → 绝对 cosine 门槛过滤（P1 已做）取 top-k 种子。
2. **图扩展**：用 G 的 `getNeighbors(seed, {maxHop=1})`，把强相关邻居并入（抑制孤立）。
3. **再门控**：合并后按 `score + priority×ε + significance×w` 排序，`score>=threshold`、且 `certainty` 可信者入。
4. **包装**：输出 `{记忆, scene_name, 时间线(occurred_at→valid_end), 图路径(可选)}`，格式化给 agent。

## 3. 时间性利用
- 结果按 `occurred_at` 组时间线；持续态摘要(来自 H)优先于零碎点。
- 支持"当时"查询：query 含时间锚则按时间窗过滤。

## 4. 感知层的接入（承前）
- 结果可携带 `valence/significance`，把"这事多重要、什么滋味"也带给 agent（感受层基础）。

## 5. 落点
- 改 `memory-search.ts` 返回体扩展为"回忆片段"；`auto-recall.ts` 注入侧沿用其输出。

## 6. 非目标
- 不做多跳长链（maxHop 暂 1）；做强相关才出片段，宁缺毋滥。

## 7. 待评审
- 片段长度/预算；何时"返回空"（宁缺毋滥阈值）。

---

## 实现状态（2026-09-08 P3）
- ✅ `formatSearchResponse` 已升级为"回忆片段"：持续态(work_fact)优先 + 时间线分组（occurred_at 升序）+ 每条带确定性/情感/重要度（`998de26`）。
- ✅ 图邻居扩展已在 memory-search（`neighborExpand`，默认开 config 门）。
- ⏳ 待办：query 时间锚按窗过滤、"当时"查询、scene(L2) 附着、片段长度预算。