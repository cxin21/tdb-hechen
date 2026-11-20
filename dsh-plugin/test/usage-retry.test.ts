import { describe, expect, it } from "vitest";
import { UsageRetryQueue } from "../src/usage-retry";

describe("UsageRetryQueue（A4 Round15）", () => {
  it("FIFO：最旧的一条先补投，同一 key 只保留一份", () => {
    const q = new UsageRetryQueue<number>(8);
    q.enqueue("t1", 1);
    q.enqueue("t2", 2);
    q.enqueue("t1", 11);
    expect(q.size).toBe(2);
    // Map 保留首次插入顺序：重复入队更新值但不改位置。
    expect(q.oldest()).toEqual(["t1", 11]);
    q.delete("t1");
    expect(q.oldest()).toEqual(["t2", 2]);
  });

  it("有上限：满员时丢最旧，不丢刚进来的", () => {
    const q = new UsageRetryQueue<number>(32);
    for (let i = 0; i < 40; i += 1) q.enqueue("t" + i, i);
    expect(q.size).toBe(32);
    expect(q.oldest()?.[0]).toBe("t8");
    expect(q.has("t39")).toBe(true);
  });

  it("非法上限直接拒绝构造（避免 0 或负数变成无界或永远丢）", () => {
    expect(() => new UsageRetryQueue(0)).toThrow(/positive/);
  });
});
