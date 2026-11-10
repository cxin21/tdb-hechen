/**
 * P1-B W3：DSH 的工具调用 → soul 事件（tool / test / commit / rollback）。
 *
 * 为什么单独成模块：分类、裁剪、去重键都是纯函数，能单测、不依赖宿主；
 * index.ts 只负责「什么时候发」（turn 收口、L0 写回成功之后）。
 *
 * 为什么四类必须分开：`我改完了`(tool) / `我跑过验证`(test) / `我提交了`(commit) /
 * `我回滚了`(rollback) 在人格层是四种分量不同的事实（spec §4.2）。混成一类，
 * 「我验证过」就再也无法证伪。
 *
 * 契约（照抄 MemoryCore/src/gateway/soul-event-endpoint.ts，不是猜的）：
 *  - 租户只走 x-tdai-team-id / -agent-id / -user-id 头，body 里不带；
 *  - dedupe_key <=200、summary <=400、evidence.quote 由 Core 截到 400、record_id <=200；
 *  - action.result_status 的口径是 SOUL_ACTION_STATUSES：
 *    success | fail | partial | unknown —— **不是 failure**（发错即整条 400）；
 *  - 工具类来源（tool/test/commit/rollback）带工具证据时允许 observed，但置信上限 0.9
 *    （§4.2 第 4 条：工具自报的「观察到了」不占满分，剩下 0.1 留给人工验收）。
 */
import { createHash } from 'node:crypto';
import type { SoulEventPayload } from './memory-client.js';

/** 分类：四类来源 + 兜底的 tool。 */
export type ToolEventKind = 'commit' | 'rollback' | 'test' | 'tool';

/**
 * 结果三态。取值必须是 Core 的 `fail`，不是 `failure`：
 * `SOUL_ACTION_STATUSES = ['success','fail','partial','unknown']`，
 * 写 `failure` 会让整条事件 400（不是少记一条，是整条丢）。
 */
export type ToolResultStatus = 'success' | 'fail' | 'unknown';

/** writeback.ts 采集到的一次工具调用（TurnEndPayload.toolCalls 的元素）。 */
export interface ToolCallRecord {
  name?: string;
  /** 宿主给的调用 id；同时当 dedupe 的第三段与 evidence.record_id。 */
  callId?: string;
  arguments?: unknown;
  /** tool/result 的文本回执；没有它就没有证据，这条不发。 */
  result?: string;
}

export interface ToolEventBatch {
  /** 可投递的事件（顺序与 toolCalls 一致）。 */
  events: SoulEventPayload[];
  /** 被跳过、只计数的调用：没有 result / 没有 callId / 没有 sessionId。 */
  skipped: number;
}

/** summary 里命令首行的上限。 */
const COMMAND_MAX = 120;
/** Core：summary <= 400。 */
const SUMMARY_MAX = 400;
/** Core：evidence.quote 截 400（写进来前先截，省一次无用的传输）。 */
const QUOTE_MAX = 400;
/** Core：dedupe_key <= 200。 */
const DEDUPE_KEY_MAX = 200;
/** 工具事件的置信度：与 store 的 SOUL_TOOL_EVIDENCE_MAX_CONFIDENCE 同值（不能更高）。 */
const TOOL_CONFIDENCE = 0.9;

// 优先级 commit > rollback > test > tool：一条命令既是提交又命中 test 字样时，
// 按更硬的事实归类（`git commit -m 'fix test'` 是提交，不是验证）。
const COMMIT_PATTERN = /\bgit\s+commit\b/i;
const ROLLBACK_PATTERN = /\bgit\s+(?:revert|reset\s+--hard|restore)\b/i;
// 词边界手写（`test` 必须整词，`foo.test.ts` 也算：点、下划线都是分隔符）。
const TEST_PATTERN = /(?:^|[^a-z0-9])(?:tsc\s+--noemit|vitest|jest|pytest|typecheck|test)(?:[^a-z0-9]|$)/i;

/**
 * 结果文本 → 三态。判据顺序是有意的：
 *  1. exit code 最硬（`exit code: 1`、`[exit code: 0]`、`{"exitCode":0}`），有就照它判；
 *  2. 否则看失败词（failed / error / fatal / exception / panic），
 *     先抹掉 `0 failed` / `0 errors` 这类「零个失败」的假阳性；
 *  3. 否则看成功词（passed / ok / success）；
 *  4. 都不像 → unknown（不猜）。
 * 只看最后一条 exit code：一份日志可能打印多次，最终码才是结论。
 */
export function resultStatusOf(result: string | undefined): ToolResultStatus {
  if (typeof result !== 'string' || result.trim() === '') return 'unknown';
  // `0 failed` / `0 errors`：数量为零不是失败。
  const text = result.replace(/\b0\s+(?:failed|failures?|errors?|failing)\b/gi, ' ');
  const exitCode = lastExitCode(text);
  if (exitCode !== undefined) return exitCode === 0 ? 'success' : 'fail';
  if (/\b(?:failed|failure|fail|errors?|error|fatal|exception|panicked?|nonzero)\b/i.test(text)) return 'fail';
  if (/\b(?:passed|pass|ok|success|succeeded|successfully)\b/i.test(text)) return 'success';
  return 'unknown';
}

