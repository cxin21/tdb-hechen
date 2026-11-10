/**
 * 人物身份层（person）数据契约 —— 2026-11-08 人格系统 v3 阶段 1。
 *
 * 设计文档：`docs/specs/2026-11-08-emotion-person-scene-plan-v3.md` §3-B / §5.1。
 *
 * 为什么需要独立于 L1 的一张表：L1 的 `metadata_json.personRefs` 只是「提到了谁」的
 * 自由文本，既不能按平台 id 去重，也不能承载「同一个人改了昵称」这件事。`soul_person`
 * 把「谁」变成稳定主键（person_key），L1 只存 `{key, role}` 引用，于是：
 *   - 昵称/别名变化不会产生第二个人；
 *   - 一条记忆里出现的人最多 3 个，角色有明确枚举（主体/说话人/被提到）；
 *   - 合并（mergeSoulPerson）只做指针，不搬数据，可回滚。
 *
 * 本文件只放类型，不含逻辑 —— 供 store/types.ts 与 person/*.ts 双方引用，
 * 避免 store 层反向依赖 person 层的实现。
 */

/** 一条记忆里某人的角色。三者互斥，按优先级 subject > speaker > mentioned 截断到 3 人。 */
export type PersonRole = "subject" | "speaker" | "mentioned";

/**
 * 解析/挂人时给的一条「人」线索。
 *
 * 只有 platformId 或 displayName 至少一个非空才有意义：
 *   - platformId 存在 → 平台身份（最强证据，直接生成 p_<sha1> 主键）；
 *   - 只有名字 → 归一化名（弱证据，可能同名，按「唯一命中」判定）。
 */
export interface PersonHint {
  /** 平台名（cli/mp/dsh/...），空串表示未知平台，与 platformId 一起参与主键哈希。 */
  platform?: string;
  /** 平台内稳定 id（手机号/unionid/工号等）。空/缺省 = 无平台身份。 */
  platformId?: string | null;
  /** 展示名（原样保留大小写，比较时归一）。 */
  displayName?: string | null;
  /** 别名（旧名、昵称、称呼）。 */
  aliases?: string[];
  /** 可选的角色提示：给定时该线索优先作为该角色（目前只用于 subject）。 */
  role?: PersonRole;
}

/** `soul_person` 一行（读面用，字段与列一一对应）。 */
export interface SoulPerson {
  personKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  /** 平台名，NOT NULL DEFAULT ''。 */
  platform: string;
  /** 平台内 id；无平台身份时 null（不是空串——空串会让 partial 唯一索引失效）。 */
  platformId: string | null;
  displayName: string;
  aliases: string[];
  /** 被合并到谁（合并后该行保留为墓碑，读面默认过滤）。 */
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
}

/** upsert 入参：已有行只更新展示面（display_name/aliases/platform），created_at 不动。 */
export interface SoulPersonUpsert {
  personKey: string;
  platform?: string;
  platformId?: string | null;
  displayName?: string;
  aliases?: string[];
}

/** 落进 `l1_records.metadata_json.persons[]` 的元素。 */
export interface LinkedPerson {
  key: string;
  role: PersonRole;
}

/** `linkMemoryToPersons` 的输入（抽取之后、落库之前的那一步）。 */
export interface LinkMemoryInput {
  /** 目标 L1 记录 id（仅用于日志/回溯，不落进 persons）。 */
  recordId: string;
  /** 本轮在场/涉及的参与者；第一个非说话人默认作为 subject。 */
  participants?: PersonHint[];
  /** 这句话是谁说的。 */
  speaker?: PersonHint;
  /** 明确被提到的人（含第三方转述的被说者）。 */
  mentioned?: PersonHint[];
}
