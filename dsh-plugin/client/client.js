window.__ModuleLoader__.load({
	id: "@tdb/agemem-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.tdbAgemem";
		/**
		 * The Host profile entry id this page configures. It must equal the id the
		 * deployment writes into the profile patch ("- id: tdb-agemem-dsh"), because
		 * dsh-settings names every settings namespace after a profile entry id.
		 */
		const ENTRY_ID = "tdb-agemem-dsh";

		const en = {
			title: "TDB memory",
			description: "Point the plugin at a TDB core, choose who it reads and writes, and turn its channels on or off.",
			enableLabel: "Plugin enabled",
			enableHint: "Off removes both the recall injection and the writeback from the host.",
			baseUrlLabel: "Core base URL",
			baseUrlHint: "The TDB core's HTTP root, such as http://127.0.0.1:8420.",
			serviceIdLabel: "Service id",
			serviceIdHint: "Defaults to default; change it only for a multi-tenant core.",
			teamIdLabel: "Team id",
			teamIdHint: "Required: an empty team makes the plugin inert.",
			agentIdLabel: "Agent id",
			agentIdHint: "Required: the agent whose memories this host reads and writes.",
			userIdLabel: "User id",
			userIdHint: "Required: the human the session speaks for.",
			apiKeyRefLabel: "API key reference",
			apiKeyRefHint: "Name of the stored core key. The key itself is never written to the settings file.",
			userKeyRefLabel: "User key reference",
			userKeyRefHint: "Name of the stored user key, used when the core resolves the identity.",
			apiKeyLabel: "Core API key",
			apiKeyHint: "Write-only. Stored outside the settings file under the reference above.",
			userKeyLabel: "User key",
			userKeyHint: "Write-only. Stored outside the settings file under the reference above.",
			configured: "A value is configured.",
			unset: "No value is configured yet.",
			writebackLabel: "Write memories back",
			writebackHint: "Off makes recall read-only: the session's turns are no longer distilled into memories.",
			skillFeedLabel: "Feed L2 skills",
			skillFeedHint: "Off keeps L2 dark for this identity.",
			volatileLabel: "Volatile recall block",
			volatileHint: "Injects a short per-turn block from the core's volatile channel.",
			maxCharsLabel: "Volatile block budget (chars)",
			maxCharsHint: "Characters the volatile block may occupy in one turn.",
			toolsLabel: "Memory tools",
			toolsHint: "Exposes the plugin's own memory tools to the model.",
			toolsRecallLabel: "Recall tool",
			toolsRecallHint: "The tool that asks the core for memories on demand.",
			debugLabel: "Debug log",
			debugHint: "Writes the plugin's traffic to a rotating file; turn it off once the setup works.",
			restartHint: "Saved values apply when the host next loads the plugin (restart or reload the profile).",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving...",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};

		const zh = {
			title: "TDB 记忆",
			description: "指向一个 TDB 核心，选择读谁的记忆、写不写，以及各通道的开关。",
			enableLabel: "启用插件",
			enableHint: "关掉后宿主既不再注入召回块，也不再写回记忆。",
			baseUrlLabel: "核心地址",
			baseUrlHint: "TDB 核心的 HTTP 根地址，例如 http://127.0.0.1:8420。",
			serviceIdLabel: "服务 id",
			serviceIdHint: "默认 default，多租户核心才需要改。",
			teamIdLabel: "团队 id",
			teamIdHint: "必填：留空时插件整体不起作用。",
			agentIdLabel: "智能体 id",
			agentIdHint: "必填：本宿主读写的记忆属于哪个智能体。",
			userIdLabel: "用户 id",
			userIdHint: "必填：会话代表哪个人。",
			apiKeyRefLabel: "核心密钥引用名",
			apiKeyRefHint: "核心密钥在凭据库里的名字；密钥本身永不写入设置文件。",
			userKeyRefLabel: "用户密钥引用名",
			userKeyRefHint: "用户密钥在凭据库里的名字，供核心解析身份时使用。",
			apiKeyLabel: "核心 API Key",
			apiKeyHint: "只写不读：按上面的引用名存进凭据库，不写设置文件。",
			userKeyLabel: "用户 Key",
			userKeyHint: "只写不读：按上面的引用名存进凭据库，不写设置文件。",
			configured: "已配置。",
			unset: "尚未配置。",
			writebackLabel: "写回记忆",
			writebackHint: "关掉后召回变成只读：会话内容不再被蒸馏成记忆。",
			skillFeedLabel: "投喂 L2 技能",
			skillFeedHint: "关掉后该身份的 L2 层保持黑暗。",
			volatileLabel: "易失召回块",
			volatileHint: "每轮从核心的易失通道注入一小块记忆。",
			maxCharsLabel: "易失块字数预算",
			maxCharsHint: "单轮注入的易失块最多占多少字符。",
			toolsLabel: "记忆工具",
			toolsHint: "把插件自带的记忆工具暴露给模型。",
			toolsRecallLabel: "召回工具",
			toolsRecallHint: "按需向核心要记忆的那个工具。",
			debugLabel: "调试日志",
			debugHint: "把插件的收发写进轮转文件；配好之后建议关掉。",
			restartHint: "保存后的值在宿主下次加载插件时生效（重启或重载 profile）。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			readOnly: "本次部署的设置是只读的。",
			saveFailed: "部署没有接受这些值，已保留供你修改。",
			save: "保存",
			saving: "保存中...",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidNumber: "请填数字，留空表示用默认值。"
		};

		/**
		 * One editable field. path is the settings path inside this entry's config,
		 * and it is why this page does not use SettingsFormModel: the shared model
		 * addresses single-segment fields (sectionValue(name), path: [name]), while
		 * this plugin's surface is nested (server.teamId, writeback.enabled, ...).
		 * The transport behind the scope accepts multi-segment paths; the
		 * convenience layer above it does not.
		 */
		const FIELDS = [
			{ path: ["enabled"], kind: "boolean", label: "enableLabel", hint: "enableHint" },
			{ path: ["server", "baseUrl"], kind: "string", label: "baseUrlLabel", hint: "baseUrlHint" },
			{ path: ["server", "serviceId"], kind: "string", label: "serviceIdLabel", hint: "serviceIdHint" },
			{ path: ["server", "teamId"], kind: "string", label: "teamIdLabel", hint: "teamIdHint" },
			{ path: ["server", "agentId"], kind: "string", label: "agentIdLabel", hint: "agentIdHint" },
			{ path: ["server", "userId"], kind: "string", label: "userIdLabel", hint: "userIdHint" },
			{ path: ["server", "apiKeyRef"], kind: "string", label: "apiKeyRefLabel", hint: "apiKeyRefHint" },
			{ path: ["server", "userKeyRef"], kind: "string", label: "userKeyRefLabel", hint: "userKeyRefHint" },
			{ path: ["writeback", "enabled"], kind: "boolean", label: "writebackLabel", hint: "writebackHint" },
			{ path: ["writeback", "skillFeed"], kind: "boolean", label: "skillFeedLabel", hint: "skillFeedHint" },
			{ path: ["volatile", "enabled"], kind: "boolean", label: "volatileLabel", hint: "volatileHint" },
			{ path: ["volatile", "maxChars"], kind: "number", label: "maxCharsLabel", hint: "maxCharsHint" },
			{ path: ["tools", "enabled"], kind: "boolean", label: "toolsLabel", hint: "toolsHint" },
			{ path: ["tools", "recall"], kind: "boolean", label: "toolsRecallLabel", hint: "toolsRecallHint" },
			{ path: ["debug"], kind: "boolean", label: "debugLabel", hint: "debugHint" }
		];

		/** Write-only secrets: the credential name is the reference the config names. */
		const SECRETS = [
			{ id: "apiKey", refPath: ["server", "apiKeyRef"], defaultRef: "TDAI_GATEWAY_APIKEY", label: "apiKeyLabel", hint: "apiKeyHint" },
			{ id: "userKey", refPath: ["server", "userKeyRef"], defaultRef: "TDAI_USER_KEY", label: "userKeyLabel", hint: "userKeyHint" }
		];

		/** Join a path for use as a React key and a staged-edit key. */
		function keyOf(path) {
			return path.join(".");
		}

		/** Read a nested value without throwing on a missing intermediate. */
		function readPath(root, path) {
			let node = root;
			for (const key of path) {
				if (node === null || typeof node !== "object") return undefined;
				node = node[key];
			}
			return node;
		}

		/** Whether the user layer stored this exact path, so the field shows as overridden. */
		function storedAt(root, path) {
			let node = root;
			for (const key of path) {
				if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) return false;
				node = node[key];
			}
			return true;
		}

		/** Format a live value for a text input. */
		function formatValue(value) {
			if (value === undefined || value === null) return "";
			if (typeof value === "string") return value;
			return String(value);
		}

		/** Parse one staged text back into a config value; undefined means invalid, keep the draft. */
		function parseValue(field, text) {
			const trimmed = String(text).trim();
			if (trimmed === "") return { kind: "clear" };
			if (field !== undefined && field.kind === "number") {
				const value = Number(trimmed);
				return Number.isInteger(value) && value >= 0 ? { kind: "set", value: value } : undefined;
			}
			return { kind: "set", value: trimmed };
		}

		/**
		 * The staged form over one profile entry: nested field paths, booleans
		 * written as JSON booleans, secrets routed to the credential store, and a
		 * write queue that keeps the Host as the source of truth.
		 */
		class AgememFormController {
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.staged = new Map();
				this.saving = false;
				this.failed = false;
				this.baseline = undefined;
				this.credentials = {
					apiKey: { ref: "", configured: false, writable: true },
					userKey: { ref: "", configured: false, writable: true }
				};
				this.store = createSnapshotStore(this.projection());
				this.off = scope.subscribe(() => {
					this.publish();
					this.readCredentials();
				});
				this.readCredentials();
			}
			/** The Host's view of this entry: status, live value, base, user layer, revision. */
			getSnapshot() {
				return this.scope.getSnapshot();
			}
			/** Publish the projected page state. */
			publish() {
				if (this.store !== undefined) this.store.set(this.projection());
			}
			/** One text or boolean field's view. */
			fieldView(field, snapshot) {
				const key = keyOf(field.path);
				const staged = this.staged.get(key);
				const overridden = storedAt(snapshot.user, field.path);
				if (field.kind === "boolean") {
					const live = readPath(snapshot.value, field.path) === true;
					return { checked: staged === undefined ? live : staged.booleanValue === true, overridden: overridden, invalid: false };
				}
				const live = formatValue(readPath(snapshot.value, field.path));
				if (staged === undefined) return { text: live, overridden: overridden, invalid: false };
				const parsed = parseValue(field, staged.text);
				return { text: String(staged.text), overridden: overridden, invalid: parsed === undefined };
			}
			/** Everything the card renders, projected from the Host snapshot plus drafts. */
			projection() {
				const snapshot = this.getSnapshot();
				const fields = {};
				for (const field of FIELDS) fields[keyOf(field.path)] = this.fieldView(field, snapshot);
				const secrets = {};
				for (const secret of SECRETS) {
					const credential = this.credentials[secret.id];
					secrets[secret.id] = { ref: credential.ref, configured: credential.configured, writable: credential.writable, text: this.secretText(secret.id) };
				}
				const ops = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable === true,
					dirty: ops.length > 0,
					invalid: ops.some((entry) => entry.op === undefined && entry.run === undefined),
					saving: this.saving,
					failed: this.failed,
					fields: fields,
					secrets: secrets
				};
			}
			/** Stage a text edit for one path. */
			edit(path, text) {
				this.stage(keyOf(path), { text: text });
			}
			/** Stage a boolean toggle for one path. */
			setBoolean(path, checked) {
				this.stage(keyOf(path), { booleanValue: checked === true });
			}
			/** Stage a secret literal for one credential. */
			editSecret(id, text) {
				this.stage(id, { text: text });
			}
			/** The staged text of one secret, for the write-only input. */
			secretText(id) {
				const draft = this.staged.get(id);
				return draft === undefined || draft.text === undefined ? "" : String(draft.text);
			}
			/** Drop one field back to the deployed base value. */
			resetField(path) {
				const key = keyOf(path);
				const field = FIELDS.find((candidate) => keyOf(candidate.path) === key);
				const base = readPath(this.getSnapshot().base, path);
				if (field !== undefined && field.kind === "boolean") this.stage(key, { booleanValue: base === true });
				else this.stage(key, { text: formatValue(base) });
			}
			/** Drop every draft. */
			discard() {
				if (this.staged.size === 0 && !this.failed) return;
				this.staged.clear();
				this.baseline = undefined;
				this.failed = false;
				this.publish();
			}
			/** Record one draft, remembering the revision the save will be measured against. */
			stage(key, draft) {
				if (this.baseline === undefined) this.baseline = this.getSnapshot();
				this.staged.set(key, draft);
				this.failed = false;
				this.publish();
			}
			/** Turn drafts into transport ops; an invalid draft yields an op-less entry that blocks the save. */
			plan() {
				const ops = [];
				const snapshot = this.getSnapshot();
				for (const [key, draft] of this.staged) {
					const field = FIELDS.find((candidate) => keyOf(candidate.path) === key);
					if (field === undefined) continue;
					const live = readPath(snapshot.value, field.path);
					if (field.kind === "boolean") {
						const target = draft.booleanValue === true;
						if (target === (live === true)) continue;
						ops.push({ field: key, op: { op: "set", path: field.path.slice(), value: target } });
						continue;
					}
					const parsed = parseValue(field, draft.text);
					if (parsed === undefined) {
						ops.push({ field: key });
						continue;
					}
					if (parsed.kind === "clear") {
						if (storedAt(snapshot.user, field.path)) ops.push({ field: key, op: { op: "unset", path: field.path.slice() } });
						continue;
					}
					if (formatValue(live) === formatValue(parsed.value)) continue;
					ops.push({ field: key, op: { op: "set", path: field.path.slice(), value: parsed.value } });
				}
				for (const secret of SECRETS) {
					const draft = this.staged.get(secret.id);
					if (draft === undefined) continue;
					const text = String(draft.text === undefined ? "" : draft.text).trim();
					if (text === "") continue;
					ops.push({ field: secret.id, run: () => this.writeSecret(secret, text) });
				}
				return ops;
			}
			/** Write every dirty path, then write the staged secrets; a refusal keeps the drafts. */
			async save() {
				const ops = this.plan();
				if (ops.length === 0 || this.saving || this.getSnapshot().writable !== true) return;
				if (ops.some((entry) => entry.op === undefined && entry.run === undefined)) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				try {
					const transport = ops.flatMap((entry) => (entry.op === undefined ? [] : [entry.op]));
					const revision = this.baseline === undefined ? undefined : this.baseline.revision;
					let accepted = transport.length === 0 || (await this.scope.mutate(transport, revision)) !== false;
					if (!accepted) {
						this.failed = true;
						return;
					}
					for (const entry of ops) {
						if (entry.run === undefined) continue;
						accepted = (await entry.run()) && accepted;
					}
					if (accepted) {
						this.staged.clear();
						this.baseline = undefined;
					}
					this.failed = !accepted;
				} catch (_error) {
					this.failed = true;
				} finally {
					this.saving = false;
					this.publish();
				}
			}
			/** The credential reference a secret currently uses. */
			refOf(secret) {
				const live = readPath(this.getSnapshot().value, secret.refPath);
				return typeof live === "string" && live.length > 0 ? live : secret.defaultRef;
			}
			/** Write one staged secret to the credential store under the reference the config names. */
			async writeSecret(secret, text) {
				const response = await this.ctx.remote.credentials.set(this.refOf(secret), text);
				await this.readCredentials();
				return response === undefined || response === null ? true : response.ok !== false;
			}
			/** Ask the credential domain whether each referenced secret is configured. */
			async readCredentials() {
				const remote = this.ctx.remote === undefined ? undefined : this.ctx.remote.credentials;
				if (remote === undefined) return;
				let response;
				try {
					response = await remote.describe(SECRETS.map((secret) => this.refOf(secret)));
				} catch (_error) {
					return;
				}
				if (response === undefined || response === null || response.ok === false) return;
				const value = response.value === undefined ? {} : response.value;
				let changed = false;
				for (const secret of SECRETS) {
					const ref = this.refOf(secret);
					const view = value[ref];
					const next = {
						ref: ref,
						configured: view !== undefined && view !== null && view.configured === true,
						writable: !(view !== undefined && view !== null && view.writable === false)
					};
					const previous = this.credentials[secret.id];
					if (next.ref !== previous.ref) this.credentials[secret.id] = next;
					else if (next.configured !== previous.configured || next.writable !== previous.writable) this.credentials[secret.id] = next;
					else continue;
					changed = true;
				}
				if (changed) this.publish();
			}
			/** The face the page's slot registration injects. */
			inject() {
				return {
					hooks: { tdbAgememCard: this.store },
					edit: (path, text) => {
						this.edit(path, text);
					},
					resetField: (path) => {
						this.resetField(path);
					},
					setBoolean: (path, checked) => {
						this.setBoolean(path, checked);
					},
					editSecret: (id, text) => {
						this.editSecret(id, text);
					},
					save: () => this.save(),
					discard: () => {
						this.discard();
					}
				};
			}
			/** Release the scope subscription. */
			dispose() {
				this.off();
			}
		}

		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		/** Join a settings path into the key the card and drafts use. */
		const keyText = (path) => path.join(".");

		/** Pages whose rows are read from the same staged form. */
		const SECTIONS = [
			{ fields: ["enabled", "server.baseUrl", "server.serviceId", "server.teamId", "server.agentId", "server.userId"] },
			{ fields: ["server.apiKeyRef", "secret:apiKey", "server.userKeyRef", "secret:userKey"] },
			{ fields: ["writeback.enabled", "writeback.skillFeed", "volatile.enabled", "volatile.maxChars", "tools.enabled", "tools.recall", "debug"] }
		];

		/** The form frame's copy, read from this page's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}

		const css = "._tdbAgemem_section{display:grid;gap:10px}._tdbAgemem_toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}._tdbAgemem_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._tdbAgemem_divider{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-secondary);font-size:12px;line-height:1.5}";
		const cssId = "@tdb/agemem-dsh/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@tdb/agemem-dsh";
			tag.dataset.pluginCss = cssId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const px = jsxRuntime.jsx;
		const pxs = jsxRuntime.jsxs;

		/** One boolean row: label on the left, switch on the right, hint underneath. */
		function toggleRow(props, state, meta, path) {
			const key = keyText(path);
			const view = state.fields[key];
			const t = props.t;
			const disabled = !state.writable || state.saving;
			return pxs("div", {
				id: "tdb-agemem-" + key,
				className: "_tdbAgemem_section",
				children: [
					pxs("label", {
						className: "_tdbAgemem_toggleRow",
						children: [
							px("span", { children: t(meta.label) }),
							px(primitives.Switch, {
								checked: view.checked === true,
								label: t(meta.label),
								disabled: disabled,
								onChange: (checked) => {
									props.setBoolean(path, checked);
								}
							})
						]
					}),
					view.overridden ? px("p", { className: "_tdbAgemem_hint", children: t("overridden") }) : null,
					px("p", { className: "_tdbAgemem_hint", children: t(meta.hint) })
				]
			});
		}

		/** One text or number row. */
		function valueRow(props, state, meta, path) {
			const key = keyText(path);
			const view = state.fields[key];
			const t = props.t;
			const disabled = !state.writable || state.saving;
			return px(primitives.SettingsValueField, {
				id: "tdb-agemem-" + key,
				label: t(meta.label),
				hint: t(meta.hint),
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: t("invalidNumber"),
				numeric: meta.kind === "number",
				disabled: disabled,
				text: view.text,
				overridden: view.overridden,
				invalid: view.invalid,
				onEdit: (text) => {
					props.edit(path, text);
				},
				onReset: () => {
					props.resetField(path);
				}
			});
		}

		/** One write-only credential row. */
		function secretRow(props, state, meta, id) {
			const view = state.secrets[id];
			const t = props.t;
			return px(primitives.SettingsSecretField, {
				id: "tdb-agemem-secret-" + id,
				label: t(meta.label),
				hint: t(meta.hint),
				disabled: !state.writable || state.saving || view.writable === false,
				text: view.text,
				configured: view.configured === true,
				stateLabel: view.configured === true ? t("configured") : t("unset"),
				onEdit: (text) => {
					props.editSecret(id, text);
				}
			});
		}

		/** Render one entry of a section, whether it is a field path or a credential. */
		function renderItem(props, state, key) {
			if (key.startsWith("secret:")) {
				const id = key.slice("secret:".length);
				const secret = SECRETS.find((candidate) => candidate.id === id);
				return secretRow(props, state, secret, id);
			}
			const meta = FIELDS.find((candidate) => keyText(candidate.path) === key);
			if (meta === undefined) return null;
			return meta.kind === "boolean" ? toggleRow(props, state, meta, meta.path) : valueRow(props, state, meta, meta.path);
		}

		/**
		 * The TDB memory settings page: a one-liner in the Plugins list, and the
		 * full form once opened. Every row reads the same staged form, so one save
		 * covers config and credentials together.
		 */
		function AgememCard(props) {
			const t = props.t;
			const state = props.useTdbAgememCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const sections = SECTIONS.map((section, index) => {
				const children = section.fields.map((key) => renderItem(props, state, key));
				if (index === 0) return px("div", { className: "_tdbAgemem_section", key: "section-0", children: children });
				return pxs("div", {
					className: "_tdbAgemem_section",
					key: "section-" + index,
					children: [px("p", { className: "_tdbAgemem_divider", children: t("restartHint") }), ...children]
				});
			});
			return px(primitives.SettingsForm, {
				labels: formLabels(t),
				state: state,
				onSave: props.save,
				onDiscard: props.discard,
				children: sections
			});
		}

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		/**
		 * Mount the settings page while the Host serves this plugin's own profile
		 * entry. A host that never loaded the plugin serves no such namespace, so no
		 * trace of the page appears.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tdb-agemem: dictionaries");
			const card = new AgememFormController(ctx.configForms.get(ENTRY_ID), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "tdb-agemem: form subscription");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", () => card.readCredentials()), "tdb-agemem: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: "tdb-agemem",
				order: 40,
				label: () => t("title"),
				locale: NS,
				inject: () => card.inject()
			}, AgememCard))), "tdb-agemem: page");
		}

		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
