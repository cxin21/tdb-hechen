/**
 * provider-repo — persistence + repo for member LLM providers.
 *
 * Backed by the process-level ProxyStorage abstraction (COS / SQLite / FS /
 * Memory), the same shared KV layer used by binding / skill / session repos,
 * via {@link getProxyStorage}. Entries live permanently under the `nottl/`
 * bucket (never auto-expired — losing a provider would silently make members
 * fall back to the global upstream and change behavior).
 *
 * Key layout (the spaceId-position segment is a fixed constant because member
 * providers are global per `(subject_type, subject_id)`, matching the spec
 * table which has no spaceId column):
 *   nottl/<namespace>/llm-provider/<type>/<id>.json
 *
 * Uniqueness: each `(subject_type, subject_id)` maps to exactly one key, so a
 * `set` is an overwrite of the same composite key (PK semantics).
 */
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { assertKeySegment } from "../storage/key-utils.js";
import type { LlmProvider, LlmProviderSubjectType } from "./types.js";

/** Allowed subject kinds — restricted to `user | agent` by the spec. */
export const LLM_PROVIDER_SUBJECT_TYPES: readonly LlmProviderSubjectType[] = ["user", "agent"];

/** Read/write contract for the provider store. */
export interface LlmProviderStore {
  get(type: LlmProviderSubjectType, id: string): Promise<LlmProvider | null>;
  set(entry: LlmProvider): Promise<void>;
  del(type: LlmProviderSubjectType, id: string): Promise<void>;
  list(type: LlmProviderSubjectType): Promise<LlmProvider[]>;
}

const BUCKET = "nottl";
/** Fixed spaceId-position segment — member providers are global (no spaceId in spec). */
const PROVIDER_NAMESPACE = "_default";
const PROVIDER_DIR = "llm-provider";
const JSON_SUFFIX = ".json";

/** Reject any subject type outside the spec's `user | agent`. */
function assertSubjectType(type: LlmProviderSubjectType): void {
  if (type !== "user" && type !== "agent") {
    throw new Error(`invalid llm_provider subject_type: ${String(type)}`);
  }
}

function keyOf(type: LlmProviderSubjectType, id: string): string {
  assertSubjectType(type);
  assertKeySegment("subject_id", id);
  return `${BUCKET}/${PROVIDER_NAMESPACE}/${PROVIDER_DIR}/${type}/${id}${JSON_SUFFIX}`;
}

/** Concrete ProxyStorage-backed repo. Misses return null; reads never throw. */
export class LlmProviderRepo implements LlmProviderStore {
  constructor(private readonly storage: ProxyStorage) {}

  async get(type: LlmProviderSubjectType, id: string): Promise<LlmProvider | null> {
    try {
      return await this.storage.getJSON<LlmProvider>(keyOf(type, id));
    } catch {
      return null;
    }
  }

  set(entry: LlmProvider): Promise<void> {
    // keyOf validates subject_type + subject_id synchronously so bad input is
    // observable at the call site rather than as a silent async failure.
    const key = keyOf(entry.subject_type, entry.subject_id);
    return this.storage.putJSON(key, entry);
  }

  async del(type: LlmProviderSubjectType, id: string): Promise<void> {
    try {
      await this.storage.del(keyOf(type, id));
    } catch {
      /* missing key is not an error */
    }
  }

  async list(type: LlmProviderSubjectType): Promise<LlmProvider[]> {
    const prefix = `${BUCKET}/${PROVIDER_NAMESPACE}/${PROVIDER_DIR}/${type}/`;
    let names: string[];
    try {
      names = await this.storage.listNames(prefix);
    } catch {
      return [];
    }
    const out: LlmProvider[] = [];
    for (const name of names) {
      if (!name.endsWith(JSON_SUFFIX)) continue;
      const id = name.slice(0, -JSON_SUFFIX.length);
      const entry = await this.get(type, id);
      if (entry) out.push(entry);
    }
    return out;
  }
}