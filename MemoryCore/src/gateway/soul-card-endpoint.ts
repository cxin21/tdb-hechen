/**
 * S2（判据 2/4/14）：GET /v3/soul/card 与 GET /v3/soul/turn —— 两条注入通道的唯一数据源。
 *
 * 合同（spec §2 / G2）：
 *   - 纯读：只调用 assembleSoulCard({persist:false}) 与 assembleSoulTurn，不写任何表。
 *   - 失败即降级：store 未就绪 → 503 soul_card_unavailable；渲染异常 → 503 soul_card_failed。
 *     插件侧对此一律 fail-open（拿不到就当没有这段注入），绝不因此阻断会话。
 *   - 不返回权重/算法名/轴名：卡文本由 v13 渲染器（card-v13.ts）决定，这里只加版本标识与九块元数据。
 */
import { createHash } from "node:crypto";
import type { URL } from "node:url";
import type { ServerResponse } from "node:http";
import type { CoreTenant, IMemoryStore } from "../core/store/types.js";
import type { AgentProfile } from "../core/soul/agent-profile.js";
import { assembleSoulCard, assembleSoulTurn } from "../core/soul/card-service.js";
import { assembleTurnState, type TurnStateAssembly } from "../core/soul/turn-state-assembler.js";
import { normalizePersonName } from "../core/person/resolve.js";
import { SEED_LABELS, SOUL_AXES, activationOf, normalizeDirection, seedStateFromSeeds } from "../core/soul/traits.js";

export interface SoulCardRouteDeps {
  getStore: () => IMemoryStore | null;
  /**
   * §6 运行时状态装配开关。缺省开启；传 false 时 turn 响应与本会话前逐字一致
   * （只有 text/openLoops/chars），供 A/B 回放与回退取证。
   */
  runtimeStateEnabled?: boolean;
  /** metadata 侧读表单人格（与 worker 同一端口）；缺席时卡里只有表单缺省。 */
  getReadAgentProfile?: () => ((agentId: string) => Promise<AgentProfile | null>) | null;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

function tenantOf(url: URL): CoreTenant {
  const pick = (k: string): string => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : "default";
  };
  return { teamId: pick("team"), userId: pick("user"), agentId: pick("agent") };
}

/** 一次最多认几个在场者：URL 不该能拉出一张无限长的名单。 */
const MAX_PARTICIPANTS = 8;
/** person_key 前缀（personKeyOf 两种分支：`p_<hash>` 与 `p_name_<hash>`）。 */
const PERSON_KEY_PREFIX = "p_";

/**
 * `?participants=` → 请求的在场者名单（阶段 2 / P2-B）。
 *   - 没传 → `undefined`（不过滤，旧行为）；
 *   - `participants=` 空串 → `[]`（只剩全局共性行）；
 *   - 逗号分隔，去空白、去空项、最多 8 个。
 * 这里只做切分，不解析名字——解析在 resolveParticipants（要读库）。
 */
export function personsOf(url: URL): string[] | undefined {
  const raw = url.searchParams.get("participants");
  if (raw === null) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PARTICIPANTS);
}

export interface ResolveParticipantsOptions {
  /** 显式名单（`?participants=`），优先于 session。 */
  participants?: string[];
  /** 会话 id：没有显式名单时，用它取该会话最近一条带参与方的事件。 */
  session?: string;
}

/**
 * 把「在场者线索」解析成 person_key（阶段 2 / P2-B，两种形态按顺序试）：
 *   ① 已经是 person_key（`p_` 前缀）→ 原样用（不查库、不改写）；
 *   ② 展示名 → 在租户内用 `listSoulPersons` 的 display_name/aliases 归一化精确命中，
 *      命中恰好 1 条才用；0 条（没人叫这个名字）或 ≥2 条（重名）都**丢弃**——不猜。
 *
 * 三态返回（这是本函数的核心，不能压成 []）：
 *   - 显式 `participants`（含空串）→ 解析后的列表，可能是 `[]`；
 *   - 只给 session 且该会话最近一条 `persons_json` 非空 → 事件里那组 person_key；
 *   - 只给 session 但没事件 / 事件的 persons_json 为空 → `undefined`；
 *   - 什么都没给 → `undefined`。
 * 为什么 session 查不到不是 `[]`：`[]` 的语义是「只剩全局共性行」，会把该会话本人的
 * `layer='human'` 行静默清空；未知≠没有，宁可不过滤。
 * session 路径读 `persons_json`（person_key 数组），不读 `participants_json`（展示名）。
 */
