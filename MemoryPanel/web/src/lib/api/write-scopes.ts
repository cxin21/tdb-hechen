/**
 * lib/api/write-scopes.ts — 「这个写接口影响什么缓存」的唯一真源（S4）
 *
 * 四个传输层（panel / chat-memory / skill / meta）在**写成功后**各调一次对应的
 * 判定函数，得到语义作用域再广播给 mutation-bus。放在一处而不是散在几十个业务
 * 调用点：调用点只关心业务，新增一个页面不会再漏一次失效。
 *
 * 判定规则只认「动作词」，不认「资源名词」的语义猜测——
 * 读接口一律返回 null，宁可多发一次请求（误判为写）也不要漏失效。
 */
import type { MutationScope } from './mutation-bus';

const PANEL_WRITES: Array<[RegExp, MutationScope[]]> = [
  // 知识资产挂到 agent / 从 agent 解绑：不知道 asset_type，两面都失效
  [/^\/(?:allocate|unbind)$/, ['wiki', 'code']],
  [
    /^\/wiki\/(?:create|sync|ingest|delete|source\/update|source\/refetch|page\/rm|raw\/write|raw\/rm)$/,
    ['wiki'],
  ],
  [/^\/code-graph\/(?:create|sync|delete|register-meta|connectors\/pull)$/, ['code']],
];

/** panel 网关（知识面）写路径 → 作用域；读路径返回 null。 */
export function panelWriteScopes(path: string): MutationScope[] | null {
  for (const [re, scopes] of PANEL_WRITES) if (re.test(path)) return scopes;
  return null;
}

/** chat-memory 网关里会改数据的 action。其余（layer/item/search/team-assets…）都是读。 */
const CHAT_MEMORY_WRITES = new Set([
  'allocate',
  'unbind',
  'set-agent-fixed',
  'create',
  'patch-scope',
  'import',
  'importance',
]);

export function chatMemoryWriteScopes(action: string): MutationScope[] | null {
  return CHAT_MEMORY_WRITES.has(action) ? ['memory'] : null;
}

/**
 * skill 数据面写 action。get/list/versions/search/extract/files-read 都是读。
 * files/write 与 files/remove 改的是 skill 正文与资源，星图里同属技能面，必须一起失效。
 */
const SKILL_WRITES = new Set([
  'create',
  'update',
  'patch',
  'delete',
  'files/write',
  'files/remove',
]);

export function skillWriteScopes(action: string): MutationScope[] | null {
  return SKILL_WRITES.has(action) ? ['skills'] : null;
}

/** meta 动作名以写动词收尾即视为写操作。 */
const META_WRITE_SUFFIX = /\/(?:create|update|delete|add|remove|set|patch|archive|restore|upsert|link|unlink|grant|revoke|rotate)$/;

/**
 * 团队 / agent / 成员一变，星图里的 agent 段、team 段、分配关系全部不可信，
 * 因此直接全清。其他 meta 写（设置、实例）目前不影响星图，给 null 以免白刷。
 */
const META_STRUCTURE = /^(?:team|team-member|agent|agents)\//;

export function metaWriteScopes(action: string): MutationScope[] | null {
  if (!META_WRITE_SUFFIX.test(action)) return null;
  if (META_STRUCTURE.test(action)) return ['all'];
  return null;
}
