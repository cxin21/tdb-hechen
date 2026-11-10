/**
 * 人物解析（resolve）—— 2026-11-08 人格系统 v3 阶段 1。
 *
 * 一条规则：**同一个人只能有一个 person_key**。判定优先级是硬编码的，不做概率匹配：
 *   1. 平台 id 精确命中（`platform + platform_id`，partial 唯一索引保证至多一行）；
 *   2. 归一化名唯一命中（display_name 或 aliases 归一后相等，且**恰好一条**）；
 *   3. 新建一行。
 *
 * 为什么第 2 步要求「唯一」：名字是弱证据。同名两条就说明分不清，此时宁可新建一行
 * 留待人工/后续 mergeSoulPerson 合并，也不能猜——猜错会把两个人的事实混进同一份档案，
 * 而档案是要注入到对方面前的。
 *
 * 归一化口径：NFKC → 压空白 → trim → 小写。刻意不剥标点/不做拼音：中文名去掉标点
 * 会让「小满。」与「小满」合并（可能是同一人，也可能是句读残留），这类判断应交给人。
 */

import { createHash } from "node:crypto";
import type { IMemoryStore } from "../store/types.js";
import type { CoreTenant } from "../store/types.js";
import { normalizeCoreTenant } from "../store/types.js";
import type { PersonHint, SoulPerson } from "./types.js";
import { normalizePersonNameCandidate } from "../record/person-hints.js";

/** 平台身份主键前缀。 */
export const PLATFORM_PERSON_PREFIX = "p_";
/** 无平台身份时按归一化名生成的主键前缀。 */
export const NAME_PERSON_PREFIX = "p_name_";

/** 哈希截断长度（与 §3-B 一致：sha1 前 12 个 hex）。 */
const KEY_HASH_LEN = 12;

/**
 * 名字归一化（比较用，不写回库）。
 * - NFKC：全角/半角、康熙部首等兼容字符先折叠；
 * - \s+ → 单空格：`张 三` 与 `张  三` 视为同一写法；
 * - trim + toLowerCase：`HeChen` 与 `hechen` 同一。
 */
export function normalizePersonName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function sha1Hex12(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").slice(0, KEY_HASH_LEN);
}

/**
 * person_key 生成（纯函数，无 IO）。
 *
 * - 有 platform_id：`p_<sha1(team|user|agent|platform|platform_id)[:12]>`
 *   —— 三租户维度进哈希：同一平台 id 在不同 agent 下是不同的人（agent 隔离是硬边界）。
 * - 无 platform_id：`p_name_<sha1(team|user|agent|归一化名)[:12]>`
 *   —— 名字分支同样带租户：不同 agent 下同名的是不同的人（否则跨租户撞主键）。
 *
 * @throws 既无 platformId 也无 displayName 时抛错（调用方应先过滤空线索）。
 */
export function personKeyOf(input: {
  teamId?: string;
  userId?: string;
  agentId?: string;
  platform?: string | null;
  platformId?: string | null;
  displayName?: string | null;
}): string {
  const platform = (input.platform ?? "").trim();
  const platformId = (input.platformId ?? "").trim();
  if (platformId !== "") {
    const raw = [
      input.teamId ?? "",
      input.userId ?? "",
      input.agentId ?? "",
      platform,
      platformId,
    ].join("|");
    return `${PLATFORM_PERSON_PREFIX}${sha1Hex12(raw)}`;
  }
  const name = normalizePersonName(input.displayName);
  if (name === "") {
    throw new Error("personKeyOf: platformId 与 displayName 不能同时为空");
  }
  return `${NAME_PERSON_PREFIX}${sha1Hex12([input.teamId ?? "", input.userId ?? "", input.agentId ?? "", name].join("|"))}`;
}

/** 该行是否「叫这个名字」（display_name 或别名归一后相等）。 */
function personMatchesName(person: SoulPerson, normalizedName: string): boolean {
  if (normalizedName === "") return false;
  if (normalizePersonName(person.displayName) === normalizedName) return true;
  return (person.aliases ?? []).some((alias) => normalizePersonName(alias) === normalizedName);
}

