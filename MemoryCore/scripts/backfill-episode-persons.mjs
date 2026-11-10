/**
 * 存量补齐：给历史 `soul_episodes` 补 `persons_json`（阶段 2 / P2-E 的存量补齐）。
 *
 * 为什么需要它：`persons_json` 是新增列，只有「新挖/重挖」的事件才会写值；
 * 历史事件不补，卡端点的 session 分支（读 persons_json）对老会话完全不生效。
 *
 * 旧版（仓库外 scratch 那份）按 `participants_json` 里的展示名解析，只能补 7/57——
 * 因为 50 条事件的 participants 里是角色词（cfg.personName 默认「用户」）。
 * 这版改按真身份：`quote_json.recordId` → `l0_conversations.user_id`，
 * platform 用与运行时同一个常量 `EPISODE_SPEAKER_PLATFORM`（两处各写一份会把同一个人
 * 拆成两个 person_key）。拿不到 L0 身份的行才回退到展示名，与运行时同一条判据。
 *
 * 口径：默认 dry-run（只读连接，一行都不写）；`--apply` 前先 `VACUUM INTO` 备份，
 * 单事务内「建人 + 写 persons_json + 两条断言」，断言不过整体回滚。
 * 与运行时同一份解析代码：personsForEpisode（剔角色词）+ resolvePerson（id → key）。
 *
 * 用法：
 *   node --import tsx scripts/backfill-episode-persons.mjs            # dry-run
 *   node --import tsx scripts/backfill-episode-persons.mjs --apply    # 先停 Core 再跑
 *   SOUL_DB=/path/to/vectors.db node --import tsx scripts/...mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { EPISODE_SPEAKER_PLATFORM, personsForEpisode } from '../src/core/soul/episode.ts';
import { resolvePerson } from '../src/core/person/resolve.ts';
import { SOUL_PERSON_DDL } from '../src/core/store/soul-person-ddl.ts';

const DB = process.env.SOUL_DB ?? 'D:/TDB/data/vectors.db';
const APPLY = process.argv.includes('--apply');
const TAG = '[backfill-episode-persons]';

const db = new DatabaseSync(DB, { readOnly: !APPLY });

/** 缺 persons_json 列就直接停：先让 Core 起一次把 ALTER 跑完，别在这里手补列。 */
try {
  db.prepare('SELECT persons_json FROM soul_episodes LIMIT 1').get();
} catch (err) {
  console.error(`${TAG} soul_episodes 缺 persons_json 列，先启动一次 Core 完成 ALTER。原始错误：${err?.message ?? err}`);
  process.exit(2);
}

/* —— 读面 —— */
const qEpisodes = db.prepare(
  'SELECT team_id, user_id, agent_id, episode_id, participants_json, quote_json, persons_json FROM soul_episodes',
);
const qL0 = db.prepare('SELECT record_id, user_id, agent_id FROM l0_conversations WHERE record_id = ?');
const countNull = () => db.prepare('SELECT count(*) c FROM soul_episodes WHERE persons_json IS NULL').get().c;
const countWith = () => db.prepare('SELECT count(*) c FROM soul_episodes WHERE persons_json IS NOT NULL').get().c;
/** 引用但本租户查不到人：名单里有 key、soul_person 里没这行（跨租户失配也算）。 */
const countUnresolved = () =>
  db
    .prepare(
      `SELECT count(*) c FROM soul_episodes e, json_each(e.persons_json) j
        WHERE NOT EXISTS (
          SELECT 1 FROM soul_person p
           WHERE p.person_key = j.value AND p.team_id = e.team_id
             AND p.user_id = e.user_id AND p.agent_id = e.agent_id
        )`,
    )
    .get().c;

