// v21：深度思考 开/关 A/B 真实测试（2026-10-06 思考归因轮）
// 背景：生产 l1-extraction 在 8192 覆写下出现 2 起 finishReason=length 空响应+180s 超时面抬升；
//       探针证实 mimo 端点 reasoning_effort="none" 可关思考（reasoning=0、trivial 题 34s→0.5s）。
// 设计：两臂同一新提示词（工作区已提交版，生产忠实组合），唯一差异=请求体加 reasoning_effort:"none"。
//       同种子 S1-S10、temperature 0.2、120s 超时（与 v19/v20 逐字一致，可跨机架对比）。
// 统计：armStat 全套（数量/预算/枚举/范围/六字段）+ 每臂 latency(ms)/reasoning_tokens/finish/空响应。
// 用法：sudo -H -u tdai node --experimental-strip-types v21_prompt_ab.mjs（REPO=/opt/tdai/td-agemem）
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ENV_FILE = "/opt/tdai/etc/env";
try { for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$/); if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
} } catch {}
const YAML_FILE = "/opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml";
const yamlText = fs.readFileSync(YAML_FILE, "utf8");
const grab = (re) => { const m = yamlText.match(re); return m ? m[1] : ""; };
let BASE = grab(/^llm:\s*\n\s*baseUrl:\s*"([^"]+)"/m) || process.env.TDAI_LLM_BASE_URL || "";
let MODEL = grab(/^llm:\s*\n\s*baseUrl:[^\n]*\n\s*model:\s*"([^"]+)"/m) || "ark-code-latest";
let KEY = process.env.TDAI_LLM_API_KEY || "";
try {
  const ov = JSON.parse(fs.readFileSync("/data/tdai-memory/config-override.json", "utf8"));
  if (ov.llm && ov.llm.baseUrl && ov.llm.model && ov.llm.apiKey) {
    BASE = ov.llm.baseUrl; MODEL = ov.llm.model; KEY = ov.llm.apiKey;
    console.error("override=config-override.json (production same-source LLM)");
  }
} catch { console.error("no override, fallback yaml"); }
if (!KEY || !BASE) { console.error(`NO_KEY_OR_BASE base=${BASE ? "set" : "missing"}`); process.exit(2); }
console.error(`endpoint=${BASE} model=${MODEL}`);

const REPO = "/opt/tdai/td-agemem";
const srcPath = "MemoryCore/src/core/prompts/l1-extraction.ts";
const GATED = { selfIdentityEnabled: true, sensitivityEnabled: true, recurrenceEnabled: true };
const mod = await import(pathToFileURL(`${REPO}/${srcPath}`).href);
const PROMPT = mod.getExtractMemoriesSystemPrompt("chat", GATED);
console.error(`[prompt] len=${PROMPT.length} endsWithFinal=${PROMPT.endsWith("或解释文本。")}`);

const SAMPLES = [
  { id: "S1 多事件拼贴", msg: "先说结论：F-CLUSTER 的月配额耗尽阻塞已解除——套餐续费到账了，生产 core 重启后提取链恢复，journal 里 cursor 没有丢，明天重置后全线回归正常。" },
  { id: "S2 琐碎信息", msg: "我刚刚顺手把桌上的水杯挪了一下位置，然后继续看你发的这个文档，中间还倒了一次热水。" },
  { id: "S3 归因判断", msg: "所以这个 derive 报警不是代码缺陷，应该是租户过滤设计导致的正常现象，属于环境层面的问题。" },
  { id: "S4 拍板决策", msg: "拍板：锚点相似合并门这个方案我批准了，按你说的 config-first 落地，enabled 开关放 yaml。" },
  { id: "S5 健康禁忌", msg: "我对芒果过敏，吃了会起疹子，以后点外卖千万别帮我点含芒果的东西。" },
  { id: "S6 例行操作", msg: "我按平常的习惯每天早上慢跑三十分钟，然后洗澡吃早饭，八点半出门上班。" },
  { id: "S7 三事件混叙", msg: "今天上午先修了蓝牙驱动的回滚问题，中午跟同事吃饭聊了预算的事，下午把评审意见改完提交了。" },
  { id: "S8 全局指令", msg: "以后所有报告都按四态格式给我：DONE 或 DONE_WITH_CONCERNS 加上 commit hash 和一行摘要，别的不用写。" },
  { id: "S9 边缘闲聊", msg: "哈哈这个梗好好笑，前面那个表情包也太抽象了，我发给我室友看看。" },
  { id: "S10 双事件+归因", msg: "昨天密扫报了假阳性，排查后确认是正则把 task- 前缀误判成密钥了，属于工具口径问题不是泄漏，我改了词边界就消掉了。" },
];

