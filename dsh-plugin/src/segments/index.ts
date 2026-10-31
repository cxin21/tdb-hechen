/**
 * Barrel for the capability modules. Importing this file registers every
 * head-pack / volatile segment that ships today: the modules self-register on
 * import, so `src/index.ts` never lists them.
 *
 * Adding a capability = one new file + one import line here.
 */
import './persona.js';
import './l2.js';
import './skills.js';
import './wiki.js';
import './knowledge.js';
import { markBuiltins } from './registry.js';

// Snapshot the shipped segments; the test hook only clears what a test added.
markBuiltins();

export * from './registry.js';
