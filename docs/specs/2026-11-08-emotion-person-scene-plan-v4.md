# 情绪 · 人物 · 场合：v4 实施规格（可直接交付实现）

- 状态：**设计定稿 + 实施规格**。实现者按本文逐条执行，不需要再做设计；发现与代码冲突即停并回报，不得自行改设计。
- 追踪：GitHub issue [#180](https://github.com/cxin21/tdb-hechen/issues/180)
- 历史：v2 `docs/specs/2026-11-08-emotion-person-scene-plan.md`、v3 同目录 `…-plan-v3.md`（本文件取代 v3）
- 依据：`docs/research/2026-11-08-emotion-models.md`、`-person-profile-memory.md`、`-scene-atmosphere.md`、`-persona-dynamics-evidence.md`

## 0. 给实现者的读法

1. 四个阶段（§3–§6）**串行**执行，每阶段独立可回滚、独立验收；不要跨阶段合并提交。
2. 每条改动都写了「文件 + 现有锚点 + 改成什么」。锚点是当前代码的位置，行号漂移时按函数名/唯一字符串定位。
3. 每阶段结束必须跑 §8 的命令并贴原始结论行；仿真脚本必须输出 `PASS/FAIL 断言名 实测值`。
4. 生产库只允许：只读核对、以及你自己写的迁移脚本（dry-run 缺省、`--apply` 前备份）。造数一律 `mkdtemp` 临时库。
5. 遇到「文档与代码不一致」「签名对不上」「测试要求与现有用例冲突」→ 停，回报，不猜。

## 1. 全局约定

- 新增 store 方法一律加到接口时标 `?`（可选），实现里 `if (typeof store.x === "function")` 守卫，保证测试替身不炸。
- 所有建表/加列必须幂等：`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN` 包 `try/catch`（SQLite 重复加列抛错）。
- 时间一律 ISO 字符串 `new Date().toISOString()`；日期聚合用 `YYYY-MM-DD`（UTC）。
- 事务：多行写入用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，失败向上抛，不吞。
- 命名：表 `soul_*`；`soul_person` 主键 `person_key`；`soul_persona.meta_json.person.key` 与 `soul_person.person_key` 同值。
- 新增的对外 HTTP 一律 GET-only、失败码 `503 <snake_case>_unavailable|_failed`。

## 2. 数据模型（DDL 原文）

### 2.1 `soul_person`（阶段 1 新建）

```sql
CREATE TABLE IF NOT EXISTS soul_person (
  person_key   TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT '',
  platform_id  TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  merged_into  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_soul_person_platform
  ON soul_person (team_id, user_id, agent_id, platform, platform_id)
  WHERE merged_into IS NULL AND platform_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_soul_person_name
  ON soul_person (team_id, user_id, agent_id, display_name);
```

### 2.2 `soul_emotions` 三列（阶段 3 加列，幂等）

```sql
ALTER TABLE soul_emotions ADD COLUMN agency TEXT;          -- 归因主体 self|other|environment，旧行 NULL
ALTER TABLE soul_emotions ADD COLUMN confidence REAL;      -- 0..1，旧行 NULL
ALTER TABLE soul_emotions ADD COLUMN object_person TEXT;   -- 命中 person alias 时写 person_key
```

现有列不动：`label TEXT NOT NULL`（`''` = 未命中锚点）、`valence/arousal/dominance` 即 PAD。

## 3. 阶段 1：人物身份 + 记忆挂人 + 存量迁移

### P1-A 建表与 store 方法

- 文件：`MemoryCore/src/core/store/sqlite.ts`
  - 锚点：`CREATE TABLE IF NOT EXISTS soul_emotions` 在 `:1310`，把 §2.1 的 DDL 放在它之后（同类 soul_* 块内）。
  - 新增方法（与 `listSoulPersona`（`:3370` 附近）同风格，均 `normalizeCoreTenant`）：
    - `upsertSoulPerson(tenant, row: {personKey, platform?, platformId?, displayName?, aliases?}): { inserted: boolean }`
    - `getSoulPersonByPlatform(tenant, platform, platformId): SoulPerson | null`
    - `getSoulPersonByName(tenant, normalizedName): SoulPerson[]`（按 `display_name` + `aliases_json` 匹配，返回全部命中，供「唯一命中」判断）
    - `listSoulPersons(tenant): SoulPerson[]`
    - `mergeSoulPerson(tenant, fromKey, intoKey): { merged: number }`（置 `merged_into`，并把 `soul_persona.meta_json.person.key` 从 fromKey 改写成 intoKey）
  - 行映射函数 `mapSoulPersonRow(row)`：`aliases` 用 `JSON.parse` 容错成 `[]`。
- 文件：`MemoryCore/src/core/store/types.ts`：新增 `SoulPerson` 类型；接口里上述 5 个方法标 `?`。
- 测试：`MemoryCore/src/core/store/__tests__/soul-person-store.test.ts`（4 条：建表两次不抛；同平台 id 二次 upsert 返回 `inserted:false` 且行数不变；`platform_id` 为 NULL 时唯一索引允许多行；`mergeSoulPerson` 后 fromKey 的 persona 行 `meta.person.key` 变为 intoKey）。

### P1-B 身份解析

- 新文件：`MemoryCore/src/core/person/resolve.ts`
  - `personKeyOf(input: {teamId,userId,agentId,platform,platformId?,displayName?}): string`
    - 有 `platformId`：`"p_" + sha1(`${teamId}|${userId}|${agentId}|${platform}|${platformId}`).slice(0,12)`
    - 无 `platformId`：`"p_name_" + sha1(`${teamId}|${userId}|${agentId}|${normalizeName(displayName)}`).slice(0,12)`
  - `normalizeName(name: string): string`：`trim` → 全角转半角 → 去空白 → `toLowerCase()`。
  - `resolvePerson(store, tenant, hint: {platform?, platformId?, displayName?, aliases?}): Promise<{person: SoulPerson, created: boolean}>`
    阶梯（顺序固定）：① `platformId` 且 `getSoulPersonByPlatform` 命中 → 返回；② `displayName` 或 aliases 任一 `getSoulPersonByName` **恰好 1 条** → 返回（若本次带了 `platformId` 而命中行未绑平台，就地 `upsertSoulPerson` 用同一 `personKey` 补绑；补绑失败不改归属）；③ 命中 ≥2 条 → 返回 `throw new PersonAmbiguousError(names)`（调用方按「不入档」处理并计 `person_ambiguous`）；④ 都没有 → `upsertSoulPerson` 建新行。
- 测试：`MemoryCore/src/core/person/__tests__/resolve.test.ts`（5 条：平台 id 优先于名字；名字唯一命中复用；两条同名抛 `PersonAmbiguousError`、abc 与 ABC 归一后同人；无 platformId 走 `p_name_` 前缀且幂等）。

### P1-C 记忆挂人

- 新文件：`MemoryCore/src/core/person/link.ts`
  - `linkMemoryToPersons(store, tenant, args: {participants?: Array<{name, platform?, platformId?}>, speakerName?: string, speakerIsSubject?: boolean, mentioned?: string[]}): Promise<Array<{key: string, role: "subject"|"speaker"|"mentioned"}>>`
  - 规则：① `participants` 里每人先 `resolvePerson`；② `role`：本轮发言人是 `speaker`，非发言者中第一个是 `subject`，其余 `participants` 与 `mentioned` 是 `mentioned`；③ 最多 3 人（按 `subject > speaker > mentioned` 优先截断）；④ 第三方转述（`speakerIsSubject === false` 且说话人不是 `subject`）的人一律 `role: "mentioned"` 且**不写 `soul_persona` 档案**（只记归属）；⑤ 任何 `PersonAmbiguousError` 跳过该人并累计 `ambiguous` 计数返回。
  - 返回结构同时带 `stats: {resolved:number, ambiguous:number, capped:number}`（调用方记 `soul_gate_stats` 的 `code='person:link'`）。
- 接线点：`MemoryCore/src/core/record/l1-extractor.ts` 的 metadata 装配处（锚点：`:436` 附近「D-4 确定性门…并入 metadata_json」），在**构建完 metadata 对象、写库之前**调用 `linkMemoryToPersons`，把结果写进 `metadata.persons`；`persons` 为空数组时**不写该键**。同时保留原 `personRefs` 不动。
- 测试：`MemoryCore/src/core/person/__tests__/link.test.ts`（5 条：两人参与 → 1 subject + 1 speaker；转述者只 mentioned；超过 3 人截断且 subject 优先；同名歧义跳过且 stats.ambiguous=1；`persons` 空时不产生键）。

### P1-D 兼容读（personRefs 回退）

- 文件：`MemoryCore/src/core/lifecycle/consolidation/attribute-key.ts:98`（`firstRef(meta.personRefs)`）与 `MemoryCore/src/core/lifecycle/forgetting/scorer.ts:55`（`["coreRefs","personRefs"]` 循环）各加一条「先读 `persons[].key`，无则回退 `personRefs`」，并各记一次 `person_refs_fallback` 计数（`soul_gate_stats`，`code='person:fallback'`）。
- 测试：上述两个已有测试文件各加 1 条（`persons` 存在时优先、`persons` 缺失时行为与改前一致）。

### P1-E 迁移脚本

- 新文件：`MemoryCore/scripts/migrate-person-refs.mjs`
  - 参数：`--apply`（缺省 dry-run）、`--db <path>`（缺省 `D:/TDB/data/vectors.db`）。
  - 步骤：① 读 `select rowid, metadata_json from l1_records where metadata_json like '%personRefs%'`；② 逐行用 `personKeyOf({teamId,userId,agentId,displayName})` 在**该行自己的租户**下生成 key（有平台 id 走 `p_`，否则 `p_name_<sha1(team|user|agent|归一化名)>`）；**禁止跨租户共用固定 key**（`p_lead` 这类会撞 `person_key` 主键，导致其它 agent 在自己租户里查不到人）；③ 多值拆条；④ `--apply` 前用 `sqlite3 .backup` 等价方式复制到 `<db>.bak-person-<yyyyMMddHHmmss>`（含 `-wal`/`-shm`），打印路径；⑤ `UPDATE l1_records SET metadata_json = json_set(metadata_json, '$.persons', ?) WHERE rowid = ?`，事务批量 200 行；⑥ 核对 `select count(*) from l1_records where metadata_json like '%personRefs%' and json_extract(metadata_json,'$.persons') is null` = 0，非 0 则 `throw`；⑦ 另核对「每个被引用的 key 必须在**同租户** `soul_person` 里存在」（`unresolvedRefs`）= 0；⑧ 核对 `soul_person` 未合并行数 = dry-run 报的「拟建人数」。
  - 输出：`待迁移 N 行 / 映射 M 人 / 覆盖 K 个 distinct 名字`，`--apply` 后追加 `核对行数 0`。
- 先 dry-run 回报，得到确认再 `--apply`。

### P1-F 仿真脚本

- 新文件：`MemoryCore/scripts/sim-person-link.mjs`（`mkdtemp` + 新 sqlite，复用 `sqlite.ts` 的建表逻辑或直接执行同 DDL）
  - 断言 A1：灌 2 人（各有 platformId）→ `soul_person` 2 行。
  - 断言 A2：每人 3 条记忆，共 6 条 → `select count(*) from l1_records where json_extract(metadata_json,'$.persons') is not null` = 6。
  - 断言 A3：一条 `speakerIsSubject:false` 的转述记忆 → 该人 `role='mentioned'` 且不产生 `layer='human'` 的 persona 行。
  - 断言 A4：同名两人（无 platformId）→ 抛 `PersonAmbiguousError`，`stats.ambiguous=1`。
  - 输出格式：每行 `PASS|FAIL <断言名> <实测> = <期望>`，末尾一行 `SUMMARY <passed>/<total>`。

### P1-G 验收

1. `cd MemoryCore && node scripts/typecheck-gate.mjs` → `Δ` 不得变正（基线 `121/23 Δ=-28`）。
2. `npx vitest run src/core/store src/core/person src/core/record` 全绿。
3. `node scripts/sim-person-link.mjs` → `SUMMARY 4/4`。
4. `node scripts/migrate-person-refs.mjs`（dry-run）→ `待迁移 569 行`（±5，允许存量变化）。
5. `--apply` 后 §P1-E ⑥⑦⑧ 核对全部为 0 / 等于期望。

### P1-H 已执行结果（2026-11-08 12:11，生产已落地）

- 生产备份：`D:/TDB/data/vectors.db.bak-person-refs-20261108-121158`（463,179,776 字节，VACUUM INTO，自检 5,693 行）。
- `--apply`：更新 **564** 行、`soul_person` **8** 人、`l1_records` 5693 → 5693 行、`personRefs` 仍保留 564 行（只加不删）。
- 校验：`missingWithRefs=0` / `withPersons=564` / `soul_person=8` / `unresolvedRefs=0`。
- 按租户分布：`agt-2m7buribzz` 4 人（Lead/何晨/wlp/用户）、`agt-bbr29z58s2` 2 人（Lead alias lead / 用户）、`agt-dofal7hgfe` 2 人（何晨/何晨的妻子）。
- 演练口径：同一份脚本先在 `VACUUM INTO` 的生产快照（`rehearsal-person.db`）上跑过一遍，四条校验与生产一致后才动生产；服务先 `POST /stop`、迁移完 `POST /start`，13 次轮询后 200/200/200。
- 实施前废弃的方案：固定映射（`p_lead`/`p_user`…）只建 5 人且跨租户共用 key，会让另外两个 agent 的 193 行指向本租户里不存在的人。

## 4. 阶段 2：per-person 卡 + 契约扩参

### P2-A Core：卡输入接受在场者

- 文件：`MemoryCore/src/core/soul/card-service.ts`
  - `buildCardInput`（`:202`）签名加 `persons?: string[]`：
    ```ts
    export function buildCardInput(args: {
      profile; labels; items: ReadonlyArray<PersonaItem>; version: number; state?;
      persons?: string[];   // person_key 列表；undefined = 不按人过滤（向后兼容）
    }): PersonaCardInput
    ```
  - `human`（`:225`）与 `relationship` 的取行改为：
    ```ts
    const personFilter = (it: PersonaItem): boolean => {
      if (args.persons === undefined) return true;         // 缺省=旧行为（不过滤）
      const key = it.meta?.person?.key ?? "";
      if (key === "") return true;                        // 全局共性行始终在场
      return args.persons.includes(key);                   // 只在场者本人的行
    };
    const humanLines = cardLinesFromItems(filterPersonaItems(items, ["human"], personFilter), ["human"], HUMAN_MAX_LINES);
    ```
    新增纯函数 `filterPersonaItems(items, layers, predicate)` 放在 `card-service.ts` 尾部并导出（便于单测）。
  - `assembleSoulCard`（`:296` 附近）options 加 `persons?: string[]`，透传给 `buildCardInput`。
- **本阶段只过滤 `human` 层**：`relationship` 条目的 `meta.object` 目前存的是展示名（如「用户」「何晨」）而不是 `person_key`，按 key 过滤会一律命中空、静默把关系史清空。等 §P3 的 `object_person` 回填完成（阶段 3 一并做）再按 key 过滤；本阶段 `relationship` 保持全局可见，作为已知缺口登记。
- 测试：`MemoryCore/src/core/soul/__tests__/card-persons.test.ts`（4 条：`persons` 省略时输出与改前逐字节相同；`persons:[A]` 只含 A 的 human 行；`persons:[]` 只含 `meta.person` 为空的行；`persons:[A]` 且无 A 行时 human 块缺失且 warning 含「关于你」）。

### P2-B Core：端点解析参数

- 文件：`MemoryCore/src/gateway/soul-card-endpoint.ts`
  - `tenantOf(url)`（`:24`）旁新增：
    ```ts
    function personsOf(url: URL): string[] | undefined {
      const raw = url.searchParams.get("participants");
      if (raw === null) return undefined;                  // 未传=不过滤
      return raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 8);
    }
    ```
  - `handleSoulCardRoute`（`:41`）里 `isCard` 分支把 `persons: personsOf(url)` 传给 `assembleSoulCard`；`isTurn` 传 `session`（若实现从会话取，则先用 `query.session` 直接透传给 card-service 的 `resolveParticipants`）。
  - `participants` 的取值允许两种形态，服务端按顺序解析：① 直接是 `person_key`（`p_...` 前缀）→ 原样用；② 是展示名 → 在租户内用 `listSoulPersons` 的 `display_name`/`aliases` 精确命中（归一化后），命中 1 条才用，0 条或 ≥2 条都**丢弃**（不猜）。`session` 路径同口径：取最近 1 条 `soul_episodes.participants_json` 的名字列表，按上面 ② 解析。
  - `resolveParticipants(store, tenant, {session?, participants?}): Promise<string[] | undefined>`，**返回三态、不得把「不知道」写成「没有」**：
    | 输入 | 返回 | 理由 |
    |---|---|---|
    | 显式 `participants=a,b` | `["<key a>", "<key b>"]`（解析后，可能为空数组） | 调用方明确列了人，解析不出的名字被丢弃 |
    | 显式 `participants=`（空串） | `[]` | 调用方明确说「这次没有在场者」 |
    | 只给 `session`，且该会话最近一条 `soul_episodes.persons_json` 非空 | 解析出的 key 列表 | 正常路径 |
    | 只给 `session`，但该会话没有 episode、或 `persons_json` 为空 | `undefined` | **未知 ≠ 没有**：按 `[]` 过滤会把个人行静默清空，卡只剩全局行而不报错 |
    | 两者都没给 | `undefined` | 不过滤，旧行为 |
  - `session` 路径读 **`persons_json`**（person_key 数组，见 P2-E），不读 `participants_json`（那是展示名，见 P2-E 的说明）。
- 测试：`MemoryCore/src/gateway/__tests__/soul-card-participants.test.ts`（3 条：无 `participants` 参数时响应 `text` 与基线快照逐字节相同；`participants=a,b` 时 `data.persons` 回显且 human 过滤；`participants=` 空串当 `[]` 处理）。

### P2-C 插件：带 session 取卡

- 文件：`dsh-plugin/src/memory-client.ts`：`soulCard`（`:1471`）与留因版（`:1502`）的 query 增加可选 `session`、`participants`；签名 `soulCard(opts?: {session?: string; participants?: string[]})`。
- 文件：`dsh-plugin/src/persona-card.ts`
  - `PersonaCardDeps.fetchCard`（`:172`）已带 `sessionId`；`bindOnce`（`:378`）调用 `deps.fetchCard(sessionId)` 时把 `participants` 一起通过新的 `fetchCardWithParams?: (p:{sessionId?: string; participants?: string[]}) => Promise<PersonaCardRead>` 传入（保留旧 `fetchCard` 以兼容测试替身，二选一：有新的用新的）。
  - `cardSegments`（`:304`）不变；`FrozenCard` 增加 `personsHash?: string`（`sha256(persons.join(",")).slice(0,8)`），用于日志判定两段取自哪组在场者。
- 文件：`dsh-plugin/src/session-identity.ts`：`SessionBinding`（`:91`）增加 `personKey?: string`；picked 分支写入所选 agent 对应 person_key（若无法确定则留空）。
- 测试：`dsh-plugin/test/persona-card-participants.test.ts`（3 条：带 participants 时 fetch URL 含 `participants=`；不带时 URL 与改前一致；`personsHash` 变化只在 participants 变化时发生）。

### P2-E Core：按人的事实生产者（`persons_json` 与 human 行的 `meta.person`）

**问题（实测）**：`episode.ts:748` 写的是 `participants: [cfg?.personName || "user", "assistant"]`，是展示名与角色名；`soul_persona` 的 `human` 层生产行（改写提示词里的「关于你」）从不带 `meta.person`，生产里 human 层 0 行。⇒ 只传 participants 没有可筛的行，per-person 卡在端到端上是空的。本节补生产者。

- `store/sqlite.ts`：`soul_episodes` 幂等 `ALTER TABLE ADD COLUMN persons_json TEXT`；建表同步；`commitSoulEpisodes` 的 INSERT 列清单加 `persons_json`（`JSON.stringify(ep.persons ?? [])`，空数组写 `NULL`）；`mapSoulEpisodeRow` 读回 `persons: string[] | undefined`（缺列/空 → undefined）。
- `core/soul/types.ts`：`SoulEpisode` 加 `persons?: string[]`（注释：person_key 数组，mine 时由 participants 展示名解析而来，解析不出的人不进数组）。
- `core/soul/episode.ts`：`mineEpisodes` 的返回**不改签名**；新增纯函数
  ```ts
  export function personsForEpisode(participants: readonly string[] | undefined): { names: string[] }
  ```
  只做「哪些 participant 是候选自然人」——剔除 `"assistant"`、`"user"`、`"system"` 三个角色名与空串，其余原样返回（去重、保序）。**不做 key 解析**（纯函数不碰 store）。
- `core/soul/worker.ts`：mine 之后、`commitSoulEpisodes` 之前，对每条 episode：
  `keys = (personsForEpisode(ep.participants).names).map(name => resolvePerson(store, tenant, {displayName: name})?.personKey).filter(Boolean)`；
  `ep.persons = unique(keys)`（0 或 ≥2 都照实写，交给下游判「是否唯一」）。裁决规则：解析失败 fail-open（`ep.persons = []`），不阻断落库。每次 tick 用 `Map<displayName, key>` 缓存，避免逐行查库。
- `core/soul/worker.ts`（改写候选 → 条目）：候选聚合出 `episodePersons = unique(candidate.episodeIds.flatMap(id => episodeById[id]?.persons ?? []))`；
  - 长度 === 1：给该候选产出的 **`human` 层**条目写 `meta.person = { key, displayName }`（displayName 取 `soul_person.display_name`）；非 human 层一律不写（identity/values/relationship 是 agent 自己的，不属于某个用户）。
  - 长度 0 或 ≥2：不写 `meta.person`（=全局共性行，恒在场）。注释写明「≥2 说明这句话同时涉及两个人，归到谁身上都是猜」。
- 测试：`src/core/soul/__tests__` 新增 3 条（`personsForEpisode` 剔除角色名；单人在场时 human 条目带 `meta.person.key`；两人在场时不带）。

### P2-F Core：`/v3/soul/card` 响应契约

- 仅当**真的按人过滤**（`persons !== undefined`）时，`data.persons` 回显解析后的 key 数组（含 `[]`）；不过滤时**整个字段不出现**（不写空数组冒充「不过滤」）。
- `card-service.ts` 的 `payloadJson` 增加 `persons`（回放可还原当时用的是哪组在场者）。
- 向后兼容：不带 `participants`/`session` 时 `text`/`hash` 与 v28 基线逐字节相同（`471a012d405d3c75`/`816cb53541a7a527`/`42041e6f5a342edc`）。

### P2-D 验收

1. `cd MemoryCore && node scripts/typecheck-gate.mjs` → Δ 不变正。
2. `npx vitest run src/core/soul src/gateway` 全绿。
3. `cd ../dsh-plugin && npx tsc --noEmit && npx vitest run` 全绿（基线 40 files / 734 tests），`npm run build`，`cp -rf dist/.` 到 `C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist/`。
4. 生产（Core 重启后）`curl`：不带 `participants` 与改前快照 `text/hash` 逐字节相同。
5. 端到端（**必须可观测，不接受「human 为 0 所以不可观测」**）：用假数据造两个自然人 A/B 在同一租户下轮流跟同一 agent 说话 →
   - `soul_episodes.persons_json` 分别记到 A 与 B 的 key（各 ≥1 行）；
   - 改写产出两条 `human` 条目，`meta_json` 各自带 `person.key`（各 ≥1 条）；
   - `GET /v3/soul/card?participants=<A 的 key>` 的 `human` 段含 A 的行、**不含** B 的行；B 反之；两者都不含对方的行；
   - `/v3/soul/card` 不带参数时两段都含（全局视角）；
   - 反例：`session` 指向一个没有 episode 的会话 → 不过滤（`data.persons` 不出现），**不是**只剩全局行。
6. 清场：假数据用独立测试 agent（`agt-3i8k22f496`）与独立 person，跑完用 `rollbackSoulPersona` + 删除该 agent 的 episodes/persons 复原，并贴复原后的行数。

## 5. 阶段 3：情绪层

### P3-A 加列与读回

- `sqlite.ts`：§2.2 三条 `ALTER`（幂等）；`commitSoulEmotions`（`:3835`）INSERT 列加 `agency, confidence, object_person`（值缺省 `null`）；`mapSoulEmotionRow` 读回三列。
- `types.ts`：`SoulEmotionRecord` 加 `agency?: "self"|"other"|"environment"|null`、`confidence?: number|null`、`objectPerson?: string|null`。

### P3-B 半衰期与倍率

- `emotion.ts`：`EMOTION_TEMPLATES`（`:164-189`）24 条的 `halfLifeHours` 全部 ×0.5（`3→1.5`、`4→2`、`6→3`、`8→4`、`12→6`；写死新值，不写成表达式）；
- `decayedIntensity`（`:371`）与 `decayedStoredIntensity`（`:386`）各加第 4 个可选参数 `scale = EMOTION_HALF_LIFE_SCALE`，内部 `effectiveHalfLife = templateHalfLifeHours(emotion) * scale`；新常量 `export const EMOTION_HALF_LIFE_SCALE = 1;`
- `EMOTION_TEMPLATE_VERSION`（`:218`）改为 `et-${fnv1a(`${EMOTION_LABELS.join("|")}|${APPRAISAL_RULE_REV}|hl-0.5|scale-1`)}`，保证升版。
- 单测：`emotion.ts` 现有测试加 2 条：强度 1.0 的 `joy` 在 6.5h 后 < `EMOTION_EXPIRY_INTENSITY`；`scale=0.5` 时半衰点位移一半。

### P3-C 写入与锚点映射

- `emotion.ts`：`emotionFromSignal`（`:565`）返回值加 `agency`（来自 `appraisal.agency`，缺省 `"other"`）、`confidence`（`clamp01((appraisal.control ?? 0.5) * (appraisal.normCompatibility ?? 0.5) * 2)`，缺省 0）。
- **`label` 仍由现有 `pickTemplate`（规则，吃 appraisal 含 agency/blame/norm）决定，不由 PAD 反推**。2026-11-08 用生产 9 条真实行验过纯余弦方案：`平静(0.3,0.4,0.6)→自豪 cos 0.974`、`恼火(-0.5,0.4,0.6)→同情 0.990`、`笃定(0.3,0.4,0.7)→踏实 0.972`，全部错；原因是行里的 PAD 是 appraisal 连续量（dominance 恒 0.6 左右），模板 PAD 也是各维偏正，归一后方向几乎一致，余弦落在 0.97–0.998，`MIN_COS=0.6` 永不触发。⇒ 余弦+阈值这个判据是坏的，删掉。
- `labelFromPad` 与 `EMOTION_LABEL_MIN_COS` **不实现、不新增**（余弦判据已作废；派工消息里那条要求同样作废，以本节为准）。
- 改为纯读面辅助（不参与写入）：`export function rankLabelsByPad(pad, k = 2): {label, distance}[]`，用**加权欧氏距离**（v/a 权重 1、d 权重 0.5，各轴先折算到 0..1）排序；新常量 `export const EMOTION_PAD_NEAR_MAX = 0.35;`（distance ≤ 该值才认为「像某模板」）。读面字段 `nearestLabels` 仅供展示与「锚点命中」统计，绝不覆盖写入的 label。
- 单测：`rankLabelsByPad` 3 条（正中某模板 → 该 label 距离 0；全零向量 → 距离 > EMOTION_PAD_NEAR_MAX、不命中；k=2 返回两条且按距离升序）。

### P3-D 漏斗埋点

- `worker.ts`：在情绪段（`:2061-2170`）按序写计数，全部走 `bumpSoulGateStats(tenant, [{day, code, layer:'emotion', count, at}])`：
  - `emotion:candidate` = `unintegratedEpisodes.length`
  - `emotion:object_ok` = 其中 `emotionObjectForEpisode(ep) !== ""` 的数量
  - `emotion:appraised` = `episodeEvents.length`
  - `emotion:anchor_hit` = `episodeEvents.filter(e => rankLabelsByPad(e)[0]?.distance <= EMOTION_PAD_NEAR_MAX).length`（= PAD 落在某锚点附近；旧定义 `label !== ''` 恒真、无信息）
  - `emotion:intensity_ok` = 过强度门的数量（现有 `intensity>0` 条件）
  - `emotion:committed` = `commitSoulEmotions` 返回的 `inserted`
- 测试：`src/core/soul/__tests__/soul-emotion-funnel.test.ts`（2 条：一次 tick 后六个 code 都有行且 `committed ≤ appraised`；`label=''` 时 `anchor_hit` 不增但 `committed` 增）。

### P3-G 漏斗零值补齐（端点契约）

`bumpSoulGateStats` 只在计数 >0 时写行，因此某档本 tick 为 0 时库里没有该行。**端点必须补零**，不能把「0」表达成「缺键」：

- `soul-emotions-endpoint.ts` 的 `funnel` 固定输出六个键，缺失的档位记 `0`（`const FUNNEL_CODES = [...]` 一次定义，读库结果按 code 覆盖）。
- 若某档在 `since` 窗口内从未出现，也输出 `0`；只有「store 完全没有 `listSoulGateStats` 方法」才 503。
- 测试补 1 条：库里只有 `emotion:committed` 一行时，响应 `funnel` 六个键齐、其余五键为 `0`。

### P3-E 读面与面板

- 新文件 `MemoryCore/src/gateway/soul-emotions-endpoint.ts`：`handleSoulEmotionsRoute(url, method, sendJson, res, deps)`，GET `/v3/soul/emotions`，参数 `team/user/agent/limit(默认 50, ≤200)/since`；返回
  ```json
  {"code":0,"data":{"rows":[{"at":"…","object":"…","objectPerson":null,"label":"平静","valence":0,"arousal":0.2,"dominance":0.1,"intensity":0.4,"decayedIntensity":0.31,"agency":"other","confidence":0.5,"templateVersion":"et-…"}],
   "funnel":{"emotion:candidate":12,"emotion:object_ok":9,"emotion:appraised":9,"emotion:anchor_hit":7,"emotion:intensity_ok":8,"emotion:committed":8}}}
  ```
  `decayedIntensity` 用 `decayedStoredIntensity(row, now)`（只衰一次）。
- `server.ts`：在 soul 路由块内注册（照 `soul-card-endpoint.ts` 的 `checkAuth` 顺序）。
- 面板：`MemoryPanel/src/panel/http/routes/chat-memory-soul.ts` 加 BFF `GET /soul/emotions`（照 `:233` 的 stats 模式，含 504/502/503 映射）；`MemoryPanel/web/src/pages/SoulPage/` 新增 `SoulEmotionPanel.tsx`（逐条表 + 漏斗条），在 `SoulPage/index.tsx` 的 `<SoulFeelingBar>` 之后插入。
- 测试：Core 端点 4 条（200 字段齐、limit 上限 200、since 过滤、store 缺方法 503）；Panel BFF 2 条（透传、上游 503 映射）。

### P3-F 验收

1. `typecheck-gate` Δ 不变正；`npx vitest run src/core/soul src/core/store src/gateway` 全绿。
2. `node scripts/sim-emotion.mjs`（新，`mkdtemp`，灌 3 对象 × 3 appraisal，断言：行数 9、**至少一行 `rankLabelsByPad(pad)[0].distance > EMOTION_PAD_NEAR_MAX`**（即 PAD 落在所有锚点之外；不用 `label=''`，因为 label 恒来自 pickTemplate）、两 tick 后行数不变、`decayedIntensity` 与手算差 ≤1e-3）→ `SUMMARY 4/4`。
3. 生产重启后：`soul_emotions` 行数增加；次 tick 不增；`GET /v3/soul/emotions` 200 且 `funnel` 六键齐；面板能看到列表。

## 6. 阶段 4：场合氛围（插件侧）

### P4-A `scene.ts`

- 新文件 `dsh-plugin/src/scene.ts`：
  ```ts
  export type SceneTone = "松" | "常" | "收";
  export interface SceneInput { lastUserText: string; recentUserTexts: string[]; gapMs?: number; isGroup?: boolean; }
  export interface SceneResult { tone: SceneTone; line: string; signals: Record<string, number>; }
  export function computeScene(input: SceneInput): SceneResult
  ```
  七信号与打分（每项 0..1，权重给死）：
  | 信号 | 计算 | 权重 | 「收」方向 |
  |---|---|---|---|
  | 句长 | `avg(len)/60` clamp | 0.15 | 越长越收 |
  | 标点密度 | 标点数/字数 | 0.10 | 越高越收 |
  | emoji 占比 | emoji 数/字数 | 0.10 | 越低越收 |
  | 礼貌词 | 命中 请/麻烦/谢谢/辛苦 的次数 | 0.10 | 有则「收」+0.2 |
  | 代码块/Markdown | ``` 与 `##` 计数 | 0.25 | 越多越收 |
  | 称呼/敬称 | 您/老师/经理 命中 | 0.15 | 有则收 |
  | 节奏 | `gapMs<120000` → 0.8，`>1h` → 0.2 | 0.15 | 越快越松 |
  `score = Σ(weight * s)`；`score ≥ 0.62 → 收；≤ 0.38 → 松；else 常`。
  `line` 模板：`松`→`对方在闲聊，短句接住，别提前交作业。`；`常`→`正常推进，先结论后理由。`；`收`→`对方在等你交付，先给结论，别铺陈。`（均 ≤60 字，写死常量，不做 LLM）。
- 测试 `dsh-plugin/test/scene.test.ts`（5 条：长交付 → 收；短闲聊 → 松；三档 line 均 ≤60 字；`gapMs` 影响档位；空输入 → 常）。

### P4-B 注册 context

- `dsh-plugin/src/index.ts`：`apply` 里（与 section 注册同层，`:900` 附近）
  ```ts
  const scene = ctx.systemPrompt.context({
    name: "tdb-agemem:scene",
    order: 0,
    text: (c) => sceneLineFor(c),   // 内部 Map<sessionId,{at,line}> TTL 600_000，命中即复用
  });
  ```
  `deactivate`/`effects` 里摘除；`text` 失败返回 `''`（宿主空串语义为清空，安全）。
- 测试 `dsh-plugin/test/scene-context.test.ts`（3 条：注册一次、返回 ≤60 字、TTL 内两次同一 session 不重算（计次）、不同 session 各自计算）。

### P4-C 验收

1. `dsh-plugin`：`npx tsc --noEmit` 0、`npx vitest run` 全绿、`npm run build`、dist 同步 profile。
2. 仿真 `dsh-plugin/scripts/sim-scene.mjs`（两组输入 → 档位与长度断言）→ `SUMMARY 3/3`。
3. 生产（宿主重启后）：插件日志每轮一行 `scene=<档> chars=<n>`；Core 全部表 `scene` 命中 0；prompt 快照出现 `对方在…` 文本。

## 7. 三个仿真脚本的统一输出格式

```
PASS <断言名> <实测> = <期望>
FAIL <断言名> <实测> != <期望>
SUMMARY <passed>/<total>
```
退出码：全 PASS 0，否则 1。

## 8. 命令清单（每阶段末尾必跑）

```bash
cd D:/TDB/td-agemem/MemoryCore
node scripts/typecheck-gate.mjs                      # 期望 Δ ≤ 0，基线 121/23 Δ=-28
npx vitest run <affected dirs>                        # 全绿
node scripts/sim-*.mjs                                # SUMMARY 全 PASS
node scripts/migrate-person-refs.mjs                  # 仅阶段 1；dry-run 缺省

cd D:/TDB/td-agemem/dsh-plugin
npx tsc --noEmit && npx vitest run && npm run build    # 阶段 2/4 涉及
cp -rf dist/. "C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist/"
```

Core 重启（生产验证用）：`curl -X POST -H "X-Tdb-Control: 1" -H "content-type: application/json" -d '{"name":"tdai-core"}' http://127.0.0.1:8446/restart` → 202，约 25–40s 后 `/health` 200。

## 9. 判据总表（可证伪）

| # | 判据 | 命令/取数 | 期望 |
|---|---|---|---|
| 1 | personRefs 迁移完成 | `select count(*) from l1_records where metadata_json like '%personRefs%' and json_extract(metadata_json,'$.persons') is null` | 0 |
| 2 | 人物表 | `select count(*) from soul_person` | ≥5 |
| 3 | human 按人隔离 | 临时库 A/B 两人，`GET /v3/soul/card?participants=A` 文本中 B 的事实出现次数 | 0 |
| 4 | 卡向后兼容 | 不带 `participants` 的 `text`、`identity.hash`、`anchor.hash` | 与改前快照逐字节相同 |
| 5 | 情绪衰减 | 手算 `0.4*0.5^((now-at)/hl)` vs `decayedIntensity` | 差 ≤1e-3 |
| 6 | 情绪幂等 | 连续两 tick 的 `soul_emotions` 行数 | 第二个 tick 不增 |
| 7 | 漏斗 | `select code,sum(count) from soul_gate_stats where code like 'emotion:%' group by code` | 六键都有行，`committed ≤ appraised` |
| 8 | 场合不污染 | Core 全表 `scene` 命中数 | 0 |
| 9 | 反例有效 | `EMOTION_PAD_NEAR_MAX=0` 时 `anchor_hit` / `committed` | 前者 0、后者 >0 |

## 10. 回滚

- 阶段 1：恢复 `vectors.db.bak-person-*`；`soul_person` 表可 `DROP`（无外键）。
- 阶段 2：Core 恢复备份；插件 `dist` 回滚上一版（`cp` 上一份备份目录）。
- 阶段 3：`ALTER TABLE soul_emotions DROP COLUMN agency/confidence/object_person`；`EMOTION_TEMPLATE_VERSION` 回退常量值。
- 阶段 4：删 `ctx.systemPrompt.context` 注册（`effects` 自动摘），无需动数据。

## 11. 不做 / 未采集

**不做**：标签集扩张；PAD 反推标签当读面（`label=''` 合法）；Core 存场合；每轮重注入补偿；以用户满意当漂移奖励；voiceRate 当上线门槛；群成员表（无数据源，在场者只认本轮发言者）。

**未采集**：群聊多用户同 agent 的真实会话；24 条新半衰期在真实对话上的消退曲线（需 24h）；插件 `ctx.systemPrompt.context` 在本宿主版本的运行时行为（源码 0 次调用，仅 asar 静态证据）；`/v3/soul/card` 扩参后 MemoryPanel 记忆块表现（它走 `/v3/core-memory/read`）。

## §P3-H 模板 D 轴极性复核（结论：不重标定，2026-11-08 实测）

调研文档 `docs/research/2026-11-08-emotion-projection-algorithms.md` §0 断言「我们 24 条模板 D 全部 ≥0.2，而 ALMA 负性情绪 D 多为负 → 极性写错」。**复核结论：该断言是量纲误读，不成立**，因此本阶段**不改任何模板的 dominance**。

事实（`MemoryCore/src/core/soul/emotion.ts:144-199` 的 `dominance` 字段）：

- 我们存的是 **0..1 单位轴**（0.5 = 中性），ALMA 用 **−1..1**。换算 `d_{pad} = 2d_{01} − 1` 后：

| 标签 | v | d(0..1) | d(−1..1) | ALMA 参照 |
|---|---|---|---|---|
| 着急 | −0.35 | 0.30 | **−0.40** | Fear −0.43 |
| 愧疚 | −0.50 | 0.25 | **−0.50** | Shame −0.60 / Remorse −0.60 |
| 害羞 | −0.30 | 0.20 | **−0.60** | Shame −0.60 |
| 无奈 | −0.30 | 0.20 | **−0.60** | Distress −0.50 |
| 失落/失望 | −0.45/−0.50 | 0.25 | **−0.50** | Disappointment −0.40 |
| 自豪 | 0.65 | 0.75 | **+0.50** | Pride +0.30 |
| 笃定 | 0.50 | 0.70 | **+0.40** | Satisfaction +0.40 |
| 恼火 | −0.60 | 0.60 | **+0.20** | Anger +0.25（负效价 + 高支配，本就如此） |

- 24 条里 **只有「恼火」是负效价 + 正支配**，而它与 ALMA 的 Anger(+0.25) 一致，属正确行为，不是极性错误；其余 23 条符号与 ALMA 同向。唯一可议的是「感激」d=−0.10（受惠于人略有低支配），保留不动。
- 真正让「人人都匹配同一标签」的是**用 PAD 反推标签**（已按 §P3-A 删除 `labelFromPad`，写入路径只走 appraisal 规则表），与模板 D 无关。

结论与判据：
- **不做**：不重标定模板 D、不 bump `EMOTION_TEMPLATE_VERSION` 里的 D 相关部分、不加 `d` 轴权重到任何写入路径。
- 保留的守卫（照调研 §7.5 的 I1/I2，落在单测而非运行时拒绝）：① 每条模板 `valence<0` 时 `2d−1 ≤ 0.25`（允许「恼火」这类正当例外，阈值取 ALMA Anger 0.25）；② `valence>0` 时 `2d−1 ≥ −0.15`（允许「感激」这类边缘）；③ 命中规则的 label 必须来自 `EMOTION_TEMPLATES`，不允许 PAD 反推。
- 若将来真要动 D，唯一合法触发是「按对象聚类后，同一 PAD 邻域里 `valence` 相反的标签无法分开」的实测证据（用 `scripts/sim-emotion.mjs` 的近邻表统计），而不是量表对比。

## §P3-I 阶段 3 已实施结果（2026-11-08 12:50，Lead 复核）

- 半衰期：24 条模板 `halfLifeHours` 全部换成减半后的字面值（如 振奋 2→1、踏实 12→6、愧疚 8→4），`EMOTION_HALF_LIFE_SCALE=1` 只作实验旋钮、模板值不再乘 scale（避免双重重缩）。
- 版本串：`EMOTION_TEMPLATE_VERSION` 现为 `et-e9a10bb3`（拼 `hl-0.5|scale-1`）。
- 三列：`soul_emotions` 已有 `agency`/`confidence`/`object_person`（幂等 ALTER）；旧 10 行为 null 属预期。
- **P3-A 已改口径**：写入路径的 label 只由 appraisal 规则表产出，`labelFromPad` 与 `EMOTION_LABEL_MIN_COS` 已**整段删除**（全仓 0 命中）；近邻排序 `rankLabelsByPad` 只服务读面与漏斗展示，不参与落库。
- 漏斗：六档 `candidate/object_ok/appraised/anchor_hit/intensity_ok/committed` 写 `soul_gate_stats`（`code='emotion:<档>'`）；端点`GET /v3/soul/emotions` 对缺席档位补 0 键（P3-G）。
- 门：`typecheck-gate` 121/23 Δ=−28 PASS；`npx vitest run src/core/soul src/core/store src/gateway` 127 files / 1044 tests passed；`node scripts/sim-emotion.mjs` **6/6**（行数 9；PAD 远离锚点 3 行且 `label` 不为空；agency/confidence 9、objectPerson 0；漏斗 candidate9/object_ok9/appraised9/anchor_hit6/intensity_ok9/committed9；幂等 9；6h 衰减 0.005469=期望）。
- 生产：`GET /v3/soul/emotions?...` → 200，六档键齐、rows 带 `decayedIntensity`（0.4→0.3697/0.3364/0.1975）；库内旧行未被改写。
- 未采集（本轮之前）：新列与新版本串**尚无新写入行**，需下一 tick 处理到新事件后看 `agency/confidence/template_version` 才闭环。

## §P3-J 阶段 4（场合氛围）与阶段 2 插件侧的依赖关系

阶段 4 在插件侧（`dsh-plugin`）用 `systemPrompt.context` 注册独立段，与阶段 2 插件侧的 section 改动同在 `src/index.ts`，因此顺序固定为：P2-E/P2-F（Core）→ 阶段 2 插件侧（`soulCard` 带 `session`/`participants`、`FrozenCard.personsHash`）→ 阶段 4（`computeScene` + context 段）。三者不可并行改 `src/index.ts`。

## §P3-K voice 口径修复（读法加「不用 Markdown」，2026-11-08 实测）

`MemoryCore/scripts/soul-rubric/eval-sessions.mjs:244 judgeVoice` 判四项违规：表格行、标题行、`**` 加粗、句数 > `VOICE_MAX_SENTENCES=3`。默认样本（5 个有卡会话 / 91 轮）实测 voice **0/54**，`--all`（409 会话 / 1309 轮）voiceRate 0.031 —— 不是统计噪声，是注入源里根本没有这条要求。

改一处注入源：`MemoryCore/src/core/soul/traits.ts` 的 `CARD_READER_NOTE` 追加一行「· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。」。理由：读法常量是卡头唯一被模型必读的指令位，且卡自身不动（不新增段、不占预算、不改渲染顺序）；改的是「怎么说话」，不是「我是谁」。

连带改动（金样必须同步，否则等于悄悄改了契约）：
- 四份金样随文本与 hash 更新：`MemoryCore/src/core/soul/__tests__/card-persons.test.ts`、`MemoryCore/src/gateway/__tests__/soul-card-participants.test.ts`、`MemoryCore/scripts/sim-person-card.mjs`（新 hash 前缀 `09adc06ce7e4`）、`MemoryCore/src/core/soul/__tests__/soul-card-segments.test.ts`（`LEGACY_TEXT` 数组式，hash `d666d76b…`、`chars` 470→512）。
- 金样 hash 口径记录：整卡 `hash = sha256(material)`，`material = CARD_READER_NOTE + "\n\n" + 卡体`，**不含**卡尾 `<!-- persona-card … -->` 注释；数组式金样去掉注释时必须连它前面那个空行一起去掉，否则多一个 `\n` 会算出不同的 hash（本轮踩过）。

判据（可证伪）：`npx vitest run src/core/soul src/gateway` 96 files / 899 tests 全绿；`node scripts/sim-person-card.mjs` 17/17；`typecheck-gate` Δ=−28 PASS；生产 `GET /v3/soul/card`（重启 core 后 version 31、identity 569 字符）正文第 6 行即新增读法行。

未采集：voice 率的真实变化 —— 只有**新会话**（重新绑卡、拿到新 hash 的卡）才有意义，旧会话按设计保留冻结的旧卡；需宿主重启后一轮真实对话 + 重跑 rubric。

## P3-L 关系层行文改造（2026-11-08 追加）

**问题（生产实拍）**：卡上「关系」段是三行同类句子——「用户指出：「…」；我当时回的是：<我那轮回复>」，还带「你看看http…」这种被截断的链接。读起来是一段聊天记录，不是「我和这个人怎么相处」；我的原话在自我史里已经记过，在关系这一格只是重复占预算。

**改法（`MemoryCore/src/core/soul/history.ts`）**
1. `clip()` 先剔载体：`const CARRIER_URL = /https?:\/\/\S+/gu;`，链接整段删除再截断。原因：链接截断后不含任何可用信息，却吃掉半行预算。
2. 关系层行文从「逐句转述」改为「他的要求 + 我做到没有」：`<人>对我的要求：「<他的原话≤56>」——` 后面接四种确定性结论之一——`这条我还没做到`（我认了）/`我当场顶了回去`（回复里有取证反驳）/`我只回了话，没改`（中性）/`后来补上了：<修复原话≤48>`（判定为修复）。删掉 `retort` 变量与我这轮回复的引用。
3. 信任两条改用 `speaker`，不再写死「他」：`<人>把判断权交给我：「…」`、`<人>开始不太放心我：「…」`。

**旧行处置**：`itemId = layer + ":hx-" + hash(text…)` 由文本决定，行文一改就是新 id，旧行不会自己消失。故新增 `MemoryCore/scripts/invalidate-old-relationship-form.mts`（缺省 dry-run，`--apply` 才写，写前整库备份，走 `commitSoulPersona` 同事务记账本 `action=invalidate`，判据是旧行文指纹 `」；`）。生产已执行：备份 `D:/TDB/data/vectors.db.bak-relationship-form-2026-11-08T1045`，作废 3 行（`relationship:hx-63295f2a6e3e` / `-973be1d12616` / `-f49a0debd84d`，reason `gate:relationship_form_v2`），现行 relationship 行归 0，等新事件按新行文重新长出。

**判据**：`soul-history.test.ts` 加两例（链接不进行文且不留残片；行文形如 `<人>对我的要求：「…」——` 且不复述我这轮回复）；三处旧断言随行文更新（`只回了` → `对我的要求`+`这条我还没做到`、`Lead 指出` → `Lead 对我的要求`、`我当时回的是` → `我只回了话`）。门：typecheck Δ=-28 PASS、`soul`/`store`/`person`/`gateway` 141 files / 1162 tests 全绿。

**未采集**：新行文在真实卡上的样子——要等新的一次纠正事件进池才长出来。
