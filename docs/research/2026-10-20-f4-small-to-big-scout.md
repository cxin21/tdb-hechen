# F4 small-to-big 原子召回+父块回链 —— 只读预研笔记（#78）

> 2026-10-20 · 等待部署重启授权窗口的只读取证（零实施、零写入、探针用后即删）。
> 性质：调研文档，供 F4 拍板时零等待起步；合同另立（依赖 #77 观察窗数据）。

## 1. 结论一句话

父块回链的存储基建**已就位**（l1_links 表 4748 条边 + store 链接层 API），F4 缺的是两段：
**写面**（reflection 结论卡零边）与**读面**（召回链路零消费 l1_links）。

## 2. 存储端现状（一手实证）

- l1_records 28 列：record_id/content/type/priority/scene_name/session_key/session_id/team_id/task_id/user_id/agent_id/version/timestamp_str/timestamp_start/timestamp_end/created_time/updated_time/metadata_json/occurred_at/valid_start/valid_end/certainty/source/valence/arousal/significance/sensitivity/importance
  - source 列：reflection.ts / l1-writer.ts **零赋值**（grep 实证）→ 结论卡该列为空，语义可议但不宜复用（存疑）
  - valence/arousal 列存在；**R-A 红线：F4 全程零引用进召回**
- **l1_links 表**（生产库实测）：source_id, target_id, type, strength, created_at；**4748 条边**
- store 链接层（core/store/sqlite.ts）：addLink :1793（ON CONFLICT 幂等）/ getLinksByTarget :1866 / getLinksBySource :1884（注释原文「L2 侧身世查询：这个 scene block 由哪些 L1 蒸馏而来」）/ getLinksByType :1900；接口 core/store/types.ts:726-735
- 失效对账已挂边：sqlite.ts:4027 invalidateL1 用 getLinksByTarget(id,"derived_from")

## 3. 边类型使用现状

| type | 写点 | 语义 |
| --- | --- | --- |
| derived_from | utils/pipeline-factory.ts:982-998（scene block → L1，幂等） | scene 块身世 |
| part_of | consolidation-worker.ts:224-225（rec.id → sourceIds） | 蒸馏卡 → 触发证据 |
| evolved_from | evolution-worker.ts:296-297（merged → older/newer） | 合并演化 |
| similar | neighbor-expand 测试 | 相邻扩展 |

**缺口**：reflection.ts 零 addLink 调用（grep 实证）——work_fact 结论卡无 derived_from/part_of 身世边。

## 4. 检索端现状

- L2 结论候选形状：recall-layered.ts:19-32（L2ConclusionSource="work_fact"|"scene_block"；sceneName/content/source/recordId）
- textHit 万词面门 :51-79 + :152-157（textHitMaxTokenRatio）；IDF 加权 :85-88（#53）；筛选循环 :183-196；去重 key=sceneName\0content :193；排序 work_fact 先于 scene_block :137；格式化 :307
- 召回链路（auto-recall/memory-search/v2-router）**零消费 l1_links**——候选 recordId 已在手（:196/:327）但只用于指纹/日志

## 5. 方案雏形（拍板用，未定案）

- **D-a 读面 small-to-big**：结论候选命中后 getLinksByTarget(recordId,"part_of"/"derived_from") 回捞原子行/父块，作为预算内附加「上下文行」注入（config-first 缺省关；不扩 conclusionLayer 语义，独立开关）
- **D-b 写面补边**：runReflection 已持触发行集（triggerRows）→ 写卡成功后 addLink(rec.id, triggerRecordId, "part_of")（幂等；只填新卡，不改存量；存量回填属 D2 域拍板）
- 边界：D8 门裁决不创作（写面补边是元数据记录，非内容创作，不冲突）；R-A 零情绪数据；F4 改动不碰 scene-governance/truncateConclusionContent 语义（Batch B 契约延续）

## 5b. 对抗预审（2026-10-20 goal round 12，三问亲验）

- **Q1 写面幂等（D-b）**：addLink=ON CONFLICT(source_id,target_id,type) DO UPDATE SET strength/created_at（sqlite.ts:1798）——同卡重写更新时间戳不插重边，幂等 ✓；失败软处理 catch→warn→return false（:1803-1806），不阻塞写卡主链路 ✓。
- **Q2 读面性能（D-a）**：getLinksByTarget 单条 prepared 查询（:1866），候选面 N≤行帽 16 → 每轮 ≤16 次微秒级 sqlite 查询，无阻塞风险；批量化（IN 一次取）留作后续优化非阻塞项。getNeighbors BFS（:1817）可作多跳扩展备用，一期不做。
- **Q3 config-first 形态（留拍板）**：(a) 写面无条件补边（part_of 纯元数据，读面零消费时零行为影响）+读面新键缺省关；(b) 写读都门控。预审倾向 (a)：数据先积累，观察窗验证读面收益后再开读面开关——与 #77 三键 config-first 同构。

## 6. 待办链

观察窗数据（#77 三键生效后）→ 用户拍板 F4 范围（读面/写面/先后）→ 合同 → RED → GREEN → 门 → commit/push（m00637 授权链）
