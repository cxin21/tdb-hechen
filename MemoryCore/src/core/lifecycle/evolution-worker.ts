/**
 * P4b 受控正文演化 · worker（GROW-EVO §4，REG-REMAINING-005 #1）。
 *
 * 形态：离线 worker，挂 lifecycle tick（与 consolidation/forgetting/anchor-growth 同款）；
 * ingestion 路径逐位不变。这是全系统唯一允许改写已固化正文的路径，门必须最严
 * （错误不对称：门严=不触发，良性；门松=错误改写正文，污染难恢复——spec §7.1 拍板③）。
 *
 * 设计最优性审查定案（2026-09-17，REG-REMAINING-005 #1 实施前置红队，全部真实代码/数据实证）：
 *  1. 幂等标记 = evolved_from 审计边参与集（任一端点已在 evolved_from 边上→跳过）。
 *     不能用旧记录 valid_end 当幂等标记：P2 内联失效（l1-extractor conflict 分支）在写入
 *     瞬间已给旧记忆置 valid_end（vectors.db 实测 08:12/14:37 两条真矛盾边 TGT 均已置位），
 *     拿它当标记会让 worker 永远跳过全部真矛盾对。审计边兼任幂等标记，协议内聚。
 *  2. 门①（spec：dedup LLM 给了 rationale）降级为"conflict 边存在"——rationale 从未落盘
 *     （全库 grep 零命中，存量边亦无），再验证职责移交本 worker 单次 LLM 调用的 skip 分支
 *     （spec §4.3"低置信→只留 conflict 边"本就预留该分支，语义等价）。spec 偏差已登记 CHANGELOG。
 *  3. 门⑤ pin/veto：L1 记录无 pin/veto 机制（仅 core_values 锚有）——实现为
 *     metadata.pinned/vetoed 真值检查（前瞻协议位，当前恒过）。
 *  4. 合并/失效边界（v5 硬要求）：LLM prompt 内置反例指令——新记忆已叙事化包含旧值
 *     （如 session-h"从 CMAS 改学 PADI"）= 归纳合并，不是待消解矛盾 → skip，
 *     绝不系统性推翻 extractor 的合并决定；golden 测试双向断言（evolution-worker.test.ts）。
 *  5. 写路径全部走 store 层（upsertL1 双表同步 / invalidateL1 双表同步 / addLink），
 *     复用 invalidateL1 教训的纪律；新记录 metadata-only（无 embedding，consolidation
 *     持续态同款先例，FTS 路召回不受损；向量覆盖缺口登记 v5 观察项 O7）。
 *
 * 五条件门（spec §4.2，实现口径）：
 *  ① conflict 边存在（见上 #2）    ② 双方 certainty='observed'
 *  ③ 双方 metadata.subject 非空且严格相等（null≠null：无同主题证据不放行，宁缺毋滥）
 *  ④ 新.occurred_at 晚于旧（方向不信任边方向，按 occurred_at 判定）
 *  ⑤ 双方未被 pin/veto（见上 #3）  +  新值未被失效（valid_end 空）、无 evolved_from 幂等边
 *
 * 观察期遥测（spec §4.5）：门条件逐项计数，日志行 gate={...}。
 */
import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";

