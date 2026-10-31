/**
 * Barrel for tool modules. Importing this file registers every tool the plugin
 * ships: the modules self-register on import, so `src/index.ts` never lists
 * them. Adding a tool = one new file + one import line here.
 */
import './recall.js';
import './skills.js';
import './knowledge.js';

export * from './registry.js';
