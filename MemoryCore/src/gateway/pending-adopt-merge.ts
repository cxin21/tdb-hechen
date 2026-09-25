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
