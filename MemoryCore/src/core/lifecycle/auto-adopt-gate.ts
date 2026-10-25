/**
 * #92 stage 2（2026-10-25 拍板四项：N₂/T₂=4/72h · 0.60/0.75 · 快照+版本守卫回滚 · 面板跟进票）：
 * self_identity 确定性自动采纳门——三重门高置信自动采纳，人转审计员。
 *
 * 缺省 off = config-first 逐位现状（晋升只到 ready-for-human，人审不变）。三重门：
 *   ① count≥N₂ ∧ 跨度≥T₂（store 候选查询保证，口径与 TTL sweep 同构）；
 *   ② 无同主题 rejected 矛盾：proposalSimilarity(content, 任一 rejected 行) ≥ contradictionThreshold
 *      → blocked（宁拦勿收：误拦=退回人审安全方向，漏拦=误收人格污染不可自动修复）；
 *   ③ 非槽内重复：proposalSimilarity(content, 任一现行槽行) ≥ dupThreshold → skipped。
 * 采纳链逐位镜像 #82 人审 merge-on-adopt（v2-router.ts:2435-2450 先例）：readCore → escapeXmlTags
 * 按行消毒 → mergeIdentityFacts 单一源（槽行守恒 slice(-8)）→ 合并输出与槽相同则跳过写槽（幂等零
 * version 空转）→ upsertCore(source="auto-adopt-gate") → decidePendingCoreAuto 落 state='auto_adopted'
 * + attrs_json.auto_adopt 审计快照（prev 内容/版本/存在性、post 版本、门参数）。
 * 回滚走既有 decide 路由 rejected 分支（rollbackAutoAdoptedPending：版本守卫下恢复快照，零删除）；
 * 面板零 API 变更（reject 按钮即回滚入口）。拍级计数由 scheduler 打日志行（观测夹带口径同 #91）。
 */
import { proposalSimilarity } from "./proposal-dedup.js";
import { mergeIdentityFacts } from "./identity-discovery.js";
import { escapeXmlTags } from "../../utils/sanitize.js";

export interface SelfIdentityAutoAdoptConfig {
  enabled?: boolean;
  /** N₂：自动采纳票数门槛（缺省 4——比 stage-1 ready 的 votes=3 严一票）。 */
  votes?: number;
  /** T₂：晋升跨度小时（缺省 72——跨 3 天持续复现才够格，慢变量口径）。 */
  spanHours?: number;
  /** 同主题 rejected 矛盾线（缺省 0.60，低于去重 0.75——宁拦勿收）。 */
  contradictionThreshold?: number;
  /** 槽内重复线（缺省 0.75，沿用 proposal-dedup 单一源标准）。 */
  dupThreshold?: number;
}

type AutoAdoptRow = { pending_id: string; content: string; recurrence_json: string | null; attrs_json: string | null; team_id: string; user_id: string; agent_id: string; created_at: string };

export interface AutoAdoptDeps {
  store: {
    listReadySelfIdentityPending?(tenant?: unknown, opts?: { votesN?: number; spanHours?: number }): Array<AutoAdoptRow> | Promise<Array<AutoAdoptRow>>;
    decidePendingCoreAuto?(pendingId: string, tenant?: unknown, audit?: { prev_slot_content?: string; prev_slot_version?: number; prev_slot_existed?: boolean; post_slot_version?: number; gate?: { votes: number; spanHours: number; contradictionThreshold: number; dupThreshold: number } }): boolean | Promise<boolean>;
    readCore?(tenant?: unknown): Array<{ slot: string; content: string; version?: number }> | Promise<Array<{ slot: string; content: string; version?: number }>>;
    upsertCore?(slot: string, content: string, source: string, tenant?: unknown): boolean | Promise<boolean>;
    listPendingCore?(tenant?: unknown, opts?: { includeDecided?: boolean }): Array<{ slot?: string; state?: string; content?: string }> | Promise<Array<{ slot?: string; state?: string; content?: string }>>;
  };
  config?: SelfIdentityAutoAdoptConfig;
  logger?: { info?(msg: string): void; warn?(msg: string): void; debug?(msg: string): void };
}