/** 最后一次出现的 exit code；没有就是 undefined。 */
function lastExitCode(text: string): number | undefined {
  const pattern = /exit[\s_-]*code["']?\s*[:=]?\s*["']?(-?\d+)/gi;
  let code: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) code = parsed;
  }
  return code;
}

/**
 * 命令文本：`arguments.command` 是 DSH 的 shell 工具口径；arguments 本身是字符串
 * （有些工具直接传命令串）时也认。拿不到就是空串——分类只看工具名。
 */
function commandOf(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const command = (args as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
  }
  return '';
}

/** 首行：命令里的换行之后是第二种意图，不该压进同一句 summary。 */
function firstLine(text: string): string {
  const index = text.search(/\r?\n/);
  const line = index === -1 ? text : text.slice(0, index);
  return line.trim();
}

/** 按「工具名 + 命令」判四类来源。 */
export function classifyToolEventKind(name: string, command: string): ToolEventKind {
  const haystack = name + ' ' + command;
  if (COMMIT_PATTERN.test(haystack)) return 'commit';
  if (ROLLBACK_PATTERN.test(haystack)) return 'rollback';
  if (TEST_PATTERN.test(haystack)) return 'test';
  return 'tool';
}

/** sha256 十六进制：命令正文不出插件，只出指纹。 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** arguments 的指纹；JSON.stringify 抛（循环引用/BigInt）时退化成字符串指纹，绝不抛。 */
function argsDigestOf(args: unknown): string {
  try {
    return sha256Hex(JSON.stringify(args ?? null));
  } catch {
    return sha256Hex(String(args));
  }
}

/**
 * dedupe_key：同一次工具调用重复投递必须落成同一条事件。
 * `dsh:<sessionId>:<callId>` —— 前缀区分来源（插件 vs Core 自己生成的事件），
 * 超长（>200）时退化成整串的哈希：仍然「同调用同键」，只是不再人类可读。
 */
function dedupeKeyOf(sessionId: string, callId: string): string {
  const key = 'dsh:' + sessionId + ':' + callId;
  if (key.length <= DEDUPE_KEY_MAX) return key;
  return 'dsh:' + sha256Hex(key).slice(0, 40);
}

/**
 * 一批工具调用 → 一批 soul 事件。
 *
 * 跳过（只计数、不发明事件）的三种情况：
 *  - 没有 result：没有工具输出就没有证据，Core 侧无证据只能 inferred<=0.5，
 *    而这条事件的全部价值就是「工具确实跑过」——宁可少记，不发假事件；
 *  - 没有 callId：dedupe_key 与 evidence.record_id 都靠它，缺了就是不可判重的一条；
 *  - 没有 sessionId：事件会串到别人的会话上，直接不发。
 */
export function toToolEvents(
  toolCalls: readonly ToolCallRecord[] | undefined,
  sessionId: string | undefined,
): ToolEventBatch {
  const events: SoulEventPayload[] = [];
  let skipped = 0;
  const session = typeof sessionId === 'string' ? sessionId.trim() : '';
  for (const raw of toolCalls ?? []) {
    const call: ToolCallRecord = raw ?? {};
    const callId = typeof call.callId === 'string' ? call.callId.trim() : '';
    const result = typeof call.result === 'string' ? call.result : '';
    if (callId === '' || session === '' || result.trim() === '') {
      skipped += 1;
      continue;
    }
    const toolName = typeof call.name === 'string' && call.name.trim() !== '' ? call.name.trim() : 'tool';
    const command = commandOf(call.arguments);
    const kind = classifyToolEventKind(toolName, command);
    const head = firstLine(command).slice(0, COMMAND_MAX);
    const summary = (kind + ': ' + toolName + (head === '' ? '' : ' ' + head)).slice(0, SUMMARY_MAX);
    events.push({
      dedupe_key: dedupeKeyOf(session, callId),
      source_kind: kind,
      summary,
      session_id: session,
      // record_id 记 tool_call_id，不是 L0 record_id：工具事件没有对应的 L0 行，
      // 拿 L0 id 冒充会把「我跑过这条命令」变成查不到源头的断言（store :375-377）。
      evidence: [{ role: 'tool', quote: result.trim().slice(0, QUOTE_MAX), record_id: callId }],
      action: {
        tool: toolName,
        tool_call_id: callId,
        args_digest: argsDigestOf(call.arguments),
        result_status: resultStatusOf(result),
      },
      // 有工具证据 + 工具类来源才允许 observed；置信度钉在 0.9（store 上限）。
      epistemic: 'observed',
      confidence: TOOL_CONFIDENCE,
    });
  }
  return { events, skipped };
}
