/**
 * V12-ADJ（拍板执行④续，2026-09-26）：pending 采纳合并语义——修复整槽替换丢既有红线 P0 缺陷。
 *
 * 根因实锚：v2-router handleCoreMemoryPendingDecide 的 strict_rule 采纳分支直接
 * upsertCore(decided.content)（整槽替换）——5 次采纳使 strict_rule 槽仅剩最后一条，
 * 原 3 条红线被挤出注入（生产实锚：slot version 1→6、content 仅剩 A/B 单行）。
 *
 * 语义：既有行全保留 + 采纳行按行处理——全等幂等（保持）→ 相似≥阈值取最高相似行
 * （P3 #80 2026-10-21 用户拍板「增量生成：相似→更新而非新增」：采纳行码点更长则原位替换
 * =更新，否则旧行保留、采纳行丢弃）→ 不相似追加（V12-ADJ 语义不变）+ '- ' 前缀规范化。
 * 单一源：strict_rule 采纳写入的唯一合并实现（identity 类槽由 worker mergeIdentityFacts 承载，
 * 互不复制）；相似度单一源=core/lifecycle/proposal-dedup proposalSimilarity。
 */
import { proposalSimilarity, REDLINE_MERGE_THRESHOLD } from "../core/lifecycle/proposal-dedup.js";

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
  for (const adoptedLine of String(adopted ?? '').split('\n')) {
    const body = norm(adoptedLine);
    if (!body) continue;
    if (lines.some((x) => norm(x) === body)) continue; // 全等幂等（V12-ADJ 保持）
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < lines.length; i++) {
      const s = proposalSimilarity(body, norm(lines[i]));
      if (s > bestSim) {
        bestSim = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestSim >= REDLINE_MERGE_THRESHOLD) {
      // 相似合并：保留信息更全行（码点更长）于原位；等长/更短 → 旧行保留（宁保守不降信息量）。
      if ([...body].length > [...norm(lines[bestIdx])].length) lines[bestIdx] = '- ' + body;
      continue;
    }
    lines.push('- ' + body);
  }
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
import { looksLikeEpisode } from "../core/hooks/episode-gate.js";

const CV_LABEL_MAX = 8;
const CV_DESC_MAX = 60;

/**
 * 灵魂注入质量轮（2026-10-04 何晨令「禁止无意义、不明确的内容」）：
 * desc 句边界 sanitizer——60 字窗口内含句末标点（。！？；）→ 截到最后句末标点；
 * 窗口内无句末标点：尾悬空（以，、, 结尾=写入口截断实锤特征）→ 置空（宁缺毋滥不入半句），
 * 完整短语（尾非悬空）→ 原样保留。
 *
 * P0-1A（issue #1，2026-10-13）单一源迁移：实现搬至 core/hooks/anchor-desc.ts
 * （anchor-growth 自生长采纳端按 core→core 方向复用），此处 re-export 保持公共 API。
 */
import { sanitizeAnchorDescription as sanitizeDescription } from "../core/hooks/anchor-desc.js";
export { sanitizeDescription };

export function coerceCoreValueAnchor(input: { label?: string | null; description?: string | null; content: string }): { valueIdSeed: string; label: string; description: string } | null {
  const label = String(input.label ?? "").trim();
  if (!label) return null;
  if ([...label].length > CV_LABEL_MAX) return null;
  // JSON/结构残留门：LLM 偶发把整段 JSON 或结构符号塞进 label——落锚即污染注入块。
  if (/[{}\[\]":]/.test(label)) return null;
  const descRaw = String(input.description ?? "").trim();
  const content = String(input.content ?? "");
  // R2 episode 门（灵魂禁混记忆内容）：用户显式给的 desc 为具体事件叙述（commit hash/编号/
  // HTTP 状态/日期等硬特征）→ 不是价值观说明，整锚拒绝（门不过 422，pending 保留不暗箱裁决）。
  if (descRaw && looksLikeEpisode(descRaw)) return null;
  // 2026-10-04 句边界化：原 60 字硬切产半句入库存活（「A-5 达 GRE、」形态全量渲染）→ sanitize。
  let description = sanitizeDescription(descRaw || content, CV_DESC_MAX);
  // R2 episode 门（回退链）：旧格式提案无 desc → content 回退产物为具体事件叙述 → desc 置空
  // （锚保留待合格 desc，渲染端宁缺毋滥跳过；不整锚拒——旧格式提案的 content 本就是事件事实）。
  if (!descRaw && looksLikeEpisode(description)) description = "";
  return { valueIdSeed: label, label, description };
}