/** memory.evolution 配置（config-first：enabled 缺省 false = 逐位现状）。 */
export interface EvolutionWorkerConfig {
  enabled: boolean;
  /** 单轮最多重写多少对（LLM 成本护栏；spec §4.4 缺省 3）。 */
  maxRewrites: number;
  /** 进程内节流（重启归零=多做一次幂等扫描，无害——幂等由 evolved_from 边保证）。 */
  intervalMs: number;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionWorkerConfig = {
  enabled: false,
  maxRewrites: 3,
  intervalMs: 3_600_000,
};

/** 合并正文长度上限（协议护栏：LLM 失控输出不得灌爆正文；硬编码+注明=安全 clamp）。 */
const MAX_MERGED_CONTENT_CHARS = 2000;

const SYSTEM_PROMPT =
  "你是记忆系统的矛盾消解审查器。给你两条被提取阶段判定为互相矛盾的记忆（同一主题的新旧记录）。" +
  "严格判断这是否属于【同一事实的新旧值真矛盾】（如计划时间变更、状态反转、数值更新）。" +
  "以下情况必须返回 skip，绝不重写：\n" +
  "1. 新记忆已经以叙事方式包含旧记忆的值（如「从 CMAS 改学 PADI」）——这是归纳合并后的叙事，不是待消解矛盾；\n" +
  "2. 两条记忆描述的是不同事实（提取阶段误判冲突）；\n" +
  "3. 矛盾可以并存（不同子项/不同场景/不冲突的补充）。\n" +
  '仅当确属同字段真矛盾时返回 {"action":"rewrite","content":"<合并后的单条记忆正文，保留仍然成立的最新事实，可简述沿革，不超过500字>","reason":"<一句话审计理由>"}；' +
  '否则返回 {"action":"skip","reason":"<一句话原因>"}。只输出 JSON，不要多余文本。';

/** 进程内节流戳（GROW-RACE 同款考量：scheduler 已有 runOnceInFlight 互斥，这里只做间隔门）。 */
let lastRunAtMs = 0;

/** 待演化矛盾对端点的宽松行形状（scheduler mapL1RowToRecord 产出：id 兜底 + metadata 已解析）。 */
type EvoRow = {
  id?: string; record_id?: string; content?: string; type?: string; priority?: number; scene_name?: string;
  certainty?: string; occurred_at?: string; valid_start?: string; valid_end?: string;
  valence?: number | null; arousal?: number | null; significance?: number | null;
  teamId?: string; userId?: string; agentId?: string; taskId?: string;
  team_id?: string; user_id?: string; agent_id?: string; task_id?: string;
  metadata?: Record<string, unknown>;
};

function pickTenant(r: EvoRow): { teamId: string; userId: string; agentId: string; taskId: string } {
  return {
    teamId: r.teamId ?? r.team_id ?? "default",
    userId: r.userId ?? r.user_id ?? "default",
    agentId: r.agentId ?? r.agent_id ?? "default",
    taskId: r.taskId ?? r.task_id ?? "",
  };
}

function subjectOf(r: EvoRow): string {
  const s = (r.metadata as Record<string, unknown> | undefined)?.subject;
  return typeof s === "string" ? s.trim() : "";
}

function isPinnedOrVetoed(r: EvoRow): boolean {
  const m = (r.metadata ?? {}) as Record<string, unknown>;
  return m.pinned === true || m.vetoed === true;
}

/** LLM 回复 JSON 解析（容忍 ``` 围栏；解析失败=低置信，走 skip——宁缺毋滥）。 */
function parseLlmReply(raw: string): { action: string; content?: string; reason?: string } | null {
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const v = JSON.parse(stripped.slice(start, end + 1)) as { action?: unknown; content?: unknown; reason?: unknown };
    if (typeof v.action !== "string") return null;
    return {
      action: v.action,
      content: typeof v.content === "string" ? v.content : undefined,
      reason: typeof v.reason === "string" ? v.reason : undefined,
    };
  } catch {
    return null;
  }
}

export interface EvolutionRunResult {
  ran: boolean;
  /** 扫描的 conflict 边（去重对）数。 */
  scanned: number;
  /** 通过全部确定性门、进入 LLM 重写判定的对数。 */
  candidates: number;
  /** 实际完成重写（新记录 + evolved_from×2 + 双旧失效）的对数。 */
  rewrites: number;
  /** ran=false 时的首个拦截原因（v4#7 summary 行同款纪律）。 */
  skipped?: string;
  /** 门条件逐项计数（spec §4.5 观察期遥测；将来放宽门时以 this 为数据依据）。 */
  gate?: Record<string, number>;
}

export interface EvolutionWorkerDeps {
  /** 全量 L1 行（scheduler 同款 queryL1——mapL1RowToRecord 映射后：id 兜底 + metadata 解析）。 */
  queryL1: () => Promise<Array<unknown>>;
  llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> } | null;
  config?: Partial<EvolutionWorkerConfig>;
  store?: IMemoryStore;
  logger?: Logger;
}

