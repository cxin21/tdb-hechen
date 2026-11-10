/**
 * `soul_person` 建表语句（单一事实源）。
 *
 * 为什么单独一个文件：建表有两个消费者——`VectorStore.init()`（运行时建表）和
 * `scripts/migrate-person-refs.mjs`（存量迁移前确保表存在）。两处手抄 DDL 是本仓库
 * 反复踩过的坑（列名/默认值漂移后一边改一边忘），所以这里只留一份，双方 import。
 * 本文件不 import 任何运行时依赖，可被脚本安全加载（不触发 sqlite-vec 加载）。
 *
 * 设计文档：`docs/specs/2026-11-08-emotion-person-scene-plan-v3.md` §3-B、
 * `docs/specs/2026-11-08-person-profile-distill-spec.md` §5.2/§5.3。
 */

/** 表：人物身份（person_key 是「谁」的唯一主键，L1 只存 {key, role} 引用）。 */
export const SOUL_PERSON_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_person (
  person_key TEXT PRIMARY KEY,
  team_id TEXT,
  user_id TEXT,
  agent_id TEXT,
  platform TEXT NOT NULL DEFAULT '',
  platform_id TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/**
 * partial 唯一索引：只在「未合并 + 有平台 id」的行上成立。两个 WHERE 条件缺一不可：
 * ① merged_into IS NULL —— 合并后的墓碑行必须能与后继行共存，否则「改名后按新 id 建档」撞索引；
 * ② platform_id IS NOT NULL —— SQL 里 NULL != NULL，缺它时无平台身份的行根本不进索引，
 *    「(team,user,agent,platform) 唯一」会被静默扩大成全局约束。
 */
export const SOUL_PERSON_PLATFORM_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_soul_person_platform
  ON soul_person(team_id, user_id, agent_id, platform, platform_id)
  WHERE merged_into IS NULL AND platform_id IS NOT NULL`;

/** 列表/按名解析都是「先按三租户过滤，再过滤 merged_into」。 */
export const SOUL_PERSON_TENANT_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_person_tenant ON soul_person(team_id, user_id, agent_id)";

/**
 * 关系边表（P2-H §5.2）。`subj_key/pred/obj_key` 三段就是「谁—什么关系—谁」，
 * `obj_name` 是没法绑定到 person_key 时的名字兜底（如「我老婆」）。
 * `valid_from/valid_to` 让「曾经」可回放：过时写 valid_to，行不删（A4）。
 */
export const SOUL_PERSON_RELATION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS soul_person_relation (
  rel_id       TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  subj_key     TEXT NOT NULL,
  pred         TEXT NOT NULL,
  inverse_pred TEXT,
  obj_key      TEXT,
  obj_name     TEXT,
  direction    TEXT NOT NULL DEFAULT 'out',
  quote        TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)`;

/** 按人查边（出边）：`WHERE team,user,agent,subj_key = X`。 */
export const SOUL_REL_SUBJ_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_rel_subj ON soul_person_relation(team_id, user_id, agent_id, subj_key)";

/** 按人查边（入边，A6 双向可查）：`WHERE team,user,agent,obj_key = X`。 */
export const SOUL_REL_OBJ_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_soul_rel_obj ON soul_person_relation(team_id, user_id, agent_id, obj_key)";

/**
 * 幂等迁移（`ALTER TABLE ... ADD COLUMN`）：已存在的库不会因为 `CREATE TABLE IF NOT EXISTS`
 * 补列，所以新增列必须单独 ALTER 一次。执行侧对「duplicate column name」按幂等吞掉，
 * 其它错误仍要冒泡（不许把真错当已迁移）。
 *
 * - `soul_person.profile_at`：A8，提炼成功水位（`profile_token_budget` 已按 A8 删除，不入表）。
 * - `soul_person_relation.inverse_pred`：关系谓词由模型给（开放集合，不再用固定词表），
 *   逆词也由模型给，用来判定「两条边说的是同一件事」，所以必须落库。
 * - `soul_person_relation.evidence_json`：A5，反向边合并时把多条证据并到既有边。
 */
export const SOUL_PERSON_MIGRATION_DDL: readonly string[] = [
  "ALTER TABLE soul_person ADD COLUMN profile_at TEXT",
  "ALTER TABLE soul_person_relation ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE soul_person_relation ADD COLUMN inverse_pred TEXT",
];

/** 按顺序执行即可（表 → 平台唯一索引 → 租户索引 → 关系边表/索引）。 */
export const SOUL_PERSON_DDL: readonly string[] = [
  SOUL_PERSON_TABLE_DDL,
  SOUL_PERSON_PLATFORM_INDEX_DDL,
  SOUL_PERSON_TENANT_INDEX_DDL,
  SOUL_PERSON_RELATION_TABLE_DDL,
  SOUL_REL_SUBJ_INDEX_DDL,
  SOUL_REL_OBJ_INDEX_DDL,
];