/** store 不具备持久化能力时的降级行（不落库，读取面会读不到——刻意不抛，避免阻断 L1 写入）。 */
function ephemeralPerson(tenant: CoreTenant, hint: PersonHint, key: string): SoulPerson {
  const now = new Date().toISOString();
  const platformId = (hint.platformId ?? "").trim();
  return {
    personKey: key,
    teamId: tenant.teamId,
    userId: tenant.userId,
    agentId: tenant.agentId,
    platform: (hint.platform ?? "").trim(),
    platformId: platformId === "" ? null : platformId,
    displayName: (hint.displayName ?? "").trim(),
    aliases: Array.isArray(hint.aliases) ? [...hint.aliases] : [],
    mergedInto: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 线索是否可解析（至少要有一个身份锚）。 */
export function isUsablePersonHint(hint: PersonHint | null | undefined): hint is PersonHint {
  if (!hint || typeof hint !== "object") return false;
  const platformId = typeof hint.platformId === "string" ? hint.platformId.trim() : "";
  const name = normalizePersonName(hint.displayName ?? "");
  return platformId !== "" || name !== "";
}

/**
 * 这行是不是「空壳」：没有平台身份、没有任何档案行、也不在任何关系边上。
 *
 * 用来区分「同名占位行」与「另一个同名的人」：前者可以安全并进平台行，后者不行。
 * 任何一项读不出来都按「不是空壳」处理——宁可不合并，也不要吞掉别人的档案。
 */
async function isPersonShell(store: IMemoryStore, tenant: CoreTenant, person: SoulPerson): Promise<boolean> {
  if ((person.platformId ?? "").trim() !== "") return false;
  if (typeof store.listSoulPersona !== "function") return false;
  try {
    const items = (await store.listSoulPersona(tenant, { includeSuperseded: true })) ?? [];
    const key = person.personKey;
    const owned = (it: { meta?: unknown }): boolean => {
      const p = (it.meta as { person?: { key?: unknown } } | undefined)?.person;
      return typeof p?.key === "string" && p.key.trim() === key;
    };
    if (items.some(owned)) return false;
  } catch {
    return false;
  }
  if (typeof store.listSoulPersonRelations === "function") {
    try {
      const edges = (await store.listSoulPersonRelations(tenant, { includeClosed: true })) ?? [];
      if (edges.some((e) => e.subjKey === person.personKey || e.objKey === person.personKey)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 平台行补名字（幂等、只补空）。
 *
 * 补不上不是错：`upsertSoulPerson` 可能因为唯一索引/并发失败，那就继续用旧行——
 * 名字缺失只影响读面的检索与展示，不能让一条 L1 记忆的挂人因此丢掉。
 */
async function withDisplayName(
  store: IMemoryStore,
  tenant: CoreTenant,
  person: SoulPerson,
  displayName: string,
): Promise<SoulPerson> {
  const name = displayName.trim();
  if (name === "") return person;
  // 已有一个「像名字」的名字就不再覆盖（先到的证据更完整）；但库里存着角色词（「用户」
  // 「助手」）不算名字——那是模型把称呼槽填成了角色词，留着面板上就会出现一个叫「用户」
  // 的人，且它会被当成「已有名字」挡住后来的真名。这类脏名字允许被真名覆盖。
  const current = (person.displayName ?? "").trim();
  if (current !== "" && normalizePersonNameCandidate(current) !== null) return person;
  if (typeof store.upsertSoulPerson !== "function") return person;
  // 同租户已经有一行叫这个名字时：只有当那行是「空壳」才把它并进来。
  // 空壳＝没有平台身份、没有任何档案行、也不在任何关系边上——它只可能是这个名字早先
  // 以「被提到」的形式进库时建出来的占位行（90 天回放实测：mentioned 先落库、本人自述
  // 后来的顺序就长成这样）。真正的两个人合用一名（同名不同人）不会满足「零档案零边」，
  // 那种情况的合并是数据迁移决策，不在这里做。
  if (typeof store.listSoulPersons === "function") {
    try {
      const all = (await store.listSoulPersons(tenant)) ?? [];
      const wanted = normalizePersonName(name);
      const clash = all.find((p) => p.personKey !== person.personKey && personMatchesName(p, wanted));
      if (clash) {
        const shell = await isPersonShell(store, tenant, clash);
        if (!shell) return person;
        if (typeof store.mergeSoulPerson === "function") {
          // 壳行进 → 本行：读面按 `merged_into IS NULL` 过滤，合并后同一个名字只剩一行。
          const merged = await store.mergeSoulPerson(tenant, clash.personKey, person.personKey);
          if (!merged?.merged) return person;
        } else {
          return person;
        }
      }
    } catch {
      // 列表读不出来就按「没有冲突」处理：这次补名是幂等写，不会造成数据损坏。
    }
  }
  try {
    const res = await store.upsertSoulPerson(tenant, {
      personKey: person.personKey,
      platform: (person.platform ?? "").trim(),
      platformId: person.platformId ?? null,
      displayName: name,
      aliases: Array.isArray(person.aliases) ? person.aliases : [],
    });
    // upsert 只回 `{personKey, created}`；名字是本地刚写入的事实，直接并进返回值，
    // 不为了一次展示再回读一趟列表。
    return { ...person, personKey: res?.personKey ?? person.personKey, displayName: name };
  } catch {
    return person;
  }
}

/**
 * 解析（或创建）一个人。
 *
 * 优先级：平台 id 精确 → 归一化名唯一命中 → 建新行。
 * 返回的 `SoulPerson` 一定带 personKey；`created` 由调用方通过 listSoulPersons 观察，
 * 这里不额外返回（保持签名简单）。
 */
export async function resolvePerson(
  store: IMemoryStore,
  tenant: CoreTenant | undefined,
  hint: PersonHint,
): Promise<SoulPerson> {
  const t = normalizeCoreTenant(tenant);
  const platform = (hint.platform ?? "").trim();
  const platformId = (hint.platformId ?? "").trim();
  const displayName = (hint.displayName ?? "").trim();

  // ① 平台 id 精确命中（最强证据）。merged 行不可命中——它已经有归属了。
  if (platformId !== "" && typeof store.getSoulPersonByPlatform === "function") {
    const hit = await store.getSoulPersonByPlatform(t, { platform, platformId });
    if (hit) {
      // 「先有身份、后知道名字」是常态：L0 里只有 user_id，名字要等他自述或被别人喊。
      // 生产实测 7 个 platform 行 display_name 全空、名字只长在档案 alias 字段里，
      // 于是面板按名字索引时整条人都看不见（`soul-persons.ts` 把空名行 skip 掉）。
      // 这里只在旧行没名字时补写；已有名字绝不覆盖——先到的那份证据更完整。
      return withDisplayName(store, t, hit, displayName);
    }
  }

  // ② 归一化名唯一命中。>1 条说明分不清，落到 ③ 新建，绝不猜。
  const name = normalizePersonName(displayName);
  if (name !== "" && typeof store.listSoulPersons === "function") {
    const all = (await store.listSoulPersons(t)) ?? [];
    const hits = all.filter((p) => personMatchesName(p, name));
    if (hits.length === 1) {
      const hit = hits[0];
      // 名字唯一命中 + 这次带了平台 id + 旧行还没绑平台 → 就地补绑（幂等；失败不改归属）。
      const alreadyBound = typeof hit.platformId === "string" && hit.platformId.trim() !== "";
      if (platformId !== "" && !alreadyBound && typeof store.upsertSoulPerson === "function") {
        try {
          await store.upsertSoulPerson(t, {
            personKey: hit.personKey,
            platform,
            platformId,
            displayName: hit.displayName,
            aliases: hit.aliases ?? [],
          });
        } catch {
          /* 补绑失败不改归属：名字命中的归属结论比平台绑定更重要 */
        }
      }
      return hit;
    }
  }

  // ③ 新建（或按主键回填展示面）。
  const key = personKeyOf({
    teamId: t.teamId,
    userId: t.userId,
    agentId: t.agentId,
    platform,
    platformId,
    displayName,
  });
  if (typeof store.upsertSoulPerson !== "function") {
    return ephemeralPerson(t, hint, key);
  }
  const upserted = await store.upsertSoulPerson(t, {
    personKey: key,
    platform,
    platformId: platformId === "" ? null : platformId,
    displayName,
    aliases: Array.isArray(hint.aliases) ? hint.aliases : [],
  });
  const finalKey = upserted?.personKey ?? key;
  // 回读：upsert 可能撞上平台唯一索引而挂到既有行（finalKey !== key），也可能因
  // 并发插入返回了别人的行。回读失败就返回内存构造的行，绝不让 L1 写入因读面失败而中断。
  if (typeof store.listSoulPersons === "function") {
    const all = (await store.listSoulPersons(t)) ?? [];
    const found = all.find((p) => p.personKey === finalKey);
    if (found) return found;
  }
  return ephemeralPerson(t, hint, finalKey);
}
