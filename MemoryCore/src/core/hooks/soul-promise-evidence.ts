/**
 * #41（ADR0003-P3 实施票 C，2026-10-16）：promise 确定性证据门 —— (b) 证据通道单一源。
 *
 * 合同（#41 票面 + ADR0003 D8 确定性证据裁决 + 2026-10-16 对抗审查处置）：
 * 1. 确认话语 = 锚定全句白名单正则（^…$，禁止子串命中）且**必须带承诺指称**
 *    （审查 I2：裸赞同/裸否定「同意/不对/有问题」在任务语境与承诺语义混淆，叠加
 *    refKey 全量迁移+终态不可逆 → 误放向量过大；收窄为承诺语义锚定形态，宁缺毋滥，
 *    漏报由 (a) 人工显式 / (c) 提案采纳兜底）。
 * 2. 证据 → 迁移映射确定性：confirmation:kept→kept / confirmation:broken→broken /
 *    tool_failure→broken / tool_success→kept。不做任何 LLM 判定、不做内容模糊匹配。
 * 3. 关联 = promise.refKey === 证据 refKey 严格相等；双方任一缺 refKey → 不迁移
 *    （宁缺毋滥：确认话语本身不指名承诺，宁可不迁移）。refKey 命中时该任务上下文下的
 *    全部 open promise 参与迁移（一项证据影响其在途承诺全集）；同一 promise 多条证据
 *    首条生效（状态机单向不变式，终态拒绝由 store 复判兜底）。
 * 4. 陈旧证据守卫（审查 I3）：证据 at（user 消息 timestamp 的 ISO 化）早于
 *    promise.createdAt → 跳过——防「先有话语、后建 promise」的毒批重放把新 promise
 *    扫成终态；任一侧缺时间 → 不设防（不猜）。at 同时入 note 供审计。
 * 5. 判定来源溯源：迁移恒 stamp source="evidence"（soul_promise_events.source 列）；
 *    note 带命中正则序号 #pN（审查 M2）+ at。
 *
 * intake 边界（诚实降级）：extraction 侧今日可确定性采集的信号仅 user 确认话语
 * （L0 无 tool 角色、MemoryRecord 无 tool 回执标记——不猜）。tool_failure/tool_success
 * 证据项由本模块定义 intake 形状与映射，供未来工具回执接入方复用同一门（禁第二实现）。
 * 门 off（coreMemory.soulRender.promiseEvidence.enabled 缺省 false）= 零 promise 读零 promise 写。
 */

/** 门路径单一源（审查 C1 回归锁）：唯一生产调用点 pipeline-factory.ts:619 传
 *  memoryConfig=cfg（MemoryTdaiConfig 扁平接口，soulRender 在 coreMemory 子树）——
 *  门必须沿 cfg.coreMemory.soulRender 下钻；直下钻 soulRender 恒 undefined=死开关。
 *  实参刻意 unknown（调用方形状由本函数单点下钻，路径契约由
 *  config.soulrender-promise-evidence.test.ts 门路径 describe 用 parseConfig 产物钉死）。 */
export function promiseEvidenceGateEnabled(memoryConfig: unknown): boolean {
  return (
    (memoryConfig as { coreMemory?: { soulRender?: { promiseEvidence?: { enabled?: boolean } } } } | undefined)
      ?.coreMemory?.soulRender?.promiseEvidence?.enabled === true
  );
}

/**
 * 确认话语白名单（kept）：承诺指称 + 兑现动词；锚定全句，尾部仅允许语气/标点。
 * 审查 I2 收窄：裸「同意/收到/已完成」等无承诺指称形态一律移出（任务语境歧义）。
 */
export const PROMISE_CONFIRMATION_KEPT_PATTERNS: readonly RegExp[] = [
  // ① 承诺指称前缀 + 兑现动词：说好的做到了 / 答应的事办完了 / 承诺兑现了 / 答应你的搞定了
  // 中段字符类排除否定词（没/未/不）：防「说好的没做到」被中段吞否定后误判 kept
  //（kept 先于 broken 判定；否定语义必须落 broken 白名单，审查处置轮 RED 探针钉死）。
  /^(?:说(?:好|定)(?:的|了)|答应(?:的|了|过)?|承诺(?:的|了|过)?)(?:的|的事|那些事)?[^。！？\n没未不]{0,6}(?:做到|办到|办完|完成|兑现|搞定|落实)(?:了|完)?[的了呢吧。！!～~，,\s]*$/,
  // ② 指称主语 + 兑现动词：这些承诺都兑现了 / 全部承诺都完成了
  /^(?:这?些?(?:承诺|答应的事)|全部承诺|所有承诺)[^。！？\n没未不]{0,4}都?(?:兑现|办完|完成|做到)(?:了)?[的了呢吧。！!～~，,\s]*$/,
];

/**
 * 确认话语白名单（broken）：承诺指称 + 未兑现 / 承诺失信习语；锚定全句。
 * 审查 I2 收窄：裸「不对/不行/有问题/打回/返工」等可指纠错讨论的形态一律移出。
 */
