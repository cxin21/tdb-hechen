/**
 * task-83（生产 L0 测试数据卫生 · A 段抽取侧卫生闸）：会话忽略匹配。
 *
 * 背景：生产 vectors.db 的 l0_conversations 里混进了探针/测试会话
 * （`probe-*`、`session-probe-*`，128 行 / 23 会话 / 905,703 字符），它们会被
 * L1 蒸馏成「记忆」。删除生产行需要用户授权（红线），所以先做**抽取侧不蒸馏**
 * 的卫生闸：命中的会话不进入 L1 候选、不计入 batch 计数。
 *
 * 匹配语义（本实现选择，票面允许「glob 或前缀」二选一，这里两者兼顾）：
 *  - **前缀匹配**：pattern 只锚定字符串开头，不需要写尾随 `*`
 *    （`"probe-"` 命中 `probe-abc`，不命中 `my-probe-abc`）。
 *  - **`*` 通配**：pattern 内的 `*` 展开为 `.*`（`"probe-*b"` 命中 `probe-x-b`）。
 *  - **其余字符一律字面转义**：`"probe.[1]"` 只命中字面 `probe.[1]`，不会被当正则
 *    （票面「通配符转义」用例）。
 *  - 大小写敏感（与 L0 里 session_id/session_key 的存储形态一致，不做归一化）。
 *  - 空串 / 纯空白 pattern 丢弃；`[]` 与 `undefined` 之外的「关闭」语义见下。
 *
 * 缺省值：`DEFAULT_IGNORE_SESSION_PATTERNS`（config.ts 的
 * `memory.extraction.ignoreSessionPatterns` 缺省即用它）。显式配置 `[]` = 关闸，
 * 此时行为与 task-83 之前逐位一致（无任何会话被跳过）。
 */

/** 探针/测试会话的缺省忽略前缀（与 scratch/lead 归档的现网 session_id 形态一致）。 */
export const DEFAULT_IGNORE_SESSION_PATTERNS: readonly string[] = ["probe-", "session-probe-"];

export interface SessionIgnoreHit {
  /** 命中的 pattern（原样，转义前） */
  pattern: string;
  /** 命中的字段：行级 session_id 还是外层 session_key */
  matchedOn: "session_id" | "session_key";
  /** 命中的实际取值 */
  value: string;
}

export interface SessionIgnoreMatcher {
  /** 生效的 pattern 列表（已剔除空串） */
  patterns: string[];
  /** 命中则返回命中详情；否则 undefined。session_id 与 session_key 都会被检查。 */
  match(sessionId?: string | null, sessionKey?: string | null): SessionIgnoreHit | undefined;
  /** 只判真假（调用方不需要命中详情时更省事） */
  isIgnored(sessionId?: string | null, sessionKey?: string | null): boolean;
}

/** pattern → 前缀锚定正则；`*`=`.*`，其余字符字面转义。 */
function patternToRegex(pattern: string): RegExp {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      out += ".*";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(out);
}

/**
 * 编译忽略闸。
 * @param patterns 生效 pattern；`undefined`/`null` ⇒ 用缺省值（不是「关」——
 *   关闸必须显式传 `[]`，避免调用方漏传字段时静默关掉卫生闸）。
 */
export function compileSessionIgnorePatterns(
  patterns?: readonly string[] | null,
): SessionIgnoreMatcher {
  const source = patterns == null ? DEFAULT_IGNORE_SESSION_PATTERNS : patterns;
  const cleaned = source.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
  const compiled = cleaned.map((pattern) => ({ pattern, re: patternToRegex(pattern) }));

  const match = (sessionId?: string | null, sessionKey?: string | null): SessionIgnoreHit | undefined => {
    if (compiled.length === 0) return undefined;
    const fields: Array<["session_id" | "session_key", string | null | undefined]> = [
      ["session_id", sessionId],
      ["session_key", sessionKey],
    ];
    for (const [matchedOn, value] of fields) {
      if (typeof value !== "string" || value.length === 0) continue;
      for (const c of compiled) {
        if (c.re.test(value)) return { pattern: c.pattern, matchedOn, value };
      }
    }
    return undefined;
  };

  return {
    patterns: cleaned,
    match,
    isIgnored: (sessionId, sessionKey) => match(sessionId, sessionKey) !== undefined,
  };
}
