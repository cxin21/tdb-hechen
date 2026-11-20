import { readFile } from "node:fs/promises";
/**
 * Round19 契约新增：GET /v3/soul/labels 的合同测试（假 store，不连库）。
 *
 * 盯五件事：只接 GET、store 未就绪 503、缺省过滤 dormant 但 counts 含全量、
 * includeDormant=1 能审计已退役行、读失败 503 而不是 200 空表。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

import { handleSoulLabelsRoute } from "../soul-card-endpoint.js";
import type { SoulCardRouteDeps } from "../soul-card-endpoint.js";

const res = {} as ServerResponse;

type Row = Record<string, unknown>;

function label(name: string, status: string, over: Row = {}): Row {
  return {
    label: name,
    definition: `${name} 的定义`,
    gloss: "",
    anchor: "",
    direction: {},
    evidence: 3,
    status,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-11-01T00:00:00.000Z",
    aliases: [],
    protocolVersion: "v1",
    ...over,
  };
}

function handlerFor(rows: Row[] | null, extra: Partial<SoulCardRouteDeps> = {}) {
  const sent: Array<{ status: number; payload: unknown }> = [];
  const send = (_r: ServerResponse, status: number, payload: unknown) => {
    sent.push({ status, payload });
  };
  const store = rows === null ? null : ({ listSoulTraitLabels: vi.fn(async () => rows) } as never);
  const deps = { getStore: () => store, ...extra } as SoulCardRouteDeps;
  return async (query: string, method = "GET", pathname = "/v3/soul/labels") =>
    handleSoulLabelsRoute(new URL(`${pathname}?${query}`, "http://localhost"), method, send, res, deps).then((handled) => ({
      handled,
      sent,
    }));
}

describe("GET /v3/soul/labels", () => {
  it("缺省过滤 dormant，counts 仍按全量统计", async () => {
    const run = handlerFor([label("严谨", "seed"), label("先验后报", "admitted", { evidence: 4 }), label("旧习惯", "dormant")]);
    const { handled, sent } = await run("team=t1&user=u1&agent=a1");
    expect(handled).toBe(true);
    expect(sent[0].status).toBe(200);
    const data = (sent[0].payload as { data: { labels: Row[]; counts: Row; includeDormant: boolean } }).data;
    expect(data.labels.map((r) => r.label)).toEqual(["严谨", "先验后报"]);
    expect(data.counts).toEqual({ seed: 1, admitted: 1, dormant: 1 });
    expect(data.includeDormant).toBe(false);
    expect(data.labels[1]).toEqual({
      label: "先验后报",
      status: "admitted",
      definition: "先验后报 的定义",
      evidence: 4,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-11-01T00:00:00.000Z",
    });
  });

  it("includeDormant=1 能审计已退役行", async () => {
    const run = handlerFor([label("旧习惯", "dormant")]);
    const { sent } = await run("team=t1&includeDormant=1");
    const data = (sent[0].payload as { data: { labels: Row[]; includeDormant: boolean } }).data;
    expect(data.labels.map((r) => r.label)).toEqual(["旧习惯"]);
    expect(data.includeDormant).toBe(true);
  });

  it("store 未就绪 503；读失败 503（不回空表冒充成功）", async () => {
    const runNull = handlerFor(null);
    const a = await runNull("team=t1");
    expect(a.sent[0].status).toBe(503);
    expect((a.sent[0].payload as { message: string }).message).toBe("soul_labels_unavailable");

    const boom = handlerFor([], {});
    const storeBoom = { listSoulTraitLabels: vi.fn(async () => { throw new Error("db locked"); }) } as never;
    const sent: Array<{ status: number; payload: unknown }> = [];
    const deps = { getStore: () => storeBoom } as SoulCardRouteDeps;
    await handleSoulLabelsRoute(
      new URL("/v3/soul/labels?team=t1", "http://localhost"),
      "GET",
      (_r, status, payload) => sent.push({ status, payload }),
      res,
      deps,
    );
    expect(sent[0].status).toBe(503);
    expect((sent[0].payload as { message: string }).message).toBe("soul_labels_failed");
    expect(boom).toBeTruthy();
  });

  it("只接 GET 与自己的路径；store 缺方法时 200 空表", async () => {
    const run = handlerFor([label("严谨", "seed")]);
    expect((await run("", "POST")).handled).toBe(false);
    expect((await run("", "GET", "/v3/soul/card")).handled).toBe(false);

    const sent: Array<{ status: number; payload: unknown }> = [];
    const deps = { getStore: () => ({}) } as SoulCardRouteDeps;
    const handled = await handleSoulLabelsRoute(
      new URL("/v3/soul/labels?team=t1", "http://localhost"),
      "GET",
      (_r, status, payload) => sent.push({ status, payload }),
      res,
      deps,
    );
    expect(handled).toBe(true);
    const data = (sent[0].payload as { data: { labels: Row[]; counts: Row } }).data;
    expect(data.labels).toEqual([]);
    expect(data.counts).toEqual({ seed: 0, admitted: 0, dormant: 0 });
  });
  // 接线守卫必须对「注释掉」和「删掉派发」都红：只 contains 子串会被注释与 import 行骗过（A5 Round19）。
  const wiringProblems = (src: string): string[] => {
    const code = src
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"))
      .join("\n");
    const problems: string[] = [];
    if (!code.includes('pathname === "/v3/soul/labels"')) problems.push("whitelist_missing");
    if (!code.includes("await handleSoulLabelsRoute(")) problems.push("dispatch_missing");
    return problems;
  };

  it("server.ts 的 GET 白名单确实接了 /v3/soul/labels（接线不是零覆盖）", async () => {
    const src = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    expect(wiringProblems(src)).toEqual([]);
  });

  it("接线守卫能红：注释掉白名单 / 删掉派发都报错", () => {
    const src = [
      "if (method === \"GET\") {",
      '  if (pathname === "/v3/soul/labels") return true;',
      "  await handleSoulLabelsRoute(url, method, sendJson, res, deps);",
      "}",
    ].join("\n");
    expect(wiringProblems(src)).toEqual([]);
    expect(wiringProblems(src.replace('  if (pathname === "/v3/soul/labels") return true;', '  // if (pathname === "/v3/soul/labels") return true;'))).toContain("whitelist_missing");
    expect(wiringProblems(src.replace("  await handleSoulLabelsRoute(url, method, sendJson, res, deps);", ""))).toContain("dispatch_missing");
  });
});
