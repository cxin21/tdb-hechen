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
		 * this plugin's surface is nested (server.baseUrl, writeback.enabled, ...).
		 * The transport behind the scope accepts multi-segment paths; the
		 * convenience layer above it does not.
		 *
		 * Deliberately absent: the identity triple (server.teamId / agentId /
		 * userId). It is resolved from the user key at mount and from the user's
		 * own session_init config on every session, so a field here could only
		 * make this host disagree with the core. A core that cannot resolve the
		 * key gets the triple from `deploy.sh --identity` instead.
		 */
		const FIELDS = [
			{ path: ["enabled"], kind: "boolean", label: "enableLabel", hint: "enableHint" },
			{ path: ["server", "baseUrl"], kind: "string", label: "baseUrlLabel", hint: "baseUrlHint" },
			{ path: ["server", "serviceId"], kind: "string", label: "serviceIdLabel", hint: "serviceIdHint" },
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
			{ fields: ["enabled", "server.baseUrl", "server.serviceId"] },
			{ fields: ["server.apiKeyRef", "secret:apiKey", "server.userKeyRef", "secret:userKey"] },
			{ fields: ["writeback.enabled", "writeback.skillFeed", "volatile.enabled", "volatile.maxChars", "tools.enabled", "tools.recall", "debug"] }
		];


	/**
	 * Wave 4: the service-stack page used to live in a separate bundle
	 * (`tdb-lifecycle`). Its dictionary is merged here, in the same namespace, so
	 * one locale registration covers both pages.
	 */
	const servicesZh = {
		"servicesNav": "TDB 服务",
		"servicesTitle": "TDB 服务栈",
		"servicesDesc": "三个 TDB 服务（记忆核心、知识库、管理面板）由本插件随 DSH 启动与看护：健康检查通过才算起来，子服务挂了自己重拉。",
		"servicesNoStack": "本机不托管服务栈",
		"servicesReasonRemote": "记忆核心在另一台机器上（{host}），本地再起三个服务只会白占端口——请在那台机器上用 systemd / Windows 服务 / 启动脚本自行拉起。",
		"servicesReasonOff": "本机托管已关闭（services.enabled=false）。要由本插件拉起 core / knowledge / panel，请在插件配置里打开。",
		"servicesReasonNone": "services.include 里没有本插件认识的服务名；空值代表三个全都托管。",
		"servicesCoreHost": "记忆核心地址",
		"servicesSupervisor": "看护状态",
		"servicesRunning": "运行中",
		"servicesStopped": "已停止",
		"servicesAdopted": "（由另一个 DSH 窗口看护）",
		"servicesAutoRestart": "自动重启",
		"servicesBudget": "重启预算",
		"servicesStartedAt": "启动于",
		"servicesService": "服务",
		"servicesPort": "端口",
		"servicesStatus": "状态",
		"servicesPid": "PID",
		"servicesActions": "操作",
		"servicesHealthy": "运行",
		"servicesDown": "停止",
		"servicesNotOwned": "非本插件拉起",
		"servicesStartAll": "启动全部",
		"servicesStopAll": "停止全部",
		"servicesRestart": "重启",
		"servicesBusy": "处理中…",
		"servicesLoadFailed": "控制服务不可达（插件未启用、刚启动，或端口被占用）",
		"servicesConfirmStop": "停止会同时关闭三个 TDB 服务。确定停止？",
		"servicesNoteRestarting": "已请求重启，自动重启会在数秒内拉起该服务。",
		"servicesNoteStarted": "已请求启动，健康检查最长需要 90 秒。",
		"servicesNoteStopped": "已请求停止。",
		"servicesErrAlreadyRunning": "服务栈已在运行",
		"servicesErrNotRunning": "看护未运行",
		"servicesErrAutoRestartDisabled": "自动重启已关闭，无法单服务重启",
		"servicesErrNotOwned": "该服务不是本插件拉起的",
		"servicesErrWatchdogPending": "服务已停止，自动重启会拉起它"
};
	const servicesEn = {
		"servicesNav": "TDB services",
		"servicesTitle": "TDB service stack",
		"servicesDesc": "The three TDB services (memory core, knowledge, panel) start and are watched by this plugin: a service counts as up only once /health passes, and a crashed child is respawned.",
		"servicesNoStack": "This host does not run the stack",
		"servicesReasonRemote": "The memory core lives on another machine ({host}); a local stack would only hold three ports hostage. Start it there (systemd / Windows service / a plain script).",
		"servicesReasonOff": "Local hosting is switched off (services.enabled=false). Turn it on in the plugin config to have this plugin start core / knowledge / panel.",
		"servicesReasonNone": "services.include names no service this plugin knows; empty means all three.",
		"servicesCoreHost": "Memory core address",
		"servicesSupervisor": "Supervisor",
		"servicesRunning": "Running",
		"servicesStopped": "Stopped",
		"servicesAdopted": "(supervised by another DSH window)",
		"servicesAutoRestart": "Auto-restart",
		"servicesBudget": "Restart budget",
		"servicesStartedAt": "Started at",
		"servicesService": "Service",
		"servicesPort": "Port",
		"servicesStatus": "Status",
		"servicesPid": "PID",
		"servicesActions": "Actions",
		"servicesHealthy": "Up",
		"servicesDown": "Down",
		"servicesNotOwned": "Not started by this plugin",
		"servicesStartAll": "Start all",
		"servicesStopAll": "Stop all",
		"servicesRestart": "Restart",
		"servicesBusy": "Working…",
		"servicesLoadFailed": "Control service unreachable (plugin off, still starting, or the port is taken)",
		"servicesConfirmStop": "Stopping also shuts down the three TDB services. Stop now?",
		"servicesNoteRestarting": "Restart requested; auto-restart brings the service back within seconds.",
		"servicesNoteStarted": "Start requested; health checks can take up to 90 seconds.",
		"servicesNoteStopped": "Stop requested.",
		"servicesErrAlreadyRunning": "The stack is already running",
		"servicesErrNotRunning": "Supervisor is not running",
		"servicesErrAutoRestartDisabled": "Auto-restart is off; cannot restart a single service",
		"servicesErrNotOwned": "That service is not owned by this plugin",
		"servicesErrWatchdogPending": "Service already down; auto-restart will bring it back"
};

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

		const css = "._tdbAgemem_page{display:grid;gap:12px}._tdbAgemem_heading{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:1.4}._tdbAgemem_section{display:grid;gap:10px}._tdbAgemem_toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}._tdbAgemem_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._tdbAgemem_divider{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-secondary);font-size:12px;line-height:1.5}._tdbAgemem_table{width:100%;border-collapse:collapse;font-size:13px}._tdbAgemem_th{text-align:left;font-weight:500;padding:6px 8px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-secondary)}._tdbAgemem_cell{padding:7px 8px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-secondary)}._tdbAgemem_dot{display:inline-block;width:8px;height:8px;border-radius:8px;margin-right:6px;vertical-align:middle}._tdbAgemem_dotOn{background:#2f9e44}._tdbAgemem_dotOff{background:#e03131}._tdbAgemem_button{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-primary);padding:4px 12px;font-size:13px;font-family:inherit}._tdbAgemem_buttonPrimary{background:var(--dsw-alias-interactive-bg-brand,#4c6ef5);color:#fff;border:none}._tdbAgemem_buttonDanger{color:#e03131}._tdbAgemem_button:disabled{opacity:.45;cursor:default}._tdbAgemem_error{color:#e03131}";
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
		 * The form body: the same three sections under every surface, so the Plugins
		 * card and the Settings page can never drift apart.
		 */
		function formBody(props, state) {
			const t = props.t;
			return SECTIONS.map((section, index) => {
				const children = section.fields.map((key) => renderItem(props, state, key));
				if (index === 0) return px("div", { className: "_tdbAgemem_section", key: "section-0", children: children });
				return pxs("div", {
					className: "_tdbAgemem_section",
					key: "section-" + index,
					children: [px("p", { className: "_tdbAgemem_divider", children: t("restartHint") }), ...children]
				});
			});
		}

		/**
		 * The TDB memory page inside the Plugins list: a one-liner in the list, and
		 * the full form once opened. Every row reads the same staged form, so one
		 * save covers config and credentials together.
		 */
		function AgememCard(props) {
			const t = props.t;
			const state = props.useTdbAgememCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			return px(primitives.SettingsForm, {
				labels: formLabels(t),
				state: state,
				onSave: props.save,
				onDiscard: props.discard,
				children: formBody(props, state)
			});
		}

		/**
		 * The TDB memory section of the Settings panel. The shell draws the
		 * navigation row, so the page only adds the panel copy above the same form.
		 */
		function AgememSection(props) {
			const t = props.t;
			const state = props.useTdbAgememCard((snapshot) => snapshot);
			return pxs("div", {
				className: "_tdbAgemem_page",
				children: [
					px("h2", { className: "_tdbAgemem_heading", children: t("title") }),
					px("p", { className: "_tdbAgemem_hint", children: t("description") }),
					px(primitives.SettingsForm, {
						labels: formLabels(t),
						state: state,
						onSave: props.save,
						onDiscard: props.discard,
						children: formBody(props, state)
					})
				]
			});
		}


		/** One boolean-ish status dot: green when the service answers /health. */
		function statusDot(ok) {
			return px("span", {
				className: ok ? "_tdbAgemem_dot _tdbAgemem_dotOn" : "_tdbAgemem_dot _tdbAgemem_dotOff",
				"aria-hidden": "true"
			});
		}

		/**
		 * The service stack page. Same-origin first: the host web server serves
		 * /tdb-lifecycle/*, so no CORS and no loopback assumption. A 404/405 means the
		 * host has no route registration, and the loopback control server takes over.
		 */
		function ServicesSection(props) {
			const t = props.t;
			const { useCallback, useEffect, useRef, useState } = require("react");
			const [status, setStatus] = useState(null);
			const [loadFailed, setLoadFailed] = useState(false);
			const [busy, setBusy] = useState("");
			const [note, setNote] = useState("");
			const [noteError, setNoteError] = useState(false);
			const mounted = useRef(true);
			const base = useRef("/tdb-lifecycle");

			useEffect(() => () => {
				mounted.current = false;
			}, []);

			const call = useCallback(async (subPath, init) => {
				const send = (prefix) => fetch(prefix + subPath, init);
				let response = await send(base.current);
				if (base.current === "/tdb-lifecycle" && (response.status === 404 || response.status === 405)) {
					// No same-origin routes on this host build: use the loopback server.
					base.current = "http://127.0.0.1:8444";
					response = await send(base.current);
				}
				return response;
			}, []);

			// A remote core is a normal deployment, not a fault: say which one it is
			// instead of showing an empty table with dead buttons.
			const unmanagedText = status !== null && status.managed === false
				? t("servicesNoStack") + " — " + (
					status.reason === "remote-core"
						? t("servicesReasonRemote").replace("{host}", String(status.coreHost || "?"))
						: status.reason === "no-services"
						? t("servicesReasonNone")
						: t("servicesReasonOff")
				)
				: "";

			const refresh = useCallback(async () => {
				try {
					const response = await call("/status");
					if (!response.ok) throw new Error("HTTP " + response.status);
					const data = await response.json();
					if (mounted.current) {
						setStatus(data);
						setLoadFailed(false);
					}
				} catch {
					if (mounted.current) setLoadFailed(true);
				}
			}, [call]);

			useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 5000);
				return () => clearInterval(timer);
			}, [refresh]);

			const act = useCallback(async (subPath, body, key, noteKey) => {
				setBusy(key);
				try {
					const response = await call(subPath, {
						method: "POST",
						headers: { "Content-Type": "application/json", "X-Tdb-Control": "1" },
						body: JSON.stringify(body === undefined ? {} : body)
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok) {
						const known = {
							"already-running": "servicesErrAlreadyRunning",
							"supervisor-not-running": "servicesErrNotRunning",
							"auto-restart-disabled": "servicesErrAutoRestartDisabled",
							"service-not-owned": "servicesErrNotOwned",
							"service-already-down-watchdog-will-restart": "servicesErrWatchdogPending"
						};
						setNoteError(true);
						setNote(known[data && data.error] ? t(known[data.error]) : String((data && data.error) || ("HTTP " + response.status)));
					} else {
						setNoteError(false);
						setNote(noteKey ? t(noteKey) : "");
					}
					await refresh();
				} catch {
					setNoteError(true);
					setNote(t("servicesLoadFailed"));
				} finally {
					if (mounted.current) setBusy("");
				}
			}, [call, refresh, t]);

			const services = status && Array.isArray(status.services) ? status.services : [];
			const row = (svc) => pxs("tr", {
				key: svc.name,
				children: [
					px("td", { className: "_tdbAgemem_cell", children: svc.name }),
					px("td", { className: "_tdbAgemem_cell", children: String(svc.port) }),
					px("td", {
						className: "_tdbAgemem_cell",
						children: [
							statusDot(svc.healthy === true),
							px("span", { children: svc.healthy ? t("servicesHealthy") : t("servicesDown") }),
							svc.healthy && !svc.owned
								? px("span", { className: "_tdbAgemem_hint", children: " " + t("servicesNotOwned") })
								: null
						]
					}),
					px("td", { className: "_tdbAgemem_cell", children: svc.pid && svc.pidAlive ? String(svc.pid) : "—" }),
					px("td", {
						className: "_tdbAgemem_cell",
						children: px("button", {
							type: "button",
							className: "_tdbAgemem_button",
							id: "tdb-agemem-restart-" + svc.name,
							disabled: busy !== "" || svc.owned !== true || status.running !== true || status.autoRestart !== true,
							onClick: () => act("/restart", { name: svc.name }, "restart:" + svc.name, "servicesNoteRestarting"),
							children: busy === "restart:" + svc.name ? t("servicesBusy") : t("servicesRestart")
						})
					})
				]
			});

			return pxs("div", {
				className: "_tdbAgemem_page",
				children: [
					px("h2", { className: "_tdbAgemem_heading", children: t("servicesTitle") }),
					px("p", { className: "_tdbAgemem_hint", children: t("servicesDesc") }),
					px("p", {
						className: "_tdbAgemem_hint",
						id: "tdb-agemem-services-summary",
						children: loadFailed || status === null
							? t("servicesLoadFailed")
							: status.managed === false
							? unmanagedText
							: t("servicesSupervisor") + ": " + (status.running ? t("servicesRunning") : t("servicesStopped"))
								+ " · " + t("servicesAutoRestart") + ": " + (status.autoRestart ? "✓" : "✕")
								+ " · " + t("servicesBudget") + ": " + String(status.restartsUsed) + "/" + String(status.maxRestarts)
								+ (status.startedAt ? " · " + t("servicesStartedAt") + ": " + status.startedAt : "")
					}),
					pxs("div", {
						className: "_tdbAgemem_section",
						children: [
							px("button", {
								type: "button",
								className: "_tdbAgemem_button _tdbAgemem_buttonPrimary",
								id: "tdb-agemem-services-start",
								disabled: busy !== "" || status === null || status.managed === false || status.running === true,
								onClick: () => act("/start", undefined, "start", "servicesNoteStarted"),
								children: busy === "start" ? t("servicesBusy") : t("servicesStartAll")
							}),
							px("button", {
								type: "button",
								className: "_tdbAgemem_button _tdbAgemem_buttonDanger",
								id: "tdb-agemem-services-stop",
								disabled: busy !== "" || status === null || status.managed === false || status.running !== true,
								onClick: () => {
									if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(t("servicesConfirmStop"))) return;
									act("/stop", undefined, "stop", "servicesNoteStopped");
								},
								children: busy === "stop" ? t("servicesBusy") : t("servicesStopAll")
							})
						]
					}),
					status !== null && status.managed !== false
						? pxs("table", {
						className: "_tdbAgemem_table",
						id: "tdb-agemem-services-table",
						children: [
							px("thead", {
								children: pxs("tr", {
									children: [
										px("th", { className: "_tdbAgemem_th", children: t("servicesService") }),
										px("th", { className: "_tdbAgemem_th", children: t("servicesPort") }),
										px("th", { className: "_tdbAgemem_th", children: t("servicesStatus") }),
										px("th", { className: "_tdbAgemem_th", children: t("servicesPid") }),
										px("th", { className: "_tdbAgemem_th", children: t("servicesActions") })
									]
								})
							}),
							px("tbody", { children: services.map(row) })
						]
					})
						: null,
					note !== "" || loadFailed
						? px("p", {
							className: noteError ? "_tdbAgemem_hint _tdbAgemem_error" : "_tdbAgemem_hint",
							id: "tdb-agemem-services-note",
							children: loadFailed ? t("servicesLoadFailed") : note
						})
						: null
				]
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
			// One namespace, two pages: the service-stack page joined this plugin in
			// Wave 4, so its copy rides the same registration.
			ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...servicesZh }, en: { ...en, ...servicesEn } }), "tdb-agemem: dictionaries");
			const card = new AgememFormController(ctx.configForms.get(ENTRY_ID), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "tdb-agemem: form subscription");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", () => card.readCredentials()), "tdb-agemem: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => {
				const face = () => card.inject();
				const dropCard = ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: "tdb-agemem",
					order: 40,
					label: () => t("title"),
					locale: NS,
					inject: face
				}, AgememCard));
				/*
				 * The Plugins list is managed by the desktop profile itself, so the same
				 * form also needs a seat the desktop shell always renders: the Settings
				 * navigation. Both slots share one staged form and one save path.
				 */
				const dropSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "tdb-agemem",
					order: 30,
					label: () => t("title"),
					locale: NS,
					inject: face
				}, AgememSection));
				return () => {
					if (typeof dropSection === "function") dropSection();
					if (typeof dropCard === "function") dropCard();
				};
			}), "tdb-agemem: page");

			/*
			 * Wave 4: the service stack page. It renders even when the config form is
			 * unavailable (a host that serves no form still serves live status), which is
			 * the whole point of a supervisor page.
			 */
			const dropServices = ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "tdb-services",
				order: 31,
				label: () => t("servicesNav"),
				locale: NS,
				inject: () => ({ t })
			}, ServicesSection));
			if (typeof dropServices === "function") ctx.effect(() => dropServices, "tdb-agemem: service stack page");
		}

		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
