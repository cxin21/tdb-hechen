/**
 * 装配表静态还原 —— 把 src/server.ts 与 src/routes/*.ts 读成「挂载表 + /v3 路由清单」。
 *
 * 为什么不 import 真实 app：createApp() 会拉起 db/store/engines（better-sqlite3 原生绑定）
 * 与 telemetry；鉴权护栏只关心「装配行与路由清单写得对不对」，不该被运行期依赖绑架。
 * 路由清单以源码为唯一真相源，新增端点必然被抽到（抽不到就红，见 readV3Inventory 的
 * unresolved）。
 *
 * 用法：service-auth-route-guard.test.ts（路由清单 × 白名单）、
 * service-auth-assembly.test.ts（生产装配行位置）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEGRAPH_QUERY_TOOL_NAMES } from "../../src/codegraph-tool-names.js";

export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

export function readSrc(...segments: string[]): string {
  return readFileSync(join(SRC_DIR, ...segments), "utf8");
}

export interface RouteFile {
  file: string;
  source: string;
  /** 导出的 `createXxxRoutes` 完整名；没有导出工厂则为 undefined。 */
  factory?: string;
}

const ROUTE_FILE = /^[a-z0-9][a-z0-9-]*\.ts$/i;

let routeFilesCache: RouteFile[] | undefined;

/**
 * src/routes 下的全部路由模块（按文件名排序，目录即清单）。
 * 一次读取内缓存：同一次断言里的路由清单与挂载表必须来自同一份快照。
 * 目录里出现不符合 ROUTE_FILE 的 .ts（例如 `_shared.ts`）直接抛错 —— 静态还原会整份漏掉它，
 * 静默跳过等于护栏失效。
 */
export function readRouteFiles(): RouteFile[] {
  if (routeFilesCache) return routeFilesCache;
  const names = readdirSync(join(SRC_DIR, "routes")).filter((name) => name.endsWith(".ts"));
  const unparsed = names.filter((name) => !ROUTE_FILE.test(name));
  if (unparsed.length > 0) {
    throw new Error(
      `src/routes 下有不符合约定的文件名，静态装配还原会漏掉它们：${unparsed.join(", ")}`,
    );
  }
  routeFilesCache = names.sort().map((file) => {
    const source = readSrc("routes", file);
    const factory = /export function (create\w+Routes)\s*\(/.exec(source)?.[1];
    return { file, source, factory };
  });
  return routeFilesCache;
}

interface DynamicRegistration {
  /** 抽不到的注册调用条数（与静态正则的条数相加须等于真实调用总数）。 */
  calls: number;
  /** 这些调用展开出的端点（method + 已剥前缀的 path）。 */
  endpoints: { method: string; path: string }[];
}

/**
 * 已知的动态注册：源码里路径是模板/变量，静态正则抽不到，必须显式登记。
 * 登记不全（漏一处循环）或展开数不对，readV3Inventory 的 unresolved 会报红。
 */
function dynamicRegistrationsFor(file: string): DynamicRegistration | undefined {
  if (file !== "code-graph.ts") return undefined;
  // 源码：for (const action of CODEGRAPH_QUERY_TOOL_NAMES) app.post(`/${action}`, ...)
  return {
    calls: 1,
    endpoints: CODEGRAPH_QUERY_TOOL_NAMES.map((action) => ({ method: "POST", path: `/${action}` })),
  };
}

export interface MountEntry {
  /** app = 根 app（不受 /v3 门禁）；api = /v3 子 app（受门禁）。 */
  host: "app" | "api";
  /** server.ts 里的挂载前缀；"/" 表示无前缀。 */
  prefix: string;
  factory: string;
  /** 对应的 src/routes 文件；undefined = 死挂载（指向不存在的路由模块）。 */
  file?: string;
}

/**
 * 解析 server.ts 的挂载表：`(app|api).route("<prefix>", createXxxRoutes(...))`。
 * 注意 `app.route(config.apiPrefix, api)` 不是路由模块挂载，故意不匹配。
 */
export function readMountTable(): MountEntry[] {
  const serverSrc = readSrc("server.ts");
  const files = readRouteFiles();
  const mounts: MountEntry[] = [];
  for (const m of serverSrc.matchAll(
    /(?<![.\w])(app|api)\.route\(\s*"([^"]*)"\s*,\s*(create\w+Routes)\(/g,
  )) {
    mounts.push({
      host: m[1] as "app" | "api",
      prefix: m[2],
      factory: m[3],
      file: files.find((f) => f.factory === m[3])?.file,
    });
  }
  return mounts;
}

