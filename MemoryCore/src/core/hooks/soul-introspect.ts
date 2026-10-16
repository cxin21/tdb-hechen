/**
 * #36（R5）：soul_introspect——只读自省面（自省常驻注入=自我指涉噪声，故按需取用）。
 *
 * 三返回段（r5-36）：
 *  ① rendered——当前 soul 全量渲染文本（buildSoulPrefix 强制 snapshotsEnabled:false，
 *     零写入；soulVersion 经 metaOut 带出）。
 *  ② snapshots——最近 N 次快照 + 相邻行级 diff（added/removed；listSoulSnapshots
 *     ASC 取尾 N；store 未实现快照面 → 空段+note 如实降级）。
 *  ③ probes——调用方可注入 IdentityProbe 形状清单（默认不注入 → null + note 如实
 *     降级：探针为 CI 测试资产，src 不反向 import 测试文件）；注入时对 rendered
 *     评估 contains/notContains/regex。
 * 孤儿锚检测（R5 修正：#22 落地后悬空无对象，改「低活性指标」）：证据窗
 * （evidenceWindowHours，缺省 168h）内的证据语料（调用方传入 corpus，窗按行
 * 时间戳过滤）对锚 label 零命中 → orphan。判定有据=窗口+语料+逐锚命中数全量返回；
 * 无语料 → 全列+note（仅供低活性参考，非删除建议）。
 *
 * 零写入路径（R-A 边界）：不落库、不写快照、不改任何状态；纯读+纯函数评估。
 */
import type { CoreTenant, IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";
import { buildSoulPrefix, type SoulRenderOptions } from "./soul-assembler.js";

export interface IntrospectProbe {
  id: string;
  category: string;
  layer: string;
  expectContains?: string[];
  expectNotContains?: string[];
  expectRegex?: string;
}

export interface SoulIntrospectResult {
  rendered: string;
  soulVersion?: string;
  snapshots: Array<{ ts: string; content_hash: string; trigger: string; diff?: { addedLines: number; removedLines: number } }>;
  probes: Array<{ id: string; category: string; layer: string; passed: boolean; reason?: string }> | null;
  orphanAnchors: Array<{ label: string; evidenceHits: number }>;
  evidenceWindowHours: number;
  notes: string[];
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(Math.floor(v), hi)) : dflt;

export async function introspectSoul(
  store: IMemoryStore,
  tenant: CoreTenant,
  opts?: {
    logger?: Logger;
    renderOpts?: Omit<SoulRenderOptions, "snapshotsEnabled">;
    snapshotLimit?: number;
    evidenceWindowHours?: number;
    probes?: IntrospectProbe[];
    evidence?: Array<{ content: string; at?: string }>;
  },
): Promise<SoulIntrospectResult> {
  const notes: string[] = [];
  const snapshotLimit = clampInt(opts?.snapshotLimit, 1, 200, 20);
  const evidenceWindowHours = clampInt(opts?.evidenceWindowHours, 1, 2160, 168);

  // —— ① 渲染全文（零写入：snapshotsEnabled 强制 false，旁路快照尾写+缓存补账）——
  const metaOut: { soulVersion?: string } = {};
  const rendered = await buildSoulPrefix(
    store,
    tenant,
    opts?.logger,
    { ...(opts?.renderOpts ?? {}), snapshotsEnabled: false },
    metaOut,
  );

  // —— ② 快照 + 相邻 diff ——
  const snapshots: SoulIntrospectResult["snapshots"] = [];
  if (!store.listSoulSnapshots) {
    notes.push("snapshot-surface-unavailable: store 未实现 listSoulSnapshots，快照段降级为空");
  } else {
    try {
      const all = await store.listSoulSnapshots(tenant, snapshotLimit);
      const tail = all.slice(-snapshotLimit);
      tail.forEach((r, i) => {
        const entry: SoulIntrospectResult["snapshots"][number] = { ts: r.ts, content_hash: r.content_hash, trigger: r.trigger };
        if (i > 0) {
          const prev = new Set(tail[i - 1].payload_json.split("\n"));
          const cur = r.payload_json.split("\n");
          const curSet = new Set(cur);
          const prevSet = prev;
          entry.diff = {
            addedLines: cur.filter((l) => !prevSet.has(l)).length,
            removedLines: [...prevSet].filter((l) => !curSet.has(l)).length,
          };
        }
        snapshots.push(entry);
      });
    } catch (err) {
      notes.push(`snapshot-read-failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // —— ③ 探针段（注入才评，缺省如实降级）——
  let probes: SoulIntrospectResult["probes"] = null;
  if (opts?.probes && opts.probes.length > 0) {
    probes = opts.probes.map((p) => {
      for (const s of p.expectContains ?? []) {
        if (!rendered.includes(s)) return { id: p.id, category: p.category, layer: p.layer, passed: false, reason: `missing:${s}` };
      }
      for (const s of p.expectNotContains ?? []) {
        if (rendered.includes(s)) return { id: p.id, category: p.category, layer: p.layer, passed: false, reason: `forbidden-present:${s}` };
      }
      if (p.expectRegex !== undefined) {
        try {
          if (!new RegExp(p.expectRegex).test(rendered)) {
            return { id: p.id, category: p.category, layer: p.layer, passed: false, reason: `regex-miss:${p.expectRegex}` };
          }
        } catch {
          return { id: p.id, category: p.category, layer: p.layer, passed: false, reason: `regex-invalid:${p.expectRegex}` };
        }
      }
      return { id: p.id, category: p.category, layer: p.layer, passed: true };
    });
  } else {
    notes.push("probes-not-provided: 探针为 CI 测试资产（soul-identity-probes），src 不反向 import；按需经 gateway body 注入评估");
  }

  // —— 孤儿锚（低活性指标；#22 后悬空已无渲染对象，此项只读呈现）——
  const orphanAnchors: SoulIntrospectResult["orphanAnchors"] = [];
  try {
    const values = (await store.listValues?.(tenant)) ?? [];
    const active = values.filter((v) => v.state === "active" || v.state === undefined);
    const now = Date.now();
    const win = evidenceWindowHours * 3_600_000;
    let corpus = opts?.evidence ?? [];
    if (!opts?.evidence || opts.evidence.length === 0) {
      notes.push("evidence-corpus-empty: 无证据语料，孤儿检测全列（仅供低活性参考，非删除建议）");
    }
    corpus = corpus.filter((e) => {
      if (e.at === undefined) return true; // 无时间戳证据按窗内处理（保守）
      const t = Date.parse(e.at);
      if (Number.isNaN(t)) return true;
      return now - t <= win;
    });
    for (const v of active) {
      const hits = corpus.filter((e) => e.content.includes(v.label)).length;
      if (hits === 0) orphanAnchors.push({ label: v.label, evidenceHits: 0 });
    }
  } catch (err) {
    notes.push(`orphan-scan-failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    rendered,
    soulVersion: metaOut.soulVersion,
    snapshots,
    probes,
    orphanAnchors,
    evidenceWindowHours,
    notes,
  };
}
