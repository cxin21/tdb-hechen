/**
 * #138 活体探针（只读）：对**运行中的网关**发 /v3/recall，记录注入构成与门观测。
 * 用途：生产落 additive/routing 前后各跑一次，用同一组查询对照「经验行数、结论行数、
 * 回捞上下文行、gates.smallToBig、routing 是否命中」——不写记忆、不改配置。
 *
 * 用法：node scripts/audit/r138-live-probe.mjs [--base http://127.0.0.1:8420] [--key <gateway apiKey>]
 *   key 缺省取 yaml 的 server.apiKey；--key "" 表示不带鉴权头。
 * 说明：探针只调 /v3/recall（读侧），零写入。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const base = String(arg("base", "http://127.0.0.1:8420")).replace(/\/$/, "");
let key = arg("key", undefined);
if (key === undefined) {
  try {
    const yaml = fs.readFileSync(path.join(REPO, "tdai-gateway.yaml"), "utf8");
    const m = yaml.match(/^\s{2}apiKey:\s*"([^"]+)"/m) || yaml.match(/^\s*apiKey:\s*"([^"]+)"/m);
    key = m ? m[1] : "";
  } catch { key = ""; }
}
const tenant = {
  teamId: String(arg("team", "team-2k12lgb650")),
  userId: String(arg("user", "usr-2m7b1144d9")),
  agentId: String(arg("agent", "agt-2m7buribzz")),
};
const QUERIES = [
  { id: "user-fact", q: "我上次说过的采购订单测试环境地址是什么？" },
  { id: "kupdate", q: "云文库二期的接口调研做到哪一步了？" },
  { id: "assistant-recall", q: "Can you remind me what ratio you told me to dilute the tea tree oil with?" },
  { id: "advice", q: "Can you recommend some resources where I can learn more about video editing?" },
];

const call = async (query) => {
  // 网关 /v3 要求严格隔离（422）：team_id / agent_id / user_id / session_id（snake_case）
  const body = {
    team_id: tenant.teamId,
    user_id: tenant.userId,
    agent_id: tenant.agentId,
    session_id: "r138-live-probe",
    query,
    strategy: "hybrid",
  };
  const t0 = Date.now();
  const res = await fetch(base + "/v3/recall", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": "default",
      ...(key ? { authorization: "Bearer " + key } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  const d = json?.data ?? json ?? {};
  const meta = d.meta ?? {};
  // /v3/recall 响应只有 { block, meta }：记忆行在 <relevant-memories>…</relevant-memories> 段，
  // soul 身份段不是记忆行——必须按段裁出来再数，否则会把身份条目误算成经验行。
  const block = typeof d.block === "string" ? d.block : "";
  const seg = block.match(/<relevant-memories>([\s\S]*?)<\/relevant-memories>/);
  const lines = (seg ? seg[1] : "").split("\n").map((s) => s.trim()).filter((s) => s.startsWith("- "));
  return {
    query,
    status: res.status,
    ms: Date.now() - t0,
    lines: lines.length,
    conclusionLines: lines.filter((l) => l.startsWith("- [结论") || l.startsWith("- [work_fact")).length,
    contextLines: lines.filter((l) => l.includes("[上下文")).length,
    experienceLines: lines.filter((l) => /^- \[(?!结论|work_fact|上下文)/.test(l)).length,
    metaKeys: Object.keys(meta),
    layered: meta.layered ?? d.layered,
    conclusionCount: meta.conclusionCount ?? d.conclusionCount,
    experienceCount: meta.experienceCount ?? d.experienceCount,
    gates: d.gates ?? meta.gates ?? null,
    sample: lines.slice(0, 3).map((l) => l.slice(0, 90)),
    raw: json === null ? text.slice(0, 200) : undefined,
  };
};

console.log("# #138 活体探针（只读）→ " + base);
for (const { id, q } of QUERIES) {
  try {
    const r = await call(q);
    const s2b = r.gates?.smallToBig;
    console.log(`\n[${id}] status=${r.status} ms=${r.ms} lines=${r.lines} 结论=${r.conclusionLines} 上下文=${r.contextLines} 经验=${r.experienceLines} meta(cc=${r.conclusionCount ?? "-"},ec=${r.experienceCount ?? "-"},layered=${r.layered ?? "-"})`);
    console.log("  gates.smallToBig=" + (s2b ? JSON.stringify(s2b) : "(absent)"));
    if (r.raw) console.log("  raw: " + r.raw);
    for (const s of r.sample) console.log("  · " + s);
  } catch (e) {
    console.log(`\n[${id}] 调用失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
