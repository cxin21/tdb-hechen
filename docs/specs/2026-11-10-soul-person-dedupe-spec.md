# 同名人物两行合并方案（soul_person / 关系边 / 状态层）

- 状态：方案（**不实现自动合并**；只读检测已落地：`MemoryCore/scripts/detect-soul-person-dupes.mjs` + `MemoryCore/src/core/person/dupes.ts`，合并仍按 §4 人工执行）
- 日期：2026-11-10
- 关联：`docs/specs/2026-11-10-soul-event-model-full-optimization.md` §4.4 / §10.8；`docs/specs/2026-11-08-person-profile-distill-spec.md` §5.2/§5.3
- 适用范围：同一租户三元组（team_id, user_id, agent_id）内，同一个自然人被建成了两行 `soul_person`

## 0. 现状核对（2026-11-10 实测，只读）

对生产库做 `VACUUM INTO` 副本后扫描（`node scripts/detect-soul-person-dupes.mjs --db <副本>`）：

- `soul_person` 共 29 行：存活 27，墓碑 2（`p_name_5cf1675acf0e -> p_9014f2235ec1`、`p_name_2a6ce2084161 -> p_b38a137ab63b`）。
- **同租户同名候选组 0，别名候选 0** —— 当前生产没有待合并的两行。
- 墓碑残留 0：关系出边/入边、`soul_person_state`、`soul_person_state_events`、`soul_persona` human 行、
  `soul_episodes.persons_json` 归属全为 0，说明已有两次合并是「立指针前就改过键/尚未产生数据」，
  不是 §1 描述的「只立指针不搬数据」形态。

§1 里「display_name='何晨' 6 行」是**跨租户**的既有事实（5 个 agent 各认识一个人），按 §2.1 永不合并，
所以它不是本方案的执行对象，只是解释「为什么必须按租户三元组判重」。

检测口径（只读，不写库，判据与代码同源）：

```bash
cd MemoryCore
node scripts/detect-soul-person-dupes.mjs --db <path> [--tenant team/user/agent] [--json]
```

- 分级 A/B/C 与 §2.2 一致；A 级也要求执行前重跑一次；
- 别名候选单列（一方 `aliases_json` 登记了另一存活行的 `display_name`，即使两边 display_name 不同）；
- 墓碑残留非 0 会逐键打印并在结论行提示「只立了指针没改键」，直接对应 §4 S3–S6。
- 实现：`MemoryCore/src/core/person/dupes.ts`（纯只读，吃最小 db 句柄）；单测
  `MemoryCore/src/core/person/__tests__/dupes.test.ts` 7 条。


## 1. 为什么要单独定方案

生产库现在已经有同名多行（2026-11-10 只读取证：`soul_person` 里 display_name='何晨' 6 行，
分属 5 个不同 agent 租户；另有「何辰」错字行与「何晨的默认助手」这种**不同人**）。
这些行大多数是**跨租户**的，按既有设计不能合并；真正需要处理的只是同一租户内被拆开的两行。

现有 `mergeSoulPerson(tenant, fromKey, intoKey)`（MemoryCore/src/core/store/sqlite.ts:6097-6138）
**只写 `merged_into` 指针，不搬任何数据**，所以直接调用它会把数据留在旧键上，读面立刻坏掉：

| 数据 | 合并后的实际后果（按当前代码） |
| --- | --- |
| `soul_person_relation.subj_key/obj_key` | 仍指向旧键。`readStructuredRelationship` 用 `listSoulPersons`（只返回 `merged_into IS NULL`，sqlite.ts:5207）建名字表（card-service.ts:825 与 :874 两处 `filter((p) => !p.mergedInto)`）→ 旧键解析不到名字 → 该行被省略并给 `person_unresolved:<key>`（card-service.ts:781 / :786）。关系**从卡上消失**。 |
| `soul_person_state` | 主键是 `person_key` + 三租户列；旧键的状态行变成孤儿，新键从 0.5 重新长，历史数值丢失。 |
| `soul_person_state_events` | `person_key` 仍为旧键，按人查审计断掉。 |
| `soul_persona` human 行 | `meta_json.person.key` 是旧键，`buildCardInput` 的按人过滤（card-service.ts:285-321、`personKeyOfItem` 在 :719）会把它们过滤掉 → 「关于你」段变空。 |
| `soul_episodes.persons_json` | 旧键留在数组里，事件归属不再匹配新键。 |
| `soul_person.profile_at` | 留在墓碑行上，提炼水位随墓碑一起失效。 |
| 证据（quote / record_id / event_id / evidence_json） | 不受影响——合并**不动**证据列，这是本方案能「保留事实」的基础。 |

