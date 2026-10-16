/**
 * #26（R5）：soul/core 重叠观测 observer + 组合 observer。
 *
 * 原则（observer.ts 同款）：
 *   - fire-and-forget：journal 写入不 await、失败静默（best-effort 观测）
 *   - 错误隔离：本 observer 任何异常都不传播到管线
 *   - 跨钩子聚合：soul 内容（tdai L1 召回钩子）与 core 内容（tdai profile 钩子）
 *     分属不同钩子，按 `${sessionKey}:${turnSeq}` 聚合，onPipelineEnd 落盘
 *
 * 零行为变化：只读 blocks，不改注入字节。
 */

import type {
  AgentContextMetadata,
  ContextBlock,
  InjectionHook,
  InjectionPoint,
} from "./types.js";
import type { HookResult, InjectionObserver } from "./observer.js";
import {
  appendJournalEntry,
  buildJournalEntry,
} from "./soul-overlap-journal.js";
import path from "node:path";

/** #26 journal 配置（InjectionConfig.soulOverlapJournal）。 */
export interface SoulOverlapJournalOptions {
  enabled?: boolean;
  /** JSONL 输出文件；缺省 <cwd>/data/soul-overlap-journal.jsonl。 */
  file?: string;
}

interface TurnBuffer {
  blocks: { content: string }[];
}

function legacyTurnKey(meta: AgentContextMetadata): string {
  const sessionKey = (meta as { sessionKey?: string })?.sessionKey ?? "unknown";
  const turnSeq = (meta as { turnSeq?: number })?.turnSeq;
  return `${sessionKey}:${typeof turnSeq === "number" ? turnSeq : "unknown"}`;
}

/** #38（R5-F2 root）：聚合主键=请求级 requestId（`req:<id>`）；缺省回退 legacy 键
 *  （sessionKey:turnSeq，跨 handler 可碰撞）并一次性 warn 提示调用方升级。 */
function turnKey(meta: AgentContextMetadata, warnedLegacy?: { v: boolean }): string {
  const requestId = (meta as { requestId?: string })?.requestId;
  if (requestId) return `req:${requestId}`;
  if (warnedLegacy && !warnedLegacy.v) {
    warnedLegacy.v = true;
    console.warn("[soul-overlap-journal] meta 缺 requestId，回退 legacy turnKey（跨 handler 可碰撞；调用方应升级至管线入口分配 requestId）");
  }
  return legacyTurnKey(meta);
}

/**
 * soul/core 重叠观测 observer。config-first：仅当
 * `injection.soulOverlapJournal.enabled === true` 时由 buildPipelineBundle 装配。
 */
export class SoulOverlapJournalObserver implements InjectionObserver {
  private buffers = new Map<string, TurnBuffer>();
  /** R5-F2：保守丢弃可见性——并发多活跃轮期间 onHookDone 块被丢弃的累计次数。 */
  private dropped = 0;
  /** #38：legacy 回退一次性 warn 旗标。 */
  private legacyWarned = { v: false };

  constructor(private readonly options: SoulOverlapJournalOptions) {}

  /** 观测诚实性：丢弃计数可被运维/报告面读取（首次丢弃时 warn 一次，防日志刷屏）。 */
  get droppedCount(): number {
    return this.dropped;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      const key = turnKey(meta, this.legacyWarned);
      // R5-F2b：同键二次 start 复用而非覆盖（工具循环共享 legacy 键时宁混勿丢）；
      // #38 后正常路径每管线一个唯一 requestId，同键复用只剩 legacy 回退场景会走到。
      if (this.buffers.has(key)) {
        console.warn(`[soul-overlap-journal] 同 turnKey 复用 buffer（前管线未结束）：${key}`);
        return;
      }
      this.buffers.set(key, { blocks: [] });
    } catch { /* never throw */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(
    _hook: InjectionHook,
    _point: InjectionPoint,
    blocks: ContextBlock[],
    _durationMs: number,
    _cacheStrategy?: string,
    requestId?: string,
  ): void {
    try {
      // #38（R5-F2 root）：requestId 在场 → 直达路由（并发多活跃 buffer 也不串轮）；
      // 缺省（旧调用方/单测）→ 沿用保守策略：仅一个活跃 buffer 才挂，避免串轮污染。
      if (requestId) {
        const buf = this.buffers.get(`req:${requestId}`);
        if (!buf) return; // 未知 requestId（start 未达/已结束）→ 丢弃（宁缺毋假挂）
        buf.blocks.push(...(blocks ?? []));
        return;
      }
      if (this.buffers.size !== 1) {
        this.dropped++;
        if (this.dropped === 1) {
          console.warn("[soul-overlap-journal] 并发多活跃轮，onHookDone 块保守丢弃（计数 droppedCount 可查）");
        }
        return;
      }
      const buf = this.buffers.values().next().value;
      if (!buf) return;
      buf.blocks.push(...(blocks ?? []));
    } catch { /* never throw */ }
  }

  onPipelineEnd(meta: AgentContextMetadata, _durationMs: number, _results: HookResult[]): void {
    try {
      const key = turnKey(meta, this.legacyWarned);
      const buf = this.buffers.get(key);
      this.buffers.delete(key);
      if (!buf || buf.blocks.length === 0) return;
      const entry = buildJournalEntry(buf.blocks, meta as { sessionKey?: string; turnSeq?: number });
      if (!entry) return;
      const file =
        this.options.file ||
        path.join(process.cwd(), "data", "soul-overlap-journal.jsonl");
      appendJournalEntry(file, entry);
    } catch { /* journal is best-effort; never throw */ }
  }

  onPipelineError(meta: AgentContextMetadata, _error: Error): void {
    try {
      this.buffers.delete(turnKey(meta, this.legacyWarned));
    } catch { /* never throw */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void { /* noop */ }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookError(
    _hook: InjectionHook,
    _point: InjectionPoint,
    _error: Error,
    _durationMs: number,
  ): void { /* noop */ }
}

/**
 * 组合 observer：把 journal 与既有 observer（Langfuse/Logging/Noop）串联。
 * 逐个调用、逐个吞异常，保持「observer 永不阻断管线」原则。
 */
export class CompositeInjectionObserver implements InjectionObserver {
  constructor(private readonly children: InjectionObserver[]) {}

  onPipelineStart(meta: AgentContextMetadata): void {
    for (const c of this.children) { try { c.onPipelineStart(meta); } catch { /* isolated */ } }
  }

  onPipelineEnd(meta: AgentContextMetadata, durationMs: number, results: HookResult[]): void {
    for (const c of this.children) { try { c.onPipelineEnd(meta, durationMs, results); } catch { /* isolated */ } }
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    for (const c of this.children) { try { c.onPipelineError(meta, error); } catch { /* isolated */ } }
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    for (const c of this.children) { try { c.onHookStart(hook, point); } catch { /* isolated */ } }
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
    requestId?: string,
  ): void {
    for (const c of this.children) {
      try { c.onHookDone(hook, point, blocks, durationMs, cacheStrategy, requestId); } catch { /* isolated */ }
    }
  }

  onHookError(hook: InjectionHook, point: InjectionPoint, error: Error, durationMs: number): void {
    for (const c of this.children) { try { c.onHookError(hook, point, error, durationMs); } catch { /* isolated */ } }
  }
}
