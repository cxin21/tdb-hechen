/**
 * R1（2026-11-07）：POST /v3/soul/injection —— 插件回传「本轮实际注入了什么」。
 *
 * 解决的问题：召回日志里 `soul.sessionInit/turnChars` 是 Core 侧**估算**
 * （读落库快照 meta + 现场再渲染一次），与插件真正拼进 prompt 的字节不等：
 *   - volatile 块被 `<soul-feeling>` 等包裹后比内文多 30+ 字符；
 *   - 相同文本 3 轮内插件直接 skip，日志却照记字符数；
 *   - 卡在会话中途改版时，日志记新版本、模型看旧版本。
 *
 * 合同：
 *   - 只收 **长度与指纹**，绝不上送卡正文/注入正文/token（本条是隐私边界，勿放宽）；
 *   - best-effort：任何字段异常都只 400/忽略，不阻塞会话；写日志失败也不报错；
 *   - 与召回行同文件、同轮转，靠 `kind:"injection"` 区分，用 `sessionKey + turn` 关联。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecallJournalInjection, RecallJournalOpts } from "../core/recall/recall-journal.js";
import { appendRecallJournalInjection } from "../core/recall/recall-journal.js";

export const SOUL_INJECTION_PATH = "/v3/soul/injection";

export interface SoulInjectionRouteDeps {
  /** 与 auto-recall 同源：`<dataDir>/logs/recall`。 */
  journalDir: string;
  journalOpts: RecallJournalOpts;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

function asString(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return undefined;
  return trimmed;
}

function asCount(value: unknown, max = 10_000_000): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.floor(n);
}

function asHash(value: unknown): string | undefined {
  const s = asString(value, 128);
  return s && /^[0-9a-zA-Z._-]+$/.test(s) ? s : undefined;
}

function asCard(value: unknown): RecallJournalInjection["card"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const version = asCount(v.version, 1_000_000);
  const hash = asHash(v.hash);
  const chars = asCount(v.chars);
  if (version === undefined || hash === undefined || chars === undefined) return undefined;
  return { version, hash, chars };
}

function asVolatile(value: unknown): RecallJournalInjection["volatile"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const chars = asCount(v.chars);
  const hash = asHash(v.hash);
  const skipped = v.skipped === true;
  if (chars === undefined || hash === undefined) return undefined;
  return { chars: skipped ? 0 : chars, hash, skipped };
}

/** A4（Round5）：回复侧写照的字段白名单（计数，不含正文）。 */
function asUsage(value: unknown): RecallJournalInjection["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const matchedLines = asCount(v.matchedLines, 100_000);
  const totalLines = asCount(v.totalLines, 100_000);
  const overlapRaw = typeof v.overlapPct === "number" && Number.isFinite(v.overlapPct) ? v.overlapPct : undefined;
  if (matchedLines === undefined || totalLines === undefined || overlapRaw === undefined) return undefined;
  return { matchedLines, totalLines, overlapPct: Math.max(0, Math.min(100, Math.round(overlapRaw * 10) / 10)) };
}

// A4 Round10（CP1）：section_install_failed 是「人格段没能注册进系统提示词」，
// 与取卡失败并列上报。Round11 起 stats 的 failReasons 里它单列一桶（面板按桶判红），
// 插件本地的 plugin.byReason 仍按四类 + other 统计。
const FAIL_REASONS = ["http_status", "timeout", "empty", "parse", "section_install_failed"] as const;

/** A4：插件上报的失败原因（与 stats 的 FAIL_REASONS 同名，避免两侧各写一套字面量）。 */
function asFailReason(value: unknown): RecallJournalInjection["failReason"] {
  const s = asString(value, 32);
  return s !== undefined && (FAIL_REASONS as readonly string[]).includes(s)
    ? (s as RecallJournalInjection["failReason"])
    : undefined;
}

function asPhase(value: unknown, hasCard: boolean, hasVolatile: boolean, hasUsage: boolean): RecallJournalInjection["phase"] {
  const explicit = asString(value, 16);
  if (explicit === "card" || explicit === "volatile" || explicit === "mixed" || explicit === "usage") return explicit;
  // 旧版插件不带 phase：按在场字段推断（两边都在 = mixed，理论上不该出现）。
  if (hasCard && hasVolatile) return "mixed";
  if (hasCard) return "card";
  if (hasVolatile) return "volatile";
  if (hasUsage) return "usage";
  return undefined;
}

export async function handleSoulInjectionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: IncomingMessage) => Promise<T>,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  deps: SoulInjectionRouteDeps,
): Promise<boolean> {
  if (pathname !== SOUL_INJECTION_PATH) return false;
  if (method !== "POST") {
    sendJson(res, 405, { code: 405, message: "method_not_allowed" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(req);
  } catch {
    sendJson(res, 400, { code: 400, message: "bad_json" });
    return true;
  }
  const team = asString(body?.team, 128);
  if (!team) {
    sendJson(res, 400, { code: 400, message: "missing_team" });
    return true;
  }
  const card = asCard(body?.card);
  const volatile = asVolatile(body?.volatile);
  const failReason = asFailReason(body?.failReason);
  const usage = asUsage(body?.usage);
  if (!card && !volatile && failReason === undefined && usage === undefined) {
    sendJson(res, 400, { code: 400, message: "empty_injection" });
    return true;
  }
  const user = asString(body?.user, 128);
  const agent = asString(body?.agent, 128);
  const sessionKey = asString(body?.sessionKey, 400);
  const turnRaw = body?.turn;
  const turn = typeof turnRaw === "number" && Number.isFinite(turnRaw) ? Math.floor(turnRaw) : null;
  const phase = asPhase(body?.phase, card !== undefined, volatile !== undefined, usage !== undefined);
  const entry: RecallJournalInjection = {
    kind: "injection",
    ts: (deps.now?.() ?? new Date()).toISOString(),
    teamId: team,
    ...(user ? { userId: user } : {}),
    ...(agent ? { agentId: agent } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    turn,
    ...(card ? { card } : {}),
    ...(volatile ? { volatile } : {}),
    ...(usage ? { usage } : {}),
    ...(phase ? { phase } : {}),
    ...(failReason ? { failReason } : {}),
    ...(failReason === "http_status" ? { failStatus: asCount(body?.failStatus, 599) } : {}),
  };
  appendRecallJournalInjection(deps.journalDir, { teamId: team, agentId: agent }, entry, deps.journalOpts);
  sendJson(res, 200, { code: 0, data: { ok: true } });
  return true;
}
