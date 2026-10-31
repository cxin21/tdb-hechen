/**
 * session-init 诊断尾巴的**脱敏摘要**（红队 2026-11-01 §F 静默失败/日志卫生）。
 *
 * 背景：handler.ts 原来在 session-init 开启时把最后 3 条消息的
 * `content.slice(0, 80)` 直接打进 stdout —— 即用户消息正文、工具入参片段
 * 落进生产日志（`logs/` 下已有历史文件）。日志只需能回答「这个请求带了什么
 * 形状的消息」，不需要正文。
 *
 * 因此缺省**只输出结构信息**：role、content 的类型与长度、tool_call_id 前 8 位。
 * 需要看正文时必须在环境里显式设置 PROXY_DEBUG_SESSION_INIT_TAIL=1（本地排障），
 * 且仍然只截前 80 字符。
 */

/** 打开正文回显所需的环境变量（值必须严格等于 "1"）。 */
export const SESSION_INIT_TAIL_ENV = "PROXY_DEBUG_SESSION_INIT_TAIL";

export interface SessionInitTailOptions {
  /** 为 true 时才回显 content 前 80 字；缺省 false（脱敏）。 */
  dumpBody?: boolean;
}

/** 从环境变量判断是否允许回显正文；非 "1" 一律视为关闭。 */
export function isSessionInitTailDumpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SESSION_INIT_TAIL_ENV] === "1";
}

function describeContent(content: unknown, dumpBody: boolean): string {
  if (typeof content === "string") {
    if (!dumpBody) return `string(len=${content.length})`;
    return `string(len=${content.length}) ${JSON.stringify(content.slice(0, 80))}`;
  }
  if (Array.isArray(content)) {
    const types = content.map((block) => {
      const type = (block as { type?: unknown } | null)?.type;
      return typeof type === "string" ? type : "?";
    });
    return `array[${types.join(",")}]`;
  }
  if (content === null) return "null";
  if (content === undefined) return "undefined";
  return typeof content;
}

function shortId(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/**
 * 把消息数组的「尾巴」压成一行可 grep 的摘要。
 * 不抛异常：入参来自网络请求，任何形状都要能日志化。
 */
export function summarizeSessionInitTail(
  messages: readonly unknown[],
  options: SessionInitTailOptions = {},
): string {
  const dumpBody = options.dumpBody === true;
  const tail = messages.slice(-3);
  return tail
    .map((raw, idx) => {
      const message = (raw ?? {}) as {
        role?: unknown;
        content?: unknown;
        tool_call_id?: unknown;
        tool_calls?: unknown;
      };
      const role = typeof message.role === "string" ? message.role : "?";
      const contentPart = describeContent(message.content, dumpBody);
      const tcid = shortId(message.tool_call_id);
      let tcs = "";
      if (Array.isArray(message.tool_calls)) {
        const ids = message.tool_calls.map((call) => shortId((call as { id?: unknown })?.id));
        tcs = ` tool_calls[${ids.join(",")}]`;
      }
      return `[${idx}]role=${role} content=${contentPart} tool_call_id=${tcid}${tcs}`;
    })
    .join(" | ");
}
