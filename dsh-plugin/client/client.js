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
		"servicesDesc": "由 dsh-tdb-lifecycle 看护：启停、健康检查与自动重启都在那个 bundle 里，本插件只把页面请求转发到它的控制面。",
		"servicesRefresh": "刷新",
		"servicesRunning": "运行中",
		"servicesStopped": "未运行",
		"servicesAutoRestart": "自动重启",
		"servicesBudget": "累计重启",
		"servicesBudgetPer": "每服务上限",
		"servicesStartedAt": "启动于",
		"servicesService": "服务",
		"servicesPort": "端口",
		"servicesStatus": "状态",
		"servicesPid": "PID",
		"servicesOrigin": "来源",
		"servicesOriginOwned": "自身",
		"servicesOriginAdopted": "接管",
		"servicesActions": "操作",
		"servicesHealthy": "运行",
		"servicesDown": "停止",
		"servicesStartAll": "启动全部",
		"servicesStopAll": "停止全部",
		"servicesRestart": "重启",
		"servicesBusy": "处理中…",
		"servicesEmpty": "看护进程在跑，但没有托管中的服务。",
		"servicesUnreachable": "控制面不可达：dsh-tdb-lifecycle 未运行，或 127.0.0.1:8446 不通。",
		"servicesConfirmStop": "停止会同时关闭三个 TDB 服务。确定停止？",
		"servicesNoteRestarting": "已请求重启，看护进程会在数秒内拉起该服务。",
		"servicesNoteStarted": "已请求启动，健康检查最长需要 90 秒。",
		"servicesNoteStopped": "已请求停止。"
};
	const servicesEn = {
		"servicesNav": "TDB services",
		"servicesTitle": "TDB service stack",
		"servicesDesc": "Watched by dsh-tdb-lifecycle: starting, health checks and auto-restart all live in that bundle; this plugin only forwards the page's requests to its control plane.",
		"servicesRefresh": "Refresh",
		"servicesRunning": "Running",
		"servicesStopped": "Not running",
		"servicesAutoRestart": "Auto-restart",
		"servicesBudget": "Restarts so far",
		"servicesBudgetPer": "per-service cap",
		"servicesStartedAt": "Started at",
		"servicesService": "Service",
		"servicesPort": "Port",
		"servicesStatus": "Status",
		"servicesPid": "PID",
		"servicesOrigin": "Origin",
		"servicesOriginOwned": "Owned",
		"servicesOriginAdopted": "Adopted",
		"servicesActions": "Actions",
		"servicesHealthy": "Up",
		"servicesDown": "Down",
		"servicesStartAll": "Start all",
		"servicesStopAll": "Stop all",
		"servicesRestart": "Restart",
		"servicesBusy": "Working…",
		"servicesEmpty": "The control plane is up but manages no services.",
		"servicesUnreachable": "Control plane unreachable: dsh-tdb-lifecycle is not running, or 127.0.0.1:8446 does not answer.",
		"servicesConfirmStop": "Stopping also shuts down the three TDB services. Stop now?",
		"servicesNoteRestarting": "Restart requested; the lifecycle bundle brings the service back within seconds.",
		"servicesNoteStarted": "Start requested; health checks can take up to 90 seconds.",
		"servicesNoteStopped": "Stop requested."
};

	/** The composer identity chip's copy (task-117 v4). */
	const identityZh = {
		identityChip: "TDB 记忆",
		identityChipChoose: "TDB 记忆 · 选择",
		identityChipStaged: "TDB 记忆 · 待生效",
		identityChipNone: "TDB 记忆 · 未关联",
		identityEditable: "可改",
		identityUnresolved: "上次解析未完成（核心服务不可达或候选有歧义）。在这里重新选一次即可生效。",
		identityChipUnresolved: "TDB 记忆 · 未关联 · 点此设置",
		identityEmpty: "选一个 Agent，或本次不关联",
		identityPanelTitle: "本次会话的记忆范围",
		identityTeam: "Team",
		identityAgent: "Agent",
		identityTask: "工作项（可选）",
		identityNoTask: "本次不关联任务",
		identityPresetLocked: "用户配置的默认 Agent（固定，不可选）",
		identityConfirm: "确定",
		identityDecline: "本次不关联",
		identityCancel: "取消",
		identityStaged: "已选择；发送第一条消息后生效，之后不可修改。",
		identityLocked: "这个会话已经绑定身份，不能再改。想换人设请新建会话。",
		identityBound: "已在本次会话生效，不可修改。",
		identityInert: "当前组合没有 user key，无法列出身后的 Team/Agent。",
		identityFailed: "取候选失败：",
		identityNoAgents: "这个 Team 下没有可用的 Agent。",
		identityPickTeam: "先选 Team"
	};
	const identityEn = {
		identityChip: "TDB memory",
		identityChipChoose: "TDB memory · choose",
		identityChipStaged: "TDB memory · pending",
		identityChipNone: "TDB memory · none",
		identityEditable: "editable",
		identityUnresolved: "The last resolution did not finish (core unreachable or ambiguous candidates). Pick here to apply it.",
		identityChipUnresolved: "TDB memory · none · set it here",
		identityEmpty: "Pick an agent, or leave this conversation unassociated",
		identityPanelTitle: "Memory scope for this conversation",
		identityTeam: "Team",
		identityAgent: "Agent",
		identityTask: "Work item (optional)",
		identityNoTask: "No work item",
		identityPresetLocked: "Default agent from your user config (fixed, not selectable)",
		identityConfirm: "Confirm",
		identityDecline: "Do not associate",
		identityCancel: "Cancel",
		identityStaged: "Chosen; it takes effect with the first message and cannot be changed after.",
		identityLocked: "This conversation already has its identity; open a new one to change it.",
		identityBound: "Already active for this conversation and not editable.",
		identityInert: "This composition has no user key, so no Team/Agent can be listed.",
		identityFailed: "Could not load candidates: ",
		identityNoAgents: "This Team has no agent available.",
		identityPickTeam: "Choose a Team first"
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

		const css = "._tdbAgemem_page{display:grid;gap:12px}._tdbAgemem_heading{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:1.4}._tdbAgemem_section{display:grid;gap:10px}._tdbAgemem_toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}._tdbAgemem_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._tdbAgemem_divider{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-secondary);font-size:12px;line-height:1.5}._tdbAgemem_table{width:100%;border-collapse:collapse;font-size:13px}._tdbAgemem_th{text-align:left;font-weight:500;padding:6px 8px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-secondary)}._tdbAgemem_cell{padding:7px 8px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-secondary)}._tdbAgemem_dot{display:inline-block;width:8px;height:8px;border-radius:8px;margin-right:6px;vertical-align:middle}._tdbAgemem_dotOn{background:#2f9e44}._tdbAgemem_dotOff{background:#e03131}._tdbAgemem_button{cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-primary);padding:4px 12px;font-size:13px;font-family:inherit}._tdbAgemem_buttonPrimary{background:var(--dsw-alias-interactive-bg-brand,#4c6ef5);color:#fff;border:none}._tdbAgemem_buttonDanger{color:#e03131}._tdbAgemem_button:disabled{opacity:.45;cursor:default}._tdbAgemem_error{color:#e03131}._tdbAgemem_chipWrap{position:relative;display:inline-flex}._tdbAgemem_chip{cursor:pointer;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-primary);padding:2px 10px;font-size:12px;line-height:1.6;font-family:inherit;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}._tdbAgemem_chip:hover{border-color:var(--dsw-alias-border-primary,var(--dsw-alias-border-secondary))}._tdbAgemem_chipStatic{cursor:default;color:var(--dsw-alias-label-secondary)}._tdbAgemem_chipDot{width:6px;height:6px;border-radius:6px;background:#2f9e44;display:inline-block}._tdbAgemem_chipDotOff{background:var(--dsw-alias-label-tertiary)}._tdbAgemem_panel{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;width:320px;max-height:60vh;overflow:auto;display:grid;gap:10px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-primary,#fff));box-shadow:0 8px 28px rgba(0,0,0,.16)}._tdbAgemem_panelTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}._tdbAgemem_panelRow{display:grid;gap:4px}._tdbAgemem_panelLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}._tdbAgemem_choice{text-align:left;cursor:pointer;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 8px;font-size:12px;line-height:1.5;font-family:inherit;display:flex;justify-content:space-between;gap:8px;align-items:center}._tdbAgemem_choice:hover{background:var(--dsw-alias-bg-secondary,transparent)}._tdbAgemem_choiceOn{border-color:var(--dsw-alias-interactive-border-brand,var(--dsw-alias-border-primary,currentColor));font-weight:600}._tdbAgemem_choiceLocked{cursor:default;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-secondary,transparent);border-color:var(--dsw-alias-border-secondary)}._tdbAgemem_panelActions{display:flex;justify-content:flex-end;gap:8px}";
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
		 * The TDB service stack page (task-26). It renders the answer of
		 * `dsh-tdb-lifecycle`'s control plane verbatim: this plugin neither starts
		 * nor watches a service any more. Everything comes from one /status payload,
		 * so an unreachable control plane is one hint line — never an empty table.
		 */
		function ServicesSection(props) {
			const t = props.t;
			const { useCallback, useEffect, useRef, useState } = require("react");
			const [status, setStatus] = useState(null);
			const [failed, setFailed] = useState(false);
			const [busy, setBusy] = useState("");
			const [note, setNote] = useState("");
			const [noteError, setNoteError] = useState(false);
			const mounted = useRef(true);

			useEffect(() => () => {
				mounted.current = false;
			}, []);

			const refresh = useCallback(async () => {
				try {
					const response = await fetch("/tdb-lifecycle/status", { headers: { Accept: "application/json" } });
					const payload = await response.json().catch(() => null);
					const data = payload && payload.ok === true && payload.data ? payload.data : null;
					if (data === null) throw new Error("HTTP " + response.status);
					if (!mounted.current) return;
					setStatus(data);
					setFailed(false);
				} catch {
					if (!mounted.current) return;
					setStatus(null);
					setFailed(true);
				}
			}, []);

			useEffect(() => {
				refresh();
				// One minute: the lifecycle bundle's own heartbeat is faster, and the page is
				// a read-only view — a tighter loop would only add traffic.
				const timer = setInterval(refresh, 60000);
				return () => clearInterval(timer);
			}, [refresh]);

			const act = useCallback(async (path, body, key, noteKey) => {
				setBusy(key);
				try {
					const response = await fetch("/tdb-lifecycle" + path, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body === undefined ? {} : body)
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok) {
						setNoteError(true);
						setNote(String((payload && payload.error) || ("HTTP " + response.status)));
					} else {
						setNoteError(false);
						setNote(noteKey ? t(noteKey) : "");
					}
					await refresh();
				} catch {
					setNoteError(true);
					setNote(t("servicesUnreachable"));
				} finally {
					if (mounted.current) setBusy("");
				}
			}, [refresh, t]);

			const reachable = status !== null && failed === false;
			const managed = reachable && status.managed && typeof status.managed === "object" ? status.managed : {};
			const names = Object.keys(managed).sort();
			const localTime = (value) => {
				if (!value) return "—";
				const parsed = new Date(value);
				return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
			};
			const summary = status === null ? "" : [
				status.supervisorPid > 0 ? t("servicesRunning") : t("servicesStopped"),
				t("servicesAutoRestart") + " " + (status.autoRestart === true ? "✓" : "✗"),
				// restartsUsed 是跨服务的累计值，而预算本身是「每服务 N 次」；
				// 写成 n/m 会被读成「用尽」，所以把两个口径分开写。
				t("servicesBudget") + " " + String(status.restartsUsed || 0) +
					"（" + t("servicesBudgetPer") + " " + String(status.maxRestarts || 0) + "）",
				t("servicesStartedAt") + " " + localTime(status.startedAt)
			].join(" · ");

			const row = (name) => {
				const svc = managed[name] || {};
				const pid = Number(svc.pid) || 0;
				return pxs("tr", {
					key: name,
					children: [
						px("td", { className: "_tdbAgemem_cell", children: name }),
						px("td", { className: "_tdbAgemem_cell", children: svc.port === undefined ? "—" : String(svc.port) }),
						px("td", {
							className: "_tdbAgemem_cell",
							children: [
								statusDot(svc.healthy === true),
								px("span", { children: svc.healthy === true ? t("servicesHealthy") : t("servicesDown") })
							]
						}),
						px("td", { className: "_tdbAgemem_cell", children: pid > 0 ? String(pid) : "—" }),
						px("td", {
							className: "_tdbAgemem_cell",
							children: svc.origin === "adopted" ? t("servicesOriginAdopted") : t("servicesOriginOwned")
						}),
						px("td", {
							className: "_tdbAgemem_cell",
							children: px("button", {
								type: "button",
								className: "_tdbAgemem_button",
								id: "tdb-agemem-restart-" + name,
								// The pid decides: a row without one has nothing to restart, and a
								// dead control plane cannot carry the request anyway.
								disabled: busy !== "" || !reachable || pid <= 0,
								onClick: () => act("/restart", { name: name }, "restart:" + name, "servicesNoteRestarting"),
								children: busy === "restart:" + name ? t("servicesBusy") : t("servicesRestart")
							})
						})
					]
				});
			};

			return pxs("div", {
				className: "_tdbAgemem_page",
				children: [
					pxs("div", {
						className: "_tdbAgemem_toggleRow",
						children: [
							pxs("div", {
								children: [
									px("h2", { className: "_tdbAgemem_heading", children: t("servicesTitle") }),
									px("p", { className: "_tdbAgemem_hint", children: t("servicesDesc") })
								]
							}),
							px("button", {
								type: "button",
								className: "_tdbAgemem_button",
								id: "tdb-agemem-services-refresh",
								disabled: busy !== "",
								onClick: () => {
									refresh();
								},
								children: t("servicesRefresh")
							})
						]
					}),
					px("p", {
						className: failed ? "_tdbAgemem_hint _tdbAgemem_error" : "_tdbAgemem_hint",
						id: "tdb-agemem-services-summary",
						children: reachable ? summary : t("servicesUnreachable")
					}),
					reachable && names.length === 0
						? px("p", { className: "_tdbAgemem_hint", id: "tdb-agemem-services-empty", children: t("servicesEmpty") })
						: null,
					reachable && names.length > 0
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
											px("th", { className: "_tdbAgemem_th", children: t("servicesOrigin") }),
											px("th", { className: "_tdbAgemem_th", children: t("servicesActions") })
										]
									})
								}),
								px("tbody", { children: names.map(row) })
							]
						})
						: null,
					reachable
						? pxs("div", {
							className: "_tdbAgemem_section",
							children: [
								px("button", {
									type: "button",
									className: "_tdbAgemem_button _tdbAgemem_buttonPrimary",
									id: "tdb-agemem-services-start",
									disabled: busy !== "",
									onClick: () => act("/start", undefined, "start", "servicesNoteStarted"),
									children: busy === "start" ? t("servicesBusy") : t("servicesStartAll")
								}),
								px("button", {
									type: "button",
									className: "_tdbAgemem_button _tdbAgemem_buttonDanger",
									id: "tdb-agemem-services-stop",
									disabled: busy !== "",
									onClick: () => {
										if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(t("servicesConfirmStop"))) return;
										act("/stop", undefined, "stop", "servicesNoteStopped");
									},
									children: busy === "stop" ? t("servicesBusy") : t("servicesStopAll")
								})
							]
						})
						: null,
					note !== ""
						? px("p", {
							className: noteError ? "_tdbAgemem_hint _tdbAgemem_error" : "_tdbAgemem_hint",
							id: "tdb-agemem-services-note",
							children: note
						})
						: null
				]
			});
		}

	/* ---------------------------------------------------------------------- *
	 * Identity chip (task-117 v4).
	 *
	 * The host refuses to swap an agent's tools once a turn has run, so the
	 * conversation's memory scope has to be chosen BEFORE the first turn -- which
	 * is why this is a chip in the composer tool row (next to the model picker)
	 * rather than a dialog raised from a pre-step. Picking stages a choice on the
	 * server; the session's first turn commits it; from then on the chip renders
	 * as a read-only label, the same rule the host applies to its own preset.
	 *
	 * It renders nothing when the transport is absent (the plugin's identity
	 * section can be switched off, and a host without a web server has no
	 * routes), so a disabled plugin leaves no trace in the composer.
	 * ---------------------------------------------------------------------- */
	const IDENTITY_STATE = "/tdb-identity/state";
	const IDENTITY_CHOOSE = "/tdb-identity/choose";

	function identityLabelOf(option) {
		return option && typeof option.label === "string" ? option.label : "";
	}

	/** One request against the chip's transport; null on any failure. */
	async function identityRequest(url, init) {
		try {
			const response = await fetch(url, init);
			const payload = await response.json().catch(() => null);
			if (payload === null || payload.ok !== true || payload.data === undefined) return null;
			return payload.data;
		} catch {
			return null;
		}
	}

	/**
	 * Same request, but keep the server's error code. The chip needs it to tell
	 * 「this conversation is already pinned」apart from 「the request failed」-- both
	 * look identical to a boolean, and one of them is not retryable.
	 */
	async function identitySend(url, init) {
		try {
			const response = await fetch(url, init);
			const payload = await response.json().catch(() => null);
			if (payload !== null && payload.ok === true && payload.data !== undefined) {
				return { data: payload.data, error: "" };
			}
			return { data: null, error: payload && typeof payload.error === "string" ? payload.error : "failed" };
		} catch {
			return { data: null, error: "failed" };
		}
	}

	function IdentityChip(props) {
		const { useCallback, useEffect, useRef, useState } = require("react");
		const t = props.t;
		const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
		const [state, setState] = useState(null);
		const [open, setOpen] = useState(false);
		const [busy, setBusy] = useState(false);
		const [note, setNote] = useState("");
		const [teamId, setTeamId] = useState("");
		const [agentId, setAgentId] = useState("");
		const [taskId, setTaskId] = useState("");
		// A pick that this component staged but that the first turn has not yet
		// written into the store. Kept locally (not only in the server's staged
		// map) so the chip can show 「待生效」between the click and the first turn
		// without a second round trip landing on a stale snapshot.
		const [stagedPicked, setStagedPicked] = useState(false);
		const mounted = useRef(true);
		useEffect(() => () => {
			mounted.current = false;
		}, []);
		const load = useCallback(async (nextTeamId) => {
			if (sessionId === "") return;
			const url = IDENTITY_STATE + "?sessionId=" + encodeURIComponent(sessionId)
				+ (typeof nextTeamId === "string" && nextTeamId !== "" ? "&teamId=" + encodeURIComponent(nextTeamId) : "");
			const data = await identityRequest(url, { headers: { Accept: "application/json" } });
			if (!mounted.current) return;
			setState(data);
			if (data === null) return;
			// The first turn has committed the pick: the server now owns the answer,
			// so the local 「待生效」flag must fall away. Without this the chip keeps
			// claiming a pick is pending long after it took effect (measured
			// 2026-11-22 11:32, session a0166b0a: store committed at :28, chip still
			// said 「待生效」because nothing reloaded after the turn).
			// "The server owns the answer" only once the row is no longer a pre-answer:
			// a creation-time row is exactly the state the pick is still waiting on.
			if (data.bound && data.bound.unconfirmedAt === undefined) setStagedPicked(false);
			const preset = data.teamId !== undefined && data.teamId !== "" ? data.teamId : (data.teams[0] ? data.teams[0].id : "");
			setTeamId((previous) => (previous !== "" ? previous : preset));
			const stagedAgent = data.staged ? data.staged.agentId : "";
			// The account's preset agent (locked) IS the default: preselect it, so the
			// panel shows "this is your default" instead of quietly defaulting to some
			// other agent in the list.
			const lockedAgent = data.agents.find((option) => option.locked === true);
			// Never preselect on the user's behalf when the row is still open: the
			// 「待生效」chip says a pick is pending, and quietly filling in an agent
			// would then commit a choice nobody made on the next 确定.
			const openRow = data.editable === true || (data.bound && data.bound.unconfirmedAt !== undefined);
			// A preset agent is the user's own configured default, so preselecting it is not
		// "choosing on their behalf" — it also keeps 确定 usable while the row is open.
		// Any other open row stays empty: an accidental 确定 must not commit a pick
		// nobody made (2026-11-22 12:13, session 0a7a0854).
		const choice = stagedAgent !== ""
				? stagedAgent
				: lockedAgent ? lockedAgent.id : (openRow ? "" : (data.agents[0] || {}).id || "");
			setAgentId((previous) => (previous !== "" ? previous : choice));
			setTaskId(data.staged && typeof data.staged.taskId === "string" ? data.staged.taskId : "");
		}, [sessionId]);
		useEffect(() => {
			if (open) void load(teamId);
		}, [open, load]);
		useEffect(() => {
			void load("");
		}, [load]);
		// While a pick is waiting for the first turn to commit it, keep asking. The
		// commit happens on the SERVER during the next turn, and nothing in the
		// composer re-renders on that event, so a one-shot load would leave the
		// chip showing 「待生效」forever. Bounded by stagedPicked: it clears on the
		// first reload that reports a bound identity.
		// A creation-time answer ("pre-answer") is also waiting for its first turn to
		// confirm it, and the composer does not re-render when that happens server-side.
		// Without polling for it too, the chip keeps saying 「可改」after the row is
		// already frozen (measured 2026-11-22 12:14, session 0a7a0854: store confirmed at
		// :04, chip still offered an edit until a manual reload).
		const preAnswerOpen = state !== null && state.editable === true;
		useEffect(() => {
			if (!stagedPicked && !preAnswerOpen) return undefined;
			const timer = setInterval(() => { void load(""); }, 3000);
			return () => clearInterval(timer);
		}, [stagedPicked, preAnswerOpen, load]);
		if (sessionId === "") return null;

		const bound = state && state.bound ? state.bound : null;
		const staged = (state && state.staged ? state.staged : null) !== null || stagedPicked ? true : null;
		// The label the server froze into the binding wins over the live list: the
		// list is empty whenever a candidates read failed, and a read-only chip
		// that answers with 「agt-3i8k22f496」is useless to the person reading it.
		const agentLabel = (id) => {
			if (bound !== null && bound.agentId === id && typeof bound.agentLabel === "string" && bound.agentLabel !== "") {
				return bound.agentLabel;
			}
			const found = state && Array.isArray(state.agents) ? state.agents.find((option) => option.id === id) : null;
			return found ? identityLabelOf(found) : id;
		};
		// Bound: a read-only label. An empty teamId with associate:false is the
		// explicit 「本次不关联」. An EMPTY TRIPLE nobody chose (candidates failed, or
		// ambiguous with the chip unused) is unresolved, not declined -- it must stay
		// editable, otherwise a 3-second core restart locks the conversation out of
		// the preset the user actually configured.
		// A pre-answer (rules-written row, no turn yet) keeps the panel reachable:
		// with a default agent configured the conversation used to be frozen the
		// moment it existed, so 「本次不关联」/换人 was unreachable (rule ②, measured
		// 2026-11-22 11:56 session-7ce40b5d). state.editable is that window.
		if (bound !== null && state.unresolved !== true && state.editable !== true) {
			const text = bound.teamId === ""
				? t("identityChipNone")
				: t("identityChip") + " · " + agentLabel(bound.agentId);
			return px("span", {
				className: "_tdbAgemem_chip _tdbAgemem_chipStatic",
				title: t("identityBound"),
				children: [
					px("span", { className: "_tdbAgemem_chipDot" }),
					px("span", { children: text })
				]
			});
		}
		// Hidden until the transport answers: a host that serves no routes (or a
		// plugin whose identity section is off) must not leave a dead chip behind.
		if (state === null) return null;
		if (state.status === "inert") return null;

		const commit = async () => {
			setBusy(true);
			setNote("");
			const result = await identitySend(IDENTITY_CHOOSE, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ sessionId, teamId, agentId, taskId })
			});
			if (!mounted.current) return;
			setBusy(false);
			if (result.data === null) {
				setNote(result.error === "already-committed" ? t("identityLocked") : t("identityFailed") + "choose");
				void load(teamId);
				return;
			}
			setOpen(false);
			setStagedPicked(true);
			setNote(t("identityStaged"));
			void load(teamId);
		};
		const decline = async () => {
			setBusy(true);
			setNote("");
			const result = await identitySend(IDENTITY_CHOOSE, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ sessionId, associate: false })
			});
			if (!mounted.current) return;
			setBusy(false);
			if (result.data === null) {
				setNote(result.error === "already-committed" ? t("identityLocked") : t("identityFailed") + "choose");
				void load("");
				return;
			}
			setOpen(false);
			setStagedPicked(true);
			setNote(t("identityStaged"));
			void load("");
		};

		const teams = Array.isArray(state.teams) ? state.teams : [];
		const agents = Array.isArray(state.agents) ? state.agents : [];
		// preset 给了默认 agent：它就是**固定**的（名称与 id 只展示），面板里不再
		// 出现别的 agent 可选。想换人设请去改 userKey 的 session_init 默认，
		// 或者在这里选「本次不关联」让这一条对话不带记忆。
		const presetAgent = agents.find((option) => option.locked === true) || null;
		const tasks = Array.isArray(state.tasks) ? state.tasks : [];
		// A staged pick IS the answer to whatever the unresolved hint was about:
		// telling the user 「上次解析未完成」after they just picked would read as
		// "your click did not register". So staged outranks unresolved here.
		// 「待生效」covers both cases that are true only after the next turn: a click
		// just made, and a row that is still the creation-time answer.
		// 「待生效」means the user picked something and the first turn has not written it
		// yet. A creation-time answer is NOT a pick: it is what this account defaults to,
		// so the chip says which agent it is and marks it editable (the panel can still
		// change it or decline before the first message).
		const chipText = staged !== null
			? t("identityChipStaged")
			: state.editable === true
				? (bound !== null && bound.agentId !== ""
					? t("identityChip") + " · " + agentLabel(bound.agentId) + " · " + t("identityEditable")
					: t("identityChipChoose"))
				: state.unresolved === true ? t("identityChipUnresolved") : t("identityChipChoose");
		const rows = [];
		rows.push(px("p", { className: "_tdbAgemem_panelTitle", children: t("identityPanelTitle") }));
		if (state.unresolved === true) {
			rows.push(px("p", { className: "_tdbAgemem_hint", children: t("identityUnresolved") }));
		}
		if (state.status === "failed") {
			rows.push(px("p", { className: "_tdbAgemem_hint", children: t("identityFailed") + String(state.reason || "") }));
		}
		if (teams.length > 1 && presetAgent === null) {
			rows.push(pxs("div", {
				className: "_tdbAgemem_panelRow",
				children: [
					px("p", { className: "_tdbAgemem_panelLabel", children: t("identityTeam") }),
					px("select", {
						className: "_tdbAgemem_choice",
						value: teamId,
						onChange: (event) => {
							const next = event.target.value;
							setTeamId(next);
							setAgentId("");
							setTaskId("");
							void load(next);
						},
						children: teams.map((option) => px("option", { value: option.id, children: identityLabelOf(option) }, option.id))
					})
				]
			}));
		}
		rows.push(pxs("div", {
			className: "_tdbAgemem_panelRow",
			children: [
				px("p", { className: "_tdbAgemem_panelLabel", children: t("identityAgent") }),
				agents.length === 0
					? px("p", { className: "_tdbAgemem_hint", children: teams.length > 1 && teamId === "" ? t("identityPickTeam") : t("identityNoAgents") })
					: pxs("div", {
						style: { display: "grid", gap: "2px" },
						children: (presetAgent !== null ? [presetAgent] : agents).map((option) => (
							option.locked === true
								? px("div", {
									className: "_tdbAgemem_choice _tdbAgemem_choiceLocked",
									title: t("identityPresetLocked"),
									children: [
										px("span", { children: identityLabelOf(option) }),
										px("span", { className: "_tdbAgemem_hint", children: t("identityPresetLocked") })
									]
								}, option.id)
								: px("button", {
									type: "button",
									className: "_tdbAgemem_choice" + (agentId === option.id ? " _tdbAgemem_choiceOn" : ""),
									onClick: () => setAgentId(option.id),
									children: [
										px("span", { children: identityLabelOf(option) }),
										agentId === option.id ? px("span", { children: "✓" }) : null
									]
								}, option.id)
						))
					})
			]
		}));
		rows.push(pxs("div", {
			className: "_tdbAgemem_panelRow",
			children: [
				px("p", { className: "_tdbAgemem_panelLabel", children: t("identityTask") }),
				px("select", {
					className: "_tdbAgemem_choice",
					value: taskId,
					onChange: (event) => setTaskId(event.target.value),
					children: [
						px("option", { value: "", children: t("identityNoTask") }),
						...tasks.map((option) => px("option", { value: option.id, children: identityLabelOf(option) }, option.id))
					]
				})
			]
		}));
		rows.push(pxs("div", {
			className: "_tdbAgemem_panelActions",
			children: [
				px("button", {
					type: "button",
					className: "_tdbAgemem_button",
					disabled: busy,
					onClick: decline,
					children: t("identityDecline")
				}),
				px("button", {
					type: "button",
					className: "_tdbAgemem_button _tdbAgemem_buttonPrimary",
					disabled: busy || agentId === "",
					onClick: commit,
					children: t("identityConfirm")
				})
			]
		}));

		return pxs("div", {
			className: "_tdbAgemem_chipWrap",
			children: [
				pxs("button", {
					type: "button",
					className: "_tdbAgemem_chip",
					onClick: () => setOpen((previous) => !previous),
					title: note !== "" ? note : t("identityPanelTitle"),
					children: [
						px("span", { className: "_tdbAgemem_chipDot _tdbAgemem_chipDotOff" }),
						px("span", { children: chipText }),
						px("span", { children: open ? "▴" : "▾" })
					]
				}),
				open ? pxs("div", { className: "_tdbAgemem_panel", children: rows }) : null,
				open === false && note !== "" ? px("span", { className: "_tdbAgemem_hint", style: { display: "none" }, children: note }) : null
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
			ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...servicesZh, ...identityZh }, en: { ...en, ...servicesEn, ...identityEn } }), "tdb-agemem: dictionaries");
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
			 * the whole point of a lifecycle page.
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

			/*
			 * task-117 v4: the identity chip. It sits in the composer tool row, left
			 * of the input, next to whatever control the host puts there -- the
			 * position the user pointed at ("参照会话框选择模型位置"). It is NOT tied
			 * to configForms: identity works even when the settings form is
			 * unavailable, and the chip hides itself when its transport is absent.
			 */
			const dropChip = ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "tdb-agemem-identity",
				order: 20,
				label: () => t("identityChip"),
				locale: NS,
				inject: () => ({ t })
			}, IdentityChip));
			if (typeof dropChip === "function") ctx.effect(() => dropChip, "tdb-agemem: identity chip");
		}

		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
