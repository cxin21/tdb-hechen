/**
 * A4 Round15：usage 上报的补投队列。
 *
 * 失败的上报按 key 入队；下一次回合收口先补投一条最旧的，再发本回合自己的。
 * 上限固定，满了丢最旧的一条 —— 宁可丢一条最老的观测，也不让内存随失败无限增长。
 * 单独成文件是为了能在单测里直接验证「满了丢最旧」而不必真的驱动 33 个回合。
 */
export class UsageRetryQueue<T> {
  private readonly map = new Map<string, T>();

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("max must be a positive integer");
  }

  /** 入队；同一 key 只保留一份（重复失败不叠加），满员时先丢最旧。 */
  enqueue(key: string, value: T): void {
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  /** 最旧的一条（FIFO），空队列返回 undefined。 */
  oldest(): [string, T] | undefined {
    return this.map.entries().next().value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
