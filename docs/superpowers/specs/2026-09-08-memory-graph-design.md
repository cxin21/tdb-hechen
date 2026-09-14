# 记忆图（Memory Graph）· 设计

> 触底：`2026-09-08-agent-soul-memory-spec.md` 支柱「关联性(C2)」。依赖已完成 P2a（L1 已有计时/情感/置信字段）。
> 原则（承前讨论）：记忆不是孤点，是**网络**；召回能"沿着关系找"，关联是灵魂的粘连。

## 1. 目标
- L1↔L1 显式语义边：`因果 / 相似 / 冲突 / 演化`，带强度 + 时间。
- 写入时建边（复用 dedup/merge 结果），支撑邻接与邻居召回。
- 支持 P2c/D/J 复用（巩固按邻接聚合、遗忘按重要性×时间、重构式回忆沿边组装）。

## 2. 数据模型
```
l1_links {
  source_id, target_id,         -- 两个 L1 id
  type: causal|similar|conflict|evolve,
  strength REAL DEFAULT 1.0,    -- 边强度 0..1
  created_at TEXT,
  PRIMARY KEY(source_id, target_id, type),
  INDEX(target_id), INDEX(source_id)
}
```

## 3. 建边策略（写入时）
- 在 `l1-dedup.ts`：
  - `decision.action === "merge"`（新记忆与旧互补合并）→ 若内容不同主体，建 `similar` 边。
  - `decision.action === "update"`（同主体演进）→ 建 `evolve` 边（旧→新）。
  - 冲突（去重判定 detects conflict 时）→ 建 `conflict` 边。
  - 语义相近但各自保留 → `similar` 边。
- 新记忆与最相关 top-1 旧记忆（无 dedup）→ 用现有 RRF 的 top 命中间加 `similar` 边。
- 边幂等：同 (s,t,type) 只保留一次，重复建边仅更新 strength/created_at。

## 4. 查询接口
- `getNeighbors(id, {types?, maxHop=1, maxN})`：沿边 BFS，返回 `[{id, type, strength, hop}]`。
- `getPath(a, b, maxHop)`：供 J 重构式回忆用（组装相关记忆时找关联路径）。

## 5. 安全/一致
- 边不替换原记忆内容；删除记忆时级联删除其边。
- 只接受 `certainty=observed` 的记忆建 `causal/evolve`（推断层不自动连因果，守"入口真实"）。

## 6. 非目标
- 不做全图重算/社区检测（列远期）；不做记忆融合成图形 summary（那是 H）。

## 7. 待评审
- 边的 `evolve` 是否要用"新版本指向旧"还是"旧指向新"（拟：新→旧，便于回溯）。
- 是否给边也打 `certainty`（复杂但更稳，可选）。