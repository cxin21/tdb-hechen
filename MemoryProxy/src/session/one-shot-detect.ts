/**
 * one-shot 子代理判定（C4-dsh Phase 2，2026-10-20 收窄）。
 *
 * 背景：spawn 的子 agent 会被 dsh harness 自动挂 ask_user_question（声明≠可执行），
 * tools 启发式失效，故插件在**子 agent 的 system prompt**里加显式标记
 * [[one-shot-subagent]]，proxy 据此跳过 session-init 与全部注入。
 *
 * 2026-10-20 收窄（#72 复盘）：原实现全量扫描 messages，导致主会话历史里的
 * 字面量引用（工具结果/代码片段/压缩摘要）把主线请求误判为子代理 →
 * dsh PTC 预检（配置代供身份）被永久跳过。标记只会出现在 system 消息，
 * 故只扫 system 消息。
 */
const ONE_SHOT_SUBAGENT_MARKER = "[[one-shot-subagent]]";

export function isOneShotSubagentMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages as Array<{ role?: unknown; content?: unknown }>) {
    if (!m || m.role !== "system") continue;
    const c = m.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p) => (p as { text?: string })?.text ?? "").join("\n")
        : "";
    if (text.includes(ONE_SHOT_SUBAGENT_MARKER)) return true;
  }
  return false;
}