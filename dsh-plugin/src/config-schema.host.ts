/**
 * The single `@deepseek-ai/schemastery` import of this plugin.
 *
 * `index.ts` re-exports `Config` from here; the host reads it off the plugin
 * module namespace (dsh-settings/lib/index.js schema(): `entry.fiber.runtime.Config`).
 * The dependency is provided by the host and never bundled: a plugin installed
 * into a profile resolves it through the profile's module graph, exactly like
 * `dsh-free-search/lib/index.js:3` (`import z from "@deepseek-ai/schemastery"`).
 * Consequence, stated because it is a real failure mode: if this package is ever
 * loaded from outside a profile (no @deepseek-ai/schemastery reachable), this
 * import fails and the whole plugin fails to load. deploy.sh always installs into
 * `<profile>/node_modules/@tdb/agemem-dsh`, and scripts/verify-installed.mjs
 * asserts that layout.
 */
import z from '@deepseek-ai/schemastery';
import { buildPluginConfigSchema, type SchemaNode, type SchemasteryLike } from './config-schema.js';

/** Schemastery `Config` for `tdb-agemem-dsh` (policy lives in config-schema.ts). */
export const Config: SchemaNode = buildPluginConfigSchema(z as unknown as SchemasteryLike);
