/**
 * 对外暴露的 codegraph 查询工具名（不含 get_info，get_info 在调用方特殊处理）。
 *
 * 只读查询名以此为准：code-graph.ts 的动态路由注册、toCodeGraphToolName 的校验列表、
 * 入站鉴权的只读白名单（middleware/auth.ts）都从这份名单来。
 * 注意 tools.ts 的 CODE_GRAPH_TOOLS 仍手写元数据（描述 / 参数 schema），不由此生成；
 * 新增或改名工具时需要两处同步，否则工具表与路由/白名单会漂移。
 *
 * 独立成零依赖叶子模块：鉴权中间件与单测都要引用同一份名单，不能经由
 * routes/tools.js —— 那条链会拖进 store/engines（better-sqlite3 等本地依赖），
 * 鉴权中间件不该背这个依赖包袱。
 */
export const CODEGRAPH_QUERY_TOOL_NAMES: readonly string[] = [
  "search", "explore", "callers", "callees", "impact", "node", "status", "files",
];
