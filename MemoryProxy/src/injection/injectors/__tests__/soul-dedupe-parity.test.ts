/**
 * soul-dedupe（2026-10-19）红线近端去重单一源镜像契约测试（soul-dedupe-parity.test.ts）。
 *
 * 两包无跨包依赖（package.json 互不依赖），去重判定单一源以「镜像副本」落地：
 *   - MemoryCore/src/core/hooks/soul-dedupe.ts（assembler 消费）
 *   - MemoryProxy/src/injection/injectors/soul-dedupe.ts（红线近端 injector 消费，
 *     带 MIRROR_OF 对账锚常量）
 * 契约：剥离各自文件头注释块后，函数体逐位等价（任一侧漂移=本测试红，
 * 强制两侧同改——这是镜像策略的安全带）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIRROR_OF } from "../soul-dedupe.js";

const PROXY_MIRROR = join(import.meta.dirname, "..", "soul-dedupe.ts");
const CORE_SOURCE = join(import.meta.dirname, "..", "..", "..", "..", "..", "MemoryCore", "src", "core", "hooks", "soul-dedupe.ts");

/** 剥离文件头：从第一个 export 起截取；proxy 侧再剥去尾部 MIRROR_OF 注释块。 */
function bodyOf(text: string): string {
  const start = text.indexOf("export ");
  let body = text.slice(start);
  const mirrorAnchor = body.indexOf("/**\n * 镜像对账锚");
  if (mirrorAnchor >= 0) body = body.slice(0, mirrorAnchor);
  return body.replace(/\s+$/, "");
}

describe("soul-dedupe 红线近端去重单一源镜像契约", () => {
  it("MIRROR_OF 指向 MemoryCore 单一源路径", () => {
    expect(MIRROR_OF).toBe("MemoryCore/src/core/hooks/soul-dedupe.ts");
  });

  it("剥离文件头后函数体逐位等价（镜像安全带：任一侧漂移即红）", () => {
    const core = readFileSync(CORE_SOURCE, "utf8");
    const proxy = readFileSync(PROXY_MIRROR, "utf8");
    expect(bodyOf(proxy)).toBe(bodyOf(core));
  });
});
