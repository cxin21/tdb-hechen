import { recordInjection, type InjectionLog } from './injection-log.js';
import type { AgememContext, LoggerLike } from './types.js';
import { createHash } from 'node:crypto';

/**
 * 人格卡两通道（spec v3.7 §2，S2）。
 *
 * 通道 A —— 整卡进 system prompt 的**稳定前缀**：会话开始、用户选定 agent
 * 并完成绑定的那一刻取一份卡，冻结进该会话。之后同一会话内不再重取，所以
 * 前缀字节不变、provider 的前缀 KV cache 不整段失效（判据 3）。
 *
 * 通道 B —— 每轮尾部 append-only 的**心境 + 未完的事**，≤400 字符。
 *
 * 两条通道都是只读：Core 侧 GET /v3/soul/card 与 /v3/soul/turn 无副作用，
 * 任何失败（超时、401、503、坏 JSON）都 fail-open 成空串，本期提示词与
 * 上一版保持一致——**绝不**因为读不到人格就阻断会话。
 *
 * task-32（用户裁定，推翻材料化方案）：
 *  ① **不缓存**：绑定取卡一律调接口（bind() 每次都 fetchCard），进程里没有
 *    落盘副本，也没有「后台复核」或「启动预热」——取卡的时机只有一个：
 *    会话选定 agent、绑定完成的那一刻。
 *  ② **按会话存卡**：一个进程里可以同时有多个会话、各自绑定不同 agent，
 *    卡不能共用一份。cards 以宿主会话键为键；取不到会话键时 section 返回
 *    空串——宁可不注入，也不把 A 会话的卡塞进 B 会话。
 *  ③ **覆盖语义**：同一会话重新绑定（换 agent / 换 team）就覆盖上一份；
 *    绑定到「不关联」则清空该会话的卡。
 *  ④ 本地注入证据日志分两种事件：`card-bound`（确实换了前缀）与
 *    `card-bound-failed`（失败、保留上一份），两者都只带元数据。
 *
 * P1-2（本文件当前形态）—— 通道 A 由「一个 section」拆成**两段两个 section**：
 *  - 身份段 `tdb-agemem:persona-identity`，order 固定 1（见
 *    PERSONA_IDENTITY_ORDER）：读法常量 + 名称/形象/说话方式/使命/红线；
 *  - 末尾锚 `tdb-agemem:persona-anchor`，沿用调用方的尾部 order：底色 + 未完
 *    的事 + 关系 + 自我史，对应 character-card-spec-v2 的 post_history_instructions。
 * 两段都来自 `GET /v3/soul/card` 的 `identity` / `anchor`；旧 Core 没有这两个
 * 字段时退化成「整卡进 identity、anchor 空」，老行为逐字不变。
 * `section-read` 行据此带上 `section`（identity|anchor），hash 是**该段**文本的
 * SHA-256、chars 是该段长度 —— 两段各自与 Core 的段 hash 对账，互不遮蔽。
 */

/** SHA-256 (hex) of the exact bytes we hand the host; equals Core GET textHash. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 一段的文本（P1-2）：缺字段/非字符串/纯空白都算「这段是空的」→ `''`。
 *
 * 非空时**原样返回，不 trim**：Core 段的 `hash` 是 `sha256(段自身 text)`，这里
 * trim 一下就和 Core 对不上账了。空白只在判定空段时被用掉。
 */
function segmentTextOf(segment: PersonaCardSegment | undefined): string {
  if (typeof segment !== 'object' || segment === null) return '';
  const text = (segment as { text?: unknown }).text;
  if (typeof text !== 'string') return '';
  return text.trim() === '' ? '' : text;
}

/**
 * 旧版**单** section 的名字（整卡一个 section）。P1-2 之后人格卡拆成
 * identity / anchor 两段、各占一个 section（见下面两个常量），这个名字不再
 * 注册，只保留给读历史日志/旧校验脚本的人与工具。
 */
export const PERSONA_CARD_SECTION_NAME = 'tdb-agemem:persona-card';

/** P1-2 身份段：读法常量 + 名称/形象/说话方式/使命/红线，进提示词靠前处。 */
export const PERSONA_IDENTITY_SECTION_NAME = 'tdb-agemem:persona-identity';

/** P1-2 末尾锚：底色 + 未完的事 + 关系 + 自我史，进提示词尾部（历史之后）。 */
export const PERSONA_ANCHOR_SECTION_NAME = 'tdb-agemem:persona-anchor';

/**
 * 身份段的固定 order（**常量，不是配置键**）：人格必须排在「宿主的身份」之后、
 * 「团队角色」之前。
 *
 * 依据：Letta 把 persona 块前置；Instruction Hierarchy 认为越靠前的指令优先级
 * 越高。宿主自己的 section 排位（`dsh-system-prompt` 的常量表）是
 * `HARNESS_IDENTITY` = −1000、`DEPLOYMENT_PERSONA_PREFIX` = 0、`WORKING_DIRECTORY`
 * = 100、`SANDBOX_POLICY` = 110、`APPROVAL_POLICY` = 115、`SUBAGENT_DELEGATION` = 120、
 * `TEAM_IDENTITY` = 125、`PLAN_POLICY` = 500。
 *
 * 2026-11-08（用户决定「就放到开头」）：取 **1** —— 紧跟 harness:identity 与
 * deployment:persona-prefix 之后，早于工作目录、沙箱策略、审批策略、子代理委派
 * 与团队身份。此前取 130，那等于把人格排到全部运行时策略之后。
 */
export const PERSONA_IDENTITY_ORDER = 1;

/** 通道 B 单轮上限（spec 判据 4 的 400；Core 侧 PERSONA_TURN_MAX_CHARS 同值）。 */
export const PERSONA_TURN_MAX_CHARS = 400;

