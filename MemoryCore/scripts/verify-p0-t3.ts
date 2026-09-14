/**
 * P0-T3 同形验证：atomic/update 漏拷 soul 8 字段 —— 编辑一次 = 灵魂记忆被洗白。
 *
 * 红线背景（E1）：/v3/atomic/update 的 handler（v2-router.ts handleAtomicUpdate）构造
 * updated 记录时只搬 content/background/租户/版本等字段，漏拷 soul 8 字段
 * （occurred_at/valid_start/valid_end/certainty/source/valence/arousal/significance）。
 * sqlite upsertL1 的 ON CONFLICT 对这 8 列全部 `col=excluded.col` 全列覆盖，
 * 而 upsertL1 绑定处对缺省 soul 字段有列语义回退（occurred_at ?? ""、certainty ?? "observed"、
 * REAL ?? null）→ 编辑后 occurred_at 被刷成 ""（遗忘引擎 ageDaysOf 恒 0，永不归档）、
 * valence/arousal/significance 清成 NULL（情感清零）、inferred 记忆被静默晋升成 observed
 * （信任边界破坏）。
 * 修复：updated 构造时从既有行补拷 8 字段（null/空透传，不造默认值——update 不走
 * writeMemory choke point，那里的 P0 默认逻辑不适用）。
 *
 * 三部分证据（同 verify-p0-t2.ts 的分段结构）：
 *   [A] 静态证据：stmtUpsertMeta 的 ON CONFLICT DO UPDATE SET 对 8 个 soul 列
 *       全部 excluded.* 覆盖 —— 任何 upsert 行缺字段都会刷掉原值（修复必要性，修复后仍成立）。
 *   [B] 真实链路（对照 A 记录，完整 soul + certainty=observed）：临时 sqlite 库
 *       （VectorStore dimensions=0）→ 真实 handleAtomicUpdate（不 mock，v2-router 导出的
 *       生产 handler）只改 content → 读回断言 8 列逐项相等（valid_start/end 空值保持空，
 *       不被填造的默认值）+ content 已改 + version 自增。
 *   [C] 信任边界（对照 B 记录，certainty=inferred）：编辑后 certainty 仍是 inferred
 *       —— 修复前会被刷成 "observed"（编辑即晋升，比清零更危险）。
 *   [D] 遗忘引擎可用性：读回行顶层 occurred_at → age > 200 天，且生产 scorer.classify
 *       （内部走 ageDaysOf 同一条时间锚路径）判 archive —— 证明时间锚活下来后
 *       遗忘引擎恢复可用（修复前 age 恒 0 → 恒 keep）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p0-t3.ts
 *
 * 只用自建临时数据，不连任何线上资源；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleAtomicUpdate, type V2RouterDeps } from "../src/gateway/v2-router.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { classify } from "../src/core/lifecycle/forgetting/scorer.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

// ── fixture（import 生产类型定义；生产加字段此处编译报错）──
// 记录 A：用户给定形态 —— 完整 soul（occurred_at=2026-01-01、observed、情感齐全）
const SEED_A = {
  occurred_at: "2026-01-01T00:00:00Z",
  certainty: "observed" as const,
  source: "user",
  valence: 0.7,
  arousal: 0.4,
  significance: 0.9,
  // valid_start / valid_end：留空 —— 断言 null/空透传，不造默认值
};
// 记录 B：信任边界对照 —— inferred 不许被编辑晋升成 observed
const SEED_B = {
  occurred_at: "2026-02-15T00:00:00Z",
  certainty: "inferred" as const,
  source: "system",
  valence: -0.2,
  arousal: 0.1,
  significance: 0.3,
};

const CONTENT_A_ORIG = "T3 用户在周三的评审会上拍板了混合检索方案（原始内容）";
const CONTENT_A_NEW = "T3 用户在周三的评审会上拍板了混合检索方案（编辑后的新内容）";
const CONTENT_B_ORIG = "T3 推断：用户可能偏好本地部署（推断其一）";
const CONTENT_B_NEW = "T3 推断：用户可能偏好本地部署（推断其一，编辑后）";

const mk = (id: string, content: string, soul: typeof SEED_A): MemoryRecord =>
  ({
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "verify-p0-t3",
    source_message_ids: [],
    metadata: {},
    timestamps: [soul.occurred_at],
    createdAt: soul.occurred_at,
    updatedAt: soul.occurred_at,
    version: 0,
    sessionKey: "verify-p0-t3",
    sessionId: "verify-p0-t3",
    ...soul,
  }) as MemoryRecord;

// ── [A] 静态证据：ON CONFLICT 对 soul 8 列全列覆盖 ────────────────
console.log("=".repeat(72));
console.log("[A] 静态证据：stmtUpsertMeta 的 ON CONFLICT 对 soul 8 列全部 excluded.* 覆盖");
console.log("=".repeat(72));

const sqliteSrc = fs.readFileSync(
  new URL("../src/core/store/sqlite.ts", import.meta.url),
  "utf8",
);
const conflictMatch = sqliteSrc.match(
  /ON CONFLICT\(record_id\) DO UPDATE SET([\s\S]*?)`;/,
);
const conflictBody = conflictMatch?.[1]?.replace(/\s+/g, " ") ?? "(未找到)";
const SOUL_COLUMNS = [
  "occurred_at", "valid_start", "valid_end", "certainty",
  "source", "valence", "arousal", "significance",
] as const;
const covered = SOUL_COLUMNS.filter((c) =>
  conflictBody.includes(`${c}=excluded.${c}`),
);
const aPass = conflictMatch !== null && covered.length === SOUL_COLUMNS.length;
console.log(`ON CONFLICT 覆盖列：${covered.join(", ") || "(无)"}`);
console.log(
  aPass
    ? "[A] PASS: soul 8 列全部被 excluded.* 覆盖 → upsert 行缺 soul 字段必刷掉原值，" +
        "handler 构造 updated 时必须补拷（修复必要性钉死）"
    : "[A] FAIL: 静态证据不符（upsertL1 覆盖语义若变更，本验证需同步更新）",
);

// ── [B]/[C]/[D] 真实链路 ──────────────────────────────────────────
console.log("");
console.log("=".repeat(72));
console.log("[B/C/D] 真实链路：临时 sqlite 库 + 生产 handleAtomicUpdate（不 mock）只改 content");
console.log("=".repeat(72));

type Row = {
  record_id: string; content: string; version: number;
  occurred_at?: string | null; valid_start?: string | null; valid_end?: string | null;
  certainty?: string | null; source?: string | null;
  valence?: number | null; arousal?: number | null; significance?: number | null;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p0-t3-"));
const dbPath = path.join(tmpDir, "vectors.db");
let bPass = false;
let cPass = false;
let dPass = false;
let exitCode = 1;

try {
  const store = new VectorStore(dbPath, 0);
  const initRes = store.init();
  if (store.isDegraded()) {
    console.log(`[B] FAIL: 临时库初始化降级（环境问题，非行为断言）：${initRes.reason}`);
  } else {
    const memA = mk("t3_mem_a", CONTENT_A_ORIG, SEED_A);
    const memB = mk("t3_mem_b", CONTENT_B_ORIG, SEED_B);
    store.upsertL1(memA, undefined);
    store.upsertL1(memB, undefined);
    console.log(`临时库：${dbPath}（dimensions=0），已写入 t3_mem_a(observed 完整 soul) + t3_mem_b(inferred)`);

    const rowById = (id: string): Row | undefined =>
      (store.queryL1Records() as Row[]).find((r) => r.record_id === id);

    // 落库前置检查：soul 列值必须与 fixture 一致（排除写入链路问题）
    const beforeA = rowById("t3_mem_a");
    const beforeB = rowById("t3_mem_b");
    const seedOk =
      beforeA?.occurred_at === SEED_A.occurred_at &&
      beforeA?.certainty === "observed" &&
      beforeA?.valence === 0.7 &&
      beforeA?.arousal === 0.4 &&
      beforeA?.significance === 0.9 &&
      beforeA?.source === "user" &&
      beforeB?.certainty === "inferred";
    if (!seedOk) {
      console.log(`[B] FAIL: 落库 soul 列与 fixture 不符（fixture/写入链路问题，非 update 行为）：` +
        `A=${JSON.stringify(beforeA)}, B.certainty=${JSON.stringify(beforeB?.certainty)}`);
    } else {
      console.log("落库前置检查：两条记忆 soul 列与 fixture 一致");

      const deps = {
        getStore: () => store,
        getEmbedding: () => undefined,
        getStorage: () => undefined,
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        deployMode: "standalone" as const,
      } as unknown as V2RouterDeps;

      // ── 真实 handler：只改 content ──
      const respA = await handleAtomicUpdate(
        { id: "t3_mem_a", content: CONTENT_A_NEW },
        { apiKey: "verify", serviceId: "verify-p0-t3" },
        "req-verify-p0-t3-a",
        deps,
      );
      const respB = await handleAtomicUpdate(
        { id: "t3_mem_b", content: CONTENT_B_NEW },
        { apiKey: "verify", serviceId: "verify-p0-t3" },
        "req-verify-p0-t3-b",
        deps,
      );
      console.log(`handleAtomicUpdate 返回：A code=${respA.code}，B code=${respB.code}`);
      // ApiResponseEnvelope 成功语义：code===0（v2/v3 通用信封 {code,message,request_id,data}）
      if (respA.code !== 0 || respB.code !== 0) {
        console.log("[B] FAIL: handler 未成功（链路/参数问题，非 soul 行为）");
      } else {
        const afterA = rowById("t3_mem_a");
        const afterB = rowById("t3_mem_b");

        // ── [B] 记录 A：8 列逐项对照（valid_start/end 空值保持空）──
        console.log("");
        console.log("[B] 记录 A（observed 完整 soul）编辑后 8 列逐项对照：");
        console.log("  列             期望               实际");
        const expectA: Array<[string, unknown, unknown]> = [
          ["occurred_at", SEED_A.occurred_at, afterA?.occurred_at],
          ["valid_start", null, afterA?.valid_start],
          ["valid_end", null, afterA?.valid_end],
          ["certainty", "observed", afterA?.certainty],
          ["source", "user", afterA?.source],
          ["valence", 0.7, afterA?.valence],
          ["arousal", 0.4, afterA?.arousal],
          ["significance", 0.9, afterA?.significance],
        ];
        // 空值语义：行读回可能给 null 或 ""（TEXT 列缺省 ""）；两者都算"空透传"
        const emptyOk = (v: unknown) => v === null || v === undefined || v === "";
        const mismatches = expectA.filter(([name, want, got]) =>
          want === null ? !emptyOk(got) : got !== want,
        );
        for (const [name, want, got] of expectA) {
          const ok = want === null ? emptyOk(got) : got === want;
          console.log(`  ${name.padEnd(14)} ${JSON.stringify(want).padEnd(18)} ${JSON.stringify(got)}  ${ok ? "OK" : "≠ FAIL"}`);
        }
        const contentChanged = afterA?.content === CONTENT_A_NEW && afterA?.content !== CONTENT_A_ORIG;
        const versionBumped = afterA?.version === 1;
        console.log(`  content        (编辑生效)          ${contentChanged ? "已替换为新内容" : "未生效"}`);
        console.log(`  version        (0 → 1)             ${JSON.stringify(afterA?.version)}`);
        bPass = mismatches.length === 0 && contentChanged && versionBumped;
        if (bPass) {
          console.log("[B] PASS: 8 列逐项相等（null 仍空，未造默认值），content 已改、version 已自增");
        } else if (mismatches.length > 0) {
          console.log(`[B] FAIL: 编辑把 soul 列刷掉：${mismatches.map(([n, w, g]) => `${n} 期望 ${JSON.stringify(w)} 实际 ${JSON.stringify(g)}`).join("; ")} —— E1 复现`);
        } else {
          console.log("[B] FAIL: soul 保留但 content/version 断言不符");
        }

        // ── [C] 记录 B：inferred 不被晋升 ──
        console.log("");
        const cOk =
          afterB?.certainty === "inferred" &&
          afterB?.occurred_at === SEED_B.occurred_at &&
          afterB?.source === "system" &&
          afterB?.valence === -0.2 &&
          afterB?.arousal === 0.1 &&
          afterB?.significance === 0.3 &&
          afterB?.content === CONTENT_B_NEW;
        console.log(
          `[C] 记录 B（inferred）编辑后：certainty=${JSON.stringify(afterB?.certainty)}，` +
            `occurred_at=${JSON.stringify(afterB?.occurred_at)}，valence=${JSON.stringify(afterB?.valence)}，` +
            `content=${contentBChanged(afterB?.content)} → ` +
            (cOk ? "PASS: inferred 未被晋升，soul 完整保留" : "FAIL: " + (afterB?.certainty === "observed" ? "编辑把 inferred 晋升成 observed（信任边界破坏）" : "soul 列被刷掉")),
        );
        cPass = cOk;

        // ── [D] 遗忘引擎可用性：occurred_at 活下来 → age>200 → classify=archive ──
        console.log("");
        const occurred = afterA?.occurred_at ?? "";
        const ageDays = occurred ? (Date.now() - new Date(occurred).getTime()) / 86_400_000 : 0;
        const recalled: MemoryRecord = {
          id: "t3_mem_a",
          content: afterA?.content ?? "",
          type: "episodic",
          priority: afterA?.priority ?? 70,
          scene_name: afterA?.scene_name ?? "verify-p0-t3",
          source_message_ids: [],
          metadata: {},
          timestamps: occurred ? [occurred] : [],
          createdAt: occurred,
          updatedAt: occurred,
          version: afterA?.version ?? 0,
          sessionKey: "verify-p0-t3",
          sessionId: "verify-p0-t3",
          occurred_at: occurred || undefined,
          certainty: (afterA?.certainty as "observed" | "inferred") ?? undefined,
        } as MemoryRecord;
        const verdict = classify(recalled); // 生产 scorer：内部走 ageDaysOf 同一条时间锚路径
        dPass = ageDays > 200 && verdict === "archive";
        console.log(
          `[D] 遗忘引擎：读回 occurred_at=${JSON.stringify(occurred)} → age≈${Math.floor(ageDays)} 天` +
            `（断言 >200），scorer.classify → ${verdict}（断言 archive，生产 ageDaysOf 路径可用）→ ` +
            (dPass ? "PASS: 时间锚活下来，遗忘引擎恢复归档能力" : "FAIL: " + (ageDays <= 200 ? "age 恒 0/过小 → 永不归档" : "classify 未按预期归档")),
        );
      }
    }
    store.close();
  }
  exitCode = aPass && bPass && cPass && dPass ? 0 : 1;
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
  }
}

function contentBChanged(c: string | undefined): string {
  return c === CONTENT_B_NEW ? "已替换" : JSON.stringify(c);
}

console.log("");
console.log(
  `总体：${exitCode === 0 ? "PASS" : "FAIL"}（A=${aPass ? "PASS" : "FAIL"}, B=${bPass ? "PASS" : "FAIL"}, C=${cPass ? "PASS" : "FAIL"}, D=${dPass ? "PASS" : "FAIL"}）`,
);
process.exit(exitCode);
