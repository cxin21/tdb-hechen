import { describe, expect, it } from "vitest";
import { expandKeptWindows } from "../injection-stage.js";

const body = (n: number) => "采购订单价格审批流程说明".repeat(Math.ceil(n / 12)).slice(0, n);

describe("残预算扩窗（2026-11-04）", () => {
  it("块尾还有余量 + 入选行是压过的窗 → 把窗扩回去（同一证据更多上下文）", () => {
    const line = body(2000);
    const windowText = new Map<number, string>([[0, body(400)]]);
    const n = expandKeptWindows({
      kept: new Set([0]),
      order: [0],
      lines: [line],
      windowText,
      query: "采购订单价格审批",
      maxChars: 1000,
      scoreOf: new Map([[0, 0.9]]),
    });
    expect(n).toBe(1);
    const wider = windowText.get(0)!;
    expect(wider.length).toBeGreaterThan(400);
    expect(wider.length).toBeLessThanOrEqual(1000);
  });

  it("余量不足 BACKFILL_MIN_CHARS → 一个字都不动", () => {
    const windowText = new Map<number, string>([[0, body(900)]]);
    const n = expandKeptWindows({
      kept: new Set([0]),
      order: [0],
      lines: [body(2000)],
      windowText,
      query: "采购订单",
      maxChars: 1000,
      scoreOf: new Map([[0, 0.9]]),
    });
    expect(n).toBe(0);
    expect(windowText.get(0)).toBe(body(900));
  });

  it("入选行本来就是整行（没被压过）→ 不扩（不引入新文本）", () => {
    const line = body(300);
    const windowText = new Map<number, string>();
    const n = expandKeptWindows({
      kept: new Set([0]),
      order: [0],
      lines: [line],
      windowText,
      query: "采购订单",
      maxChars: 2000,
    });
    expect(n).toBe(0);
    expect(windowText.size).toBe(0);
  });

  it("未入选的行不参与扩窗（只扩已注入的证据）", () => {
    const windowText = new Map<number, string>();
    const n = expandKeptWindows({
      kept: new Set([1]),
      order: [0, 1],
      lines: [body(2000), body(2000)],
      windowText,
      query: "采购订单",
      maxChars: 3000,
    });
    expect(n).toBe(0);
    expect(windowText.has(0)).toBe(false);
  });
});
