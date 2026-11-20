import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { templateHalfLifeHours, decayedStoredIntensity } from "../src/core/soul/emotion.ts";

const dbPath = process.argv[2] ?? "D:/TDB/data/vectors.db";
const outPath = process.argv[3] ?? "../.scratch/soul-fulltest/core-mood.jsonl";
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = [];
const emotions = db.prepare("SELECT * FROM soul_emotions ORDER BY at ASC").all();
for (const e of emotions) {
  const row = {
    kind: "emotion", at: e.at, label: e.label, object: e.object ?? null,
    valence: e.valence, arousal: e.arousal, dominance: e.dominance, intensity: e.intensity,
    halfLifeHours: templateHalfLifeHours(e.label),
    agency: e.agency ?? null, confidence: e.confidence ?? null,
    decay: [1, 2, 3, 6, 12, 24].map((h) => ({
      h,
      intensity: Number(decayedStoredIntensity({ label: e.label, intensity: e.intensity, at: e.at }, new Date(Date.parse(e.at) + h * 3600_000).toISOString()).toFixed(4)),
    })),
  };
  rows.push(row);
}
for (const m of db.prepare("SELECT * FROM soul_mood_events ORDER BY at ASC").all()) {
  rows.push({ kind: "mood_event", at: m.at, eventKind: m.kind, label: m.label ?? null,
    deltaValence: m.delta_valence, deltaArousal: m.delta_arousal, deltaIntensity: m.delta_intensity,
    causeEventIds: m.cause_event_ids_json ? JSON.parse(m.cause_event_ids_json) : [], note: m.note ?? null });
}
for (const s of db.prepare("SELECT * FROM soul_state ORDER BY updated_at ASC").all()) {
  rows.push({ kind: "state", at: s.updated_at, valence: s.valence, arousal: s.arousal, dominance: s.dominance,
    baselineValence: s.baseline_valence, baselineArousal: s.baseline_arousal, sampleCount: s.sample_count,
    emotionLabel: s.emotion_label ?? null, emotionIntensity: s.emotion_intensity ?? null, emotionAt: s.emotion_at ?? null,
    emotionObject: s.emotion_object ?? null, topValue: s.top_value ?? null, turnSeq: s.turn_seq });
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
mkdirSync(outPath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

// 惯性读数：相邻 state 的 valence 变化幅度 vs 事件冲击幅度
const states = rows.filter((r) => r.kind === "state");
let inertia = [];
for (let i = 1; i < states.length; i++) {
  inertia.push({ from: states[i - 1].at, to: states[i].at, dv: Number((states[i].valence - states[i - 1].valence).toFixed(4)),
    dtHours: Number(((Date.parse(states[i].at) - Date.parse(states[i - 1].at)) / 3600_000).toFixed(2)) });
}
console.log(JSON.stringify({
  dbPath, outPath, rows: rows.length,
  emotions: emotions.length, moodEvents: rows.filter((r) => r.kind === "mood_event").length, states: states.length,
  labels: [...new Set(emotions.map((e) => e.label))],
  range: emotions.length ? [emotions[0].at, emotions[emotions.length - 1].at] : [],
  decaySample: rows.filter((r) => r.kind === "emotion").slice(-3).map((r) => ({ label: r.label, at: r.at, intensity: r.intensity, halfLifeHours: r.halfLifeHours, decay: r.decay })),
  inertia,
}, null, 2));
db.close();
