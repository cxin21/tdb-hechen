/**
 * assistant 提取漏损实证探针（REG-REMAINING-003 #3，观测先行）。
 *
 * 目的：对 flowtest session-d 的 12 条消息重复 N 次完整提取（生产同构 LLM + 提取判据），
 * 逐消息统计命中率——区分"系统性排除"（恒 0 命中）与"随机漏损"（部分命中）。
 * 隔离：每次 run 写入独立临时 baseDir（records JSONL），不触碰生产存储。
 *
 * 用法（MemoryCore 目录内）：
 *   npx tsx scripts/extraction-loss-probe.mjs --runs 3
 *
 * 配置：读 /data/tdai-memory/config-override.json 的 llm 段（运行时读取，密钥不入库）。
 * 消息源：/data/tdai-memory/conversations/2026-09-16.jsonl 中 session-flowtest-20260916-d。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONV_FILE = "/data/tdai-memory/conversations/2026-09-16.jsonl";
const SESSION_ID = "session-flowtest-20260916-d";
const CONFIG_FILE = "/data/tdai-memory/config-override.json";
const RUNS_IDX = process.argv.indexOf("--runs");
const RUNS = RUNS_IDX >= 0 ? Number(process.argv[RUNS_IDX + 1]) || 3 : 3;

// 每条消息的判别 token（内容锚，非角色）——assistant 3 条在前（本实验的关注面）
const PROBES = [
  { msg: 3, role: "assistant", label: "咖啡手冲参数表", re: /咖啡|手冲|粉水比|92/ },
  { msg: 6, role: "assistant", label: "马拉松训练复盘", re: /马拉松|marathon/i },
  { msg: 10, role: "assistant", label: "鸟类观察清单", re: /观鸟|红嘴蓝鹊|鸟类|鸟种/ },
  { msg: 11, role: "user", label: "颈椎操", re: /颈椎/ },
  { msg: 12, role: "user", label: "茶馆随笔集", re: /茶馆|随笔/ },
  { msg: 1, role: "user", label: "书法晨练", re: /书法|颜体|楷书/ },
  { msg: 2, role: "user", label: "多肉植物", re: /多肉|玄机/ },
  { msg: 4, role: "user", label: "旧书市集", re: /旧书|科幻小说/ },
  { msg: 5, role: "user", label: "日语 N2", re: /日语|N2|背五十/ },
  { msg: 7, role: "user", label: "黑猫煤球", re: /煤球|黑猫/ },
  { msg: 8, role: "user", label: "木炭炉欧包", re: /木炭|欧包|酵种/ },
  { msg: 9, role: "user", label: "胶片扫描仪众筹", re: /胶片|底片|众筹/ },
];

function loadMessages() {
  const lines = fs.readFileSync(CONV_FILE, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.sessionId === SESSION_ID) out.push(o); // 保留完整消息（timestamp/recordedAt 必需）
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

async function main() {
  const messages = loadMessages();
  if (messages.length === 0) throw new Error("session-d 消息为空：" + SESSION_ID);
  console.log(`loaded ${messages.length} messages; runs=${RUNS}`);

  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const { StandaloneLLMRunner } = await import("../src/adapters/standalone/llm-runner.js");
  const runner = new StandaloneLLMRunner({
    config: {
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      // 推理模型红线（REG 实测教训）：0 = 不限制——缺省 4096 会被 thinking 吃满返回空文本
      maxTokens: cfg.llm.maxTokens ?? 0,
      timeoutMs: cfg.llm.timeoutMs ?? 120_000,
      stream: false,
    },
  });

  const { extractL1Memories } = await import("../src/core/record/l1-extractor.js");
  const hits = new Map(PROBES.map((p) => [p.msg, []])); // msg -> [runIdx...] 命中的 run
  const merges = []; // 一条记忆命中 >1 消息的记录

  for (let run = 1; run <= RUNS; run++) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "loss-probe-"));
    try {
      const res = await extractL1Memories({
        messages,
        sessionKey: `loss-probe-run${run}`,
        sessionId: SESSION_ID,
        teamId: "team-flowtest",
        userId: "usr-flowtest",
        agentId: "agt-flowtest",
        baseDir,
        config: { llm: cfg.llm },
        options: { enableDedup: true, maxMessagesPerExtraction: 10, maxMemoriesPerSession: 20, llmRunner: runner }, // 生产平价（tdai-gateway.yaml:41）
      });
      const contents = (res.records ?? []).map((r) => String(r.content ?? ""));
      console.log(`run ${run}: extracted=${res.extractedCount} stored=${res.storedCount}`);
      for (const p of PROBES) {
        const matched = contents.filter((c) => p.re.test(c));
        if (matched.length > 0) hits.get(p.msg).push(run);
      }
      // 合并检测：一条记忆命中多个探针
      for (const c of contents) {
        const matchedProbes = PROBES.filter((p) => p.re.test(c));
        if (matchedProbes.length > 1) merges.push({ run, content: c.slice(0, 60), probes: matchedProbes.map((p) => p.label) });
      }
    } finally {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  }

  console.log("\n===== 每消息命中率（runs=" + RUNS + "）=====");
  for (const p of PROBES) {
    const h = hits.get(p.msg).length;
    const cls = h === 0 ? "系统性排除嫌疑" : h === RUNS ? "稳定命中" : "随机漏损区";
    console.log(`msg#${String(p.msg).padStart(2)} [${p.role.padEnd(9)}] ${p.label.padEnd(10)} ${h}/${RUNS}  ${cls}`);
  }
  if (merges.length > 0) {
    console.log("\n===== 合并（一条记忆命中多消息）=====");
    for (const m of merges) console.log(`run${m.run}: [${m.probes.join("+")}] ${m.content}`);
  } else {
    console.log("\n无跨消息合并记录。");
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