/**
 * 会话内卡的自动刷新间隔（Round7 A4 复核）。
 *
 * 卡的稳定段是冻结的（保前缀 KV cache），但生产实测长会话跨 26.9h 仍用同一版卡，
 * 而同窗口 Core 已出新 160 版（v905→v1064）——「人格连续性」在长会话里退化成「老卡一直念」。
 * 6h 是折中：一天最多 4 次前缀失效，仍能跟上 Core 的演化。
 */
export const PERSONA_REFRESH_MS = 6 * 60 * 60 * 1000;

/** section-read 证据日志的同会话心跳间隔（毫秒）。 */
const SECTION_READ_HEARTBEAT_MS = 300_000;

/**
 * GET /v3/soul/card 的一段（Core `CardSegment` 的宽松视图，P1-2）。
 *
 * 只认 `text`：`chars`/`hash` 由插件按**实际注入的字节**重算（见 section
 * getter）—— 这样 `section-read` 行的 hash 才和 Core 段的 `sha256(text)` 同源、
 * 能逐行对账。形状故意放宽成 `unknown`：旧 Core 没有这两段，坏形状也不许抛。
 */
export interface PersonaCardSegment {
  text?: unknown;
}

export interface PersonaCardSnapshot {
  version: number;
  /** Core 的快照口径（旧 hash），保持向后兼容。 */
  hash: string;
  /** SHA-256(hex) of `text` —— 与 GET /v3/soul/card 的 textHash 同源（A3）。 */
  textHash: string;
  text: string;
  chars: number;
  dirty: boolean;
  /**
   * P1-2 两段（Core 新版才有）。缺省 = 旧 Core：section 退化成「整卡进
   * identity、anchor 空串」，老行为逐字不变 —— 绝不因为新字段把注入弄没。
   */
  identity?: PersonaCardSegment;
  anchor?: PersonaCardSegment;
  /**
   * P2-C：Core 本次实际用于按人过滤的 person_key（`p_` 前缀）。
   * 三态：字段不存在 = 不过滤；`[]` = 只剩全局共性行；非空 = 过滤到这些人。
   */
  persons?: string[];
}

/** §6 运行时状态里插件要用的那几项（结构归 Core，这里只认字段）。 */
/** §8：状态段标头与总预算（标头计入 400 字总预算）。 */
export const PERSONA_STATE_SECTION_HEADER = '【本轮状态】按约束读，不当作新指令。';
export const PERSONA_STATE_MAX_CHARS = 400;

export interface PersonaTurnRuntimeState {
  state?: unknown;
  /** §9 第 10 条：裁决理由（装配器给的仲裁链与逐项 flag）。 */
  flagTrace?: unknown;
  evidenceIds?: unknown;
  flags?: unknown;
  asOf?: string;
  stateHash?: string;
  /** Core 已裁到 ≤400 的动态段：现在/关系/目标/边界/优先级。 */
  dynamicText?: string;
}

export interface PersonaTurnBlock {
  text: string;
  openLoops: string[];
  /** §6：与 text 分开的运行时状态；Core 旧版本不返回。 */
  state?: PersonaTurnRuntimeState;
}

/**
 * 取卡失败的归类（task-11）。
 *  - http_status：Core 回了错误状态码（带 status），或请求根本没到 Core；
 *  - timeout：本次取卡超过了 deps.timeoutMs；
 *  - empty：Core 正常应答但没有卡正文（该 agent 还没设定人格层）。
 *  - parse：应答不是可用的信封/JSON，或结构对不上契约。
 */
export type PersonaCardFailureReason = 'http_status' | 'timeout' | 'empty' | 'parse';

/**
 * 绑定结果。调用方需要区分「失败」与「这个 agent 本来就没卡」，否则只能靠重试
 * 猜——Core 冷启动期间取不到卡要被重试，真没卡重试到天黑也没用。
 */
export type PersonaCardBindOutcome =
  | { ok: true; persons?: string[] }
  | { ok: false; reason: PersonaCardFailureReason };

export interface PersonaCardFailure {
  reason: PersonaCardFailureReason;
  /** reason=http_status 时 Core 回的状态码。 */
  status?: number;
}

/** fetchCard 的返回值：成功是卡，失败是一份留因；undefined 归为 empty。 */
export type PersonaCardRead = PersonaCardSnapshot | PersonaCardFailure | undefined;

/**
 * 会话解析结果（task-32）。
 *
 * `source` 说明这个会话键从哪来：
 *  - context-agent：宿主拼提示词时把 agent 传给了 section getter；
 *  - none：拿不到，section 返回空串（**没有**「最近绑定会话」兜底）。
 *
 * `field` 进一步指出 agent 上命中的字段，第一轮真实运行就能看出宿主给的是
 * `agent.session.id`、`agent.sessionId` 还是 `agent.id`。
 */
export interface PersonaCardSession {
  sessionId: string;
  source: 'context-agent' | 'none';
  field: string;
}

export interface PersonaCardDeps {
  /** 总开关：Core 侧人格层上线后缺省 true；关掉时两条通道都不注册。 */
  enabled: boolean;
  fetchCard: (sessionId?: string) => Promise<PersonaCardRead>;
  /**
   * P2-C：带参数的取卡（优先于 `fetchCard`）。
   *
   * `sessionId` 交给 Core，由它反查该会话事件的 `persons_json` 决定过滤到谁；
   * `participants` 只在调用方**确实拿到 person_key** 时才传（插件不猜人名，
   * 传展示名的结果是被 Core 静默丢弃）。两者都缺省 = 不按人过滤，老行为不变。
   */
  fetchCardWithParams?: (params: {
    sessionId?: string;
    participants?: string[];
  }) => Promise<PersonaCardRead>;
  fetchTurn: (sessionId?: string) => Promise<PersonaTurnBlock | undefined>;
  timeoutMs: number;
  /**
   * task-13：卡进了前缀之后回报 Core（POST /v3/soul/injection 的 card 段）。
   * 只发 version/hash/chars，不发卡正文；fire-and-forget，抛错也吞掉。
   */
  reportInjection?: (payload: {
    card?: { version: number; hash: string; chars: number };
    /** A4：取卡失败也回报一行（只带原因），否则 Core 的 failReasons 永远是 null。 */
    failReason?: 'http_status' | 'timeout' | 'empty' | 'parse' | 'section_install_failed';
    failStatus?: number;
    sessionId?: string;
  }) => void;
  /**
   * 端到端证据日志（injection-log.ts）。由 section getter 在**宿主真正取文本时**
   * 触发。注意 `hash` 是**这一段**的 sha256，与整卡 `textHash` 不同；要证明「Core 渲染的
   * 这张卡被取走并注入」，看同行带上的 `cardHash`（= 整卡 textHash），它与同会话绑定行的
   * `card.hash` 同定义、可直接对账（Round28 / r28c-a4 纠正了这里旧的错误说法）。
   */
  injectionLog?: InjectionLog;
  /** 会话解析：从宿主传给 section getter 的 context 里取会话键（task-32）。 */
  resolveSession?: (context: unknown) => PersonaCardSession | undefined;
  log?: LoggerLike;
}