结论：`mergeSoulPerson` 只是「开始合并」，**必须配一次确定性的键改写**才算完成；否则就是
「墓碑立了、关系没了」。本方案给判据、顺序、证据保留与回滚，供人工执行。

## 2. 判据

### 2.1 硬前提（不满足直接不合并）

1. 两行必须在**同一租户三元组**内：`team_id/user_id/agent_id` 全等。跨租户绝不合并——
   生产里「何晨」在 5 个 agent 下各有一行，那是 5 个 agent 各自认识的人，不是重复行。
2. 两行都 `merged_into IS NULL`（已合并的墓碑不再参与，避免链式合并与环）。
3. 两行 `person_key` 不同。

### 2.2 置信分级

- **A 级（可直接合并，无需人工判断）**：同一租户三元组内 `platform = ? AND platform_id = ?` 相同。
  理论上被 `idx_soul_person_platform`（只在 `merged_into IS NULL AND platform_id IS NOT NULL` 上唯一）
  拦住，但旧库/历史行可能残留。A 级也仍要求执行前重跑一次重复检查。
- **B 级（人工确认后合并）**：同一租户三元组内 `display_name` 归一化后相同
  （`trim` + NFKC + 去空白 + 大小写折叠），且两行都**没有** `platform_id`，
  或一方 `aliases_json` 里已登记另一方的 `display_name`。
- **C 级（只登记候选，不自动合并）**：
  - 名字相近但不等：错字/同音/简称（生产实例：「何晨」vs「何辰」）。
  - 一方是「何晨的默认助手」这类**角色化名字**——这是不同的人（助手），不是同一个人。
  - 跨租户同名——按 §2.1 永不合并，只允许在面板里提示「其他租户也有同名」。
  - 两行都有非空且不同的 `platform_id`——两个真实平台身份，先人工判断是不是同一人换了号。

### 2.3 禁止项

1. 禁止用 `person_key` 前缀/哈希相似度、「显示名包含」当判据。
2. 禁止跨租户合并、禁止把「助手」并进主人。
3. 禁止在合并时**删除**任何关系行、事件行、人格行——只改键/立墓碑；重复关系按 §4 处置。
4. 禁止合并 `disputed` 关系所在的人（先把争议边裁决完，否则合并会掩盖争议）。

## 3. 选 survivor（保留行）

按下列顺序取第一个能定出唯一赢家的规则；仍并列则用 `person_key` 字典序（确定性）：

1. `platform_id` 非空的一方优先（有真实平台身份的是规范行）。
2. 现行关系边更多的一方（`COUNT(*) FROM soul_person_relation WHERE valid_to IS NULL AND status='active'`）。
3. `person_state.last_interaction_at` 更新的一方。
4. `created_at` 更早的一方（历史更长）。
5. `person_key` 字典序更小的一方。

失败方称 tombstone（墓碑），其 `display_name` 追加进 survivor 的 `aliases_json`，便于以后按旧名解析。

## 4. 合并顺序（每一步都可停、可回滚）

> 全程在**一个** `node` 进程里对 `D:/TDB/data/vectors.db` 执行；仓库没有 sqlite3 CLI，
> 用 Node 内置 `node:sqlite`（MemoryCore/src/core/store/sqlite.ts:14 同款）。
> 生产执行前先停写（或至少确认没有 tick 在跑），避免与维护 tick 交错。

### S0 备份 + 账本（必做，不可跳过）

```js
// D:/TDB/backup-before-merge.mjs（临时脚本，跑完删）
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("D:/TDB/data/vectors.db");
db.exec("VACUUM INTO 'D:/TDB/data/vectors.db.bak-merge-20261110'");
console.log("backup ok");
```

