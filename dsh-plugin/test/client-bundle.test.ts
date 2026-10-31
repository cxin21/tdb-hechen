import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const CLIENT_PATH = fileURLToPath(new URL("../client/client.js", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const BUNDLE_PATCH_PATH = fileURLToPath(new URL("../cordis.bundle.yml", import.meta.url));

type AnyRecord = Record<string, any>;

/** The volatile field paths the Host schema marks; the page must cover exactly these. */
const EXPECTED_FIELD_PATHS = [
  "enabled",
  "server.baseUrl",
  "server.serviceId",
  "server.teamId",
  "server.agentId",
  "server.userId",
  "server.apiKeyRef",
  "server.userKeyRef",
  "writeback.enabled",
  "writeback.skillFeed",
  "volatile.enabled",
  "volatile.maxChars",
  "tools.enabled",
  "tools.recall",
  "debug"
];

/** The field paths rendered as toggles. */
const BOOLEAN_PATHS = [
  "enabled",
  "writeback.enabled",
  "writeback.skillFeed",
  "volatile.enabled",
  "tools.enabled",
  "tools.recall",
  "debug"
];

/** A snapshot store with the subscription shape the client store exposes. */
function snapshotStore(initial: unknown) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** Load the browser half in a VM sandbox and return its exports. */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, "utf8");
  let record: AnyRecord | undefined;
  const styles: AnyRecord[] = [];
  const sandbox: AnyRecord = {
    window: {
      __ModuleLoader__: {
        load: (module: AnyRecord) => {
          record = module;
        }
      }
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {} }),
      head: { appendChild: (tag: AnyRecord) => styles.push(tag) }
    }
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: CLIENT_PATH }).runInContext(sandbox);
  if (record === undefined) throw new Error("client.js did not call window.__ModuleLoader__.load");
  const primitives: AnyRecord = {
    SettingsForm: "SettingsForm",
    SettingsValueField: "SettingsValueField",
    SettingsSecretField: "SettingsSecretField",
    Switch: "Switch"
  };
  const jsxRuntime = {
    jsx: (type: unknown, props: AnyRecord) => ({ type, props }),
    jsxs: (type: unknown, props: AnyRecord) => ({ type, props })
  };
  const requireStub = (name: string) => {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    if (name === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: (initial: unknown) => snapshotStore(initial) };
    throw new Error("unexpected require: " + name);
  };
  const exports = (record as AnyRecord).factory(requireStub) as AnyRecord;
  return { record: record as AnyRecord, exports, primitives, styles };
}

/** Build the browser-side context the client half expects. */
function fakeContext(overrides: AnyRecord = {}) {
  const dictionaries: AnyRecord = {};
  const registrations: AnyRecord[] = [];
  const served: string[][] = [];
  const baseValue = {
    enabled: true,
    server: {
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "",
      agentId: "",
      userId: "",
      apiKeyRef: "TDAI_GATEWAY_APIKEY",
      userKeyRef: "TDAI_USER_KEY"
    },
    writeback: { enabled: true, skillFeed: true },
    volatile: { enabled: true, maxChars: 1200 },
    tools: { enabled: true, recall: true },
    debug: false
  };
  const snapshot: AnyRecord = {
    status: "ready",
    writable: true,
    revision: 7,
    value: baseValue,
    base: baseValue,
    user: {},
    secrets: {},
    ...overrides
  };
  const scope: AnyRecord = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: vi.fn(async (ops: AnyRecord[], revision?: number) => {
      void ops;
      void revision;
      return true;
    })
  };
  const ctx: AnyRecord = {
    locale: {
      register: (ns: string, dicts: AnyRecord) => {
        dictionaries[ns] = dicts;
      },
      bind: (ns: string) => (key: string) => dictionaries[ns]?.en?.[key] ?? key
    },
    configForms: {
      get: (ns: string) => {
        scope.namespace = ns;
        return scope;
      },
      whileServed: (namespaces: string[], register: () => void) => {
        served.push(namespaces);
        register();
        return () => {};
      }
    },
    slots: {
      inject: (_name: string, register: () => unknown) => {
        register();
        return () => {};
      },
      register: (options: AnyRecord, component: unknown) => {
        registrations.push({ options, component });
        return () => {};
      }
    },
    remote: {
      credentials: {
        set: vi.fn(async (ref: string, value: string) => ({ ok: true, ref, value })),
        describe: vi.fn(async (refs: string[]) => ({
          ok: true,
          value: Object.fromEntries(refs.map((ref) => [ref, { configured: ref === "TDAI_GATEWAY_APIKEY", writable: true }]))
        }))
      },
      $on: () => () => {}
    },
    effect: (fn: () => unknown) => fn()
  };
  return { ctx, scope, registrations, served, dictionaries };
}

