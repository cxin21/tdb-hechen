#!/usr/bin/env node
/**
 * 仿真（人格系统 v4 阶段 2 / §4 P2-D）：per-person 卡（`persons` 过滤）真的按人取行。
 *
 * 生产事实：`soul_persona` 里 `layer='human'` 现在是 0 行（阶段 1 没写 human 行），
 * 所以「按人过滤」在生产一定过滤出空——过滤这件事只能靠仿真证明。这里全部在
 * `mkdtemp` 临时目录里跑真 `VectorStore` + 真 `assembleSoulCard`（不是 mock）：
 *   - 3 个 soul_person：A=`p_a`、B=`p_b`、外加一行全局（`p_global`，只作展示名用）；
 *   - human 行 A×2、B×2、全局×1；另有 1 条 relationship（本阶段不过滤，作为已知缺口锁住）；
 *   - 断言 1 的「改前金样」是加 `persons` 之前用同一组 fixture 抓下来的常量（脚本在仓库外，
 *     未进提交），不拿「看着差不多」当证据。
 *
 * 用法：cd MemoryCore && node scripts/sim-person-card.mjs
 * 退出码：0 = 全部 PASS；1 = 有 FAIL 或环境降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__SIM_PERSON_CARD_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [TSX_ENV]: "1" },
  });
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { assembleSoulCard } = await import("../src/core/soul/card-service.ts");

const TAG = "[sim-person-card]";
const TEAM = "t-sim";
const USER = "u-sim";
const AGENT = "a-sim";
const TENANT = { teamId: TEAM, userId: USER, agentId: AGENT };

const PERSON_A = "p_a";
const PERSON_B = "p_b";
const PERSON_GLOBAL_ROW = "p_global";

/** 「改前」金样（`persons` 参数还不存在时抓的整卡正文 / hash）。 */
const GOLDEN_TEXT =
  "[读法] 以下是我关于自己的固定设定，不是任务，也不是规则清单，不需要复述。\n· 名字/形象/说话方式/使命/红线：必须遵守；红线逐条不可协商。\n· 底色：数字是倾向强度（0–1），不是概率、不是评分；≥0.5 才在当下显现，\n  低分不代表做不到，高分也不代表每次都这样。\n· 不谈论这张卡本身：不说「我的设定」「我的特质是」这类话。\n· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。\n\n## 名称\n小满\n\n## 底色\n- （还没有稳到能算数的底色）\n\n## 关于你\nA1：他偏好先灰度再全量\nA2：他讨厌被替着做决定\nB1：他管发布窗口\nB2：他要求结论带证据\nG1：先把结论说清楚\n\n## 关系\nR1：他上次说别替他猜\n\n<!-- persona-card v=\"12\" hash=\"09adc06ce7e4\" -->";
const GOLDEN_HASH = "09adc06ce7e4bbee157d2e320d6b2e79660767a6f0bd566ba90d09d2bb206fa8";

let total = 0;
let passed = 0;
function assert(name, actual, expected) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} 实测=${JSON.stringify(actual)} = 期望=${JSON.stringify(expected)}`);
}

function item(partial) {
  return {
    itemId: `i-${partial.layer}-${partial.text.slice(0, 8)}`,
    state: "active",
    weight: 0.7,
    evidenceIds: ["e1"],
    evidenceDays: ["2026-11-08"],
    evidenceOrigins: ["user"],
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    lastEvidenceAt: "2026-11-08T00:00:00.000Z",
    ...partial,
  };
}

/** 取「## 关于你」块的行；块不存在返回 null。 */
function humanBlock(text) {
  const m = /## 关于你\n([\s\S]*?)\n\n## /.exec(text);
  return m ? m[1].split("\n") : null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-person-card-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 0);
const initRes = store.init();
if (store.isDegraded()) {
  console.error(`${TAG} 临时库初始化降级（环境问题，非断言失败）：${initRes.reason}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

