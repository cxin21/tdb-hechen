import { describe, it, expect } from "vitest";
import { GitSourceFetcher } from "../src/source-fetcher/git-fetcher.js";

/**
 * GitSourceFetcher.validate() — HTTPS + SSH 双协议校验合同。
 *
 * 背景：wiki git 源第一版仅支持 public HTTPS；企业内网 GitLab（如 git.yyrd.com）
 * 匿名 HTTPS 不可用（GCM 强制 OAuth 交互），需支持 SSH（复用运行进程的 ~/.ssh）。
 * registry.detectType 本就把 git@/ssh:// 路由到 GitSourceFetcher（registry.ts），
 * 故此处只需扩展 validate() 的协议白名单与 host 提取；SSRF 私网黑名单两种协议同标准。
 */
describe("GitSourceFetcher.validate — HTTPS + SSH", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: true });

  it("accepts scp-like SSH url (git@host:path.git)", () => {
    expect(() => fetcher.validate("git@git.yyrd.com:NCC_SCM_AI/scm_ai.git")).not.toThrow();
  });

  it("accepts ssh:// url with optional port", () => {
    expect(() => fetcher.validate("ssh://git@git.yyrd.com/NCC_SCM_AI/scm_ai.git")).not.toThrow();
    expect(() =>
      fetcher.validate("ssh://git@git.yyrd.com:2222/NCC_SCM_AI/scm_ai.git"),
    ).not.toThrow();
  });

  it("still accepts public HTTPS url", () => {
    expect(() => fetcher.validate("https://github.com/acme/docs.git")).not.toThrow();
  });

  it("rejects scp-like SSH url pointing to a private address", () => {
    expect(() => fetcher.validate("git@192.168.1.10:acme/docs.git")).toThrow(
      /private|loopback/i,
    );
  });

  it("rejects ssh:// url pointing to loopback host", () => {
    expect(() => fetcher.validate("ssh://git@localhost/acme/docs.git")).toThrow(
      /private|loopback/i,
    );
  });

  it("rejects unsupported schemes and malformed scp-like urls", () => {
    expect(() => fetcher.validate("ftp://example.com/acme/docs.git")).toThrow(/https|ssh/i);
    expect(() => fetcher.validate("git@git.yyrd.com-acme/docs.git")).toThrow(/https|ssh/i);
  });

  it("ssrfCheck:false preserves the escape hatch for private ssh hosts", () => {
    expect(() =>
      new GitSourceFetcher({ ssrfCheck: false }).validate("git@192.168.1.10:acme/docs.git"),
    ).not.toThrow();
  });
});
