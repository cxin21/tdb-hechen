/**
 * 审计 M6/M7/M8 + #170 的单测：报告可信度门禁（判分覆盖率）、生效配置快照、
 * 成本口径段、报告归档脚本。
 *
 * 这些断言直接对应本次审计的病根：
 *  - r141 五臂被同名重跑覆盖成 judged=0，旧管线只渲染只比 Δ，从不检查「判分有没有跑」
 *    → judgeGate 必须 invalid 且调用方 exit 非 0；
 *  - 报告只记 CLI 覆盖值，底配来自 gitignored 的 tdai-gateway.yaml
 *    → effective 快照必须给出最终生效值 + 逐键来源；
 *  - 同名报告就地覆盖 → 归档脚本必须只改名不删数据，缺省 dry-run；
 *  - 文档把「embedding 占检索子阶段 94.8%」当端到端 → cost.attribution 两个分母分开算。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  attachJudgingStatus,
  enforceJudgeGate,
  judgeCoverage,
  judgeGate,
  JUDGE_COVERAGE_MIN,
} from "../scripts/lib/bench/report.mjs";
import { buildCostSection } from "../scripts/lib/bench/cost.mjs";

const judgedRow = (n: number) => ({
  caseId: `c${n}`,
  questionType: "single-session-user",
  latencyMs: 100,
  // 口径：只是数值才算判过（judge.mjs 写 0/1 分），布尔值不算——这本身就是防呆。
  genCorrect: 1,
});
const unjudgedRow = (n: number) => ({
  caseId: `c${n}`,
  questionType: "single-session-user",
  latencyMs: 100,
});
const reportOf = (rows: any[], judgeModel: string | null = "scm-flash") => ({
  config: judgeModel == null ? {} : { judgeModel },
  rows,
});

describe("判分存在性门禁（M8）", () => {
  it("全覆盖 + 判分器在案 ⇒ 通过", () => {
    const g = judgeGate(reportOf([judgedRow(1), judgedRow(2)]));
    expect(g.ok).toBe(true);
    expect(g.invalid).toBe(false);
    expect(g.coverage).toBe(1);
    expect(g.issues).toEqual([]);
  });

  it("覆盖率 50% < 95% ⇒ invalid，错误直指覆盖率", () => {
    const g = judgeGate(reportOf([judgedRow(1), unjudgedRow(2)]));
    expect(g.invalid).toBe(true);
    expect(g.coverage).toBe(0.5);
    expect(g.issues.join("\n")).toContain("判分覆盖 1/2=50.0%");
    expect(g.hint).toContain("bench-rejudge");
  });

  it("judged=0（重跑覆盖后现场）⇒ invalid 且标 retrievalOnly", () => {
    const g = judgeGate(reportOf([unjudgedRow(1), unjudgedRow(2)]));
    expect(g.invalid).toBe(true);
    expect(g.judged).toBe(0);
    expect(g.retrievalOnly).toBe(true);
    expect(g.issues.join("\n")).toContain("judged=0");
  });

  it("有判分行但 judgeModel 缺失 ⇒ invalid（判分器不可考，不可跨尺配对）", () => {
    const g = judgeGate(reportOf([judgedRow(1)], null));
    expect(g.invalid).toBe(true);
    expect(g.issues.join("\n")).toContain("config.judgeModel 缺失");
  });

  it("rows 为空 ⇒ invalid（无题行，统计无意义）", () => {
    const g = judgeGate(reportOf([]));
    expect(g.invalid).toBe(true);
    expect(g.issues.join("\n")).toContain("rows 为空");
  });

  it("allowUnjudged 只放行检索-only 档，放不过半判分档", () => {
    const only = judgeGate(reportOf([unjudgedRow(1)]), { allowUnjudged: true });
    expect(only.invalid).toBe(false);
    expect(only.issues.length).toBeGreaterThan(0);

    const half = judgeGate(reportOf([judgedRow(1), unjudgedRow(2)]), { allowUnjudged: true });
    expect(half.invalid).toBe(true);
  });

  it("enforceJudgeGate 返回 3 作为进程退出码，放行时返回 0", () => {
    expect(enforceJudgeGate(reportOf([unjudgedRow(1)]), { label: "r141-b0" })).toBe(3);
    expect(enforceJudgeGate(reportOf([judgedRow(1)]))).toBe(0);
  });

  it("attachJudgingStatus 用严格口径写 judging.invalid（检索-only 也记 true）", () => {
    const r = reportOf([unjudgedRow(1), unjudgedRow(2)]);
    const j = attachJudgingStatus(r);
    expect(j.invalid).toBe(true);
    expect(j.coverage).toBe(0);
    expect((r as any).judging.invalid).toBe(true);

    const ok = reportOf([judgedRow(1)]);
    expect(attachJudgingStatus(ok).invalid).toBe(false);
  });

  it("覆盖率阈值常量就是 0.95", () => {
    expect(JUDGE_COVERAGE_MIN).toBe(0.95);
  });
});

describe("成本与延迟口径（#170）", () => {
  const rows = [
    {
      caseId: "a",
      questionType: "q1",
      question: "问题一",
      block: "abcdef",
      latencyMs: 200,
      searchTiming: { ftsMs: 10, embeddingMs: 90, factMs: 0, expandMs: 0 },
      perfMs: { total: 210, l1: 190 },
    },
    {
      caseId: "b",
      questionType: "q2",
      question: "问题二",
      block: "ghijkl",
      latencyMs: 400,
      searchTiming: { ftsMs: 20, embeddingMs: 180, factMs: 0, expandMs: 0 },
    },
  ];

  it("recallMs 的 p50/p95 按行延迟插值计算", () => {
    const c = buildCostSection(rows as any);
    expect(c.summary.recallMs.n).toBe(2);
    expect(c.summary.recallMs.p50).toBe(300);
    expect(c.summary.recallMs.p95).toBeCloseTo(390, 6);
  });

  it("embedding 占的是「检索子阶段」，不是端到端（旧文档 94.8% 的分母）", () => {
    const c = buildCostSection(rows as any);
    // 子阶段合计 = (10+90)+(20+180) = 300；embedding = 270 ⇒ 0.9
    expect(c.attribution.embeddingShareOfStages).toBe(0.9);
    // 端到端召回 = (200+400)=600 ⇒ 子阶段只占 0.5，两者不可互换
    expect(c.attribution.stagesOfRecall).toBe(0.5);
    expect(c.caliber.stages).toContain("子阶段");
  });

  it("rerankMs 未埋点就记 null，不拿 l1 聚合冒充", () => {
    const c = buildCostSection(rows as any);
    expect(c.perQuestion[0].stages.rerankMs).toBeNull();
    expect(c.summary.stages.rerankMs.n).toBe(0);
    expect(c.perQuestion[0].perfMs).toEqual({ total: 210, l1: 190 });
  });

  it("缺 searchTiming / 缺 answer 时字段为 null 而不是 NaN", () => {
    const c = buildCostSection([{ caseId: "x", question: "q", latencyMs: 50 }] as any);
    expect(c.perQuestion[0].stages.ftsMs).toBeNull();
    expect(c.perQuestion[0].retrievalStageMs).toBeNull();
    expect(c.perQuestion[0].completionTokens).toBeNull();
    expect(c.perQuestion[0].promptTokens).toBeGreaterThan(0);
    expect(c.summary.stages.ftsMs.n).toBe(0);
  });
});

describe("归档脚本（M7）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, "../scripts/archive-bench-reports.mjs");

  const mkLegacy = (dir: string, name: string, generatedAt: string) => {
    const body = {
      generatedAt,
      config: { effectiveConfig: { "recall.maxResults": 5 } },
      rows: [{ caseId: "c1", latencyMs: 1 }],
    };
    fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(body), "utf8");
    fs.writeFileSync(path.join(dir, name + ".md"), "# report\n", "utf8");
  };

  it("缺省 dry-run 不改文件；--apply 改名并重建 latest.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-archive-"));
    try {
      mkLegacy(tmp, "r141-b0", "2026-10-31T06:23:09.000Z");
      mkLegacy(tmp, "r141-w3", "2026-10-31T07:23:58.000Z");
      fs.writeFileSync(path.join(tmp, "already-20261031-000000-deadbeef.json"), "{}", "utf8");

      const dry = spawnSync(process.execPath, [script, "--dir", tmp], { encoding: "utf8" });
      expect(dry.status).toBe(0);
      expect(fs.existsSync(path.join(tmp, "r141-b0.json"))).toBe(true);
      expect(fs.readdirSync(tmp).some((f) => /^r141-b0-\d{8}-\d{6}-[0-9a-f]{8}\.json$/.test(f))).toBe(false);

      const run = spawnSync(process.execPath, [script, "--dir", tmp, "--apply"], { encoding: "utf8" });
      expect(run.status).toBe(0);
      const files = fs.readdirSync(tmp);
      const b0 = files.find((f) => /^r141-b0-20261031-062309-[0-9a-f]{8}\.json$/.test(f));
      const w3 = files.find((f) => /^r141-w3-20261031-072358-[0-9a-f]{8}\.json$/.test(f));
      expect(b0).toBeTruthy();
      expect(w3).toBeTruthy();
      // .md 跟着走，原文件不再存在（改名而非复制，避免同一读数两份）
      expect(files).toContain(b0!.replace(/\.json$/, ".md"));
      expect(files).not.toContain("r141-b0.json");
      // 已符合规范的与 latest 不被动
      expect(files).toContain("already-20261031-000000-deadbeef.json");

      const latest = JSON.parse(fs.readFileSync(path.join(tmp, "latest.json"), "utf8"));
      expect(latest.report).toBe(w3); // generatedAt 最新的一份
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("无 rows 的 JSON 不被当报告改名", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-archive2-"));
    try {
      fs.writeFileSync(path.join(tmp, "notes.json"), JSON.stringify({ hello: "world" }), "utf8");
      const run = spawnSync(process.execPath, [script, "--dir", tmp, "--apply"], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(fs.readdirSync(tmp)).toEqual(["notes.json"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("生效配置快照（M6）", () => {
  it("沙箱 yaml 的值进入 effective 且来源标 cli；缺省键标 default", async () => {
    const { readEffectiveBenchConfig } = await import("../scripts/lib/bench/effective-config.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-eff-"));
    try {
      const yamlPath = path.join(tmp, "bench-gateway.yaml");
      fs.writeFileSync(
        yamlPath,
        [
          "memory:",
          "  recall:",
          "    maxResults: 7",
          "    candidateK: 40",
          "    validity:",
          "      mode: soft",
          "    rerank:",
          "      enabled: true",
          "",
        ].join("\n"),
        "utf8",
      );
      const ec = await readEffectiveBenchConfig({ sandboxYaml: yamlPath, dataDir: tmp });
      expect(ec.meta.error).toBeUndefined();
      expect(ec.values["recall.maxResults"]).toBe(7);
      expect(ec.values["recall.candidateK"]).toBe(40);
      expect(ec.sources["recall.maxResults"]).toBe("cli");
      expect(ec.sources["recall.injectWrapper"]).toBe("default");
      // 派生三态：mode=soft 时真正生效的是 soft（#174 的语义经 core 的同一函数取，不在这里复刻）
      expect(ec.values["recall.validity.mode"]).toBe("soft");
      expect(ec.values["recall.excludeInvalidated.effective"]).toBe("soft");
      expect(ec.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // lead 2026-10-31 追加：softPenalty（实验臂钉非缺省）与证据包两键必须能自证。
  // 否则 vsp(soft+0.25) 与 vs(soft+缺省 0.5) 的 config.effective 完全相同、指纹也相同，差值无从归因。
  it("softPenalty 与 evidencePack 两键进快照，且 defaults 给出纯代码缺省", async () => {
    const { readEffectiveBenchConfig } = await import("../scripts/lib/bench/effective-config.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-eff2-"));
    try {
      const yamlPath = path.join(tmp, "bench-gateway.yaml");
      fs.writeFileSync(
        yamlPath,
        [
          "memory:",
          "  recall:",
          "    validity:",
          "      mode: soft",
          "      softPenalty: 0.25",
          "    evidencePack:",
          "      enabled: true",
          "      adjacent: 2",
          "",
        ].join("\n"),
        "utf8",
      );
      const ec = await readEffectiveBenchConfig({ sandboxYaml: yamlPath, dataDir: tmp });
      expect(ec.meta.error).toBeUndefined();
      // 实验值原样进快照、来源标 cli；缺省层同时给出 0.5，报告才能写「实验值，非缺省」
      expect(ec.values["recall.validity.softPenalty"]).toBe(0.25);
      expect(ec.sources["recall.validity.softPenalty"]).toBe("cli");
      expect(ec.defaults["recall.validity.softPenalty"]).toBe(0.5);
      expect(ec.values["recall.evidencePack.enabled"]).toBe(true);
      expect(ec.values["recall.evidencePack.adjacent"]).toBe(2);
      expect(ec.defaults["recall.evidencePack.enabled"]).toBe(false);
      expect(ec.defaults["recall.evidencePack.adjacent"]).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 两份快照（bench 的 effective-config.ts 与 store.mjs 的 effectiveRecallSnapshot）必须同源同值：
  // 一份进报告自证、一份给 --expect-config 断言；漂了就是「断言绿、报告红」的假绿。
  it("与 store.mjs effectiveRecallSnapshot 在交集键上逐键对拍", async () => {
    const { readEffectiveBenchConfig } = await import("../scripts/lib/bench/effective-config.ts");
    const { effectiveRecallSnapshot } = await import("../scripts/lib/bench/store.mjs");
    const { loadGatewayConfig } = await import("../src/gateway/config.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-eff3-"));
    const yamlPath = path.join(tmp, "bench-gateway.yaml");
    const prevCfg = process.env.TDAI_GATEWAY_CONFIG;
    const prevData = process.env.TDAI_DATA_DIR;
    try {
      fs.writeFileSync(
        yamlPath,
        [
          "memory:",
          "  recall:",
          "    maxResults: 7",
          "    candidateK: 40",
          "    validity:",
          "      mode: soft",
          "      softPenalty: 0.25",
          "    evidencePack:",
          "      enabled: true",
          "      adjacent: 3",
          "",
        ].join("\n"),
        "utf8",
      );
      const ec = await readEffectiveBenchConfig({ sandboxYaml: yamlPath, dataDir: tmp });
      process.env.TDAI_GATEWAY_CONFIG = yamlPath;
      process.env.TDAI_DATA_DIR = tmp;
      const cfg = loadGatewayConfig().memory;
      const st = effectiveRecallSnapshot(cfg);
      const shared = Object.keys(st).filter((k) => k in ec.values);
      expect(shared.length).toBeGreaterThan(5);
      for (const k of shared) expect([k, ec.values[k]]).toEqual([k, st[k]]);
    } finally {
      if (prevCfg === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
      else process.env.TDAI_GATEWAY_CONFIG = prevCfg;
      if (prevData === undefined) delete process.env.TDAI_DATA_DIR;
      else process.env.TDAI_DATA_DIR = prevData;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("拿不到沙箱 yaml 时记录 error 并退回代码缺省，不抛", async () => {
    const { readEffectiveBenchConfig } = await import("../scripts/lib/bench/effective-config.ts");
    const ec = await readEffectiveBenchConfig({ sandboxYaml: null });
    expect(ec.meta.error).toBeTruthy();
    // WP1b：maxResults 代码缺省 5 → 10（§24/§25.6 k=10 读数）
    expect(ec.values["recall.maxResults"]).toBe(10);
    expect(ec.sources["recall.maxResults"]).toBe("default");
  });
});