```bash
node D:/TDB/backup-before-merge.mjs
```

导出受影响行（关系/状态/状态事件/人格 human 行/事件 persons_json 命中行）为 JSON，
与映射表 `{"from":"p_x","into":"p_y","tenant":{...}}` 一起写进
`D:/TDB/data/merge-journal-20261110.json`。**没有 journal 不许进入 S2。**

### S1 dry-run 计数

对每一对候选，先跑一遍**只读**统计，把结果贴进 journal：

```sql
-- 关系边（subj 出边 + obj 入边）
SELECT 'rel_subj' AS k, COUNT(*) AS n FROM soul_person_relation
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND subj_key=:from AND valid_to IS NULL
UNION ALL
SELECT 'rel_obj', COUNT(*) FROM soul_person_relation
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND obj_key=:from AND valid_to IS NULL;
-- 状态 / 状态事件 / human 人格行 / 事件归属
SELECT 'state', COUNT(*) FROM soul_person_state
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND person_key=:from;
SELECT 'state_events', COUNT(*) FROM soul_person_state_events
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND person_key=:from;
SELECT 'persona_human', COUNT(*) FROM soul_persona
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND layer='human'
   AND json_extract(meta_json,'$.person.key')=:from;
SELECT 'episodes', COUNT(*) FROM soul_episodes
 WHERE team_id=:t AND user_id=:u AND agent_id=:a
   AND persons_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(persons_json) WHERE value=:from);
```

### S2 立指针（可原地撤销）

```ts
// MemoryCore 已导出该方法；等价 SQL 见下
store.mergeSoulPerson(tenant, fromKey, intoKey);
```

```sql
UPDATE soul_person SET merged_into = :into, updated_at = :now
 WHERE person_key = :from AND team_id=:t AND user_id=:u AND agent_id=:a AND merged_into IS NULL;
```

同时把旧显示名并入 survivor 的别名（保留 JSON 里已有别名）：

```sql
UPDATE soul_person
   SET aliases_json = (
     SELECT json_group_array(DISTINCT v) FROM (
       SELECT value AS v FROM json_each(COALESCE((SELECT aliases_json FROM soul_person WHERE person_key=:into),'[]'))
       UNION ALL SELECT :fromDisplayName
     )
   ), updated_at = :now
 WHERE person_key = :into AND team_id=:t AND user_id=:u AND agent_id=:a;
```

### S3 改关系边键（关键一步）

```sql
UPDATE soul_person_relation SET subj_key = :into, updated_at = :now
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND subj_key = :from;
UPDATE soul_person_relation SET obj_key = :into, updated_at = :now
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND obj_key = :from;
```

改键后可能出现「两句一模一样的边」（同一 subj/pred/obj/direction 且都 valid_to IS NULL）。
**不删行**，按下面规则处置其一：

1. 优先保留 `event_id` 非空、`status='active'` 的那条；
2. 其次保留 `valid_from` 更早（或 `rel_id` 字典序更小）的那条；
3. 被淘汰的行执行 §S3.1「关边」而不是 DELETE，并把它的 `quote/record_id` 追加进保留行的
   `evidence_json`（A5 反向边合并已在用这个字段），证据不丢。

#### S3.1 重复边关边

```sql
UPDATE soul_person_relation
   SET valid_to = :now, status = 'ended', tense = 'past', updated_at = :now
 WHERE rel_id = :loser AND team_id=:t AND user_id=:u AND agent_id=:a AND valid_to IS NULL;
```

关边与 P2 S13d 同一语义（valid_to + status + tense 三件事一起写），卡上自然退出。

### S4 合并状态层

两行都有 `soul_person_state` 时，**不做数值平均**（平均会伪造精度）：

1. 以 `last_interaction_at` 更新的一方为基；
2. `evidence_event_ids_json` 取并集去重；`confidence` 取两者较大值（证据更多，不是更少）；
3. 四轴、`boundaries_json/model_json` 保留基行原值；
4. 写一条 merge 审计行到 `soul_person_state_events`：

