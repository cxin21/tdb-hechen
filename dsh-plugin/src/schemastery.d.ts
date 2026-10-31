/**
 * Local module declaration for the host-provided Schemastery library.
 *
 * `@deepseek-ai/schemastery` is a peer of the host application, not a dependency
 * of this package (no copy exists under dsh-plugin/node_modules — that directory
 * is a symlink to MemoryCore/node_modules). Without this declaration `tsc`
 * reports TS2307 for config-schema.host.ts. The declared contract stays
 * deliberately structural: config-schema.ts only needs `object()` and `any()`
 * plus the `.default()/.volatile()/.role()/.description()` chain.
 */
declare module '@deepseek-ai/schemastery' {
  import type { SchemaNode } from './config-schema.js';
  const z: {
    any(): SchemaNode;
    object(dict: Record<string, SchemaNode>): SchemaNode;
  };
  export default z;
}
