// _thinking_probe2.mjs — 思考开关能力复测（3 轮×4 变体，带计时，只读探测）
import fs from "node:fs";

const ov = JSON.parse(fs.readFileSync("/data/tdai-memory/config-override.json", "utf8"));
const BASE = ov.llm.baseUrl, KEY = ov.llm.apiKey, MODEL = ov.llm.model;

const variants = [
  { name: "A baseline", extra: {} },
  { name: "B effort=none", extra: { reasoning_effort: "none" } },
  { name: "C effort=minimal", extra: { reasoning_effort: "minimal" } },
  { name: "D enable_thinking=false", extra: { enable_thinking: false } },
  { name: "E thinking=disabled", extra: { thinking: { type: "disabled" } } },
];

async function probe(extra) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "先心算再作答，只输出最终数字：127 × 349 = ?" }],
    max_tokens: 2048,
    ...extra,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ms, http: res.status, err: text.slice(0, 120) };
    const j = JSON.parse(text);
    const u = j.usage ?? {};
    return {
      ms,
      finish: j.choices?.[0]?.finish_reason,
      completion: u.completion_tokens,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
      ok: String(j.choices?.[0]?.message?.content ?? "").includes("44323"),
    };
  } catch (e) {
    return { ms: Date.now() - t0, err: String(e).slice(0, 120) };
  }
}

for (let round = 1; round <= 3; round++) {
  for (const v of variants) {
    const r = await probe(v.extra);
    console.log(`r${round} ${v.name} => ${JSON.stringify(r)}`);
  }
}
