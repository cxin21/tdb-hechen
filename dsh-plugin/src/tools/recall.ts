import { createRecallTool } from '../tools.js';
import { registerToolModule } from './registry.js';

/**
 * `memory_recall` — the read-only L1/L0 search tool (moved here from the entry
 * file by the task-72 seam work; the definition itself is unchanged and still
 * built by `src/tools.ts`, which carries the host-schema reasoning).
 */
registerToolModule({
  name: 'recall',
  enabled: (config) => config.tools.enabled && config.tools.recall,
  build: ({ client, config, log }) => [
    createRecallTool({
      client,
      defaultLimit: config.tools.recallTopK,
      timeoutMs: config.server.requestTimeoutMs,
      log,
    }),
  ],
});
