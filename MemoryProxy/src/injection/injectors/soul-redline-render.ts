/**
 * 灵魂红线段渲染单一源（#52 P1 修复，2026-10-18）——MemoryProxy 镜像副本。
 *
 * 契约：与 MemoryCore/src/core/hooks/soul-redline-render.ts 逐位等价（两包无跨包
 * 依赖，镜像 + 契约测试钉等价：MemoryProxy
 * src/injection/injectors/__tests__/soul-redline-render-parity.test.ts 对两份源文件
 * 做剥离文件头注释后的函数体逐位对账——任一侧漂移即测试红）。
 *
 * 根因实锚：strict_rule 槽是多行内容（生产 version 5 = 5 条红线，每行自带 `- `
 * 弹头前缀），旧渲染 `- [strict_rule] ${content}` 只给首行打 tag 且不剥离内容
 * 自身弹头 → 产出 ``- [strict_rule] - 排查期间…`` 畸形行 + 续行全裸（无 tag、
 * 无缩进、被 LLM 视为普通文本）。
 *
 * 修复合同（P1a/P1b 共用，MemoryCore soul-assembler 与 MemoryProxy
 * tdai-soul-redline-event-injector 两处消费）：
 *   - 每一条红线独立成行，逐行携带 [strict_rule] tag（长上下文衰减下 tag 密度
 *     不随行号稀释）；
 *   - 剥离行首列表弹头（`- ` / `* ` / `+ ` / `· `` / 数字编号）后再统一加
 *     弹头，杜绝双重弹头；行体（弹头后的文字）逐字保留——真实性边界：不截断、
 *     不改写、不合并；
 *   - 空行跳过；输出零畸形。
 */

/** strict_rule 槽名（core_memory 唯一红线槽）。 */
export const STRICT_RULE_SLOT = "strict_rule";

/** 行首列表弹头（破折号/星号/加号/间隔号/数字编号），剥后统一重加；纯弹头行（'- ' trim 后仅剩 '-'）与 CJK 编号「N、」（无空格约定）同样剥净。 */
const LIST_BULLET_RE = /^(?:[-*+·•](?:\s+|$)|\d+[.、)]\s+|\d+、)/;

/** 剥离一行行首的列表弹头（无弹头原样返回）。 */
export function stripListBullet(line: string): string {
  return line.replace(LIST_BULLET_RE, "");
}

/**
 * 把 strict_rule 槽内容拆成逐条红线行：多行内容按换行拆分，剥离弹头，
 * 跳过空行（含剥弹头后为空者）。行体逐字保留（仅剥弹头，不做其他清洗）。
 */
export function strictRuleContentLines(content: string): string[] {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line) => stripListBullet(line.trim()))
    .filter((line) => line !== "");
}

/** 单条红线渲染：`- [strict_rule] 行体`。 */
export function renderStrictRuleTaggedLine(line: string): string {
  return `- [${STRICT_RULE_SLOT}] ${line}`;
}

/**
 * strict_rule 槽集合 → 红线行序列（每条独立一行、逐行带 tag）。
 * 输入是 core slots（含非 strict_rule 槽），仅取 strict_rule 且非空。
 */
export function renderStrictRuleTaggedLines(
  slots: ReadonlyArray<{ slot: string; content: string }>,
): string[] {
  const out: string[] = [];
  for (const s of slots) {
    if (s.slot !== STRICT_RULE_SLOT) continue;
    if (typeof s.content !== "string" || s.content.trim() === "") continue;
    for (const line of strictRuleContentLines(s.content)) {
      out.push(renderStrictRuleTaggedLine(line));
    }
  }
  return out;
}

/** 段名（与 #24-C1 soul-identity 红线段同源）。 */
export const REDLINE_SECTION_TITLE = "## 不可逾越（红线）";

/** 红线整段（段名 + 行序列）；无行 → 空串（调用侧宁缺毋滥省略整段）。 */
export function renderStrictRuleSectionLines(
  slots: ReadonlyArray<{ slot: string; content: string }>,
): string[] {
  return renderStrictRuleTaggedLines(slots);
}

/**
 * 镜像对账锚：本文件与 MemoryCore 源文件除本注释块外逐位等价；契约测试以
 * 「剥离各自文件头注释后函数体 hash 相等」对账（头注释允许各自表述）。
 */
export const MIRROR_OF = "MemoryCore/src/core/hooks/soul-redline-render.ts";