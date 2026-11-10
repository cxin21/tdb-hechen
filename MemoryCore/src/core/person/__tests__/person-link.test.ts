/**
 * 记忆挂人（person/resolve + person/link）的 RED/GREEN 契约 —— 人格系统 v3 阶段 1（§3-B）。
 *
 * 守住文档里四条硬规则：
 *  1. resolve 优先级：平台 id 精确 > 归一化名唯一命中 > 新建；同名两条时**不猜**；
 *  2. 多值线索拆条：participants / mentioned 各算一条，最多 3 人；
 *  3. 第三方转述不入档：A 说 B 的事 → 主体 B，A 只能 mentioned，绝不拿 speaker；
 *  4. persons 为空时不写该键（metadata_json 里连空数组都不出现）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../../store/sqlite.js";
import { writeMemory } from "../../record/l1-writer.js";
import { personKeyOf, resolvePerson } from "../resolve.js";
import { linkMemoryToPersons, MAX_PERSONS_PER_MEMORY } from "../link.js";
import type { PersonHint } from "../types.js";

const TENANT = { teamId: "team-p", userId: "usr-p", agentId: "agt-p" };

const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): { store: VectorStore; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "person-link-"));
  dirs.push(dir);
  const dbPath = join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  stores.push(store);
  store.init();
  return { store, dir, dbPath };
}

const A: PersonHint = { platform: "cli", platformId: "u-a", displayName: "何晨" };
const B: PersonHint = { platform: "cli", platformId: "u-b", displayName: "阿满" };

describe("resolvePerson", () => {
  // 生产实测：7 个 platform 行 display_name 全空，名字只长在档案 alias 字段里；
  // 面板按名字索隐，空名行整条被 skip 掉 → 面板上看不见人。缺的是「先有身份、后知道名字」
  // 这一条回填路径。
  it("平台行先建（无名字）后拿到名字 → 回填 display_name，且不新建第二行", async () => {
    const { store } = makeStore();
    const anonymous = await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-x" });
    expect(anonymous.displayName).toBe("");

    const named = await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-x", displayName: "何晨" });
    expect(named.personKey).toBe(anonymous.personKey);
    expect(named.displayName).toBe("何晨");

    const all = await store.listSoulPersons(TENANT);
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe("何晨");
  });

  // 90 天回放实测的真顺序：名字先以「被提到」的形式落库建了占位行，本人自述后到。
  // 不合并 ⇒ 面板上「何晨（0 字段）」与「未命名·ab63b（4 字段）」两行，档案挂在没名字的那行。
  it("同名占位行是空壳时并进平台行，读面只剩一个有名字有档案的人", async () => {
    const { store } = makeStore();
    const shell = await resolvePerson(store, TENANT, { displayName: "何晨" });
    expect(shell.personKey.startsWith("p_name_")).toBe(true);

    const platform = await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-hechen", displayName: "何晨" });
    expect(platform.personKey.startsWith("p_")).toBe(true);
    expect(platform.displayName).toBe("何晨");

    const all = await store.listSoulPersons(TENANT);
    expect(all).toHaveLength(1);
    expect(all[0].personKey).toBe(platform.personKey);
    expect(all[0].displayName).toBe("何晨");
  });

  it("同名行有档案（不是空壳）时不合并，也不回填", async () => {
    const { store } = makeStore();
    const owner = await resolvePerson(store, TENANT, { displayName: "何晨" });
    await store.commitSoulPersona!(TENANT, {
      upsert: [
        {
          itemId: "human:pp-test",
          layer: "human",
          text: "称呼：何晨",
          state: "active",
          weight: 1,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          lastEvidenceAt: "2026-11-01T00:00:00.000Z",
          meta: { person: { key: owner.personKey }, profileField: "alias" },
        },
      ],
      ledger: [],
    } as never);

    const platform = await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-hechen2", displayName: "何晨" });
    // 名字唯一命中 + 这次带了平台 id ⇒ 走既有的「就地补绑」，不新建第三行、也不合并。
    expect(platform.personKey).toBe(owner.personKey);
    const all = await store.listSoulPersons(TENANT);
    expect(all).toHaveLength(1);
    const kept = all[0];
    expect(kept.personKey).toBe(owner.personKey);
    expect(kept.displayName).toBe("何晨");
    expect(kept.platformId).toBe("u-hechen2");
  });

  it("已有名字的行不会被后续线索覆盖（先到的证据更完整）", async () => {    const { store } = makeStore();
    await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-y", displayName: "何晨" });
    const again = await resolvePerson(store, TENANT, { platform: "tdai", platformId: "u-y", displayName: "老何" });
    expect(again.displayName).toBe("何晨");
    const all = await store.listSoulPersons(TENANT);
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe("何晨");
  });

  it("平台 id 精确命中优先于姓名：id 一旦对上，名字写成什么都不新建人", async () => {
    const { store } = makeStore();
    const first = await resolvePerson(store, TENANT, A);
    // 同 platform id、名字换成昵称 → 必须命中同一行（平台 id 是最强证据）
    const renamed = await resolvePerson(store, TENANT, { platform: "cli", platformId: "u-a", displayName: "老板" });
    expect(renamed.personKey).toBe(first.personKey);
    expect(store.listSoulPersons!(TENANT).length).toBe(1);
  });

  it("归一化名唯一命中时复用人：大小写/空白归一后相等", async () => {
    const { store } = makeStore();
    const created = await resolvePerson(store, TENANT, { displayName: "HeChen" });
    const hit = await resolvePerson(store, TENANT, { displayName: "  hechen " });
    expect(hit.personKey).toBe(created.personKey);
    expect(store.listSoulPersons!(TENANT).length).toBe(1);
  });

  it("同名两条时不猜：新建第三行留待合并", async () => {
    const { store } = makeStore();
    // 两个不同平台 id、display_name 同为「何晨」（历史上换过名/迁移造出同名的两个人）
    store.upsertSoulPerson!(TENANT, { personKey: "p_dup00000001", platform: "cli", platformId: "u-1", displayName: "何晨" });
    store.upsertSoulPerson!(TENANT, { personKey: "p_dup00000002", platform: "cli", platformId: "u-2", displayName: "何晨" });
    // 再来一个只有名字的线索：命中两条 → 必须新建，不能挑一个
    const ambiguous = await resolvePerson(store, TENANT, { displayName: "何晨" });
    expect(store.listSoulPersons!(TENANT).length).toBe(3);
    expect(ambiguous.personKey.startsWith("p_name_")).toBe(true);
    expect(personKeyOf({ ...TENANT, displayName: "何晨" })).toBe(ambiguous.personKey);
  });
});

describe("linkMemoryToPersons", () => {
  it("多值线索拆条且最多 3 人", async () => {
    const { store } = makeStore();
    const { persons } = await linkMemoryToPersons(store, TENANT, {
      recordId: "m-multi",
      participants: [A, B, { platform: "cli", platformId: "u-c", displayName: "丙" }, { platform: "cli", platformId: "u-d", displayName: "丁" }],
    });
    expect(persons.length).toBe(MAX_PERSONS_PER_MEMORY);
    expect(persons[0].role).toBe("subject");
    expect(new Set(persons.map((p) => p.key)).size).toBe(persons.length);
    // 第 4 个人被截断，但库里的身份行仍会因解析而存在（解析与截断是两件事）
    expect(persons.map((p) => p.role)).toEqual(["subject", "mentioned", "mentioned"]);
  });

  it("第三方转述不入档：说话人只记 mentioned", async () => {
    const { store } = makeStore();
    const { persons } = await linkMemoryToPersons(store, TENANT, {
      recordId: "m-relay",
      participants: [B],
      speaker: A,
    });
    const bKey = personKeyOf({ ...TENANT, ...B });
    const aKey = personKeyOf({ ...TENANT, ...A });
    expect(persons).toContainEqual({ key: bKey, role: "subject" });
    expect(persons).toContainEqual({ key: aKey, role: "mentioned" });
    expect(persons.some((p) => p.role === "speaker")).toBe(false);
  });

  // 生产实测 2026-11-10：`speaker_name` 被模型填成角色词「用户」，这条线索带着
  // platform id 一路写进 `soul_person.display_name`，面板上出现一个叫「用户」的人。
  // 口径：脏名不写进人名，但平台 id 是可信身份锚，线索本身仍要用来挂人。
  it("带平台 id 的脏名（角色词/代词）不写名字，但身份锚照常挂人", async () => {
    const { store } = makeStore();
    const dirty: PersonHint = { platform: "tdai", platformId: "u-dirty", displayName: "用户" };
    const { persons } = await linkMemoryToPersons(store, TENANT, {
      recordId: "m-dirty",
      participants: [dirty],
    });
    const key = personKeyOf({ ...TENANT, ...dirty });
    expect(persons).toContainEqual({ key, role: "subject" });

    const rows = await store.listSoulPersons!(TENANT);
    const row = rows.find((p) => p.personKey === key);
    expect(row).toBeTruthy();
    expect(row!.displayName ?? "").toBe("");
  });

  it("只有名字没有平台 id 的脏名线索直接丢弃", async () => {
    const { store } = makeStore();
    const { persons } = await linkMemoryToPersons(store, TENANT, {
      recordId: "m-dirty-only",
      participants: [{ displayName: "助手" }],
    });
    expect(persons).toHaveLength(0);
  });
});

describe("落库接线（writeMemory → l1_records.metadata_json）", () => {
  async function writeOne(
    store: VectorStore,
    dir: string,
    id: string,
    metadata: Record<string, unknown>,
    userId: string = TENANT.userId,
  ): Promise<void> {
    await writeMemory({
      memory: { content: `${id} 内容`, type: "episodic", priority: 3, source_message_ids: [`msg-${id}`], metadata, scene_name: "unit" },
      decision: { record_id: id, action: "store", target_ids: [] },
      baseDir: dir,
      sessionKey: "sess-unit",
      sessionId: "sess-unit",
      teamId: TENANT.teamId,
      userId,
      agentId: TENANT.agentId,
      vectorStore: store,
    });
  }

  it("没有真实作者身份时不写 persons（租户占位 user）", async () => {
    // P2-G 起：写侧知道「这条记忆是谁说的」时，作者身份本身就算线索，会挂上 speaker 人。
    // 所以「无线索」这个场景只能用租户占位 user 表达，不能再用真实 user_id。
    const { store, dir, dbPath } = makeStore();
    await writeOne(store, dir, "m-empty", { note: "没有人物线索" }, "default");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select metadata_json from l1_records where record_id = 'm-empty'").get() as {
        metadata_json: string;
      };
      const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect("persons" in meta).toBe(false);
    } finally {
      db.close();
    }
  });

  it("有主体时写 persons 且保留 personRefs", async () => {
    const { store, dir, dbPath } = makeStore();
    await writeOne(store, dir, "m-hit", { participants: [A], speaker: A, personRefs: ["何晨"] });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select metadata_json from l1_records where record_id = 'm-hit'").get() as {
        metadata_json: string;
      };
      const meta = JSON.parse(row.metadata_json) as {
        persons?: Array<{ key: string; role: string }>;
        personRefs?: string[];
      };
      expect(meta.personRefs).toEqual(["何晨"]);
      expect(meta.persons).toEqual([{ key: personKeyOf({ ...TENANT, ...A }), role: "subject" }]);
    } finally {
      db.close();
    }
  });
});