/** Mount the page and return the face its slot registration injects. */
function mount(overrides: AnyRecord = {}) {
  const loaded = loadClient();
  const fake = fakeContext(overrides);
  loaded.exports.apply(fake.ctx);
  const registration = fake.registrations[0]!;
  const injected = registration.options.inject() as AnyRecord;
  const store = (injected.hooks as AnyRecord).tdbAgememCard as AnyRecord;
  const t = fake.ctx.locale.bind("settings.tdbAgemem") as (key: string) => string;
  return { ...loaded, ...fake, registration, injected, store, t };
}

/** Render the page the way the Host does, returning the element tree. */
function renderPage(mounted: ReturnType<typeof mount>, view = "page") {
  const component = mounted.registration.component as AnyRecord;
  return component({
    t: mounted.t,
    view,
    ...mounted.injected,
    useTdbAgememCard: (selector: (snapshot: unknown) => unknown) => selector(mounted.store.getSnapshot())
  }) as AnyRecord;
}

/** Collect every element id in a rendered tree. */
function collectIds(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectIds(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const element = node as AnyRecord;
  if (typeof element.props?.id === "string") out.push(element.props.id);
  collectIds(element.props?.children, out);
  return out;
}

/** Collect every rendered element of a tree. */
function collectElements(node: unknown, out: AnyRecord[] = []): AnyRecord[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const element = node as AnyRecord;
  out.push(element);
  collectElements(element.props?.children, out);
  return out;
}

describe("client half: registration", () => {
  it("registers itself under the plugin id", () => {
    const { record } = loadClient();
    expect(record.id).toBe("@tdb/agemem-dsh");
    expect(typeof record.factory).toBe("function");
  });

  it("exposes the namespace and the profile entry id the Host names the page after", () => {
    const { exports } = loadClient();
    expect(exports.NS).toBe("settings.tdbAgemem");
    expect(exports.ENTRY_ID).toBe("tdb-agemem-dsh");
  });

  it("declares exactly the services apply uses", () => {
    const { exports } = loadClient();
    expect(exports.inject).toEqual(["slots", "locale", "remote", "remote.credentials", "configForms"]);
  });
});

describe("client half: mounting", () => {
  it("binds the settings namespace to the profile entry id", () => {
    const mounted = mount();
    expect(mounted.served).toEqual([["tdb-agemem-dsh"]]);
    expect(mounted.scope.namespace).toBe("tdb-agemem-dsh");
  });

  it("registers one page into the plugins item slot", () => {
    const mounted = mount();
    expect(mounted.registrations).toHaveLength(1);
    const options = mounted.registrations[0]!.options;
    expect(options.name).toBe("plugins.item");
    expect(options.id).toBe("tdb-agemem");
    expect(options.locale).toBe("settings.tdbAgemem");
    expect(typeof options.label()).toBe("string");
    expect(options.label().length).toBeGreaterThan(0);
  });

  it("registers both dictionaries with the same key set", () => {
    const mounted = mount();
    const dicts = mounted.dictionaries["settings.tdbAgemem"];
    expect(Object.keys(dicts).sort()).toEqual(["en", "zh"]);
    expect(Object.keys(dicts.en).sort()).toEqual(Object.keys(dicts.zh).sort());
  });

  it("shares one staged form between the hook face and the actions", () => {
    const mounted = mount();
    expect(typeof mounted.store.getSnapshot).toBe("function");
    expect(typeof mounted.injected.edit).toBe("function");
    expect(typeof mounted.injected.setBoolean).toBe("function");
    expect(typeof mounted.injected.save).toBe("function");
    expect(typeof mounted.injected.discard).toBe("function");
  });
});

describe("client half: staged writes", () => {
  it("saves a nested text field as a multi-segment path at the snapshot revision", async () => {
    const mounted = mount();
    mounted.injected.edit(["server", "teamId"], "team-1");
    await mounted.injected.save();
    expect(mounted.scope.mutate).toHaveBeenCalledTimes(1);
    const [ops, revision] = mounted.scope.mutate.mock.calls[0]!;
    expect(ops).toEqual([{ op: "set", path: ["server", "teamId"], value: "team-1" }]);
    expect(revision).toBe(7);
  });

  it("saves a toggle as a JSON boolean", async () => {
    const mounted = mount();
    mounted.injected.setBoolean(["writeback", "enabled"], false);
    await mounted.injected.save();
    const [ops] = mounted.scope.mutate.mock.calls[0]!;
    expect(ops).toEqual([{ op: "set", path: ["writeback", "enabled"], value: false }]);
  });

  it("writes a number field as a number", async () => {
    const mounted = mount();
    mounted.injected.edit(["volatile", "maxChars"], "900");
    await mounted.injected.save();
    const [ops] = mounted.scope.mutate.mock.calls[0]!;
    expect(ops).toEqual([{ op: "set", path: ["volatile", "maxChars"], value: 900 }]);
  });

  it("sends nothing when a draft restates the live value", async () => {
    const mounted = mount();
    mounted.injected.edit(["server", "baseUrl"], "http://127.0.0.1:8420");
    await mounted.injected.save();
    expect(mounted.scope.mutate).not.toHaveBeenCalled();
  });

  it("clears an override only where the user layer stores the path", async () => {
    const plain = mount();
    plain.injected.edit(["server", "userId"], "");
    await plain.injected.save();
    expect(plain.scope.mutate).not.toHaveBeenCalled();

    const stored = mount({ user: { server: { userId: "u-1" } } });
    stored.injected.edit(["server", "userId"], "");
    await stored.injected.save();
    const [ops] = stored.scope.mutate.mock.calls[0]!;
    expect(ops).toEqual([{ op: "unset", path: ["server", "userId"] }]);
  });

  it("refuses an unparsable number instead of writing it", async () => {
    const mounted = mount();
    mounted.injected.edit(["volatile", "maxChars"], "abc");
    await mounted.injected.save();
    expect(mounted.scope.mutate).not.toHaveBeenCalled();
    expect(mounted.store.getSnapshot().invalid).toBe(true);
    expect(mounted.store.getSnapshot().dirty).toBe(true);
  });

  it("writes a staged secret through the credential domain, never the settings file", async () => {
    const mounted = mount();
    mounted.injected.editSecret("apiKey", "  sk-live-1  ");
    await mounted.injected.save();
    expect(mounted.scope.mutate).not.toHaveBeenCalled();
    expect(mounted.ctx.remote.credentials.set).toHaveBeenCalledWith("TDAI_GATEWAY_APIKEY", "sk-live-1");
    expect(mounted.ctx.remote.credentials.describe).toHaveBeenCalled();
  });

  it("addresses the credential reference the config names, not a hardcoded one", async () => {
    const base = fakeContext().scope.getSnapshot();
    const mounted = mount({
      value: { ...base.value, server: { ...base.value.server, apiKeyRef: "CUSTOM_REF" } }
    });
    mounted.injected.editSecret("apiKey", "sk-2");
    await mounted.injected.save();
    expect(mounted.ctx.remote.credentials.set).toHaveBeenCalledWith("CUSTOM_REF", "sk-2");
  });

  it("keeps the drafts and reports failure when the Host refuses", async () => {
    const mounted = mount();
    mounted.scope.mutate.mockResolvedValueOnce(false);
    mounted.injected.edit(["server", "teamId"], "team-1");
    await mounted.injected.save();
    const state = mounted.store.getSnapshot();
    expect(state.failed).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it("does not write while the scope reports itself read-only", async () => {
    const mounted = mount({ writable: false });
    mounted.injected.edit(["server", "teamId"], "team-1");
    await mounted.injected.save();
    expect(mounted.scope.mutate).not.toHaveBeenCalled();
    expect(mounted.store.getSnapshot().writable).toBe(false);
  });

  it("drops every draft on discard", async () => {
    const mounted = mount();
    mounted.injected.edit(["server", "teamId"], "team-1");
    expect(mounted.store.getSnapshot().dirty).toBe(true);
    mounted.injected.discard();
    expect(mounted.store.getSnapshot().dirty).toBe(false);
  });
});

describe("client half: rendering", () => {
  it("renders the one-liner in the summary view", () => {
    const mounted = mount();
    expect(renderPage(mounted, "summary")).toBe(mounted.t("description"));
  });

  it("renders one SettingsForm covering every volatile field and both credential rows", () => {
    const mounted = mount();
    const view = renderPage(mounted);
    expect(view.type).toBe(mounted.primitives.SettingsForm);
    const ids = collectIds(view);
    for (const path of EXPECTED_FIELD_PATHS) expect(ids).toContain("tdb-agemem-" + path);
    expect(ids).toContain("tdb-agemem-secret-apiKey");
    expect(ids).toContain("tdb-agemem-secret-userKey");
  });

  it("renders a switch for every boolean field", () => {
    const mounted = mount();
    const view = renderPage(mounted);
    const switches = collectElements(view).filter((element) => element.type === mounted.primitives.Switch);
    expect(switches.length).toBe(BOOLEAN_PATHS.length);
    const ids = collectIds(view);
    for (const path of BOOLEAN_PATHS) expect(ids).toContain("tdb-agemem-" + path);
  });
});

describe("bundle patch layer", () => {
  it("declares the client entry, the patch file, and keeps the patch an empty array", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as AnyRecord;
    expect(manifest.exports["./client"]).toBe("./client/client.js");
    expect(manifest.dsh.client.platform).toBe("web");
    expect(manifest.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings");
    expect(manifest.dsh.bundle.patch).toContain("cordis.bundle.yml");
    const body = readFileSync(BUNDLE_PATCH_PATH, "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("")
      .trim();
    expect(body).toBe("[]");
  });
});