export interface RouteEntry {
  method: string;
  path: string;
  origin: string;
}

export interface V3Inventory {
  /** 挂在 api 子 app 上的端点（路径已剥掉 API 前缀，与鉴权白名单同口径）。 */
  routes: RouteEntry[];
  /** 字面量抽不到、也不在已登记动态清单里的注册（>0 即漏抽，必须显式处理）。 */
  unresolved: { file: string; count: number }[];
}

/** 路由注册调用（方法 + 首个字面量路径参数）。 */
const ROUTE_CALL = /\bapp\.(get|post|patch|put|delete)\(\s*["`]([^"`$]*)["`]/g;
/** 任意路由注册调用（含路径是变量/模板的动态注册），用于「抽不到就红」。 */
const ANY_ROUTE_CALL = /\bapp\.(get|post|patch|put|delete)\s*\(/g;

/**
 * 还原 /v3 端点清单：只含 api 子 app 上的挂载；根 app 的公开路由（/health）不计入。
 * code-graph 的动态只读查询端点按 codegraph-tool-names.ts 补齐（与路由注册同源）。
 */
export function readV3Inventory(): V3Inventory {
  const files = readRouteFiles();
  const routes: RouteEntry[] = [];
  const unresolved: { file: string; count: number }[] = [];

  for (const mount of readMountTable()) {
    if (mount.host !== "api") continue;
    if (mount.file === undefined) continue; // 死挂载由挂载表断言负责报红
    const routeFile = files.find((f) => f.factory === mount.factory);
    if (!routeFile) continue; // 无导出工厂的模块不会出现在挂载表里

    const base = mount.prefix === "/" ? "" : mount.prefix;
    const staticCalls = [...routeFile.source.matchAll(ROUTE_CALL)];
    for (const m of staticCalls) {
      routes.push({ method: m[1].toUpperCase(), path: base + m[2], origin: routeFile.file });
    }

    const totalCalls = [...routeFile.source.matchAll(ANY_ROUTE_CALL)].length;
    const dynamic = dynamicRegistrationsFor(routeFile.file);
    for (const endpoint of dynamic?.endpoints ?? []) {
      routes.push({
        method: endpoint.method,
        path: base + endpoint.path,
        origin: `${routeFile.file}(dynamic)`,
      });
    }

    const unaccounted = totalCalls - staticCalls.length - (dynamic?.calls ?? 0);
    if (unaccounted !== 0) unresolved.push({ file: routeFile.file, count: unaccounted });
  }

  return { routes, unresolved };
}

export interface UseMount {
  host: "app" | "api";
  index: number;
  /** 该 use 调用在源码里的原文（用于断言实参）。 */
  text: string;
}

export interface ServerAssembly {
  source: string;
  /** `(app|api).use(..., createServiceAuthMiddleware(...))` 的挂载点。 */
  authMounts: UseMount[];
  /** 首个 `api.route(...)` 的位置；-1 = 没有任何 api 路由。 */
  firstApiRouteIndex: number;
  /** 是否存在 `app.route(config.apiPrefix, api)`（把 /v3 子 app 挂到根 app）。 */
  apiMountedAtPrefix: boolean;
}

/** 无分号结尾时的取文长度：够覆盖一行装配调用即可。 */
const EXCERPT_LEN = 200;

/** 读 server.ts 的装配行：中间件挂载点、首个 api 路由位置、/v3 子 app 的挂载。 */
export function readServerAssembly(): ServerAssembly {
  const source = readSrc("server.ts");
  const authMounts: UseMount[] = [];
  for (const m of source.matchAll(
    /(?<![.\w])(app|api)\.use\([^;]*createServiceAuthMiddleware\(/g,
  )) {
    const index = m.index ?? -1;
    const end = source.indexOf(";", index);
    authMounts.push({
      host: m[1] as "app" | "api",
      index,
      text: source.slice(index, end === -1 ? index + EXCERPT_LEN : end),
    });
  }
  return {
    source,
    authMounts,
    firstApiRouteIndex: source.search(/api\.route\(/),
    apiMountedAtPrefix: /app\.route\(\s*config\.apiPrefix\s*,\s*api\s*\)/.test(source),
  };
}
