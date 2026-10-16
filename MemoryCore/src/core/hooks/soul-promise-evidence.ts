/**
 * #41（ADR0003-P3 实施票 C，2026-10-16）：promise 确定性证据门 —— (b) 证据通道单一源。
 *
 * 合同（#41 票面 + ADR0003 D8 确定性证据裁决）：
 * 1. 确认话语 = 锚定全句白名单正则（^…$，禁止子串命中）：宁缺毋滥——白名单之外的
 *    一律不触发；漏报由 (a) 人工显式 / (c) 提案采纳兜底，误报（错误迁移）不可逆。
 * 2. 证据 → 迁移映射确定性：confirmation:kept→kept / confirmation:broken→broken /
 *    tool_failure→broken / tool_success→kept。不做任何 LLM 判定、不做内容模糊匹配。
 * 3. 关联 = promise.refKey === 证据 refKey 严格相等；双方任一缺 refKey → 不迁移
 *    （宁缺毋滥：确认话语本身不指名承诺，宁可不迁移）。refKey 命中时该任务上下文下的
 *    全部 open promise 参与迁移（一项证据影响其在途承诺全集）；同一 promise 多条证据
 *    首条生效（状态机单向不变式，终态拒绝由 store 复判兜底）。
 * 5. 判定来源溯源：迁移恒 stamp source="evidence"（soul_promise_events.source 列）。
 *
 * intake 边界（诚实降级）：extraction 侧今日可确定性采集的信号仅 user 确认话语
 * （L0 无 tool 角色、MemoryRecord 无 tool 回执标记——不猜）。tool_failure/tool_success
 * 证据项由本模块定义 intake 形状与映射，供未来工具回执接入方复用同一门（禁第二实现）。
 * 门 off（soulRender.promiseEvidence.enabled 缺省 false）= 零 promise 读零 promise 写。
 */

/** 确认话语白名单（kept）：问候/应答前缀 + 确认词；锚定全句，尾部仅允许语气/标点。 */
export const PROMISE_CONFIRMATION_KEPT_PATTERNS: readonly RegExp[] = [
  // ① 前缀 + 确认词：好的，收到 / 嗯，没问题 / ok，已完成 / 行，就这样定了
  /^(?:好的?|嗯+|行|可以|okay|ok)\s*[，,。.～~!！\s]*(?:收到|确认|确认无误|没问题|没得说|已完成|做完了?|定了?|定案了?|就这样(?:定了?|办了?)?|通过|验收通过|达成|同意)[的了呢吧呀。！!～~，,\s]*$/i,
  // ② 裸确认词起句：收到 / 确认收到 / 确认完成 / 已完成 / 没问题 / 定了 / 验收通过 / 同意
  /^(?:收到|确认(?:收到|完成|无误)?|已完成|做完了?|没(?:问题|毛病)|定了|定案了|就这样(?:定了?|办了?)?|验收(?:通过|完成)|达成|同意(?:执行)?)[的了呢吧。！!～~，,\s]*$/i,
];

/** 确认话语白名单（broken）：直接否定 / 指代否定；锚定全句。 */
export const PROMISE_CONFIRMATION_BROKEN_PATTERNS: readonly RegExp[] = [
  // ① 直接否定/未达成：不对 / 不行 / 没做到 / 没完成 / 失败了 / 重做 / 返工 / 还有问题
  /^(?:不(?:对|行|行啊|行呀|是这样|符合|通过|达标)|没(?:做到|做完|完成|通过|落地|修好|用)|做错(?:了)?|失败(?:了)?|重做|返工|有问题|还(?:有|是)?问题|未(?:完成|达成|通过)|打回)[\s的了呢吧呀。！!～~，,\s]*$/,
  // ② 指代否定：这个不对 / 这版不行 / 这样不行
  /^(?:这个?|这样|这版|那版|它)(?:完全)?(?:不(?:对|行|符合|达标|通过)|有(?:问题|毛病))[\s的了呢吧呀。！!～~，,\s]*$/,
];

export type PromiseConfirmationVerdict = "kept" | "broken";

/** 确认话语判定：命中返回 verdict + patternIndex（取证），白名单外/非字符串 → null。 */
export function matchConfirmationUtterance(text: unknown): { verdict: PromiseConfirmationVerdict; patternIndex: number } | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  for (let i = 0; i < PROMISE_CONFIRMATION_KEPT_PATTERNS.length; i++) {
    if (PROMISE_CONFIRMATION_KEPT_PATTERNS[i].test(s)) return { verdict: "kept", patternIndex: i };
  }
  for (let i = 0; i < PROMISE_CONFIRMATION_BROKEN_PATTERNS.length; i++) {
    if (PROMISE_CONFIRMATION_BROKEN_PATTERNS[i].test(s)) return { verdict: "broken", patternIndex: i };
  }
  return null;
}

