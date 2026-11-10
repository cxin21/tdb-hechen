/**
 * 人物档案提炼的交叉性质（Lead 复核时补，长期保留）：不重复单点用例，只钉四件跨层的事。
 *  1. 伪造引文（不在原文里）→ 不落库，且 byReason 有计数（禁止静默）；
 *  2. 跨人不串台：模型把别人的记录塞进来 → 按「不在本批」丢弃，A 的行里不出现别人的原话；
 *  3. 读面：真实 handler 回字段 + 每项 evidence 带 quote；
 *  4. 他人不建档案：只出现在 participants 里的非说话人，不会被当成档案主语。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../../store/sqlite.js";
import { writeMemory } from "../../record/l1-writer.js";
import { resolvePerson } from "../resolve.js";
import { runPersonProfileDistill } from "../profile-distiller.js";
import { handleSoulPersonRoute } from "../../../gateway/soul-person-endpoint.js";
import type { PersonaItem } from "../../soul/types.js";
import type { LLMRunner } from "../../types.js";

const TENANT = { teamId: "team-rv", userId: "usr-rv", agentId: "agt-rv" };
const NOW = "2027-01-01T00:00:00.000Z";

const dirs: string[] = [];
const stores: VectorStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): { store: VectorStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rv-profile-"));
  dirs.push(dir);
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  stores.push(store);
  store.init();
  return { store, dir };
}

const A = { platform: "cli", platformId: TENANT.userId, displayName: "何晨" };
const B = { platform: "cli", platformId: "u-b", displayName: "小满" };

async function seed(
  store: VectorStore,
  dir: string,
  rows: Array<{ id: string; content: string; participants: unknown[] }>,
): Promise<void> {
  for (const r of rows) {
    await writeMemory({
      memory: {
        content: r.content,
        type: "episodic",
        priority: 3,
        source_message_ids: ["msg-" + r.id],
        metadata: { participants: r.participants } as never,
        scene_name: "unit",
      },
      decision: { record_id: r.id, action: "store", target_ids: [] },
      baseDir: dir,
      sessionKey: "sess-rv",
      sessionId: "sess-rv",
      teamId: TENANT.teamId,
      userId: TENANT.userId,
      agentId: TENANT.agentId,
      vectorStore: store,
    });
  }
}

function rowsOf(store: VectorStore, key: string): PersonaItem[] {
  const items = (store.listSoulPersona!(TENANT) as PersonaItem[]) ?? [];
  return items.filter((it) => {
    const meta = it.meta as { source?: string; person?: { key?: string } } | undefined;
    return it.layer === "human" && meta?.source === "person-profile" && meta.person?.key === key;
  });
}

describe("Lead 独立复核 · 人物档案提炼", () => {
  it("伪造引文被丢且计数 + 别人的记录丢弃 + 读面带证据 + 他人不建档案", async () => {
    const { store, dir } = makeStore();
    const a = await resolvePerson(store, TENANT, A);
    const b = await resolvePerson(store, TENANT, B);
    await seed(store, dir, [
      { id: "a1", content: "我每天早上先看一遍线上告警，再动手改", participants: [A] },
      { id: "a2", content: "我讨厌别人不打招呼就改我的分支", participants: [A] },
      { id: "a3", content: "我习惯把结论写在最前面", participants: [A] },
      { id: "b1", content: "我喜欢在夜里跑步，跑到江边再回来", participants: [B] },
      { id: "b2", content: "我最烦一上来就铺背景的人", participants: [B] },
      { id: "b3", content: "我说话一句一句来，不用列表", participants: [B] },
    ]);

    const runner = {
      run: vi.fn(async () =>
        JSON.stringify({
          fields: [
            { field: "style", text: "先看线上告警再动手", recordId: "a1", quote: "我每天早上先看一遍线上告警", op: "add" },
            { field: "likes", text: "夜里跑步", recordId: "b1", quote: "我喜欢在夜里跑步", op: "add" },
            { field: "handle", text: "编的一句话", recordId: "a3", quote: "这句话原文里没有", op: "add" },
          ],
          relations: [],
        }),
      ),
    } as unknown as LLMRunner;

    const report = await runPersonProfileDistill(runner, {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 1,
      trigger: "review",
    } as never);

    const aRows = rowsOf(store, a.personKey);
    const aTexts = aRows.map((r) => r.text).join("\n");
    expect(aTexts).toContain("先看线上告警再动手");
    expect(aTexts).not.toContain("夜里跑步");
    expect(aTexts).not.toContain("编的一句话");
    const reasons = report.persons[0]?.byReason ?? {};
    expect(reasons.record_not_in_batch ?? 0).toBeGreaterThan(0);
    expect(reasons.quote_not_verbatim ?? 0).toBeGreaterThan(0);
    expect(rowsOf(store, b.personKey)).toHaveLength(0);

    const sent: Array<{ status?: number; body?: unknown }> = [];
    const sendJson = (_res: unknown, status: number, payload: unknown) => {
      sent.push({ status, body: payload });
    };
    const url = new URL(
      "http://x/v3/soul/person?team=" +
        TENANT.teamId +
        "&user=" +
        TENANT.userId +
        "&agent=" +
        TENANT.agentId +
        "&key=" +
        a.personKey,
    );
    const handled = await handleSoulPersonRoute(url, "GET", sendJson, {} as never, {
      getStore: () => store,
      now: () => NOW,
    } as never);
    expect(handled).toBe(true);
    const payload = sent
      .map((x) => x.body)
      .filter(Boolean)
      .pop() as { data?: { fields?: Array<{ field: string; evidence?: Array<{ quote?: string }> }> } } | undefined;
    const fields = payload?.data?.fields ?? [];
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.some((f) => (f.evidence ?? []).some((e) => (e.quote ?? "").includes("线上告警")))).toBe(true);
  });

  it("没有「本人发言」证据的人：不调模型、不写水位、记 deferred 而不是 failed", async () => {
    const { store, dir } = makeStore();
    // 只有名字、没有平台绑定的人：迁移期数据的真实形状（role=subject，无 platformId）。
    const named = await resolvePerson(store, TENANT, { platform: "", platformId: "", displayName: "老王" });
    await seed(store, dir, [
      { id: "n1", content: "老王说他下周去杭州出差", participants: [{ displayName: "老王" }] },
      { id: "n2", content: "老王不喜欢开会", participants: [{ displayName: "老王" }] },
      { id: "n3", content: "老王习惯早上六点起", participants: [{ displayName: "老王" }] },
    ]);

    const run = vi.fn(async () => JSON.stringify({ fields: [], relations: [] }));
    const report = await runPersonProfileDistill({ run } as unknown as LLMRunner, {
      store,
      tenant: TENANT,
      now: NOW,
      maxPersons: 4,
      trigger: "review",
    } as never);

    const one = report.persons.find((p) => p.personKey === named.personKey);
    expect(one?.error).toBe("no_self_speech");
    expect(one?.fields).toBe(0);
    expect(report.deferred).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
    expect(run).not.toHaveBeenCalled();
    const watermarks = (store.listSoulPersonProfileWatermarks?.(TENANT) as Array<{ personKey: string; profileAt: string | null }>) ?? [];
    const mine = watermarks.find((w) => w.personKey === named.personKey);
    expect(mine?.profileAt ?? null).toBeNull();
  });
});
