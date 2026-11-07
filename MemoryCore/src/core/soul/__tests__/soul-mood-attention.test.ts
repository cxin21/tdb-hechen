/**
 * A2 端到端（L3，临时库）：同一批人格条目，只改「当下心境」，注入文本必须不同——
 * 自我向情绪放大 self 层预算并把失败条目前置；关系向冲突放大 relationship 层。
 * 只证明「情绪 -> 判断」这一段接线，不伪造生产情绪。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { buildSoulPrefix } from "../../hooks/soul-assembler.js";
import { makePersonaItem } from "../persona.js";
import type { SoulMoodState } from "../emotion.js";
import { resolveSoulConfig } from "../types.js";

const T = { teamId: "t-mood", userId: "u-mood", agentId: "a-mood" };
const NOW = "2026-11-06T12:00:00.000Z";

function section(text: string, title: string): string {
  const start = text.indexOf(title);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + title.length);
  return text.slice(start, next < 0 ? undefined : next);
}

function mood(over: Partial<SoulMoodState>): SoulMoodState {
  return {
    valence: 0,
    arousal: 0.3,
    baselineValence: 0,
    baselineArousal: 0.3,
    updatedAt: NOW,
    sampleCount: 80,
    ...over,
  };
}

describe("心境改变注入（层次序/预算）", () => {
  it("愧疚（自我向）放大 self；恼火（冲突向）放大 relationship；文本与字数实测不同", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mood-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const items = [];
      for (let i = 0; i < 16; i += 1) {
        items.push(makePersonaItem({
          layer: "self",
          text: `我没守住：先取证再改，第 ${i} 次急着下结论，后来按原话重做并补了证据`,
          now: NOW,
          weight: 0.7,
        }));
        items.push(makePersonaItem({
          layer: "relationship",
          text: `我们在这件事上冲突过：菜单和按钮太丑，他当面说我找的组件库不靠谱（第 ${i} 次）`,
          now: NOW,
          weight: 0.6,
        }));
      }
      await store.commitSoulPersona(T, { upsert: items, ledger: [] });

      const opts = {
        soulPersonaEnabled: true,
        soulMaintenance: resolveSoulConfig({ enabled: true }),
      };
      const flat = await buildSoulPrefix(store, T, undefined, opts);
      const selfMoodMeta: { soulAttention?: { focus: string; object: string; chars: number } } = {};
      const selfMood = await buildSoulPrefix(
        store,
        T,
        undefined,
        { ...opts, soulMood: mood({ valence: -0.3, arousal: 0.6, emotion: { object: "先取证再改", label: "愧疚", intensity: 0.6, at: NOW } }) },
        selfMoodMeta,
      );
      const conflictMood = await buildSoulPrefix(
        store,
        T,
        undefined,
        { ...opts, soulMood: mood({ valence: -0.25, arousal: 0.7, emotion: { object: "菜单和按钮太丑", label: "恼火", intensity: 0.55, at: NOW } }) },
      );

      const selfFlat = section(flat, "## 我对自己");
      const selfGuilty = section(selfMood, "## 我对自己");
      const relFlat = section(flat, "## 我和他的关系");
      const relAngry = section(conflictMood, "## 我和他的关系");

      expect(selfMoodMeta.soulAttention?.focus).toBe("self");
      expect(selfMoodMeta.soulAttention?.object).toBe("先取证再改");
      // 同一批条目：自我向情绪下 self 段更长、装进更多条（预算 ×1.5）。
      expect(selfGuilty.length).toBeGreaterThan(selfFlat.length);
      expect((selfGuilty.match(/我没守住/g) ?? []).length).toBeGreaterThan((selfFlat.match(/我没守住/g) ?? []).length);
      // 冲突向情绪下 relationship 段更长、装进更多条。
      expect(relAngry.length).toBeGreaterThan(relFlat.length);
      expect((relAngry.match(/冲突过/g) ?? []).length).toBeGreaterThan((relFlat.match(/冲突过/g) ?? []).length);
      // 全文必须真的不同，而不是只换了心境行。
      expect(selfMood).not.toBe(flat);
      expect(conflictMood).not.toBe(flat);
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