```sql
INSERT OR IGNORE INTO soul_person_state_events
  (id, person_key, team_id, user_id, agent_id, event_id, field, old_value, new_value, reason, at)
VALUES ('pse:merge:'||:from||':'||:into, :into, :t, :u, :a, NULL, 'merge', NULL, NULL,
        'merged '||:from||' -> '||:into||'；轴值保留基行，不平均', :now);
```

5. 旧键行改键到 survivor（PK 冲突时先按上面规则合成一行，再删旧键行——**这是全流程唯一允许的
   DELETE**，且必须先写进 journal 的 pre-image）：

```sql
UPDATE soul_person_state SET person_key = :into, updated_at = :now
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND person_key = :from;
-- 若 (:into) 已存在则改为：按本节 1–4 规则合成后 DELETE FROM soul_person_state WHERE person_key=:from ...
UPDATE soul_person_state_events SET person_key = :into
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND person_key = :from;
```

> `state_events.id` 里仍带旧键（`pse:<oldKey>:...`）——**不要改 id**：它是审计主键，
> 改 id 会与已有行撞主键、也会让「这条什么时候写进来的」不可追溯。改 `person_key` 足够按人查。

### S5 改人格 human 行

```sql
UPDATE soul_persona
   SET meta_json = json_set(meta_json, '$.person.key', :into), updated_at = :now
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND layer='human'
   AND json_extract(meta_json,'$.person.key') = :from;
```

注意：人格行 `item_id` 由「层+文本哈希」决定，只改 meta 里的 key，不动 item_id——
改了会让 append-only 账本的引用断掉。

### S6 改事件归属

`soul_episodes.persons_json` 是 JSON 数组，用 JS 逐行重写（SQL 的 `json_group_array(DISTINCT …)`
在空数组/去重顺序上不可靠，不值得为省几行代码冒险）：

```ts
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("D:/TDB/data/vectors.db");
const rows = db.prepare(
  "SELECT episode_id, persons_json FROM soul_episodes WHERE team_id=? AND user_id=? AND agent_id=? AND persons_json IS NOT NULL",
).all(t, u, a);
const upd = db.prepare("UPDATE soul_episodes SET persons_json=? WHERE episode_id=? AND team_id=? AND user_id=? AND agent_id=?");
for (const r of rows) {
  const list = JSON.parse(r.persons_json);
  if (!list.includes(from)) continue;
  const next = [...new Set(list.map((k) => (k === from ? into : k)))];
  upd.run(JSON.stringify(next), r.episode_id, t, u, a);
}
```

### S7 水位与墓碑

```sql
-- 提炼水位取两者较大（更晚），只写在 survivor 上
UPDATE soul_person SET profile_at = (
  SELECT MAX(profile_at) FROM soul_person WHERE person_key IN (:from,:into) AND team_id=:t AND user_id=:u AND agent_id=:a
), updated_at=:now
 WHERE person_key=:into AND team_id=:t AND user_id=:u AND agent_id=:a;

-- 墓碑保留（merged_into 已写），不要再改 display_name/created_at：它们是审计事实
```

### S8 核验（必须全绿才算完成）

```sql
-- 1) 旧键不再有任何现行边、状态、事件、human 行（允许墓碑行 + state_events 审计行）
SELECT COUNT(*) FROM soul_person_relation
 WHERE team_id=:t AND user_id=:u AND agent_id=:a AND (subj_key=:from OR obj_key=:from);
SELECT COUNT(*) FROM soul_person_state WHERE person_key=:from AND team_id=:t AND user_id=:u AND agent_id=:a;
SELECT COUNT(*) FROM soul_persona WHERE team_id=:t AND user_id=:u AND agent_id=:a
   AND json_extract(meta_json,'$.person.key')=:from;
-- 2) 卡上没有 person_unresolved
```

再用真实读面复核（不靠 SQL 自证）：

```bash
curl -s "http://127.0.0.1:<core-port>/v3/soul/card?agent_id=...&persons=p_into" \
  -H "Authorization: Bearer <token>" | jq '.data.warnings, .data.text'
```