export async function resolveParticipants(
  store: IMemoryStore,
  tenant: CoreTenant,
  opts: ResolveParticipantsOptions = {},
): Promise<string[] | undefined> {
  if (opts.participants !== undefined) return toPersonKeys(store, tenant, opts.participants);

  const session = (opts.session ?? "").trim();
  if (session === "") return undefined;
  const episodes =
    typeof store.listSoulEpisodes === "function"
      ? ((await Promise.resolve(store.listSoulEpisodes(tenant, { limit: 2000 }))) ?? [])
      : [];
  const episode = episodes.find((e) => e.sessionId === session && (e.persons ?? []).length > 0);
  if (!episode) return undefined;
  return toPersonKeys(store, tenant, episode.persons ?? []);
}

/** 名单 → person_key（保序去重、截断）；名字未命中或重名一律丢弃。 */
async function toPersonKeys(
  store: IMemoryStore,
  tenant: CoreTenant,
  raw: ReadonlyArray<string>,
): Promise<string[]> {
  const direct: string[] = [];
  const names: string[] = [];
  for (const entry of raw) {
    const value = String(entry ?? "").trim();
    if (value === "") continue;
    if (value.startsWith(PERSON_KEY_PREFIX)) {
      direct.push(value);
      continue;
    }
    const normalized = normalizePersonName(value);
    if (normalized !== "") names.push(normalized);
  }

  const persons =
    typeof store.listSoulPersons === "function"
      ? ((await Promise.resolve(store.listSoulPersons(tenant))) ?? [])
      : [];

  // P2-B2 校验：`p_` 前缀的 key 也必须在本租户存在。
  // 不校验的话，调用方传一个不存在的 key 会原样进 data.persons，
  // 等于对「这个人在场」做了假声明；而实际过滤什么都没发生（text 与不带参相同），
  // 面板/日志读到的就是「声称按人过滤了、其实没过滤」。
  // store 没有按 key 取人的方法，这里用一次租户名单做集合判断；
  // 老实现（无 listSoulPersons）保留原样直通，避免把兼容口径弄坏。
  const knownKeys = new Set(persons.map((p) => p.personKey));
  const resolved = typeof store.listSoulPersons === "function"
    ? direct.filter((key) => knownKeys.has(key))
    : [...direct];
  if (names.length > 0) {
    for (const name of names) {
      const hits = persons.filter(
        (p) =>
          normalizePersonName(p.displayName) === name ||
          (p.aliases ?? []).some((alias) => normalizePersonName(alias) === name),
      );
      if (hits.length === 1) resolved.push(hits[0].personKey);
    }
  }
  return [...new Set(resolved)].slice(0, MAX_PARTICIPANTS);
}

/** SHA-256 (lowercase hex) of the card text: what the plugin's section-read hash must equal. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Below this the axes have not moved at all; anything larger is a real drift. */
const TRAIT_DRIFT_EPSILON = 0.005;

export async function handleSoulCardRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulCardRouteDeps,
): Promise<boolean> {
  const pathname = url.pathname;
  if (method !== "GET") return false;
  const isCard = pathname === "/v3/soul/card";
  const isTurn = pathname === "/v3/soul/turn";
  if (!isCard && !isTurn) return false;

  const store = deps.getStore();
  if (!store) {
    sendJson(res, 503, { code: 503, message: "soul_card_unavailable" });
    return true;
  }
  const tenant = tenantOf(url);
  try {
    if (isCard) {
      const readAgentProfile = deps.getReadAgentProfile?.() ?? undefined;
      // P2-B：显式 participants 优先；只有 session 时按该会话最近一条事件反查在场者。
      // 两者都没给 → undefined（不过滤，与改前逐字节一致）；解析结果即使是空数组也照传
      // （`participants=` 的语义就是「只剩全局共性行」）。
      const explicit = personsOf(url);
      const session = (url.searchParams.get("session") ?? "").trim();
      const persons =
        explicit === undefined && session === ""
          ? undefined
          : await resolveParticipants(store, tenant, {
              ...(explicit === undefined ? {} : { participants: explicit }),
              ...(session === "" ? {} : { session }),
            });
      const card = await assembleSoulCard({
        store,
        tenant,
        ...(readAgentProfile ? { readAgentProfile } : {}),
        persist: false,
        ...(persons === undefined ? {} : { persons }),
      });
      sendJson(res, 200, {
        code: 0,
        data: {
          version: card.version,
          hash: card.hash,
          textHash: sha256Hex(card.text),
          text: card.text,
          chars: card.chars,
          // P1-2：两段载荷（身份段 + 末尾锚）。text 仍是整卡，老调用方不受影响；
          // 新调用方按段注入时先用 identity/anchor，缺失才回退 text。
          identity: card.identity,
          anchor: card.anchor,
          labels: card.labels,
          warnings: card.warnings,
          sources: card.sources,
          // v13：九块的元数据（id/标题/字数/来源/置信/证据回指/块级警告）。v12 路径没有这一项。
          ...(card.schema ? { schema: card.schema } : {}),
          ...(card.blocks ? { blocks: card.blocks } : {}),
          dirty: card.dirty,
          seeded: card.seeded,
          // P2-B：回显这次真正用于过滤的 person_key；未过滤（没传 participants/session）时不出现
          // 这个字段——空数组是有语义的（只剩全局行），不能拿它冒充「不过滤」。
          ...(persons === undefined ? {} : { persons }),
        },
      });
      return true;
    }
    const turn = await assembleSoulTurn({ store, tenant });
    const data: Record<string, unknown> = { text: turn.text, openLoops: turn.openLoops, chars: turn.text.length };
    // §6：运行时状态与 400 字尾巴分开给——插件用独立字段注入，旧 text 逐字不变，
    // 缓存也能按 stateHash 分辨「同一句话、不同心境」。装配自身 fail-open：出错就不带 state，
    // 绝不让一次 SQLite 失败把整条注入打掉。
    if (deps.runtimeStateEnabled !== false) {
      const state = await readTurnStateSafely(store, tenant, url, deps);
      if (state) data.state = state;
    }
    sendJson(res, 200, { code: 0, data });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.(`[soul-card-endpoint] ${isCard ? "card" : "turn"} failed: ${message}`);
    sendJson(res, 503, { code: 503, message: isCard ? "soul_card_failed" : "soul_turn_failed" });
    return true;
  }
}