export async function runSelfIdentityAutoAdopt(deps: AutoAdoptDeps): Promise<{ ran: boolean; adopted: number; blocked: number; skipped: number }> {
  const zero = { ran: false, adopted: 0, blocked: 0, skipped: 0 };
  const cfg = deps.config;
  if (cfg?.enabled !== true) return zero; // R1：缺省关=逐位现状
  const store = deps.store;
  // 旧 store 能力探测：缺任一方法 → 门整体旁路（宽容降级=现状）
  if (typeof store.listReadySelfIdentityPending !== "function" || typeof store.decidePendingCoreAuto !== "function" || typeof store.upsertCore !== "function" || typeof store.readCore !== "function") return zero;
  const votesN = Math.max(1, Math.floor(cfg.votes ?? 4));
  const spanHours = Math.max(0, cfg.spanHours ?? 72);
  const contra = typeof cfg.contradictionThreshold === "number" ? cfg.contradictionThreshold : 0.6;
  const dup = typeof cfg.dupThreshold === "number" ? cfg.dupThreshold : 0.75;

  const candidates = ((await Promise.resolve(store.listReadySelfIdentityPending(undefined, { votesN, spanHours }))) ?? []) as AutoAdoptRow[];
  if (candidates.length === 0) return { ran: true, adopted: 0, blocked: 0, skipped: 0 };
  // 按租户三元组分组逐租户处理（候选查询缺省=全租户，行带租户字段）
  const groups = new Map<string, AutoAdoptRow[]>();
  for (const row of candidates) {
    const key = row.team_id + "|" + row.user_id + "|" + row.agent_id;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  let adopted = 0;
  let blocked = 0;
  let skipped = 0;
  for (const rows of groups.values()) {
    const tenant = { teamId: rows[0].team_id, userId: rows[0].user_id, agentId: rows[0].agent_id };
    const slotRow = ((await Promise.resolve(store.readCore(tenant))) ?? []).find((s) => s.slot === "self_identity");
    let slotContent = slotRow?.content ?? "";
    let slotVersion = slotRow?.version ?? 0;
    const slotLines = (): string[] => slotContent.split("\n").map((l) => l.trim().replace(/^-+\s*/, "")).filter((l) => l.length > 0);
    const rejectedContents = (((await Promise.resolve(store.listPendingCore?.(tenant, { includeDecided: true }))) ?? []) as Array<{ slot?: string; state?: string; content?: string }>)
      .filter((r) => r.slot === "self_identity" && r.state === "rejected")
      .map((r) => String(r.content ?? ""));
    for (const row of rows) {
      const content = String(row.content ?? "");
      // 门②：同主题 rejected 矛盾（宁拦勿收——退回人审是安全方向）
      if (rejectedContents.some((rc) => proposalSimilarity(content, rc) >= contra)) { blocked++; continue; }
      // 门③：槽内重复（已是现行认知，自动采纳只产生 version 空转）
      if (slotLines().some((sl) => proposalSimilarity(content, sl) >= dup)) { skipped++; continue; }
      // 采纳：逐位镜像 #82 人审 merge-on-adopt（消毒约定=调用方；合并唯一源=mergeIdentityFacts）
      const adoptedLines = content.split("\n").map((l) => escapeXmlTags(l.trim())).filter((l) => l.length > 0);
      const existingIdentity = slotRow ? slotContent : undefined;
      const merged = mergeIdentityFacts(existingIdentity, adoptedLines);
      if (merged !== (existingIdentity ?? "")) {
        const ok = await Promise.resolve(store.upsertCore("self_identity", merged, "auto-adopt-gate", tenant));
        if (!ok) { deps.logger?.warn?.("[auto-adopt] upsertCore failed, keep pending pid=" + row.pending_id); continue; }
      }
      const postV = ((await Promise.resolve(store.readCore(tenant))) ?? []).find((s) => s.slot === "self_identity")?.version ?? slotVersion;
      const ok2 = await Promise.resolve(store.decidePendingCoreAuto(row.pending_id, tenant, {
        prev_slot_content: slotContent,
        prev_slot_version: slotVersion,
        prev_slot_existed: slotRow !== undefined,
        post_slot_version: postV,
        gate: { votes: votesN, spanHours, contradictionThreshold: contra, dupThreshold: dup },
      }));
      if (ok2) {
        adopted++;
        slotContent = merged; // 同拍同租户后续候选基于最新槽判定
        slotVersion = postV;
      } else {
        deps.logger?.warn?.("[auto-adopt] decidePendingCoreAuto failed, keep pending pid=" + row.pending_id);
      }
    }
  }
  return { ran: true, adopted, blocked, skipped };
}