async function callLLM(userMsg, arm) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: `【待提取的新消息】\n${JSON.stringify([{ role: "user", content: userMsg, timestamp: new Date().toISOString() }])}\n\n【记忆中已有的信息】\n（无）\n\n请提取记忆，只输出 JSON 数组。` },
    ],
    temperature: 0.2,
    ...(arm === "off" ? { reasoning_effort: "none" } : {}),
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`LLM_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return {
    raw: String(j.choices?.[0]?.message?.content ?? ""),
    ms,
    finish: j.choices?.[0]?.finish_reason,
    reasoning: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    completion: j.usage?.completion_tokens ?? null,
  };
}

const CHAT_TYPES = new Set(["persona", "episodic", "instruction"]);
const LEGACY_TYPES = new Set(["episode", "instruct", "preference"]);
const clampBad = (v, lo, hi) => typeof v === "number" && (v < lo || v > hi);

const parseScenes = (raw) => {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr : null; } catch { return "UNPARSEABLE"; }
};

const armStat = (call) => {
  const { raw } = call;
  const scenes = parseScenes(raw);
  if (scenes === null) return { call, noJson: true, rawLen: raw.length, rawHead: raw.slice(0, 80) };
  if (scenes === "UNPARSEABLE") return { call, unparseable: true, rawLen: raw.length, rawHead: raw.slice(0, 80) };
  const mems = scenes.flatMap((s) => (Array.isArray(s?.memories) ? s.memories : []));
  return {
    call,
    scenes: scenes.length,
    count: mems.length,
    budgetOK: mems.length <= 20 && scenes.length <= 5,
    typeViol: mems.filter((m) => !CHAT_TYPES.has(m.type) && !LEGACY_TYPES.has(m.type)).map((m) => String(m.type)),
    prioViol: mems.filter((m) => clampBad(m.priority, -1, 100)).map((m) => m.priority),
    valViol: mems.filter((m) => clampBad(m.valence, -1, 1)).map((m) => m.valence),
    arViol: mems.filter((m) => clampBad(m.arousal, 0, 1)).map((m) => m.arousal),
    sigViol: mems.filter((m) => clampBad(m.significance, 0, 1)).map((m) => m.significance),
    sixOK: mems.filter((m) => ["occurred_at", "certainty", "valence", "arousal", "significance", "durative"].every((k) => k in m)).length,
    emptyContent: mems.filter((m) => !String(m.content ?? "").trim()).length,
    per: mems.map((m) => ({
      type: m.type, len: String(m.content ?? "").length, priority: m.priority, certainty: m.certainty,
      content: String(m.content ?? "").slice(0, 50),
    })),
  };
};

const rows = [];
const START = Number(process.env.AB_START || 0);
for (const s of SAMPLES.slice(START)) {
  let on, off;
  try { on = armStat(await callLLM(s.msg, "on")); } catch (e) { on = { callErr: String(e) }; }
  await new Promise((r) => setTimeout(r, 400));
  try { off = armStat(await callLLM(s.msg, "off")); } catch (e) { off = { callErr: String(e) }; }
  await new Promise((r) => setTimeout(r, 400));
  rows.push({ id: s.id, on, off });
  const fmt = (st) => st.callErr ? "ERR" : (st.count ?? "NOJSON");
  console.error(`done ${s.id}: think_on=${fmt(on)} think_off=${fmt(off)} (ms=${on.call?.ms ?? "-"}/${off.call?.ms ?? "-"})`);
}
console.log(JSON.stringify(rows, null, 1));