export interface PersonaCardHandle {
  /** 注册通道 A 的 section（order 由调用方按 head pack 偏移决定）。 */
  installSection: (ctx: AgememContext, order: number) => () => void;
  /**
   * 绑定：取该会话的卡并覆盖上一份。每次都调 fetchCard（无缓存）。
   * identity 为空 = 绑定到「不关联」，清空该会话的卡。
   */
  /** 绑定结果：ok=false 时调用方可以判「上游没准备好」并重试（empty 除外）。 */
  bind: (
    sessionId: string | undefined,
    identity?: string,
    /** 清卡归因：declined=用户选了否；unconfigured=没有可用身份（配置缺口）。 */
    clearedSource?: 'declined' | 'unconfigured',
  ) => Promise<PersonaCardBindOutcome>;
  /** 重取某个会话（缺省 = 最近绑定的会话），压缩后调用；走 bind 的同一路径。 */
  refresh: (sessionId?: string) => Promise<PersonaCardBindOutcome>;
  /**
   * 卡超过 maxAgeMs 就重新绑定（Round7 A4）：返回是否真的换了卡。
   * 没有卡/会话键/未到期一律 false；刷新失败保留旧卡（fail-open）。
   */
  refreshIfStale: (sessionId?: string, maxAgeMs?: number, now?: number) => Promise<boolean>;
  /**
   * 分支继承：把父会话那一份冻结卡**原样复制**给子会话（同一对象、字节相同、零网络）。
   *
   * 为什么是拷贝而不是重取（2026-11-08 决策）：分支共享父会话的历史，历史里已经有
   * 「我是 X」这类自述；重取一张不同的卡压不住那段历史，只多一次网络调用和一次
   * 「组装早于取卡」的竞态。同一段对话只该有一个人设 —— 换人设请新开会话。
   *
   * 父会话没有卡时返回 false，调用方按「按父身份重取」兜底（仍继承身份，不问人）。
   */
  inheritFrom: (parentSessionId: string | undefined, sessionId: string | undefined) => boolean;
  /** 指定会话的卡文本（诊断/测试用）；没有则空串。 */
  currentFor: (sessionId: string | undefined) => string;
  /** 当前持卡的会话数（诊断/测试用）。 */
  boundSessions: () => number;
  /** 通道 B：本轮的心境 + 未完的事，已裁到 400 字符；失败返回 ''。 */
  turnText: (sessionId?: string) => Promise<string>;
  /** §6：turn 文本 + 运行时状态，一次取回；每次调用都重新请求 Core。 */
  turnBlock: (sessionId?: string) => Promise<{ text: string; state?: PersonaTurnRuntimeState }>;
  /** 最近绑定会话的卡元数据（判据 14 的日志副本用）。 */
  snapshot: (sessionId?: string) => PersonaCardSnapshot | undefined;
  /**
   * A4（Round5）：回复侧写照——本轮助手输出里有多少行人格原文被 4-gram 覆盖 ≥50%。
   * 只上送计数，不证明因果；没有卡的会话返回全零。
   */
  usageProbe: (sessionId: string, text: string) => { matchedLines: number; totalLines: number; overlapPct: number };
}

type Timed<T> = { ok: true; value: T } | { ok: false };

/**
 * 与先前的 withTimeout 同语义，但**能区分**「超时」与「fetch 返回 undefined」：
 * 后者是 empty（Core 没设定），前者是 timeout。留因靠的就是这个区别。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), Math.max(1, timeoutMs));
  });
  return (async () => {
    try {
      return await Promise.race<Timed<T>>([
        promise.then((value) => ({ ok: true as const, value })),
        timeout,
      ]);
    } finally {
      // 必须等 race 有结果再清计时器：同步的 finally 会在计时器刚装上时就清掉它。
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
}

/** 单行裁断：通道 B 的文本本身是多行，但总字符上限按整块算。 */
function clampChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars)).trimEnd();
}

function asFailure(value: PersonaCardRead): PersonaCardFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('reason' in value)) return undefined;
  return value as PersonaCardFailure;
}

/** 某个会话当前那份卡（每会话一份；没有就是没绑定/已清空）。 */
interface FrozenCard {
  /** P1-2 身份段文本：进靠前的 section（`PERSONA_IDENTITY_ORDER`）。 */
  identityText: string;
  /** P1-2 末尾锚文本：进尾部 section（调用方给的 order）。空串 = 这段不注入。 */
  anchorText: string;
  /** 整卡文本：只留作诊断/回报，**不再**直接进提示词。 */
  text: string;
  version: number;
  hash: string;
  textHash: string;
  /** 绑定时用的身份三元组 `${team}/${user}/${agent}`；诊断用，不参与取卡。 */
  identity: string;
  /**
   * P2-C：这份卡是按哪组在场者过滤出来的（`sha256(persons.join(","))` 前 8 位）。
   * 只进日志 —— 事后要能分辨「两段取自不同在场者」与「Core 换了卡」。
   * 未过滤时为 undefined（老行为，不加字段）。
   */
  personsHash?: string;
  at: number;
}

