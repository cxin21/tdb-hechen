/**
 * V12-ADJ（拍板执行④续，2026-09-26）：pending 采纳合并语义——修复整槽替换丢既有红线 P0 缺陷。
 *
 * 根因实锚：v2-router handleCoreMemoryPendingDecide 的 strict_rule 采纳分支直接
 * upsertCore(decided.content)（整槽替换）——5 次采纳使 strict_rule 槽仅剩最后一条，
 * 原 3 条红线被挤出注入（生产实锚：slot version 1→6、content 仅剩 A/B 单行）。
 *
 * 语义：既有行全保留 + 采纳行追加 + 按行体去重（幂等）+ '- ' 前缀规范化。
 * 单一源：strict_rule 采纳写入的唯一合并实现（identity 类槽由 worker mergeIdentityFacts 承载，互不复制）。
 */
export function mergeStrictRuleContent(existing: string | undefined | null, adopted: string): string {
  const norm = (l: string): string => l.trim().replace(/^-+\s*/, '');
  const lines: string[] = [];
  for (const raw of String(existing ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const body = norm(line);
    if (lines.some((x) => norm(x) === body)) continue;
    lines.push(line.startsWith('-') ? line : '- ' + line);
  }
  const body = norm(adopted);
  if (body && !lines.some((x) => norm(x) === body)) lines.push('- ' + body);
  return lines.join('\n');
}

/**
 * V12-CV（拍板执行⑤，2026-09-26 何晨委托「你自己给一个最优方案」）：core_value 提案采纳
 * 转换层确定性门——旧采纳路径以整段 content 当锚 label（v2-router.ts:1870 实锚；锚行灾难性
 * 污染，29 条 core_value 提案因此全拒、采纳链从未对 core_value 闭合）。
 * 生成端：identity-discovery 双视角 prompt 要求 core_value 提案带 label（≤8 字）/description（≤60 字）。
 * 采纳端（本函数）：label 门（非空/≤8 字/无 JSON 结构残留）+description 回退链（缺省 → content 前 60 字）。
 * 返回 null = 门不过（router 422，pending 保持 pending，不暗箱替用户裁决）。
 */
const CV_LABEL_MAX = 8;
const CV_DESC_MAX = 60;

export function coerceCoreValueAnchor(input: { label?: string | null; description?: string | null; content: string }): { valueIdSeed: string; label: string; description: string } | null {
  const label = String(input.label ?? "").trim();
  if (!label) return null;
  if ([...label].length > CV_LABEL_MAX) return null;
  // JSON/结构残留门：LLM 偶发把整段 JSON 或结构符号塞进 label——落锚即污染注入块。
  if (/[{}\[\]":]/.test(label)) return null;
  const descRaw = String(input.description ?? "").trim();
  const content = String(input.content ?? "");
  const description = [...(descRaw || content)].slice(0, CV_DESC_MAX).join("");
  return { valueIdSeed: label, label, description };
}