/* —— soul_person 读写（语义对齐 store/sqlite.ts 的 upsertSoulPerson）—— */
const qPersonByKey = db.prepare('SELECT person_key, aliases_json FROM soul_person WHERE person_key = ? AND merged_into IS NULL');
const qPersonByPlatform = db.prepare(
  `SELECT * FROM soul_person
    WHERE team_id = ? AND user_id = ? AND agent_id = ? AND platform = ? AND platform_id = ?
      AND merged_into IS NULL LIMIT 1`,
);
const qPersonByTenant = db.prepare(
  'SELECT * FROM soul_person WHERE team_id = ? AND user_id = ? AND agent_id = ? AND merged_into IS NULL ORDER BY display_name ASC, person_key ASC',
);
const qInsertPerson = db.prepare(
  `INSERT INTO soul_person
     (person_key, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
);
const qUpdatePerson = db.prepare(
  'UPDATE soul_person SET platform = ?, platform_id = ?, display_name = ?, aliases_json = ?, updated_at = ? WHERE person_key = ? AND merged_into IS NULL',
);

const mapPerson = (p) => ({
  personKey: p.person_key,
  teamId: p.team_id ?? undefined,
  userId: p.user_id ?? undefined,
  agentId: p.agent_id ?? undefined,
  platform: p.platform ?? '',
  platformId: p.platform_id ?? undefined,
  displayName: p.display_name ?? '',
  aliases: p.aliases_json ? JSON.parse(p.aliases_json) : [],
  mergedInto: p.merged_into ?? null,
});

const mergeAliases = (json, extra) => {
  const out = [];
  for (const a of [...(json ? JSON.parse(json) : []), ...(Array.isArray(extra) ? extra : [])]) {
    const v = typeof a === 'string' ? a.trim() : '';
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
};

/**
 * resolvePerson 只要三个方法。`write=false`（dry-run）时 upsert 只回 personKey、不落库，
 * 于是 dry-run 的计数就是「apply 会写成什么样」，而库里一个字节都不动。
 */
function makeStore(write) {
  return {
    listSoulPersons: async (t) => qPersonByTenant.all(t.teamId, t.userId, t.agentId).map(mapPerson),
    getSoulPersonByPlatform: async (t, hint) => {
      const row = qPersonByPlatform.get(t.teamId, t.userId, t.agentId, hint.platform ?? '', hint.platformId ?? '');
      return row ? mapPerson(row) : undefined;
    },
    upsertSoulPerson: async (t, p) => {
      const key = (p?.personKey ?? '').trim();
      if (key === '') return { personKey: '', created: false };
      if (!write) return { personKey: key, created: false };
      const now = new Date().toISOString();
      const platform = (p.platform ?? '').trim();
      const platformId = typeof p.platformId === 'string' && p.platformId.trim() !== '' ? p.platformId.trim() : null;
      const displayName = (p.displayName ?? '').trim();
      const existing = qPersonByKey.get(key);
      if (existing) {
        qUpdatePerson.run(platform, platformId, displayName, JSON.stringify(mergeAliases(existing.aliases_json, p.aliases)), now, key);
        return { personKey: key, created: false };
      }
      try {
        qInsertPerson.run(key, t.teamId, t.userId, t.agentId, platform, platformId, displayName, JSON.stringify(mergeAliases(null, p.aliases)), now, now);
        return { personKey: key, created: true };
      } catch {
        // 撞「平台 id 唯一」：同一身份已有未合并的行 → 挂过去，不造第二个人。
        const owner = qPersonByPlatform.get(t.teamId, t.userId, t.agentId, platform, platformId);
        return { personKey: owner?.person_key ?? key, created: false };
      }
    },
  };
}

const l0Cache = new Map();
/** quote.recordId → L0 的真身份。查过一次就缓存，57 条事件不必扫全表。 */
function speakerOf(quoteJson) {
  let quote;
  try {
    quote = quoteJson ? JSON.parse(quoteJson) : null;
  } catch {
    return { recordId: '', speaker: undefined, found: false };
  }
  const recordId = typeof quote?.recordId === 'string' ? quote.recordId.trim() : '';
  if (recordId === '') return { recordId: '', speaker: undefined, found: false };
  if (!l0Cache.has(recordId)) l0Cache.set(recordId, qL0.get(recordId));
  const l0 = l0Cache.get(recordId);
  if (!l0) return { recordId, speaker: undefined, found: false };
  const userId = String(l0.user_id ?? '').trim();
  const agentId = String(l0.agent_id ?? '').trim();
  if (userId === '' && agentId === '') return { recordId, speaker: undefined, found: true };
  return {
    recordId,
    speaker: { ...(userId === '' ? {} : { userId }), ...(agentId === '' ? {} : { agentId }) },
    found: true,
  };
}

async function plan(store) {
  const rows = qEpisodes.all();
  const todo = [];
  const skipped = { already: 0, noParticipants: 0, noIdentity: 0 };
  const via = { platform: 0, byName: 0, noRecord: 0 };
  for (const r of rows) {
    if (r.persons_json) {
      skipped.already += 1;
      continue;
    }
    let participants = [];
    try {
      const parsed = r.participants_json ? JSON.parse(r.participants_json) : [];
      if (Array.isArray(parsed)) participants = parsed;
    } catch {
      /* 坏 JSON 当没有参与者 */
    }
    const { recordId, speaker, found } = speakerOf(r.quote_json);
    if (recordId !== '' && !found) via.noRecord += 1;
    const hinted = personsForEpisode(participants, speaker);
    const keys = [];
    if (hinted.platformId) {
      via.platform += 1;
      try {
        const person = await resolvePerson(store, { teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }, {
          platform: EPISODE_SPEAKER_PLATFORM,
          platformId: hinted.platformId,
          ...(hinted.names[0] === undefined ? {} : { displayName: hinted.names[0] }),
        });
        if (person?.personKey) keys.push(person.personKey);
      } catch (err) {
        console.warn(`${TAG} resolve(platform) 失败 ${r.episode_id}: ${err?.message ?? err}`);
      }
    } else {
      if (participants.length === 0) {
        skipped.noParticipants += 1;
        continue;
      }
      via.byName += 1;
      for (const name of hinted.names) {
        try {
          const person = await resolvePerson(store, { teamId: r.team_id, userId: r.user_id, agentId: r.agent_id }, { displayName: name });
          if (person?.personKey) keys.push(person.personKey);
        } catch (err) {
          // fail-open：解析不出来就不挂人，不阻断这一条补齐
          console.warn(`${TAG} resolve(name) 失败 ${r.episode_id}/${name}: ${err?.message ?? err}`);
        }
      }
    }
    if (keys.length === 0) {
      skipped.noIdentity += 1;
      continue;
    }
    todo.push({
      teamId: r.team_id,
      userId: r.user_id,
      agentId: r.agent_id,
      episodeId: r.episode_id,
      participants,
      recordId,
      keys: [...new Set(keys)],
    });
  }
  return { total: rows.length, todo, skipped, via };
}

const qUpd = db.prepare(
  'UPDATE soul_episodes SET persons_json = ? WHERE team_id = ? AND user_id = ? AND agent_id = ? AND episode_id = ?',
);

const nullBefore = countNull();
const withBefore = countWith();
console.log(`${TAG} db=${DB} apply=${APPLY}`);
console.log(`${TAG} before: total=${nullBefore + withBefore} withPersons=${withBefore} stillNull=${nullBefore}`);

if (!APPLY) {
  const p = await plan(makeStore(false));
  console.log(`${TAG} plan: todo=${p.todo.length} skipped=${JSON.stringify(p.skipped)} via=${JSON.stringify(p.via)}`);
  for (const t of p.todo.slice(0, 8)) {
    console.log(`${TAG}   ${t.episodeId} rec=${t.recordId || '-'} ${JSON.stringify(t.participants)} -> ${JSON.stringify(t.keys)}`);
  }
  console.log(
    `${TAG} 预计写后: withPersons=${withBefore + p.todo.length} stillNull=${nullBefore - p.todo.length}（dry-run 不建人，新 key 会在 --apply 时落库）`,
  );
  console.log(`${TAG} DRY-RUN：未写库。加 --apply 执行（会先备份、单事务、写后断言）。`);
  process.exit(0);
}

if (nullBefore === 0) {
  console.log(`${TAG} 无需写入：没有 persons_json 为空的事件`);
  process.exit(0);
}

const backup = `${DB}.bak-episode-persons-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
db.prepare('VACUUM INTO ?').run(backup);
console.log(`${TAG} 备份 ${backup}（${statSync(backup).size} 字节）`);
// soul_person 在老库里可能还没建（Core 没起过含本阶段的版本）；与运行时同一份 DDL，幂等。
for (const ddl of SOUL_PERSON_DDL) db.exec(ddl);

let written = 0;
let stats;
db.exec('BEGIN IMMEDIATE');
try {
  const p = await plan(makeStore(true));
  stats = p;
  for (const t of p.todo) {
    qUpd.run(JSON.stringify(t.keys), t.teamId, t.userId, t.agentId, t.episodeId);
    written += 1;
  }
  // 断言 1：每条写入只把一行从 NULL 变成非 NULL，剩余条数必须严格对得上。
  const stillNull = countNull();
  if (stillNull !== nullBefore - written) {
    throw new Error(`断言1 失败：stillNull=${stillNull}，期望 ${nullBefore - written}（写前 ${nullBefore}，写入 ${written}）`);
  }
  // 断言 2：名单里引用的每个人都能在本租户查到（否则就是跨租户/孤儿 key）。
  const unresolved = countUnresolved();
  if (unresolved !== 0) throw new Error(`断言2 失败：persons 引用但本租户查不到的人=${unresolved}（必须为 0）`);
  db.exec('COMMIT');
  console.log(`${TAG} 断言通过：stillNull=${stillNull}、unresolved=${unresolved}`);
} catch (err) {
  try {
    db.exec('ROLLBACK');
  } catch {
    /* 已在回滚态 */
  }
  console.error(`${TAG} 失败已回滚（备份 ${backup}）：${err?.message ?? err}`);
  process.exit(1);
}

const nullAfter = countNull();
const withAfter = countWith();
console.log(
  `${TAG} plan: todo=${written} skipped=${JSON.stringify(stats.skipped)} via=${JSON.stringify(stats.via)}`,
);
console.log(`${TAG} after: total=${nullAfter + withAfter} withPersons=${withAfter} stillNull=${nullAfter}`);
console.log(`${TAG} unresolved=${countUnresolved()}（必须为 0）`);
console.log(`${TAG} PASS：before ${withBefore}/${withBefore + nullBefore} → after ${withAfter}/${withAfter + nullAfter}`);