export function createPersonaCard(deps: PersonaCardDeps): PersonaCardHandle {
  /** 每会话一份卡（task-32：一个会话不一定只有一个卡）。 */
  const cards = new Map<string, FrozenCard>();
  /** 每会话最近一次绑定的身份，压缩后重取时沿用。 */
  const identities = new Map<string, string>();
  /** 单飞：同一会话的并发 bind 等同一份结果。 */
  const inflight = new Map<string, Promise<PersonaCardBindOutcome>>();
  /** 一旦发现宿主没给会话键只 warn 一次（不刷屏，也不静默）。 */
  let warnedNoSession = false;

  const snapshotOf = (card: PersonaCardSnapshot | undefined): PersonaCardSnapshot | undefined => {
    if (card === undefined) return undefined;
    const text = typeof card.text === 'string' ? card.text.trim() : '';
    // 整卡为空但段还在（理论上的新 Core 形态）也算「有卡」：判空的唯一标准是
    // 「有没有可注入的字节」，不是「整卡长不长」。
    if (text === '' && segmentTextOf(card.identity) === '' && segmentTextOf(card.anchor) === '') return undefined;
    // 本地也算一份：Core 未带 textHash（旧版本）时，section-read 仍有可对账的 64 hex。
    const textHash = typeof card.textHash === 'string' && card.textHash !== '' ? card.textHash : sha256Hex(text);
    return { ...card, text, textHash };
  };

  /**
   * 两段的取值规则（P1-2）：
   *  - 新 Core：identity / anchor 各取各的段文本；
   *  - 旧 Core（两个字段都没有）：identity 退化成整卡、anchor 为空串 —— 老行为
   *    逐字不变，绝不因为加字段把注入弄没；
   *  - identity 空但 anchor 非空（半新 Core）：identity 返回空串**不注入占位**，
   *    anchor 照常注入；
   *  - 两段都空 = 「这个 agent 没有卡」，由调用方清掉该会话（与 card===undefined
   *    同义），留着上一份就是把上一个 agent 的人格塞进这个会话。
   */
  const cardSegments = (card: PersonaCardSnapshot): { identityText: string; anchorText: string } => {
    const identity = segmentTextOf(card.identity);
    const anchor = segmentTextOf(card.anchor);
    if (identity === '' && anchor === '') return { identityText: card.text, anchorText: '' };
    return { identityText: identity, anchorText: anchor };
  };

  /**
   * 失败留因（task-11）：只带 reason/status/ms 三个元数据字段。fail-open：
   * 注入失败不影响本轮对话——该会话保留上一份卡（冷启动就是没有卡），
   * 本函数只负责让日志说得清「为什么没取到」。
   *
   * 每个失败类别只 warn 一次（后续同类降为 debug）：反复失败时逐次 warn
   * 就是日志风暴，而根因并未变化。
   */
  const warned = new Set<string>();
  const warnFailure = (failure: PersonaCardFailure, started: number): void => {
    const payload = {
      reason: failure.reason,
      status: failure.status,
      ms: Date.now() - started,
    };
    const message = 'agemem: persona card bind failed; keeping the previous frozen text';
    const key = failure.reason + ':' + String(failure.status ?? '');
    if (warned.has(key)) {
      deps.log?.debug?.(message, payload);
      return;
    }
    warned.add(key);
    deps.log?.warn?.(message, payload);
  };

  /**
   * A4 Round10（CP1）：段是否真的注册进了系统提示词。
   *
   * 旧实现里 install 失败只 warn，而 reportCard 无条件按「两段都进」上报 chars，
   * 于是「人格根本没进 prompt」在 stats 里被记成「注入成功」（生产 session-p2c /
   * session-67dc6a54 就是 card-bound chars>0 而 section-read 恒 0）。这里记下
   * 每段的注册结果，报告时按真实注册情况算 chars，并在全失败时改报 failReason。
   */
  const registeredSections = new Set<string>();
  const failedSections = new Set<string>();
  // installSection 从未被调用时（单测、或宿主没装）保持旧行为：视为「没有注册信息」，
  // 不把 chars 打成 0，否则会把「没装 section」误报成「装了但失败」。
  let sectionsInstalled = false;
  const sectionRegistered = (name: string): boolean => !sectionsInstalled || registeredSections.has(name);

  /**
   * 回报「哪版卡进了前缀」（task-13）。纯观测面：抛错只降 debug。
   *
   * P1-2 口径变化：`chars` 是**实际注入的字符数** = identityText.length +
   * anchorText.length。旧口径是整卡长度 `card.text.length`；两段之后整卡里
   * 「关于你 / 自我史 / 自传 / 整卡的未完的事」这些中段块不再进提示词，所以
   * 数值会变小 —— 而变小后的数才是真的注入量。`hash` 仍是 Core 的**整卡**
   * hash（= GET /v3/soul/card 的 textHash），便于对回 Core 的快照；两段各自的
   * hash 走 section-read 行（sha256(段文本)），不在这里报。
   */
  /** 这一份卡真正会进提示词的字符数：只算注册成功的段（没注册信息时按全部算）。 */
  const injectedCharsOf = (identityText: string, anchorText: string): number =>
    (sectionRegistered(PERSONA_IDENTITY_SECTION_NAME) ? identityText.length : 0) +
    (sectionRegistered(PERSONA_ANCHOR_SECTION_NAME) ? anchorText.length : 0);

  const reportCard = (card: PersonaCardSnapshot, identityText: string, anchorText: string, sessionId?: string): void => {
    const chars = injectedCharsOf(identityText, anchorText);
    try {
      // 零字节绑定不是「注入成功」。
      //
      // A4 Round13 复核：生产 3543 条 card-bound 里有 3343 条 chars=0（Core 回空串/卡字段缺失），
      // 过去一律记成 card-bound，stats 的 cardBound 因此把「什么都没进提示词」算成成功。
      // 现在统一改报 failReason：段注册失败 → section_install_failed；其余（空卡/空段）→ empty。
      if (chars === 0) {
        deps.reportInjection?.({
          failReason: failedSections.size > 0 ? 'section_install_failed' : 'empty',
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        return;
      }
      deps.reportInjection?.({
        card: {
          version: card.version,
          hash: card.textHash,
          chars,
        },
        // 会话键一起带出去：Core 的 /v3/soul/injection 是从请求头取身份三元组的，
        // 少了 sessionId 就退到挂载三元组（桌面端常常是空），整条回报被 422 吞掉。
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    } catch {
      deps.log?.debug?.('agemem: card injection report threw; ignored (fail-open)');
    }
  };

  const bindOnce = async (
    sessionId: string,
    identity: string | undefined,
    previous: FrozenCard | undefined,
    // 清卡原因（r26d-a1）：调用方分得清「用户在会话开始选了否」（declined）与
    // 「这套部署没装配身份 / 三元组为空」（unconfigured）。两者都清卡，但归因不同：
    // 前者是用户的决定，后者是配置缺口的症状。旧实现把 null 与 undefined 塌成一个事件，
    // 面板会把「没配身份」说成「用户主动不关联」。
    clearedSource?: 'declined' | 'unconfigured',
  ): Promise<PersonaCardBindOutcome> => {
    const started = Date.now();
    // 绑定到「不关联」：清掉该会话的卡，后面的 turn 不再注入人格。
    if (identity === undefined || identity === '') {
      // Round26（按用户指正重判）：空三元组不是「拿不到身份」——它是会话开始时用户选的
      // 「否，本次不关联」（session-identity 写入空绑定）。这是**决定**，不是取卡失败。
      //
      // 旧实现每次都记一行 `card-bound chars:0`，而没卡的会话每个 pre-step 都会再绑一次：
      // 生产 2026-11-19 单个不关联会话刷了 1010 行，stats 的 cardBoundEmpty 因此被「主动退出」
      // 灌满，看起来像注入坏了。现在只在状态真的从「有卡/未知」变「不关联」时记一行
      // card-cleared，重复绑定静默返回。
      const alreadyUnbound = identities.get(sessionId) === '';
      cards.delete(sessionId);
      identities.set(sessionId, '');
      if (!alreadyUnbound) {
        recordInjection(deps.injectionLog, {
          event: 'card-cleared',
          sessionId,
          chars: 0,
          reason: clearedSource === 'unconfigured' ? 'unconfigured' : 'unassociated',
          ...(clearedSource === undefined ? {} : { source: clearedSource }),
        });
        deps.log?.info?.('agemem: persona card cleared (session unassociated)', { sessionId });
      }
      return { ok: true };
    }
    // P2-C：有带参版本就用它（把会话键交给 Core，由 Core 反查在场者）。
    // 这里**不**传 participants：插件没有可靠的 person_key 来源，传展示名会被
    // Core 丢弃、传空串在 Core 的语义是「只剩全局行」——两者都会把卡切错。
    const fetched = deps.fetchCardWithParams !== undefined
      ? deps.fetchCardWithParams({ sessionId })
      : deps.fetchCard(sessionId);
    const outcome = await withTimeout(fetched, deps.timeoutMs);
    if (!outcome.ok) {
      failBind(sessionId, { reason: 'timeout' }, previous, started, identity);
      return { ok: false, reason: 'timeout' };
    }
    const failure = asFailure(outcome.value);
    if (failure !== undefined) {
      failBind(sessionId, failure, previous, started, identity);
      return { ok: false, reason: failure.reason };
    }
    const card = snapshotOf(outcome.value as PersonaCardSnapshot | undefined);
    const segments = card === undefined ? { identityText: '', anchorText: '' } : cardSegments(card);
    // P2-C：这份卡按哪组在场者过滤（Core 的 `persons` 三态原样保留）。
    // 空数组也有意义（「只剩全局行」），所以只把 undefined 当「不过滤」。
    const persons = card?.persons;
    const personsHash =
      persons !== undefined && persons.length > 0
        ? sha256Hex(persons.join(',')).slice(0, 8)
        : undefined;
    // 两段都空 = 这个 agent 没有可注入的东西。对今天的 Core 它与 card===undefined
    // 同义（snapshotOf 已经拒掉空整卡），这里显式再判一次：将来 Core 若只带空段、
    // 整卡还有中段块，也不能把「没有身份的文」当卡留下来。
    if (card === undefined || (segments.identityText === '' && segments.anchorText === '')) {
      // 「这个 agent 没有卡」是一个**答案**，不是一个故障：留着上一份就是
      // 把上一个 agent 的人格塞给这个会话（串卡）。所以这里清空。
      cards.delete(sessionId);
      identities.set(sessionId, identity);
      // A4 Round13（CP1）：零字节绑定不能再记成 card-bound。生产 3543 条 card-bound 里
      // 3343 条是这条路径写出来的（Core 回空卡/只剩中段块），stats 的 cardBound 因此
      // 把「什么都没进提示词」算成注入成功。改成独立事件 + 上报 failReason=empty。
      recordInjection(deps.injectionLog, {
        event: 'card-empty',
        sessionId,
        identity,
        chars: 0,
      });
      deps.reportInjection?.({
        failReason: 'empty',
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      deps.log?.info?.('agemem: persona card empty for this agent; session cleared', { sessionId, identity });
      return { ok: true };
    }
    // 原子替换（task-32）：整对象一次换掉并冻结，别的会话并发 assemble 时
    // 要么看到旧值要么看到新值，不会读到「文本换了、版本还没换」的半更新卡。
    // P1-2：两段文本在绑定时就算好（旧 Core 时 identityText = 整卡、anchorText=''），
    // getter 只读不算，保证同一份卡的任何一次 assemble 拿到同样的字节。
    cards.set(sessionId, Object.freeze({
      identityText: segments.identityText,
      anchorText: segments.anchorText,
      text: card.text,
      version: card.version,
      hash: card.hash,
      textHash: card.textHash,
      identity,
      ...(personsHash === undefined ? {} : { personsHash }),
      at: Date.now(),
    }));
    identities.set(sessionId, identity);
    const injectedChars = injectedCharsOf(segments.identityText, segments.anchorText);
    // 判据 14：Core 与插件日志各一份「哪版卡 version/hash」。只记元数据。
    // `chars` 仍是整卡长度（快照大小）；`injected` 才是两段实际进提示词的字符数。
    deps.log?.info?.('agemem: soul.sessionInit', {
      version: card.version,
      hash: card.hash.slice(0, 12),
      chars: card.text.length,
      injected: injectedChars,
      replaced: previous !== undefined,
      // P2-C：这张卡按哪组在场者过滤；不过滤时不出现这两个字段。
      ...(persons === undefined ? {} : { persons: persons.length }),
      ...(personsHash === undefined ? {} : { personsHash }),
    });
    recordInjection(deps.injectionLog, {
      event: 'card-bound',
      sessionId,
      identity,
      version: card.version,
      hash: card.textHash,
      chars: injectedChars,
    });
    reportCard(card, segments.identityText, segments.anchorText, sessionId);
    // persons 只在这张卡真的按人过滤过时回传；不过滤时整个字段不出现（老形状不变）。
    return persons === undefined ? { ok: true } : { ok: true, persons };
  };

  const failBind = (
    sessionId: string,
    failure: PersonaCardFailure,
    previous: FrozenCard | undefined,
    started: number,
    identity: string | undefined,
  ): void => {
    warnFailure(failure, started);
    // 失败保留该会话上一份（上一份也可能是另一个 agent 绑过又被清空的空）。
    recordInjection(deps.injectionLog, {
      event: 'card-bound-failed',
      sessionId,
      identity: identity ?? identities.get(sessionId),
      version: previous?.version,
      hash: previous?.textHash,
      chars: previous?.text.length ?? 0,
      reason: failure.reason,
      ...(failure.status === undefined ? {} : { failStatus: failure.status }),
      keptVersion: previous?.version,
    });
    // A4：同一个原因再回报 Core 一份（只带元数据），让 /v3/soul/injection/stats
    // 的 failReasons 能看到「这一轮取卡失败了」，而不是只能读插件本地 jsonl。
    deps.reportInjection?.({
      failReason: failure.reason,
      ...(failure.status === undefined ? {} : { failStatus: failure.status }),
      sessionId,
    });
  };

  const bind = async (
    sessionId: string | undefined,
    identity?: string,
    clearedSource?: 'declined' | 'unconfigured',
  ): Promise<PersonaCardBindOutcome> => {
    if (!deps.enabled) return { ok: true };
    if (sessionId === undefined || sessionId === '') {
      deps.log?.debug?.('agemem: persona card bind skipped (no session key)');
      return { ok: true };
    }
    const running = inflight.get(sessionId);
    if (running !== undefined) {
      // 同一会话并发绑定（pre-step 与 ensureIdentity 撞车）：等同一份结果，
      // 后到的 identity 不覆盖先到的——覆盖语义只在「下一次显式绑定」生效。
      return await running;
    }
    const previous = cards.get(sessionId);
    const task = (async (): Promise<PersonaCardBindOutcome> => {
      try {
        return await bindOnce(sessionId, identity, previous, clearedSource);
      } catch (error) {
        // fetchCard 的契约是「不抛」（memory-client 把失败折成留因）。真抛了
        // 说明是接线/协议问题：归 http_status（无 status）。**不打印 error 本体**。
        const status = (error as { status?: unknown } | undefined)?.status;
        failBind(
          sessionId,
          { reason: 'http_status', status: typeof status === 'number' ? status : undefined },
          previous,
          Date.now(),
          identity,
        );
        return { ok: false, reason: 'http_status' };
      } finally {
        inflight.delete(sessionId);
      }
    })();
    inflight.set(sessionId, task);
    return await task;
  };

  /**
   * 分支继承：把父会话的冻结卡原样复制给子会话。
   *
   * 只复制对象引用 —— 冻结卡本身是 Object.freeze 过的，父子共享同一份字节，
   * 所以「分支第一步的系统提示词与父会话逐字节相同」是结构保证，不是比对结果。
   * 不上报 Core（没有新的取卡事实），但必须在本机日志留一行，否则事后无法区分
   * 「继承了父卡」与「压根没取到卡」。
   */
  const inheritFrom = (parentSessionId: string | undefined, sessionId: string | undefined): boolean => {
    if (typeof parentSessionId !== 'string' || parentSessionId === '') return false;
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    if (parentSessionId === sessionId) return false;
    const card = cards.get(parentSessionId);
    if (card === undefined) return false;
    cards.set(sessionId, card);
    const identity = identities.get(parentSessionId);
    if (identity !== undefined) identities.set(sessionId, identity);
    recordInjection(deps.injectionLog, {
      event: 'card-inherited',
      sessionId,
      parentSessionId,
      version: card.version,
      hash: sha256Hex(card.identityText + card.anchorText).slice(0, 16),
      chars: card.identityText.length + card.anchorText.length,
    });
    return true;
  };

  const refresh = async (sessionId?: string): Promise<PersonaCardBindOutcome> => {
    // 没有显式会话键就没有对象可刷新：不拿「最近一个会话」顶替（会串卡）。
    if (sessionId === undefined || sessionId === '') return { ok: true };
    // r26e-a5：生产 08:16:13Z 有一条 card-cleared 没有 source —— 它不是「旧 bundle 还在跑」，
    // 而是这条 refresh 路径只传 identity、不传归因，于是 alreadyUnbound 为假时落了一行
    // reason=unassociated 却无从知道为什么。修法是让 refresh 根本走不到清卡分支：
    // 没有卡、身份也为空/未知时，这里没有可刷新的东西，直接返回（不复用「上次归因」——
    // 那条路实测是死代码：cards 与 identity==='' 互斥，refresh 能进 bind 时 alreadyUnbound 必为真）。
    const knownIdentity = identities.get(sessionId);
    if ((knownIdentity === undefined || knownIdentity === '') && cards.get(sessionId) === undefined) return { ok: true };
    return bind(sessionId, identities.get(sessionId));
  };

  const refreshIfStale = async (sessionId?: string, maxAgeMs = PERSONA_REFRESH_MS, now = Date.now()): Promise<boolean> => {
    if (sessionId === undefined || sessionId === '') return false;
    const card = cards.get(sessionId);
    if (card === undefined) return false;
    const age = now - card.at;
    if (!(maxAgeMs > 0) || age < maxAgeMs) return false;
    const outcome = await refresh(sessionId);
    return outcome.ok;
  };

  /**
   * section 读取去重（P1-2）：**按「会话 + 段」各记一份**。
   *
   * 宿主每个 step 都会取一次文本。旧实现只有一组 `lastSectionKey/At`，两段共用
   * 时 anchor 的 miss 会把刚记下的 identity 顶掉（反之亦然），日志里就永远只看
   * 得到最后被取的那一段。这里键里带 section，两段互不影响；值里带 hash+长度，
   * 所以「同一段同一内容」才去重，内容一变立刻记一行。
   */
  type SectionName = 'identity' | 'anchor';
  const sectionMarks = new Map<string, { key: string; at: number }>();
  const shouldRecordSection = (sessionKey: string, section: SectionName, contentKey: string): boolean => {
    const markKey = sessionKey + '|' + section;
    const now = Date.now();
    const last = sectionMarks.get(markKey);
    if (last !== undefined && last.key === contentKey && now - last.at < SECTION_READ_HEARTBEAT_MS) return false;
    // 会话一多这张表会无界长：过 256 条就整表清掉（最坏只是多记几行 section-read）。
    if (sectionMarks.size > 256 && last === undefined) sectionMarks.clear();
    sectionMarks.set(markKey, { key: contentKey, at: now });
    return true;
  };

  /**
   * 一段的 getter（P1-2）。纪律不变：拿不到会话键就返回 `''`，**没有**「最近绑定
   * 会话」兜底；没有卡、或这一段是空的，也返回 `''`（不注入空段占位）。
   */
  const sectionTextOf = (section: SectionName, pick: (card: FrozenCard) => string) => (context?: unknown): string => {
    const resolved = deps.resolveSession?.(context);
    const sessionId = resolved?.sessionId;
    if (sessionId === undefined || sessionId === '') {
      // 宿主没给会话键：这里一律不注入。任何「最近绑定会话」的兜底都会在
      // 并发会话下把 A 的卡塞进 B 的提示词——那正是要修的 bug。
      if (!warnedNoSession) {
        warnedNoSession = true;
        // 宿主给 Agent 的 text 一定带 `agent.id === sessionId`；这里为空
        // 只意味着宿主换了 API——warn 一次，别每 step 刷屏。
        deps.log?.warn?.('agemem: persona card section got no session id from the host context; injecting nothing');
      }
      if (shouldRecordSection('none', section, 'none')) {
        recordInjection(deps.injectionLog, {
          event: 'section-read',
          section,
          chars: 0,
          sidSource: 'none',
          sidField: 'none',
        });
      }
      return '';
    }
    const sidSource: PersonaCardSession['source'] = resolved?.source ?? 'none';
    const sidField = resolved?.field ?? 'none';
    const card = cards.get(sessionId);
    if (card === undefined) {
      // 会话键对上了、卡还没绑定完：**必须留痕**。静默返回空串正是
      // 「看着都像没注入」却查不出原因的位置——这里记下宿主给的会话键。
      if (shouldRecordSection(sessionId, section, 'no-card')) {
        recordInjection(deps.injectionLog, {
          event: 'section-read',
          section,
          sessionId,
          chars: 0,
          reason: 'no-card',
          sidSource,
          sidField,
          boundCount: cards.size,
          knownSessions: [...cards.keys()].slice(0, 3).join(','),
        });
      }
      return '';
    }
    const text = pick(card);
    if (text === '') {
      // 空段不注入占位：identity 空而 anchor 非空时，提示词里只有 anchor 一行。
      if (shouldRecordSection(sessionId, section, 'empty-segment')) {
        recordInjection(deps.injectionLog, {
          event: 'section-read',
          section,
          sessionId,
          identity: card.identity,
          version: card.version,
          chars: 0,
          reason: 'empty-segment',
          sidSource,
          sidField,
          via: 'getter',
        });
      }
      return '';
    }
    // hash 用该段自己的 sha256（与 Core 段 hash 同算法），chars 是该段长度：
    // 两段各自独立对账，不靠整卡 hash 反推。
    const segmentHash = sha256Hex(text);
    if (shouldRecordSection(sessionId, section, segmentHash + '|' + String(text.length))) {
      recordInjection(deps.injectionLog, {
        event: 'section-read',
        section,
        sessionId,
        identity: card.identity,
        version: card.version,
        hash: segmentHash,
        // Round28（r28c-a4）：整卡 hash 与段 hash 一起记，proof 才有同定义可比的对象。
        chars: text.length,
        cardHash: card.textHash,
        sidSource,
        sidField,
        // task-34：卡在 agent/created 就位，宿主来取时必然已在手。
        via: 'getter',
      });
    }
    return text;
  };

  const installSection = (ctx: AgememContext, order: number): (() => void) => {
    if (!deps.enabled) return () => {};
    sectionsInstalled = true;
    const installed: Array<() => void> = [];
    const install = (name: string, sectionOrder: number, text: (context?: unknown) => string): void => {
      try {
        installed.push(ctx.systemPrompt.section({ name, order: sectionOrder, interpolate: false, text }));
        registeredSections.add(name);
      } catch (error) {
        // A4 Round10（CP1）：注册失败必须留下可查的痕迹——本地日志一行 + 回报 Core
        // 一次 failReason。宿主拒绝装 section 时，「人格在提示词里吗」的答案是「不在」，
        // 这个答案不能只靠人去看 warn。
        failedSections.add(name);
        recordInjection(deps.injectionLog, {
          event: 'section-install-failed',
          section: name === PERSONA_ANCHOR_SECTION_NAME ? 'anchor' : 'identity',
          chars: 0,
          reason: 'section_install_failed',
        });
        deps.log?.warn?.(`agemem: persona section ${name} registration failed; continuing without it`, error);
      }
    };
    // 身份段：**固定 1**（PERSONA_IDENTITY_ORDER，不是配置键）。Letta 把 persona
    // 块前置、Instruction Hierarchy 认为越靠前优先级越高；宿主 harness:identity 在
    // −1000、部署人格前缀 DEPLOYMENT_PERSONA_PREFIX 在 0，故取 1 —— 紧跟部署人格、
    // 早于 WORKING_DIRECTORY=100 / SANDBOX_POLICY=110 / APPROVAL_POLICY=115 /
    // SUBAGENT_DELEGATION=120 / TEAM_IDENTITY=125，远早于 PLAN_POLICY=500。
    install(PERSONA_IDENTITY_SECTION_NAME, PERSONA_IDENTITY_ORDER, sectionTextOf('identity', (card) => card.identityText));
    // 末尾锚：沿用调用方给的尾部 order（base + orderOffset + 2）—— 这是「历史
    // 之后仍要保留的提醒」，对应 character-card-spec-v2 的 post_history_instructions。
    install(PERSONA_ANCHOR_SECTION_NAME, order, sectionTextOf('anchor', (card) => card.anchorText));
    // 每个 installSection 调用最多回报一次：两段都失败时没必要发两行同样的原因，
    // 逐段证据在本地 jsonl 的 section-install-failed 行里。
    if (failedSections.size > 0) deps.reportInjection?.({ failReason: 'section_install_failed' });
    return () => {
      for (const dispose of installed) {
        try {
          dispose();
        } catch {
          // 摘一个 section 失败不该拦住另一个：这里的失手只影响卸载干净度。
        }
      }
    };
  };

  /**
   * §6：text 与运行时状态一起返回，且**每次重新取**——缓存只允许缓存记忆段。
   * 状态缺失（Core 旧版本）时与改前逐字一致：只有 clamped text。
   */
  const turnBlock = async (sessionId?: string): Promise<{ text: string; state?: PersonaTurnRuntimeState }> => {
    if (!deps.enabled) return { text: '' };
    try {
      const outcome = await withTimeout(deps.fetchTurn(sessionId), deps.timeoutMs);
      if (!outcome.ok) {
        recordInjection(deps.injectionLog, { event: 'turn-skip', sessionId, chars: 0, reason: 'turn-timeout' });
        deps.log?.debug?.('agemem: soul turn block unavailable', { reason: 'timeout' });
        return { text: '' };
      }
      const turn = outcome.value;
      const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
      const clamped = text === '' ? '' : clampChars(text, PERSONA_TURN_MAX_CHARS);
      if (clamped !== '') {
        deps.log?.debug?.('agemem: soul.turnChars', { chars: clamped.length, openLoops: turn?.openLoops?.length ?? 0 });
      }
      // text 与 state 解耦：Core 不再输出心境行时，状态段仍要能注入（第二轮评审 MINOR）。
      const state = turn?.state === undefined ? {} : { state: turn.state };
      return { text: clamped, ...state };
    } catch (error) {
      recordInjection(deps.injectionLog, { event: 'turn-skip', sessionId, chars: 0, reason: 'turn-error' });
      deps.log?.debug?.('agemem: soul turn block unavailable', error);
      return { text: '' };
    }
  };

  const shingles = (s: string, n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
    return out;
  };

  /**
   * A4（Round5）：回复侧词面写照——本轮助手输出里，有多少行人格原文被 4-gram 覆盖 ≥50%。
   * 只用来回答「注入了却完全没人用」的最坏情况；不证明因果，也不参与任何注入决策。
   */
  const usageProbe = (sessionId: string, text: string): { matchedLines: number; totalLines: number; overlapPct: number } => {
    const card = cards.get(sessionId);
    if (card === undefined || text.trim() === '') return { matchedLines: 0, totalLines: 0, overlapPct: 0 };
    const lines = `${card.identityText}\n${card.anchorText}`
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s>*#\-–—·\d.、)（(]+/u, '').trim())
      .filter((line) => line.length >= 6 && !line.startsWith('<') && !line.startsWith('/'));
    const hay = text.replace(/\s+/gu, '');
    let matchedLines = 0;
    for (const line of lines) {
      const grams = shingles(line.replace(/\s+/gu, ''), 4);
      if (grams.length === 0) continue;
      const hit = grams.filter((gram) => hay.includes(gram)).length;
      if (hit / grams.length >= 0.5) matchedLines += 1;
    }
    const totalLines = lines.length;
    return {
      matchedLines,
      totalLines,
      overlapPct: totalLines === 0 ? 0 : Math.round((matchedLines / totalLines) * 1000) / 10,
    };
  };

  const turnText = async (sessionId?: string): Promise<string> => (await turnBlock(sessionId)).text;

  return {
    installSection,
    bind,
    inheritFrom,
    refresh,
    refreshIfStale,
    currentFor: (sessionId?: string) => sessionId === undefined || sessionId === '' ? '' : (cards.get(sessionId)?.text ?? ''),
    /** 装了多少会话的卡（诊断用；并发会话验证要能看「各自一份」）。 */
    boundSessions: () => cards.size,
    turnText,
    turnBlock,
    usageProbe,
    snapshot: (sessionId?: string) => {
      const sid = sessionId;
      if (sid === undefined || sid === '') return undefined;
      const card = cards.get(sid);
      if (card === undefined) return undefined;
      return {
        version: card.version,
        hash: card.hash,
        textHash: card.textHash,
        text: card.text,
        chars: card.text.length,
        dirty: false,
        // 两段各自的可注入文本（诊断用）：旧 Core 下 identity = 整卡、anchor = ''。
        identity: { text: card.identityText },
        anchor: { text: card.anchorText },
      };
    },
  };
}