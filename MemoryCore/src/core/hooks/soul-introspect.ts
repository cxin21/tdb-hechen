/**
 * #36（R5）：soul_introspect——只读自省面（自省常驻注入=自我指涉噪声，故按需取用）。
 *
 * 三返回段（r5-36）：
 *  ① rendered——当前「仍在 Core 侧渲染」的 soul 片段：**只有 `<soul-feeling>`
 *     （近期基调 + 当下状态）**。人格段已移交 DSH 插件（2026-11-07 task-6），本面不再
 *     产出身份/红线/人格/价值锚文本；soulVersion 由双槽内容+基档次就地重算（纯读）。
 *     渲染零写入（渲染旁路快照落账已退役）。
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
import { buildSoulPrefix, computeSoulVersion, type SoulRenderOptions } from "./soul-assembler.js";
import { SOUL_CHANGE_REASONS, diffSoulSlots, parseSoulSlotMap, summarizeSoulDiff } from "./soul-versioning.js";

export interface IntrospectProbe {
  id: string;
  category: string;
  layer: string;
  expectContains?: string[];
  expectNotContains?: string[];
  expectRegex?: string;
}

/**
 * 快照条目（缺口 A：版本与漂移审计）。
 *  - ts/content_hash/trigger/diff 为既有行级面（逐位不变）；
 *  - version/parentHash/reasonCode/reasonDetail/slotDiff 仅当库里有版本列（新写入的
 *    快照）时出现——旧行/老 store 不写这些字段，旧断言逐位不受影响。
 */
export interface SoulIntrospectSnapshotEntry {
  ts: string;
  content_hash: string;
  trigger: string;
  diff?: { addedLines: number; removedLines: number };
  /** 该 tenant+slot 维度单调递增的版本号（首版=1）。 */
  version?: number;
  parentHash?: string | null;
  /** 受控变更原因枚举（soul-versioning.SOUL_CHANGE_REASONS）。 */
  reasonCode?: string;
  reasonDetail?: string;
  /** 键级 diff 摘要（slot:/value:/block: 键空间）。 */
  slotDiff?: { added: number; removed: number; changed: number; summary: string };
}

export interface SoulIntrospectResult {
  rendered: string;
  soulVersion?: string;
  snapshots: SoulIntrospectSnapshotEntry[];
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
    renderOpts?: SoulRenderOptions;
    snapshotLimit?: number;
    evidenceWindowHours?: number;
    probes?: IntrospectProbe[];
    evidence?: Array<{ content: string; at?: string }>;
  },
): Promise<SoulIntrospectResult> {
  const notes: string[] = [];
  const snapshotLimit = clampInt(opts?.snapshotLimit, 1, 200, 20);
  const evidenceWindowHours = clampInt(opts?.evidenceWindowHours, 1, 2160, 168);

  // —— ① 渲染全文（只剩 <soul-feeling>；渲染旁路快照落账已退役，唯一写者=card-service tick 末）——
  const rendered = await buildSoulPrefix(store, tenant, opts?.logger, opts?.renderOpts);
  // 人格渲染退役（2026-11-07 task-6/12）：buildSoulPrefix 不产出指纹，但自省面仍需一个
  // 「当前数据版本」供面板比对 → 就地按双槽内容 + 基调档位重算（纯读、零写入）。读槽失败
  // 只降级指纹，不阻塞自省。
  let soulVersion: string | undefined;
  {
    try {
      const slots = (await store.readCore?.(tenant)) ?? [];
      soulVersion = computeSoulVersion(
        slots.map((s) => ({ slot: String(s.slot ?? ""), content: String(s.content ?? "") })),
        [],
        opts?.renderOpts?.moodTier?.tier,
      );
    } catch {
      notes.push("soul-version-unavailable: readCore 失败，指纹降级为空");
    }
  }

  // —— ② 快照 + 相邻 diff ——
  const snapshots: SoulIntrospectResult["snapshots"] = [];
  if (!store.listSoulSnapshots) {
    notes.push("snapshot-surface-unavailable: store 未实现 listSoulSnapshots，快照段降级为空");
  } else {
    try {
      const all = await store.listSoulSnapshots(tenant, snapshotLimit);
      const tail = all.slice(-snapshotLimit);
      tail.forEach((r, i) => {
        const entry: SoulIntrospectSnapshotEntry = { ts: r.ts, content_hash: r.content_hash, trigger: r.trigger };
        // 缺口 A：版本链与变更原因（老行缺列 → 字段不出现，旧形状逐位不变）
        if (typeof r.version === "number" && r.version > 0) entry.version = r.version;
        if (r.parent_hash !== undefined) entry.parentHash = r.parent_hash;
        if (typeof r.trigger === "string" && (SOUL_CHANGE_REASONS as readonly string[]).includes(r.trigger)) {
          entry.reasonCode = r.trigger;
        }
        if (typeof r.reason_detail === "string" && r.reason_detail.length > 0) entry.reasonDetail = r.reason_detail;
        const prevRow = i > 0 ? tail[i - 1] : undefined;
        const prevSlots = parseSoulSlotMap(prevRow?.slots_json);
        const curSlots = parseSoulSlotMap(r.slots_json);
        if (Object.keys(curSlots).length > 0) {
          const d = diffSoulSlots(prevRow ? prevSlots : null, curSlots);
          entry.slotDiff = {
            added: d.added.length,
            removed: d.removed.length,
            changed: d.changed.length,
            summary: summarizeSoulDiff(d),
          };
        }
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
  // S8（2026-11-07）：价值锚整表已删除，孤儿锚检测随之退场（无渲染对象即无需低活性提示）。
  const orphanAnchors: SoulIntrospectResult["orphanAnchors"] = [];
  notes.push("orphan-scan-retired: S8 已删除价值锚，孤儿锚指标不再适用");

  return {
    rendered,
    soulVersion,
    snapshots,
    probes,
    orphanAnchors,
    evidenceWindowHours,
    notes,
  };
}
