/**
 * 属性契约护栏（2026-11-04）：把「属性是否真的在记忆生命周期里生效」变成可判定事实。
 *
 * 断言：
 * 1. 每条属性登记 ≥1 个非 UI 消费点（仅面板/徽章 = 只用来看 → 红）；
 * 2. 每条登记项 {path, symbol} 在真实源码里存在（符号被删/改名 → 红）；
 * 3. 每条属性登记 ≥1 个 UI 可见面（用户原则：panel UI 可见）；
 * 4. 所有 soul 列都有契约条目，契约里没有幽灵字段。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATTRIBUTE_CONTRACT, nonUiConsumerCount } from "../attribute-contract.js";
import { SOUL_COL_NAMES } from "../store/soul-columns.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** __tests__ → core → src → MemoryCore → 仓库根 */
const REPO_ROOT = path.resolve(HERE, "../../../..");

const BASE_COLUMNS = new Set([
  "source_message_ids",
  "task_id",
  "type",
  "priority",
  "scene_name",
  "updated_time",
  "created_time",
]);

describe("属性契约注册表", () => {
  it("每条属性都有非 UI 消费点与 UI 可见面（禁止只用来看）", () => {
    const offenders = ATTRIBUTE_CONTRACT.filter((e) => nonUiConsumerCount(e) < 1 || !e.ui || e.ui.length === 0).map(
      (e) => `${e.name}: nonUi=${nonUiConsumerCount(e)} ui=${e.ui?.length ?? 0}`,
    );
    expect(offenders).toEqual([]);
  });

  it("登记项在真实源码里存在（符号消失即红）", () => {
    const missing: string[] = [];
    for (const entry of ATTRIBUTE_CONTRACT) {
      for (const c of entry.consumers) {
        const abs = path.join(REPO_ROOT, c.path);
        if (!fs.existsSync(abs)) {
          missing.push(`${entry.name}: 文件不存在 ${c.path}`);
          continue;
        }
        const text = fs.readFileSync(abs, "utf8");
        if (!text.includes(c.symbol)) missing.push(`${entry.name}: ${c.path} 缺符号 ${c.symbol}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("所有 soul 列都有契约条目，且没有幽灵字段", () => {
    const names = ATTRIBUTE_CONTRACT.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const unregistered = SOUL_COL_NAMES.filter((n) => !names.includes(n));
    expect(unregistered).toEqual([]);
    const ghosts = names.filter((n) => !SOUL_COL_NAMES.includes(n as never) && !BASE_COLUMNS.has(n));
    expect(ghosts).toEqual([]);
  });

  it("消费点必须给出 stage 与 effect（空描述 = 未登记清楚）", () => {
    const vague = ATTRIBUTE_CONTRACT.flatMap((e) =>
      e.consumers.filter((c) => !c.stage || !c.effect || c.effect.length < 8).map((c) => `${e.name}: ${c.path}`),
    );
    expect(vague).toEqual([]);
  });
});
