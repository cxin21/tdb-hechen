/**
 * P7 输出侧：一次成功回合的助手输出 → POST /v3/soul/gate（stage=output）。
 *
 * 为什么单独成模块：哪些回合该发、文本怎么裁、同一轮怎么只发一次，都是纯函数，
 * 能单测、不依赖宿主；index.ts 只负责「什么时候发」（L0 写回成功之后，见那里的
 * reportSoulGate 与 Outbox deliver 里的调用点）。
 *
 * 合同照抄 MemoryCore/src/gateway/soul-gate-endpoint.ts（不是猜的）：
 *  - POST /v3/soul/gate（:35），body 只读 text / stage / audience / persons / eventId；
 *  - text 空 → 400，text 长度上限 SOUL_GATE_MAX_TEXT_CHARS = 20000（:38），超了整条 400；
 *  - stage 缺省即 output（:240），显式带上，不靠 Core 的默认值；
 *  - 租户三元组只走 x-tdai-* 头（缺一 422，:192-203），body 里不带。
 *
 * shadow 期三条纪律：
 *  1. 只记不拦：Core 在 shadow 下恒回 decision=allow（endpoint :269 / :294-314），
 *     插件**不得**据此改写、截断或丢弃这一轮的输出；
 *  2. 不落原文到日志：判定结果不回灌模型，失败日志只报路由与状态码，不带 text；
 *  3. 一回合一次、失败不重投：不塞 Outbox（那会把正文写进死信文件）。
 */
import type { TurnEndPayload } from './memory-client.js';

/** Core 的 gate 路由（soul-gate-endpoint.ts:35）。 */
export const SOUL_GATE_PATH = '/v3/soul/gate';

/**
 * Core 的 text 上限（soul-gate-endpoint.ts:38）。超长不是「被截断」而是整条 400，
 * 所以插件先截再发：宁可少判尾部，也不让整轮判定丢掉。
 */
export const SOUL_GATE_MAX_TEXT_CHARS = 20_000;

/** POST /v3/soul/gate 的 body。可选字段「有则带、无则整个键不出现」，不填空串。 */
export interface SoulGateReportPayload {
  /** 这一轮助手真正落地的输出（已按 Core 上限裁剪）。 */
  text: string;
  stage: 'output';
  /**
   * 会话标识。同一值也走 x-tdai-session-id 头（Core 的会话口径就是那个头），
   * body 里再带一份是为了让「这条判定属于哪一轮」在审计侧自解释——
   * Core 的 gate 路由目前不读它，多一个未知字段不影响解析。
   */
  sessionId?: string;
  /** 这条输出依附的真实 soul 事件 id；拿不到就省略，绝不伪造一个。 */
  eventId?: string;
}

/** plugin 侧从应答里取出的最小事实（decision 一律不可用于改写输出）。 */
export interface SoulGateOutcome {
  ok: boolean;
  status?: number;
  reason?: string;
  /** Core 的判定：shadow 期恒为 allow。**只用于日志**。 */
  decision?: string;
  /** 是否处于 shadow（当前恒 true）。 */
  shadow?: boolean;
  /** soul_gate_log 是否新插入了一行（重放时 false）。 */
  logged?: boolean;
}

/**
 * 从 Core 应答里读「这一条真落库了吗」。
 *
 * Core 回的是 logged: { inserted: <number> }——gate 路由把 INSERT OR IGNORE 的
 * 行数原样带出（1=新插入、0=重放已有），不是布尔。早期插件按 inserted === true 判，
 * 于是 debug 日志里恒 false（t30 F1）。这里按真实形状判：数值 > 0 才算落库；
 * 布尔则原样接受（兼容历史替身实现），其它一律 undefined（不知道就别假装知道）。
 */
export function loggedFromCoreResult(logged: unknown): boolean | undefined {
  if (typeof logged === 'boolean') return logged;
  if (typeof logged !== 'object' || logged === null) return undefined;
  const inserted = (logged as { inserted?: unknown }).inserted;
  if (typeof inserted === 'number') return inserted > 0;
  if (typeof inserted === 'boolean') return inserted;
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 一次回合收口 → 一条输出侧判定请求；不该发的回合返回 undefined。
 *
 * 三种不发：
 *  - 不是成功回合：失败/中断的输出是半截的，下一轮很可能重写同一段，
 *    这时判「越权/虚报」只会制造误杀（而且 shadow 期也不会有人去纠正它）；
 *  - 没有助手正文：没有可判的东西，空 text 会被 Core 直接 400；
 *  - 正文纯空白：同上。
 */
export function toSoulGateReport(
  payload: TurnEndPayload | undefined,
  options: { eventId?: string } = {},
): SoulGateReportPayload | undefined {
  if (payload === undefined || payload === null) return undefined;
  if (payload.status !== 'completed') return undefined;
  const assistantText = typeof payload.assistantText === 'string' ? payload.assistantText.trim() : '';
  if (assistantText === '') return undefined;
  const text = assistantText.slice(0, SOUL_GATE_MAX_TEXT_CHARS);
  const sessionId = nonEmpty(payload.sessionId);
  const eventId = nonEmpty(options.eventId);
  return {
    text,
    stage: 'output',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(eventId === undefined ? {} : { eventId }),
  };
}

/**
 * 同一轮判一次的键：`<sessionId>:<turnId>`（没有 sessionId 时退化成 turnId）。
 * turnId 都没有就返回 undefined —— 没有稳定键的回合不做本地去重，
 * 宁可多记一条审计行，也不把两个不同回合误判成同一次。
 */
export function soulGateDedupeKey(payload: TurnEndPayload | undefined): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  const turn = nonEmpty(payload.turnId);
  if (turn === undefined) return undefined;
  const session = nonEmpty(payload.sessionId);
  return session === undefined ? turn : session + ':' + turn;
}

/**
 * firstSeen(key) → 首次 true、之后 false。有界（超出上限先丢最旧的键）。
 *
 * 为什么插件也要去重：outbox 对同一 turnId 只有一行、投递成功即删除，
 * 正常路径本来只投一次；真正会重复的是「投递成功但进程在半路崩掉」这种重放，
 * 以及宿主重复发 turn-stopping。去重键放在这里，一遍就读得懂，也测得动。
 */
export function createSoulGateOnce(limit = 256): (key: string) => boolean {
  const seen = new Set<string>();
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 256;
  return (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > cap) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  };
}