export const PROMISE_CONFIRMATION_BROKEN_PATTERNS: readonly RegExp[] = [
  // ① 承诺指称前缀 + 未兑现动词：说好的没做到 / 承诺没兑现 / 答应的没有办完 / 承诺未兑现
  /^(?:说(?:好|定)(?:的|了)?|答应(?:的|了|过)?|承诺(?:的|了|过)?)(?:的|的事|那些事)?[^。！？\n]{0,6}(?:没|未|没有)(?:有)?(?:做到|办到|办完|完成|兑现|落地|算数)(?:了)?[的了呢吧。！!～~，,\s]*$/,
  // ② 承诺失信习语（承诺语义无歧义）：说话不算话 / 言而无信 / 食言了 / 失信了
  /^(?:说话不算话|言而无信|食言(?:了)?|失信(?:了)?)[的了呢吧。！!～~，,\s]*$/,
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
  | { kind: "confirmation"; verdict: PromiseConfirmationVerdict; patternIndex?: number; refKey?: string; at?: string; note?: string }
  | { kind: "tool_failure" | "tool_success"; refKey?: string; at?: string; note?: string };

/** 证据 → 目标状态的确定性映射（tool_failure→broken / tool_success→kept）。 */
function evidenceTarget(item: PromiseEvidenceItem): "kept" | "broken" {
  if (item.kind === "confirmation") return item.verdict;
  return item.kind === "tool_success" ? "kept" : "broken";
}

function evidenceKindLabel(item: PromiseEvidenceItem): string {
  return item.kind === "confirmation" ? `confirmation:${item.verdict}` : item.kind;
}

/** 证据迁移指令（note 恒带 [evidence:*#pN] 前缀+at，供 soul_promise_events 审计）。 */
export interface PromiseEvidenceDirective {
  promiseId: string;
  to: "kept" | "broken";
  note: string;
  evidenceKind: string;
}

/** 陈旧证据守卫（审查 I3）：证据 at 早于 promise.createdAt → true（跳过）。任一缺时间 → false。 */
function isStaleEvidence(itemAt: string | undefined, promiseCreatedAt: string | undefined): boolean {
  if (!itemAt || !promiseCreatedAt) return false;
  const a = Date.parse(itemAt);
  const c = Date.parse(promiseCreatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return false;
  return a < c;
}

/**
 * 纯裁决：证据项 × open promises → 迁移指令（确定性关联 + 陈旧守卫 + 每 promise 首条生效；
 * 零 IO 零副作用）。
 */
export function evaluatePromiseEvidence(
  items: readonly PromiseEvidenceItem[],
  openPromises: readonly { promiseId: string; status: string; refKey?: string; createdAt?: string }[],
): PromiseEvidenceDirective[] {
  const byRefKey = new Map<string, string[]>(); // refKey → open promiseIds（声明序）
  for (const p of openPromises) {
    if (p.status !== "open" || !p.refKey) continue;
    const list = byRefKey.get(p.refKey);
    if (list) list.push(p.promiseId);
    else byRefKey.set(p.refKey, [p.promiseId]);
  }
  const createdAtById = new Map(openPromises.map((p) => [p.promiseId, p.createdAt] as const));
  const directives: PromiseEvidenceDirective[] = [];
  const consumed = new Set<string>(); // promiseId 首条生效
  for (const item of items) {
    if (!item.refKey) continue; // 证据缺 refKey → 不迁移（宁缺毋滥）
    const ids = byRefKey.get(item.refKey);
    if (!ids) continue;
    for (const promiseId of ids) {
      if (consumed.has(promiseId)) continue;
      if (isStaleEvidence(item.at, createdAtById.get(promiseId))) continue; // 陈旧重放：不迁移也不消费
      consumed.add(promiseId);
      const pIdx = item.kind === "confirmation" && item.patternIndex !== undefined ? `#p${item.patternIndex}` : "";
      directives.push({
        promiseId,
        to: evidenceTarget(item),
        note: `[evidence:${evidenceKindLabel(item)}${pIdx}]${item.at ? ` at=${item.at}` : ""}${item.note ? ` ${item.note}` : ""}`.trim(),
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
 * list 上限 1000（store listSoulPromises 硬上限；open 承诺超限=已登记运维边界，见票评）。
 * store 缺实现/未传 → {applied:0}；业务拒绝（{ok:false}，竞态已迁移）不计入 applied 不抛错。
 */
export async function applyPromiseEvidence(
  items: readonly PromiseEvidenceItem[],
  store: PromiseEvidenceStoreFace | undefined,
  tenant: unknown,
): Promise<{ applied: number }> {
  if (!store?.listSoulPromises || !store.transitionSoulPromise) return { applied: 0 };
  const rows = (await Promise.resolve(store.listSoulPromises(tenant, { status: "open", limit: 1000 }))) as
    | Array<{ promiseId: string; status: string; refKey?: string; createdAt?: string }>
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
 * 触发）；refKey=当前抽取任务上下文（taskId），无任务上下文 → refKey 缺省（评估阶段不迁移）；
 * timestamp（epoch ms）→ at（ISO，审查 I3 陈旧守卫输入），缺省/非法 → 无 at。
 * 工具回执今日无可确定性采集信号（见头注释 intake 边界），不在此伪造。
 */
export function collectPromiseEvidenceFromExtraction(
  messages: readonly { role: string; content: string; timestamp?: number }[],
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
      patternIndex: hit.patternIndex,
      ...(taskId ? { refKey: taskId } : {}),
      ...(typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? { at: new Date(m.timestamp).toISOString() } : {}),
    });
  }
  return items;
}