/**
 * §6：turn 侧运行时状态读取。personKey 只认显式 `person` 参数或唯一 participant；
 * 解析不出来就不带关系段（装配器里 fail-closed），session 用来取 working_state。
 * 这里再包一层 try/catch：装配器内部已逐读降级，外层只兜它自己也想不到的错。
 */
async function readTurnStateSafely(
  store: IMemoryStore,
  tenant: CoreTenant,
  url: URL,
  deps: SoulCardRouteDeps,
): Promise<TurnStateAssembly | undefined> {
  try {
    const explicit = (url.searchParams.get("person") ?? "").trim();
    const persons = personsOf(url);
    const personKey = explicit !== "" ? explicit : persons && persons.length === 1 ? persons[0] : undefined;
    const sessionId = (url.searchParams.get("session") ?? "").trim();
    // §6「边界」段：红线属于表单人格（metadata 侧），不是灵魂表的一部分，
    // 所以由端点读出来交给装配器——否则动态段永远缺这一段（票面五段只落地四段）。
    const redlines = await readRedlines(deps, tenant, url);
    // §8 的 400 是「标头 + 正文」总预算；插件把标头占位通过 stateBudget 传进来，
    // 端点只负责夹住上限，正文就不会顶穿总预算、也不会被插件二次裁掉尾行。
    const requestedBudget = Number(url.searchParams.get("stateBudget") ?? "");
    const dynamicMaxChars =
      Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.floor(requestedBudget) : undefined;
    return await assembleTurnState({
      store,
      tenant,
      ...(personKey ? { personKey } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(redlines.length > 0 ? { redlines } : {}),
      ...(dynamicMaxChars === undefined ? {} : { dynamicMaxChars }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.(`[soul-card-endpoint] turn state skipped: ${message}`);
    return undefined;
  }
}

/**
 * 表单红线里当前仍生效的那几条（active 不为 false）。读不到就返回空数组：
 * 缺边界段比拿失效红线去约束此刻更安全。
 */
async function readRedlines(
  deps: SoulCardRouteDeps,
  tenant: CoreTenant,
  url: URL,
): Promise<string[]> {
  try {
    const read = deps.getReadAgentProfile?.();
    if (typeof read !== "function") return [];
    const agentId = (url.searchParams.get("agent") ?? tenant.agentId ?? "").trim();
    if (agentId === "") return [];
    const profile = await read(agentId);
    const list = profile?.redlines ?? [];
    const out: string[] = [];
    for (const item of list) {
      if (item.active === false) continue;
      const text = String(item.text ?? "").trim();
      if (text !== "") out.push(text);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * GET /v3/soul/trait-state —— 表单「你设定的 / 它现在」两栏的唯一数据源（spec §5）。
 *
 * 只读：读 soul_trait_state 的当前 state 与表单种子，按标签算激活度（不返回轴名、权重算法）。
 *
 * 两条口径（2026-11-07 复验修正）：
 *   1) 只出「真的存在」的标签：表单声明过的 ∪ soul_trait_label 里 evidence>0 且未 dormant 的。
 *      此前用 SEED_LABELS 全量铺 18 条，零方向标签的 act 恒为 0.5，等于凭空造出
 *      「18 个特质、全是 0.5」；没设定过的种子不许出现在 traits 里。
 *   2) drifted 比同量纲的量：|state[axis] − seedState[axis]| > TRAIT_DRIFT_EPSILON（任一轴）。
 *      此前拿 act（0..1、零漂移恒 0.5）去比声明权重（Σ=1 归一），量纲不同 → 零漂移也判漂移；
 *      后来改用 TRAIT_MAX_STEP 当阈值，一粒种子级微动也会被报成 drifted（审墨 A2）。
 *      标签层面的展示仍用 act（nowWeight）。
 *   3) 没有 soul_trait_state 行时用 seedStateFromSeeds(profile.traits) 兜底（与卡同源）：
 *      否则这一屏给 0.5、卡给 0.8/0.7/0.7/0.6，两个数字互相矛盾。data.seedSource 说明
 *      这一屏是「真状态」还是「刚由表单种子推出来的」。
 *
 * 失败即降级：store 未就绪 / 读失败 → 503；成功体一律走 { code: 0, data } 信封，
 * 与 /v3/soul/card、/v3/soul/turn 同形（此前这条是裸 JSON，Panel 要写两套解析）。
 */
export async function handleSoulTraitStateRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulCardRouteDeps,
): Promise<boolean> {
  if (method !== "GET" || url.pathname !== "/v3/soul/trait-state") return false;
  const tenant = tenantOf(url);
  const store = deps.getStore();
  if (!store) {
    sendJson(res, 503, { code: 503, message: "soul_trait_state_unavailable" });
    return true;
  }
  try {
    const state = typeof store.readSoulTraitState === "function"
      ? await Promise.resolve(store.readSoulTraitState(tenant))
      : null;
    const labelRows =
      typeof store.listSoulTraitLabels === "function"
        ? ((await Promise.resolve(store.listSoulTraitLabels(tenant))) ?? [])
        : [];
    const readProfile = deps.getReadAgentProfile ? deps.getReadAgentProfile() : null;
    const profile = readProfile ? await readProfile(tenant.agentId) : null;

    const declared = (profile?.traits ?? []).filter((t) => Number.isFinite(Number(t.weight)));
    const seedWeights = new Map<string, number>(declared.map((t) => [t.label, Number(t.weight)]));
    const seeds = new Map(SEED_LABELS.map((s) => [s.label, s]));
    const rowsByLabel = new Map(labelRows.map((r) => [r.label, r]));

    // ① 声明过（按表单顺序） ② 有证据的自生长标签（evidence>0 且未 dormant，按标签名稳定排序）
    const grown = labelRows
      .filter((r) => !seedWeights.has(r.label) && (r.evidence ?? 0) > 0 && r.status !== "dormant")
      .map((r) => r.label)
      .sort((a, b) => a.localeCompare(b));
    const labels = [...declared.map((t) => t.label), ...grown];

    // 无 state 行时与卡同源：用表单种子现算一份 state（card-service 也是这么兜的），
    // 页面两栏因此不会出现「卡 0.8、表单 0.5」这种自相矛盾的数字。
    const seedState = seedStateFromSeeds(declared);
    const seedSource: "state" | "seed" = state ? "state" : "seed";
    const effectiveState = state ? state.state : seedState;
    const referenceSeed = state?.seedState ?? seedState;
    // 漂移按轴向量比（两边同在 [-1,1]）：超过 epsilon 才算漂；TRAIT_MAX_STEP 是单 tick 上限，
    // 拿它当阈值时一粒种子级微动也会报 drifted（审墨 A2）。
    const driftMax = SOUL_AXES.reduce(
      (m, axis) => Math.max(m, Math.abs(effectiveState[axis] - referenceSeed[axis])),
      0,
    );
    const drifted = driftMax > TRAIT_DRIFT_EPSILON;

    const traits = labels.flatMap((label) => {
      const seed = seeds.get(label);
      const row = rowsByLabel.get(label);
      const rawDirection = seed?.direction ?? row?.direction;
      if (!rawDirection) return [];
      const direction = normalizeDirection(rawDirection);
      return [{
        label,
        seedWeight: Number((seedWeights.get(label) ?? 0).toFixed(2)),
        nowWeight: Number(activationOf(effectiveState, direction).toFixed(2)),
        drifted,
      }];
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        agentId: tenant.agentId,
        updatedAt: state?.updatedAt ?? null,
        seedSource,
        traits,
      },
    });
    return true;
  } catch (err) {
    deps.logger?.warn?.(
      `[soul-trait-state] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 503, { code: 503, message: "soul_trait_state_failed" });
    return true;
  }
}
