/**
 * soul_person 身份表（人格系统 v3 阶段 1，§3-B1）的 store 级契约。
 *
 * 守四条：
 *  1. 建表幂等 —— VectorStore.init 会被多次调用（进程内 + 测试），反复 exec DDL 不得报错、不得多行；
 *  2. partial 唯一索引只约束「同平台身份」—— platform_id 为 NULL 的按名身份可以并存；
 *  3. upsert 撞唯一索引时挂到既有行，绝不造第二个人；
 *  4. merge 之后 from 行留墓碑（merged_into）且从 listSoulPersons 消失，自合并/重复合并被拒。
 *
 * 铁律：纯本地 sqlite（临时目录 + dims=0），不碰外部服务。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";

const TENANT = { teamId: "team-t", userId: "usr-t", agentId: "agt-t" };

const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): { store: VectorStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "soul-person-"));
  dirs.push(dir);
  const dbPath = join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
  stores.push(store);
  store.init();
  return { store, dbPath };
}

describe("soul_person 身份表", () => {
  it("建表幂等：重复 init 不报错、不新增行", () => {
    const { store, dbPath } = makeStore();
    const created = store.upsertSoulPerson!(TENANT, {
      personKey: "p_idem00000001",
      platform: "cli",
      platformId: "u-1",
      displayName: "何晨",
    });
    expect(created).toEqual({ personKey: "p_idem00000001", created: true });

    // 同一个库里再造一个 VectorStore 跑 init（等价于宿主重启/迁移脚本再跑一次）
    const again = new VectorStore(dbPath, 0);
    stores.push(again);
    expect(() => again.init()).not.toThrow();
    expect(again.listSoulPersons!(TENANT).length).toBe(1);
    expect(store.listSoulPersons!(TENANT).length).toBe(1);
  });

  it("partial 唯一索引不撞 NULL：platform_id 为空的两条按名身份可以并存", () => {
    const { store } = makeStore();
    // 同租户、同 platform、platform_id 均为 NULL —— 两个不同的人按名建行，必须都留下
    const a = store.upsertSoulPerson!(TENANT, { personKey: "p_name_aaaaaaaaaaaa", displayName: "张三" });
    const b = store.upsertSoulPerson!(TENANT, { personKey: "p_name_bbbbbbbbbbbb", displayName: "李四" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(store.listSoulPersons!(TENANT).map((p) => p.personKey).sort()).toEqual([
      "p_name_aaaaaaaaaaaa",
      "p_name_bbbbbbbbbbbb",
    ]);
  });

  it("upsert 撞平台唯一索引时挂到既有行：换 key 也不造第二个人", () => {
    const { store } = makeStore();
    store.upsertSoulPerson!(TENANT, {
      personKey: "p_first0000001",
      platform: "cli",
      platformId: "u-9",
      displayName: "何晨",
      aliases: ["hechen"],
    });
    const second = store.upsertSoulPerson!(TENANT, {
      personKey: "p_second000001",
      platform: "cli",
      platformId: "u-9",
      displayName: "何晨（老板）",
    });
    expect(second).toEqual({ personKey: "p_first0000001", created: false });
    const rows = store.listSoulPersons!(TENANT);
    expect(rows.length).toBe(1);
    // 展示面按最新一次刷新，别名做并集（不清空既有别名）
    expect(rows[0].displayName).toBe("何晨（老板）");
    expect(rows[0].aliases).toContain("hechen");
    expect(store.getSoulPersonByPlatform!(TENANT, { platform: "cli", platformId: "u-9" })!.personKey).toBe(
      "p_first0000001",
    );
  });

  it("merge 留墓碑：from 从列表消失、`merged_into` 落库、自合并与重复合并被拒", () => {
    const { store } = makeStore();
    store.upsertSoulPerson!(TENANT, { personKey: "p_into00000001", platform: "cli", platformId: "u-into", displayName: "何晨" });
    store.upsertSoulPerson!(TENANT, { personKey: "p_from00000001", platform: "cli", platformId: "u-from", displayName: "hechen" });

    expect(store.mergeSoulPerson!(TENANT, "p_into00000001", "p_into00000001").merged).toBe(false);
    const ok = store.mergeSoulPerson!(TENANT, "p_from00000001", "p_into00000001");
    expect(ok.merged).toBe(true);
    expect(store.listSoulPersons!(TENANT).map((p) => p.personKey)).toEqual(["p_into00000001"]);
    // 墓碑行还在（可追溯），但不参与按名解析
    expect(store.mergeSoulPerson!(TENANT, "p_from00000001", "p_into00000001").merged).toBe(false);
    expect(store.listSoulPersons!(TENANT).length).toBe(1);
  });
});
