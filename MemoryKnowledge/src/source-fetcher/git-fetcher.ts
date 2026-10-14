/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 public HTTPS / SSH + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceProbeResult, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * scp 风格 SSH 地址：git@host:path（host 不含 / 或 :；path 至少 1 字符）。
 * host 段为第 1 捕获组，供 SSRF 黑名单检查；ssh://user@host[:port]/path 由标准 URL 解析覆盖。
 */
const SSH_SCP_LIKE_RE = /^[^\s@]+@([^\s:/]+):([^\s]+)$/;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关（协议白名单 https/ssh 校验始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // 支持 public HTTPS 与 SSH 两种形式（scp 风格 git@host:path / ssh://user@host[:port]/path）。
    // SSH 复用运行进程的 ~/.ssh（key/agent/known_hosts）完成鉴权，凭据不落 KS 数据库；
    // 匿名 HTTPS 不可用、需 OAuth 交互的私有仓库（如企业内网 GitLab）由此解锁。
    const isHttps = sourceUrl.startsWith("https://");
    const isSsh = sourceUrl.startsWith("ssh://") || SSH_SCP_LIKE_RE.test(sourceUrl);
    if (!isHttps && !isSsh) {
      throw new Error(
        "source_url must be an https:// or SSH git URL (git@host:path.git / ssh://user@host/path.git)",
      );
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    await simpleGit().clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  /**
   * 连接探测（DS-PANEL-UI-WIKI-SOURCE-001 POST /wiki/:id/test）：git ls-remote --heads，
   * 秒级、零落盘。先 validate()（https-only + SSRF 零放宽）。10s 阻塞超时防挂起。
   */
  async probe(sourceUrl: string, branch?: string): Promise<SourceProbeResult> {
    this.validate(sourceUrl);
    const git = simpleGit({ timeout: { block: 10_000 } });
    const out = await git.listRemote(["--heads", sourceUrl]);
    const branches = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\t").pop() ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.replace("refs/heads/", ""));
    return { reachable: true, branches, ...(branch ? { currentBranch: branch } : {}) };
  }

  // ── 内部 helper ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    if (url.startsWith("git@")) {
      // scp 风格（git@host:path）不是合法 URL，无法走 URL 构造器，正则取 host 段。
      return SSH_SCP_LIKE_RE.exec(url)?.[1] ?? "";
    }
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
