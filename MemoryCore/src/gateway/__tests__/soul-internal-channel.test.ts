import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackAddress, soulInternalChannelEnabled } from "../soul-internal-channel.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, "..", "server.ts"), "utf8");

describe("Round30 内部通道（只读 soul 面免 Bearer）", () => {
  it("回环判定只认真正的回环地址", () => {
    for (const ok of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "  127.0.0.1  "]) {
      expect(isLoopbackAddress(ok), ok).toBe(true);
    }
    for (const bad of ["10.0.0.7", "192.168.1.9", "0.0.0.0", "::ffff:10.0.0.7", "", null, undefined, "localhost"]) {
      expect(isLoopbackAddress(bad as string | null | undefined), String(bad)).toBe(false);
    }
  });

  it("默认开启，只有显式 off 才关（env 由 supervisor 启动时载入，改后只重启 Core 不重读）", () => {
    expect(soulInternalChannelEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(soulInternalChannelEnabled({ TDB_SOUL_INTERNAL_CHANNEL: "  " } as NodeJS.ProcessEnv)).toBe(true);
    for (const off of ["off", "0", "false", "no", " OFF "]) {
      expect(soulInternalChannelEnabled({ TDB_SOUL_INTERNAL_CHANNEL: off } as NodeJS.ProcessEnv), off).toBe(false);
    }
    for (const on of ["on", "1", "true", "yes", " ON "]) {
      expect(soulInternalChannelEnabled({ TDB_SOUL_INTERNAL_CHANNEL: on } as NodeJS.ProcessEnv), on).toBe(true);
    }
  });

  it("只读路由走内部通道、写入路由仍走 Bearer（源码接线断言）", () => {
    // 只读两处：card/turn/trait-state/emotions/labels/person* 家族与 injection/stats
    expect(serverSrc).toMatch(/if \(!this\.checkSoulReadAuth\(req, res\)\) return;\r?\n\s+const deps = \{/u);
    expect(serverSrc).toMatch(/if \(!this\.checkSoulReadAuth\(req, res\)\) return;\r?\n\s+const statsJournalCfg/u);
    // 写入三处必须保持 Bearer：injection / event / gate
    expect(serverSrc).toMatch(/pathname === "\/v3\/soul\/injection"\) \{\r?\n\s+if \(!this\.checkAuth\(req, res\)\) return;/u);
    expect(serverSrc).toMatch(/pathname === SOUL_EVENT_PATH\) \{\r?\n\s+if \(!this\.checkAuth\(req, res\)\) return;/u);
    expect(serverSrc).toMatch(/pathname === SOUL_GATE_PATH\) \{\r?\n\s+if \(!this\.checkAuth\(req, res\)\) return;/u);
    // 内部通道函数本身不能用任何可伪造头判定
    expect(serverSrc).toMatch(/soulInternalChannelEnabled\(\) && isLoopbackAddress\(req\.socket\?\.remoteAddress\)/u);
  });
});