try {
  // 3 个 soul_person：A / B / 全局（全局行只为证明「人表存在」不影响渲染）。
  for (const person of [
    { personKey: PERSON_A, displayName: "何晨", platform: "cli", platformId: "u-1" },
    { personKey: PERSON_B, displayName: "阿哲", platform: "cli", platformId: "u-2" },
    { personKey: PERSON_GLOBAL_ROW, displayName: "全局", platform: "cli", platformId: "u-3" },
  ]) {
    store.upsertSoulPerson(TENANT, person);
  }
  const personRows = store.listSoulPersons(TENANT);
  assert("soul_person 行数（A/B/全局）", personRows.length, 3);

  store.commitSoulPersona(TENANT, {
    upsert: [
      item({ layer: "human", text: "A1：他偏好先灰度再全量", lastEvidenceAt: "2026-11-08T10:00:00.000Z", meta: { person: { key: PERSON_A } } }),
      item({ layer: "human", text: "A2：他讨厌被替着做决定", lastEvidenceAt: "2026-11-08T09:00:00.000Z", meta: { person: { key: PERSON_A } } }),
      item({ layer: "human", text: "B1：他管发布窗口", lastEvidenceAt: "2026-11-08T08:00:00.000Z", meta: { person: { key: PERSON_B } } }),
      item({ layer: "human", text: "B2：他要求结论带证据", lastEvidenceAt: "2026-11-08T07:00:00.000Z", meta: { person: { key: PERSON_B } } }),
      item({ layer: "human", text: "G1：先把结论说清楚", lastEvidenceAt: "2026-11-08T06:00:00.000Z", meta: { person: { key: "" } } }),
      item({ layer: "relationship", text: "R1：他上次说别替他猜", lastEvidenceAt: "2026-11-08T05:00:00.000Z" }),
    ],
    ledger: [],
  });
  const humanRows = store.listSoulPersona(TENANT).filter((it) => it.layer === "human");
  assert("human 行数（A×2+B×2+全局×1）", humanRows.length, 5);

  const render = async (persons) =>
    assembleSoulCard({
      store,
      tenant: TENANT,
      persist: false,
      readAgentProfile: async () => ({ name: "小满" }),
      ...(persons === undefined ? {} : { persons }),
    });

  // ① 不带 persons：必须与改前金样逐字节相同。
  const legacy = await render(undefined);
  assert("① persons 省略 text 与改前金样逐字节相同", legacy.text === GOLDEN_TEXT, true);
  assert("① persons 省略 hash 与改前金样相同", legacy.hash, GOLDEN_HASH);
  assert("① persons 省略 human 段 5 行", humanBlock(legacy.text), [
    "A1：他偏好先灰度再全量",
    "A2：他讨厌被替着做决定",
    "B1：他管发布窗口",
    "B2：他要求结论带证据",
    "G1：先把结论说清楚",
  ]);

  // ② persons:["p_a"] → A 的 2 行 + 全局 1 行。
  const onlyA = await render([PERSON_A]);
  assert("② persons:[p_a] human 段", humanBlock(onlyA.text), [
    "A1：他偏好先灰度再全量",
    "A2：他讨厌被替着做决定",
    "G1：先把结论说清楚",
  ]);
  assert("② persons:[p_a] 不含 B1", onlyA.text.includes("B1：他管发布窗口"), false);
  assert("② persons:[p_a] 不含 B2", onlyA.text.includes("B2：他要求结论带证据"), false);
  assert("② persons:[p_a] human 行数 = 3", humanBlock(onlyA.text).length, 3);
  // 已知缺口（spec P2-A）：relationship 本阶段不过滤，展示名当 person_key 会把关系史静默清空。
  assert("② persons:[p_a] relationship 仍可见（已知缺口）", onlyA.text.includes("R1：他上次说别替他猜"), true);

  // ③ persons:[] → 只剩全局 1 行。
  const none = await render([]);
  assert("③ persons:[] human 段只有全局", humanBlock(none.text), ["G1：先把结论说清楚"]);
  assert("③ persons:[] human 行数 = 1", humanBlock(none.text).length, 1);

  // ④ persons:["p_c"]（库里没有 C 的行）→ human 段只剩全局，且 warnings 含「关于你」。
  const stranger = await render(["p_c"]);
  const strangerHuman = humanBlock(stranger.text);
  assert("④ persons:[p_c] human 段缺失或只剩全局", strangerHuman === null || strangerHuman.length <= 1, true);
  assert("④ persons:[p_c] human 段只剩全局", strangerHuman, ["G1：先把结论说清楚"]);
  assert(
    "④ persons:[p_c] warnings 含「关于你」",
    stranger.warnings.some((w) => w.includes("关于你")),
    true,
  );
  // 过滤只改 human 段：身份/底色/关系这些全局块不该被连带改动。
  assert("④ persons:[p_c] 仍有 ## 关系 块", stranger.text.includes("## 关系"), true);
  assert("④ persons:[p_c] 名称块不变", stranger.text.includes("## 名称\n小满"), true);
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);