期望：`data.warnings` 里不再出现 `person_unresolved:p_<from>`；关系行数量与 S1 计数一致
（重复边按 §S3 关掉的除外）。

## 5. 证据保留

1. 关系行：`quote / record_id / event_id / evidence_json` 一律不改写；重复边关边不删，
   被淘汰边的 quote/record_id 追加到保留边 `evidence_json`。
2. 状态事件：append-only；只改 `person_key`，id 原样保留；追加一条 `field='merge'` 的审计行。
3. 事件：`persons_json` 只做 key 替换，事件本体、quote、evidence 不动。
4. 人格：只改 `meta_json.person.key`；文本、item_id、账本不动。
5. 墓碑行：保留 `display_name/platform/platform_id/created_at`，并把旧名并入 survivor 的别名。

## 6. 回滚

两层，任选其一：

### 6.1 原地回滚（未删任何行时可用，快）

```sql
UPDATE soul_person SET merged_into = NULL, updated_at = :now WHERE person_key=:from AND team_id=:t AND user_id=:u AND agent_id=:a;
UPDATE soul_person_relation SET subj_key=:from WHERE team_id=:t AND user_id=:u AND agent_id=:a AND subj_key=:into AND rel_id IN (:journalRelIds);
UPDATE soul_person_relation SET obj_key=:from WHERE team_id=:t AND user_id=:u AND agent_id=:a AND obj_key=:into AND rel_id IN (:journalRelIds);
UPDATE soul_person_state SET person_key=:from WHERE ...;
UPDATE soul_person_state_events SET person_key=:from WHERE ...;
UPDATE soul_persona SET meta_json=json_set(meta_json,'$.person.key',:from) WHERE ...;
-- episodes.persons_json 用 S6 的脚本反向跑一次
```

注意：原地回滚只能还原**唯一没删过行**的合并；如果 §S4 合成时 DELETE 过状态行，
必须走 6.2，并用 journal 里的 pre-image 重插。

### 6.2 备份还原（任何情况都可用，最稳）

```bash
# 停 core → 覆盖回备份 → 启动
cp D:/TDB/data/vectors.db.bak-merge-20261110 D:/TDB/data/vectors.db
```

备份是 `VACUUM INTO` 生成的完整快照，还原后与合并前逐字节等价（不含合并后新写入的 tick 增量，
所以只在合并后没有新数据、或愿意丢弃合并后增量时使用）。

## 7. 人工执行清单（照抄即可）

1. 停写（停 core 或确认维护 tick 空闲）；记录 `SELECT datetime('now')` 与 HEAD。
2. S0：`VACUUM INTO` 备份 + 写 journal（映射、pre-image、S1 计数）。
3. 对每对候选跑 S1，**人工**确认属于 A/B 级；C 级与跨租户一律跳过。
4. 逐对执行 S2 → S3（含重复边处置）→ S4 → S5 → S6 → S7。
5. S8 核验：SQL 计数 + 真实 `/v3/soul/card?persons=` 复核；把两边输出贴进 journal。
6. 恢复写；观察下一个 tick 的 `summary.personState` 与 `summary.relationBackfill`
   （不应出现旧键、不应新增长期 `unverifiable`）。
7. 若核验有任一条不绿：按 §6 回滚，把失败点写进 journal，重新评估判据。

## 8. 验收

- 同一租户内同名两行合并后：旧键 0 条现行关系、0 条状态、0 条 human 行；survivor 的关系条数
  等于合并前两行之和减去按 §S3 关掉的重复边。
- 卡：`persons=[survivor]` 能看到关系，且 warnings 里没有旧键的 `person_unresolved`。
- 证据：合并前后 `quote/record_id/event_id` 逐行可比（journal 里应有 before/after 两份导出）。
- 回滚演练：至少在测试库上走一遍 6.1 与 6.2。

## 9. 本方案明确不做

1. 不实现自动合并任务；不新增配置键/开关（与 2026-11-10 用户硬约束一致）。
2. 不处理跨租户同名（永不允许）。
3. 不把错字行（「何辰」）、角色行（「何晨的默认助手」）自动并入。
4. 不做历史 `persona.relationship` 行的 object_person 回填（属 P2 已知风险，另行评估）。