export async function runEvolution(deps: EvolutionWorkerDeps): Promise<EvolutionRunResult> {
  const cfg = { ...DEFAULT_EVOLUTION_CONFIG, ...(deps.config ?? {}) };
  if (!cfg.enabled) return { ran: false, scanned: 0, candidates: 0, rewrites: 0, skipped: "disabled" };
  if (!deps.llmRunner) return { ran: false, scanned: 0, candidates: 0, rewrites: 0, skipped: "no-llm" };
  const store = deps.store;
  if (!store?.getLinksByType || !store.upsertL1 || !store.addLink || !store.invalidateL1) {
    return { ran: false, scanned: 0, candidates: 0, rewrites: 0, skipped: "store-missing-primitives" };
  }
  // 进程内节流：未到间隔不消费本轮（与 anchor-growth 消费语义一致：到点即消费，0 候选也记时间）。
  const nowMs = Date.now();
  if (lastRunAtMs > 0 && nowMs - lastRunAtMs < cfg.intervalMs) {
    return { ran: false, scanned: 0, candidates: 0, rewrites: 0, skipped: "interval" };
  }
  lastRunAtMs = nowMs;

  const gate: Record<string, number> = {
    dangling: 0, crossTenant: 0, certainty: 0, subject: 0, timeOrder: 0,
    pin: 0, newerInvalid: 0, idempotent: 0, staleLineage: 0, maxRewrites: 0, llmSkip: 0, llmError: 0,
  };
  const log = deps.logger;
  try {
    const edges = await store.getLinksByType("conflict");
    // 幂等集：已参与 evolved_from 边的端点（本 worker 与既有审计边的联合记忆）。
    const evolved = new Set<string>();
    try {
      for (const e of (await store.getLinksByType("evolved_from")) ?? []) {
        evolved.add(e.sourceId); evolved.add(e.targetId);
      }
    } catch { /* 审计边读取失败不阻断扫描（首次运行为空集） */ }

    const rows = (await deps.queryL1()) as Array<EvoRow>;
    const byId = new Map<string, EvoRow>();
    for (const r of rows) {
      const id = r.id ?? r.record_id;
      if (typeof id === "string" && id) byId.set(id, r);
    }

    // 去重（无向对；A-conflict-B 与 B-conflict-A 视为同一对）。
    const pairs = new Map<string, { a: string; b: string }>();
    for (const e of edges ?? []) {
      const key = [e.sourceId, e.targetId].sort().join("|");
      if (!pairs.has(key)) pairs.set(key, { a: e.sourceId, b: e.targetId });
    }

    const maxRewrites = Math.max(1, Math.floor(cfg.maxRewrites));
    let rewrites = 0;
    let candidates = 0;
    let attempts = 0; // 单轮 LLM 调用计数（maxRewrites=单轮调用与重写总量上限，最保守成本口径）

    for (const pair of pairs.values()) {
      const ra = byId.get(pair.a);
      const rb = byId.get(pair.b);
      // 悬挂边（端点已归档/被 filter 收窄）——vectors.db 实测 7 条边中 3 条悬挂，必须容错。
      if (!ra || !rb) { gate.dangling++; continue; }
      const ta = pickTenant(ra); const tb = pickTenant(rb);
      if (ta.teamId !== tb.teamId || ta.userId !== tb.userId || ta.agentId !== tb.agentId) { gate.crossTenant++; continue; }
      const cert = (r: EvoRow) => (typeof r.certainty === "string" && r.certainty ? r.certainty : "observed");
      if (cert(ra) !== "observed" || cert(rb) !== "observed") { gate.certainty++; continue; }
      const sa = subjectOf(ra); const sb = subjectOf(rb);
      if (!sa || !sb || sa !== sb) { gate.subject++; continue; }
      const oa = Date.parse(ra.occurred_at ?? ""); const ob = Date.parse(rb.occurred_at ?? "");
      if (!Number.isFinite(oa) || !Number.isFinite(ob) || oa === ob) { gate.timeOrder++; continue; }
      const older = oa < ob ? ra : rb;
      const newer = oa < ob ? rb : ra;
      if ((newer.valid_end ?? "") !== "") { gate.newerInvalid++; continue; }
      if (isPinnedOrVetoed(ra) || isPinnedOrVetoed(rb)) { gate.pin++; continue; }
      if (evolved.has(older.id!) || evolved.has(newer.id!)) {
        // 链式残差遥测（O10 预登记，spec §4.5 同款"数据先行、不松门"）：链式同主题观测
        // （B(t1)→C(t2)→A(t3)，dedup 按到达时序建边）合并 (B,C) 后，(A,*) 对因老端已入
        // evolved_from 参与集被跳过，终态 = 新端（最新真值）与谱系叙事（断言被推翻的中间值）
        // 双 valid 并存——可能的残差张力。此计数 >0 即触发预留的 lineage-remap 方案（把老端
        // 解析到谱系产物再合并，收敛为单条），当前不松门（spec §7.1 拍板③：门松=污染难恢复；
        // 产线尚无链式实例，先立观察）。注意：新端已失效或已演化时不计（无残差）。
        if (!evolved.has(newer.id!) && (newer.valid_end ?? "") === "") gate.staleLineage++;
        gate.idempotent++; continue;
      }
      if (attempts >= maxRewrites) { gate.maxRewrites++; continue; }
      attempts++;
      candidates++;

      // 单次 LLM 受控重写（GROW-EVO P2.1 裁定：maxTokens=0/timeoutMs=0——Ark 推理模型
      // thinking 会吃满缺省 4096 返回空文本；0 = 不限制，llm-runner 语义）。
      const soul = (r: EvoRow) => JSON.stringify({
        content: r.content, type: r.type, occurred_at: r.occurred_at, valid_start: r.valid_start,
        certainty: cert(r), significance: r.significance, valence: r.valence, arousal: r.arousal,
      });
      let reply: string;
      try {
        reply = await deps.llmRunner.run({
          systemPrompt: SYSTEM_PROMPT,
          prompt:
            `主题（两记忆 metadata.subject 一致）：${sa}\n` +
            `记忆A（旧，occurred_at=${older.occurred_at ?? ""}）：${soul(older)}\n` +
            `记忆B（新，occurred_at=${newer.occurred_at ?? ""}）：${soul(newer)}\n` +
            `注意：若记忆B已叙事化包含记忆A的值（归纳合并），必须 skip。`,
          taskId: "evolution-worker",
          maxTokens: 0,
          timeoutMs: 0,
        });
      } catch (err) {
        gate.llmError++;
        log?.warn?.(`[evolution] LLM call failed for pair ${older.id}/${newer.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const parsed = parseLlmReply(reply ?? "");
      if (!parsed || parsed.action !== "rewrite" || !parsed.content || !parsed.content.trim()) {
        gate.llmSkip++;
        log?.debug?.(`[evolution] LLM skip for pair ${older.id}/${newer.id}: ${(parsed?.reason ?? "unparseable").slice(0, 120)}`);
        continue;
      }

      // 演化动作（spec §4.3）：合并单条 + evolved_from×2 审计边 + 双旧失效。
      const nowIso = new Date().toISOString();
      const tn = pickTenant(newer);
      const sigOld = typeof older.significance === "number" ? older.significance : null;
      const sigNew = typeof newer.significance === "number" ? newer.significance : null;
      const merged = {
        id: `evo_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
        content: parsed.content.trim().slice(0, MAX_MERGED_CONTENT_CHARS),
        type: newer.type || "episodic",
        priority: Math.max(typeof older.priority === "number" ? older.priority : 50, typeof newer.priority === "number" ? newer.priority : 50),
        scene_name: newer.scene_name ?? "",
        sessionKey: "evolution",
        sessionId: "evolution",
        teamId: tn.teamId, userId: tn.userId, agentId: tn.agentId, taskId: tn.taskId,
        version: 1,
        timestamps: [newer.occurred_at ?? nowIso],
        createdAt: nowIso,
        updatedAt: nowIso,
        metadata: {
          ...((newer.metadata ?? {}) as Record<string, unknown>),
          subject: sa,
          evidence_ids: [older.id, newer.id],
          // spec §4.3：created_by='evolution' + metadata.evolution={from,reason}（审计三件套之二，其一是边）
          created_by: "evolution",
          evolution: { from: [older.id, newer.id], reason: parsed.reason ?? "" },
        },
        occurred_at: newer.occurred_at ?? nowIso,
        // bi-temporal：合并事实的有效起点沿用旧值起点（旧值何时开始成立就何时开始）
        valid_start: (older.valid_start ?? "") || (older.occurred_at ?? ""),
        valid_end: "",
        certainty: "observed",
        source: "evolution",
        valence: newer.valence ?? null,
        arousal: newer.arousal ?? null,
        significance: sigOld !== null || sigNew !== null ? Math.max(sigOld ?? 0, sigNew ?? 0) : null,
      };
      if (!store.upsertL1(merged as never, undefined)) {
        gate.llmError++;
        log?.warn?.(`[evolution] upsertL1 failed for merged record of ${older.id}/${newer.id} — 只留 conflict 边（宁缺毋滥）`);
        continue;
      }
      // 审计边 + 失效（invalidateL1 首次权威不覆盖：旧值多半已被 P2 内联失效，此处幂等收尾；
      // 旧值失效时点语义 = 新观察发生时（与 P2 内联一致），新值失效时点 = 演化发生时）。
      store.addLink(merged.id, older.id!, "evolved_from", 1);
      store.addLink(merged.id, newer.id!, "evolved_from", 1);
      store.invalidateL1(older.id!, newer.occurred_at || nowIso);
      store.invalidateL1(newer.id!, nowIso);
      evolved.add(older.id!); evolved.add(newer.id!);
      rewrites++;
      log?.info?.(`[evolution] rewrote pair ${older.id} + ${newer.id} → ${merged.id} (subject=${sa}, reason=${(parsed.reason ?? "").slice(0, 80)})`);
    }

    log?.info?.(`[evolution] ran: scanned=${pairs.size} candidates=${candidates} rewrites=${rewrites} maxRewrites=${maxRewrites} gate=${JSON.stringify(gate)}`);
    return { ran: true, scanned: pairs.size, candidates, rewrites, gate };
  } catch (err) {
    log?.warn?.(`[evolution] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, scanned: 0, candidates: 0, rewrites: 0, skipped: "error", gate };
  }
}