/** 确定性证据项（单一 intake 形状；refKey=任务/上下文关联键）。 */
export type PromiseEvidenceItem =
  | { kind: "confirmation"; verdict: PromiseConfirmationVerdict; refKey?: string; at?: string; note?: string }
  | { kind: "tool_failure" | "tool_success"; refKey?: string; at?: string; note?: string };

/** 证据 → 目标状态的确定性映射（tool_failure→broken / tool_success→kept）。 */
function evidenceTarget(item: PromiseEvidenceItem): "kept" | "broken" {
  if (item.kind === "confirmation") return item.verdict;
  return item.kind === "tool_success" ? "kept" : "broken";
}

function evidenceKindLabel(item: PromiseEvidenceItem): string {
  return item.kind === "confirmation" ? `confirmation:${item.verdict}` : item.kind;
}

/** 证据迁移指令（note 恒带 [evidence:*] 前缀，供 soul_promise_events 审计）。 */
export interface PromiseEvidenceDirective {
  promiseId: string;
  to: "kept" | "broken";
  note: string;
  evidenceKind: string;
}

/**
 * 纯裁决：证据项 × open promises → 迁移指令（确定性关联 + 每 promise 首条生效；
 * 零 IO 零副作用）。
 */
export function evaluatePromiseEvidence(
  items: readonly PromiseEvidenceItem[],
  openPromises: readonly { promiseId: string; status: string; refKey?: string }[],
): PromiseEvidenceDirective[] {
  const byRefKey = new Map<string, string[]>(); // refKey → open promiseIds（声明序）
  for (const p of openPromises) {
    if (p.status !== "open" || !p.refKey) continue;
    const list = byRefKey.get(p.refKey);
    if (list) list.push(p.promiseId);
    else byRefKey.set(p.refKey, [p.promiseId]);
  }
  const directives: PromiseEvidenceDirective[] = [];
  const consumed = new Set<string>(); // promiseId 首条生效
  for (const item of items) {
    if (!item.refKey) continue; // 证据缺 refKey → 不迁移（宁缺毋滥）
    const ids = byRefKey.get(item.refKey);
    if (!ids) continue;
    for (const promiseId of ids) {
      if (consumed.has(promiseId)) continue;
      consumed.add(promiseId);
      directives.push({
        promiseId,
        to: evidenceTarget(item),
        note: `[evidence:${evidenceKindLabel(item)}]${item.note ? ` ${item.note}` : ""}`.trim(),
        evidenceKind: evidenceKindLabel(item),
      });
    }
  }
  return directives;
}

/** 证据落库最小结构面（与 IMemoryStore 可选方法同形；缺实现=观测旁路）。 */
export interface PromiseEvidenceStoreFace {
  listSoulPromises?(tenant: unknown, opts?: { status?: string; limit?: number }): unknown;
  transitionSoulPromise?(tenant: unknown, promiseId: string, to: string, opts?: { at?: string; note?: string; source?: string }): unknown;
}

/**
 * 落库 applier：评估 + 逐指令 transitionSoulPromise（source="evidence"）。
 * store 缺实现/未传 → {applied:0}；业务拒绝（{ok:false}，竞态已迁移）不计入 applied 不抛错。
 */
export async function applyPromiseEvidence(
  items: readonly PromiseEvidenceItem[],
  store: PromiseEvidenceStoreFace | undefined,
  tenant: unknown,
): Promise<{ applied: number }> {
  if (!store?.listSoulPromises || !store.transitionSoulPromise) return { applied: 0 };
  const rows = (await Promise.resolve(store.listSoulPromises(tenant, { status: "open", limit: 200 }))) as
    | Array<{ promiseId: string; status: string; refKey?: string }>
    | undefined;
  const directives = evaluatePromiseEvidence(items, rows ?? []);
  let applied = 0;
  for (const d of directives) {
    const r = (await Promise.resolve(
      store.transitionSoulPromise(tenant, d.promiseId, d.to, { source: "evidence", note: d.note }),
    )) as { ok?: boolean } | undefined;
    if (r?.ok === true) applied++;
  }
  return { applied };
}

/**
 * extraction 侧采集（intake helper）：仅 user 消息参与确认话语判定（assistant 文本绝不
 * 触发）；refKey=当前抽取任务上下文（taskId），无任务上下文 → refKey 缺省（评估阶段不迁移）。
 * 工具回执今日无可确定性采集信号（见头注释 intake 边界），不在此伪造。
 */
export function collectPromiseEvidenceFromExtraction(
  messages: readonly { role: string; content: string }[],
  taskId: string | undefined,
): PromiseEvidenceItem[] {
  const items: PromiseEvidenceItem[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const hit = matchConfirmationUtterance(m.content);
    if (!hit) continue;
    items.push({
      kind: "confirmation",
      verdict: hit.verdict,
      ...(taskId ? { refKey: taskId } : {}),
    });
  }
  return items;
}
