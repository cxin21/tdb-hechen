import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { handleSoulInjectionRoute } from "../soul-injection-endpoint.js";

const res = {} as ServerResponse;
const opts = { enabled: true, rotationSizeMB: 5, maxFiles: 5 };

function call(
  path: string,
  method: string,
  body: unknown,
  dir: string,
  journalOpts = opts,
) {
  const sendJson = vi.fn();
  const parseJsonBody = async () => body;
  return handleSoulInjectionRoute(
    {} as never,
    res,
    path,
    method,
    parseJsonBody as never,
    sendJson,
    { journalDir: dir, journalOpts, now: () => new Date("2026-11-07T12:00:00.000Z") },
  ).then((handled) => ({ handled, sendJson }));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "soul-injection-"));
}

function journalLines(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "recall-journal-team-2k12lgb650-agt-a.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("POST /v3/soul/injection（R1 实际注入回传）", () => {
  it("只认该路径 POST，其余交回 dispatch / 405", async () => {
    const dir = tmp();
    try {
      expect((await call("/v3/soul/card", "POST", {}, dir)).handled).toBe(false);
      const get = await call("/v3/soul/injection", "GET", {}, dir);
      expect(get.handled).toBe(true);
      expect(get.sendJson.mock.calls[0]?.[1]).toBe(405);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺 team → 400，且不写任何行", async () => {
    const dir = tmp();
    try {
      const r = await call("/v3/soul/injection", "POST", { card: { version: 1, hash: "ab", chars: 10 } }, dir);
      expect(r.sendJson.mock.calls[0]?.[1]).toBe(400);
      expect(journalLines(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写一条 kind=injection 行：只有长度与指纹，绝不落正文", async () => {
    const dir = tmp();
    try {
      const r = await call(
        "/v3/soul/injection",
        "POST",
        {
          team: "team-2k12lgb650",
          user: "usr-1",
          agent: "agt-a",
          sessionKey: "sess-1",
          turn: 7,
          card: { version: 16, hash: "b5d26ba1", chars: 234 },
          volatile: { chars: 83, hash: "9a1c", skipped: false },
        },
        dir,
      );
      expect(r.sendJson.mock.calls[0]?.[1]).toBe(200);
      const [row] = journalLines(dir);
      expect(row).toMatchObject({
        kind: "injection",
        teamId: "team-2k12lgb650",
        userId: "usr-1",
        agentId: "agt-a",
        sessionKey: "sess-1",
        turn: 7,
        card: { version: 16, hash: "b5d26ba1", chars: 234 },
        volatile: { chars: 83, hash: "9a1c", skipped: false },
      });
      // 隐私边界：任何正文字段都不许出现在行里。
      const text = JSON.stringify(row);
      expect(Object.keys(row)).not.toContain("text");
      expect(text).not.toContain("近期心境");
      expect(text).not.toContain("prompt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skipped=true 时 chars 强制归零（去重跳过 = 0 字符真注入）", async () => {
    const dir = tmp();
    try {
      await call(
        "/v3/soul/injection",
        "POST",
        { team: "team-2k12lgb650", agent: "agt-a", turn: 8, volatile: { chars: 52, hash: "aa", skipped: true } },
        dir,
      );
      expect(journalLines(dir)[0]?.volatile).toMatchObject({ chars: 0, skipped: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("card 与 volatile 都缺 → 400 empty_injection", async () => {
    const dir = tmp();
    try {
      const r = await call("/v3/soul/injection", "POST", { team: "t" }, dir);
      expect(r.sendJson.mock.calls[0]?.[1]).toBe(400);
      expect(journalLines(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journal 关闭时仍 200（best-effort，不阻断会话）", async () => {
    const dir = tmp();
    try {
      const r = await call(
        "/v3/soul/injection",
        "POST",
        { team: "t", agent: "agt-a", card: { version: 1, hash: "ab", chars: 5 } },
        dir,
        { enabled: false, rotationSizeMB: 5, maxFiles: 5 },
      );
      expect(r.sendJson.mock.calls[0]?.[1]).toBe(200);
      expect(existsSync(join(dir, "recall-journal-t-agt-a.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("phase：显式 card / volatile 原样落行，缺省时按在场字段推断", async () => {
    const dir = tmp();
    try {
      const base = {
        team: "team-2k12lgb650",
        agent: "agt-a",
        sessionKey: "sess-1",
        turn: 12,
      };
      await call("/v3/soul/injection", "POST", { ...base, phase: "card", card: { version: 3, hash: "abc123", chars: 480 } }, dir);
      await call("/v3/soul/injection", "POST", { ...base, phase: "volatile", volatile: { chars: 83, hash: "ff0011", skipped: false } }, dir);
      // 旧版插件不带 phase：只有 card → card，只有 volatile → volatile。
      await call("/v3/soul/injection", "POST", { ...base, card: { version: 3, hash: "abc123", chars: 480 } }, dir);
      await call("/v3/soul/injection", "POST", { ...base, volatile: { chars: 0, hash: "ff0011", skipped: true } }, dir);
      // 乱填的 phase 不采信，退回推断。
      await call("/v3/soul/injection", "POST", { ...base, phase: "bogus", card: { version: 3, hash: "abc123", chars: 480 } }, dir);

      const lines = journalLines(dir);
      expect(lines).toHaveLength(5);
      expect(lines.map((line) => line.phase)).toEqual(["card", "volatile", "card", "volatile", "card"]);
      // 隐私边界仍然成立：行里没有正文，只有长度与指纹。
      expect(JSON.stringify(lines)).not.toContain("近期心境");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
