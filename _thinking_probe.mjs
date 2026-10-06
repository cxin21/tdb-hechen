// _thinking_probe.mjs — 探测 mimo 端点是否支持关闭深度思考（只读探测，不改生产）
// 用法（服务器仓库根）: sudo -H -u tdai node _thinking_probe.mjs
import fs from "node:fs";

const ov = JSON.parse(fs.readFileSync("/data/tdai-memory/config-override.json", "utf8"));
const BASE = ov.llm.baseUrl, KEY = ov.llm.apiKey, MODEL = ov.llm.model;
console.error(`endpoint=${BASE} model=${MODEL}`);

const variants = [
  { name: "A baseline(无参数)", extra: {} },
  { name: "B reasoning_effort=none", extra: { reasoning_effort: "none" } },
  { name: "C reasoning_effort=minimal", extra: { reasoning_effort: "minimal" } },
  { name: "D enable_thinking=false", extra: { enable_thinking: false } },
  { name: "E thinking={type:disabled}", extra: { thinking: { type: "disabled" } } },
];

async function probe(extra) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "先心算再作答，只输出最终数字：127 × 349 = ?" }],
    max_tokens: 1024,
    ...extra,
  };
  try {
    const res = await fetch(`${BASE.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { http: res.status, err: text.slice(0, 160) };
    const j = JSON.parse(text);
    const u = j.usage ?? {};
    return {
      http: res.status,
      finish: j.choices?.[0]?.finish_reason,
      completion: u.completion_tokens,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning ?? null,
      content: String(j.choices?.[0]?.message?.content ?? "").slice(0, 40),
      usageKeys: Object.keys(u),
    };
  } catch (e) {
    return { err: String(e).slice(0, 160) };
  }
}

for (const v of variants) {
  const r = await probe(v.extra);
  console.log(`${v.name} => ${JSON.stringify(r)}`);
}
