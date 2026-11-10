import { describe, expect, it } from "vitest";

import {
  collectSoulJournalFields,
  readSoulDrift,
  recordSoulDrift,
  resetSoulDriftRegistry,
} from "../observation.js";

const NOW = "2026-11-07T05:00:00.000Z";
const TENANT = { teamId: "t", userId: "u", agentId: "a" };

function cardSnapshot(version = 3, hash = "abc123", chars = 12) {
  return {
    ts: NOW,
    content_hash: hash,
    payload_json: JSON.stringify({
      kind: "persona-card",
      version,
      hash,
      chars,
      text: "卡".repeat(chars),
      acts: {},
      labels: [],
      warnings: [],
      signature: "",
    }),
    trigger: "soul_tick",
    version,
    parent_hash: null,
    reason_detail: null,
    slots_json: null,
  };
}

function makeStore(over: Record<string, unknown> = {}) {
  return {
    readLastSoulSnapshot: async () => cardSnapshot(),
    listSoulPersona: async () => [],
    readSoulTraitState: async () => null,
    listSoulTraitLabels: async () => [],
    readSoulState: async () => ({
      valence: 0,
      arousal: 0.3,
      baselineValence: 0,
      baselineArousal: 0.3,
      sampleCount: 5,
      updatedAt: NOW,
    }),
    listSoulPromises: async () => [],
    ...over,
  } as never;
}

describe("soul observation (S8 D10)", () => {
  it("新会话首次召回写 sessionInit；会话复用不重复写", async () => {
    const first = await collectSoulJournalFields(makeStore(), TENANT, { sessionReused: false });
    expect(first?.sessionInit).toEqual({ version: 3, hash: "abc123", chars: 12 });
    const reused = await collectSoulJournalFields(makeStore(), TENANT, { sessionReused: true });
    expect(reused?.sessionInit).toBeUndefined();
    expect(typeof reused?.turnChars).toBe("number");
  });

  it("turnChars 与通道 B 实际渲染长度同源且 ≤400", async () => {
    const fields = await collectSoulJournalFields(makeStore(), TENANT, { sessionReused: true });
    expect(fields?.turnChars).toBeGreaterThan(0);
    expect(fields?.turnChars).toBeLessThanOrEqual(400);
  });

  it("drift 取最近一次 worker tick 登记；无登记则不写该键", async () => {
    resetSoulDriftRegistry();
    expect(readSoulDrift(TENANT)).toBeUndefined();
    recordSoulDrift(TENANT, { changed: 2, rejected: 1 }, NOW);
    const fields = await collectSoulJournalFields(makeStore(), TENANT, { sessionReused: true });
    expect(fields?.drift).toEqual({ changed: 2, rejected: 1 });
    resetSoulDriftRegistry();
  });

  it("取卡/渲染异常时 fail-open：不抛、带 failReason", async () => {
    resetSoulDriftRegistry();
    const store = makeStore({
      listSoulPromises: async () => {
        throw new Error("db down");
      },
    });
    const fields = await collectSoulJournalFields(store, TENANT, { sessionReused: true });
    expect(fields?.failReason).toBe("turn-error");
  });

  it("无 store 或三项全空 → undefined（journal 不写 soul 键）", async () => {
    expect(await collectSoulJournalFields(undefined, TENANT, { sessionReused: false })).toBeUndefined();
  });
});
