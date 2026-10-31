/**
 * task-81 · L1 抽取会话范围解析：memory.extraction.sessionScope。
 *
 * 语义（task-62 用户口径）：检索可以跨会话，抽取不能混。
 * 缺省 "session" = 一批出现多个 session_id 时只抽最靠前那个会话（其余延后，零丢行）；
 * "profile" = 旧的多会话同批行为，仅供排查/灰度。非法值一律回落缺省（写路径不因配置笔误抛错）。
 *
 * 行为差异的活证在 src/utils/l1-runner-session-isolation.test.ts（同批两会话：
 * session 档只处理 1 组 + 游标停在被延后行之前；profile 档两组同批、游标推进到本批末）。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { loadGatewayConfig } from "../../gateway/config.js";

const extractionOf = (raw: Record<string, unknown>) => parseConfig({ extraction: raw }).extraction;

describe("memory.extraction.sessionScope（task-81 接线）", () => {
  it("缺省 session（单会话抽取）", () => {
    expect(parseConfig({}).extraction.sessionScope).toBe("session");
    expect(extractionOf({}).sessionScope).toBe("session");
  });

  it("显式 profile 回退旧行为", () => {
    expect(extractionOf({ sessionScope: "profile" }).sessionScope).toBe("profile");
  });

  it("显式 session 保持缺省", () => {
    expect(extractionOf({ sessionScope: "session" }).sessionScope).toBe("session");
  });

  it("非法值回落 session（大小写/空白不算合法）", () => {
    expect(extractionOf({ sessionScope: "PROFILE" }).sessionScope).toBe("session");
    expect(extractionOf({ sessionScope: " profile " }).sessionScope).toBe("profile");
    expect(extractionOf({ sessionScope: 1 }).sessionScope).toBe("session");
    expect(extractionOf({ sessionScope: "" }).sessionScope).toBe("session");
  });

  it("生产 gateway yaml 解析出 session 档（防「类型里有、yaml 里没接」）", () => {
    // 只读解析生产 yaml 的 memory 段：不启服务、不连库、不写文件
    const yamlPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tdai-gateway.yaml");
    vi.stubEnv("TDAI_GATEWAY_CONFIG", yamlPath);
    try {
      const cfg = loadGatewayConfig();
      expect(cfg.memory.extraction.sessionScope).toBe("session");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
