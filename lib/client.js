window.__ModuleLoader__.load({
	id: "dsh-session-handoff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsx = require("react/jsx-runtime");

		/** Dictionary namespace owned by this plugin. */
		const NS = "session-handoff";

		/**
		 * The profile entry id that owns this plugin's configuration.
		 *
		 * Settings addresses a namespace by the Loader entry id, which is what
		 * cordis.patch.yml declares for this plugin. It is also the fence that keeps the
		 * form unavailable in a deployment that never mounted the row.
		 */
		const NAMESPACE = "session-handoff";

		/**
		 * Stylesheet, injected once.
		 *
		 * Class names are prefixed so they cannot collide with the shell's own. Every
		 * value is a design token rather than a literal, so the form follows the app's
		 * theme (dark mode included) instead of hard-coding one palette.
		 */
		const CSS = ".sh-section { max-width: 760px; display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-primary); }\n.sh-title { margin: 0 0 2px; font-size: 18px; font-weight: 600; }\n.sh-intro { margin: 0 0 8px; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }\n.sh-group { margin-top: 22px; }\n.sh-group:first-of-type { margin-top: 8px; }\n.sh-groupTitle { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.5; }\n.sh-groupHint { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }\n.sh-fields { margin-top: 2px; }\n.sh-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }\n.sh-field + .sh-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }\n.sh-label { font-size: 13px; font-weight: 500; line-height: 1.5; }\n.sh-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }\n.sh-control { display: flex; align-items: center; gap: 10px; }\n.sh-input { height: 34px; width: 200px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }\n.sh-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }\n.sh-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }\n.sh-select { height: 34px; min-width: 200px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; }\n.sh-select:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }\n.sh-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }\n.sh-textarea { width: 100%; max-width: 460px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-primary); resize: vertical; }\n.sh-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }\n.sh-textarea:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }\n.sh-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }\n.sh-switch[aria-checked=\"true\"] { background: var(--dsw-alias-brand-primary); }\n.sh-switch:disabled { cursor: default; opacity: 0.5; }\n.sh-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }\n.sh-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }\n.sh-switch[aria-checked=\"false\"] .sh-thumb { background: var(--dsw-alias-switch-thumb); }\n.sh-switch[aria-checked=\"true\"] .sh-thumb { transform: translateX(16px); }\n.sh-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }\n.sh-error { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); }\n.sh-saved { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }\n.sh-unit { font-size: 12px; color: var(--dsw-alias-label-tertiary); }";

		/** Inject the stylesheet once per document. */
		function ensureStyles() {
			const id = "dsh-session-handoff/form.css";
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-handoff";
			tag.dataset.pluginCss = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const zh = {
			nav: "会话交接",
			title: "会话交接",
			intro: "在会话大到无法继续之前，把它的记忆交接给一个新会话。",
			loading: "正在读取配置…",
			unavailable: "此部署没有开放本插件的配置（配置档案里没有挂载本插件这一行）。",
			readonly: "当前连接只能改进程内配置，不会写回配置档案。",
			saveFailed: "写入被拒绝：{message}",
			saved: "已保存",
			unitTokens: "词元（token）",
			unitMs: "毫秒",
			unitRatio: "比例",
			monitorTitle: "压力监控",
			monitorHint: "每一轮对话结束时测量上下文压力，超过阈值就在对话里提醒。",
			monitorEnabled: "启用监控",
			language: "提醒语言",
			languageHint: "提醒会出现在对话里。宿主半读不到浏览器的语言设置，所以这里单独选。",
			langZh: "中文",
			langEn: "English",
			watchRatio: "开始关注（占上限比例）",
			warnRatio: "警告（占上限比例）",
			criticalRatio: "危急（占上限比例）",
			upstreamTitle: "上游上限",
			upstreamHint: "模型窗口不再需要配置 —— 插件会从会话当前使用的模型配置里读取它。这里只配置上游请求长度上限：它是路由背后账号的属性，模型配置里没有，唯一权威是实测。",
			upstreamPromptLimit: "上游请求长度上限（兜底）",
			upstreamPromptLimits: "按模型覆盖（每行一条：服务商/模型 = 词元数）",
			upstreamLimitsPlaceholder: "ai/deepseek-v4.1-flash = 1048576\nzcode/GLM-5.3-Flash = 500000",
			remindTitle: "提醒节奏",
			remindHint: "同一等级重复提醒，需要同时满足冷却时间和真实增长，避免每一步都打扰。",
			remindCooldownMs: "冷却时间",
			remindEveryTokens: "增长多少才再提醒",
			autoTitle: "自动交接",
			autoHint: "会话崩了而你不在电脑边时，自动把工作接手到新会话。默认开启。「一轮」= 你发一次消息到我做完停下；一轮里有很多次工具调用。",
			autoEnabled: "启用自动交接",
			autoAtLevel: "压力触发等级",
			autoOnAnomaly: "连续失败也触发",
			autoAnomalyThreshold: "连续失败几轮才触发",
			autoArchive: "自动归档源会话",
			autoArchiveHint: "默认关闭：会话崩掉时那份记录是证据，藏起来不如留着让你看。",
			levelWatch: "关注",
			levelWarn: "警告",
			levelCritical: "危急",
			compactionTitle: "压缩失败触发",
			compactionHint: "压缩失败算异常，但要和体量一起判断：实测有会话被策略拒绝 1062 次却仍在正常工作，所以光看次数会误杀。",
			compactionFailureThreshold: "连续压缩失败次数",
			compactionAnomalyVolumeRatio: "体量下限（占模型窗口比例）",
			seedTitle: "交接内容",
			seedHint: "事实与检查点是精确的，永不为摘要让位；逐字尾部有保留份额。",
			seedBudgetTokens: "交接内容预算",
			recentShareRatio: "逐字尾部保留份额",
			whatTitle: "这个插件实际会做什么",
			whatBody: "交接顺序：读会话 → 抽四层记忆 → 分块总结 → 建新会话并投递交接内容 → 归档源会话（同时终止它的工作）→ 把源会话从内存里释放。归档不删除任何东西，日志仍在磁盘上、仍可阅读；释放只是把它从内存里的活动集合摘掉。",
			measuredNote: "压力读数优先取服务商上报的占用；只有在拿不到时才退回估算，而估算值永远不会触发自动交接。",
		};
		const en = {
			nav: "Session handoff",
			title: "Session handoff",
			intro: "Carry a conversation's memory into a new session before it grows too large to continue.",
			loading: "Reading configuration…",
			unavailable: "This deployment does not expose this plugin's configuration (no session-handoff row in the profile).",
			readonly: "This connection keeps preferences process-local and will not write to the profile.",
			saveFailed: "Write refused: {message}",
			saved: "Saved",
			unitTokens: "tokens",
			unitMs: "ms",
			unitRatio: "ratio",
			monitorTitle: "Pressure monitor",
			monitorHint: "Measures context pressure at every turn boundary and reminds you in the conversation once it crosses a threshold.",
			monitorEnabled: "Enable the monitor",
			language: "Reminder language",
			languageHint: "The reminder appears in the transcript. The host half cannot read the browser locale, so it is chosen here.",
			langZh: "中文",
			langEn: "English",
			watchRatio: "Watch at (fraction of the ceiling)",
			warnRatio: "Warn at",
			criticalRatio: "Critical at",
			upstreamTitle: "Upstream limit",
			upstreamHint: "The model window no longer needs configuring — the plugin reads it from the model configuration the session is actually using. Only the upstream prompt limit is configured here: it is a property of the account behind a route, it is not in the model config, and measurement is the only authority.",
			upstreamPromptLimit: "Upstream prompt limit (fallback)",
			upstreamPromptLimits: "Per-model overrides (one provider/model = tokens per line)",
			upstreamLimitsPlaceholder: "ai/deepseek-v4.1-flash = 1048576\nzcode/GLM-5.3-Flash = 500000",
			remindTitle: "Reminder cadence",
			remindHint: "Repeating the same level needs both a cooldown and real growth, so a parked session does not nag on every step.",
			remindCooldownMs: "Cooldown",
			remindEveryTokens: "Growth before reminding again",
			autoTitle: "Automatic handoff",
			autoHint: "When a session breaks while you are away from the machine, hand the work to a new session automatically. On by default.",
			autoEnabled: "Enable automatic handoff",
			autoAtLevel: "Pressure level that triggers",
			autoOnAnomaly: "Failed turns also trigger",
			autoAnomalyThreshold: "Consecutive failed turns before triggering",
			autoArchive: "Archive the source automatically",
			autoArchiveHint: "Off by default: a session that broke is evidence, and hiding it is worse than leaving it visible.",
			levelWatch: "Watch",
			levelWarn: "Warn",
			levelCritical: "Critical",
			compactionTitle: "Compaction-failure trigger",
			compactionHint: "A compaction failure is an anomaly, but it is judged together with volume: a real session was refused 1062 times and kept working, so the count alone would tear down a healthy session.",
			compactionFailureThreshold: "Consecutive compaction failures",
			compactionAnomalyVolumeRatio: "Volume floor (fraction of the model window)",
			seedTitle: "What the handoff carries",
			seedHint: "Facts and checkpoints are exact and never dropped for prose; the verbatim tail gets a reserved share.",
			seedBudgetTokens: "Seed budget",
			recentShareRatio: "Verbatim tail share",
			whatTitle: "What this plugin actually does",
			whatBody: "Handoff order: read the session → extract four memory layers → chunked summarization → create the successor and deliver the seed → archive the source (with stopActivity, terminating its work) → release the source's live event tree. Archiving deletes nothing: the log stays on disk and stays readable. Releasing only drops it from the in-memory live set.",
			measuredNote: "Pressure prefers the provider-reported occupancy; the estimate is a fallback only, and an estimated reading never triggers an automatic handoff.",
		};

		const inject = ["slots", "locale", "remote", "remote.settings", "configForms"];

		/** Read one numeric field, falling back to the shipped default. */
		function num(value, fallback) {
			return typeof value === "number" && Number.isFinite(value) ? value : fallback;
		}

		/** One labelled field: label, the control, then the hint. */
		function Field({ label, hint, control }) {
			return jsx.jsxs("div", { className: "sh-field", children: [
				jsx.jsx("div", { className: "sh-label", children: label }),
				control,
				hint === undefined ? null : jsx.jsx("p", { className: "sh-hint", children: hint }),
			] });
		}

		/** One titled group of fields. */
		function Group({ title, hint, children }) {
			return jsx.jsxs("section", { className: "sh-group", children: [
				jsx.jsx("h3", { className: "sh-groupTitle", children: title }),
				hint === undefined ? null : jsx.jsx("p", { className: "sh-groupHint", children: hint }),
				jsx.jsx("div", { className: "sh-fields", children }),
			] });
		}

		/** A number input bound to one config path. */
		function NumberField({ label, hint, value, fallback, unit, disabled, onCommit }) {
			const [draft, setDraft] = react.useState(String(num(value, fallback)));
			react.useEffect(() => { setDraft(String(num(value, fallback))) }, [value, fallback]);
			return jsx.jsx(Field, {
				label,
				hint,
				control: jsx.jsxs("div", { className: "sh-control", children: [
					jsx.jsx("input", {
						className: "sh-input",
						type: "number",
						value: draft,
						disabled,
						onChange: (event) => setDraft(event.target.value),
						onBlur: () => {
							const parsed = Number(draft);
							if (Number.isFinite(parsed) && parsed > 0) onCommit(parsed);
							else setDraft(String(num(value, fallback)));
						},
					}),
					unit === undefined ? null : jsx.jsx("span", { className: "sh-unit", children: unit }),
				] }),
			});
		}

		/** A map-valued field, edited as one key = value line per entry. */
		function MapField({ label, hint, value, placeholder, disabled, onCommit }) {
			const toText = (input) => Object.entries(input && typeof input === "object" ? input : {})
				.map(([key, entry]) => key + " = " + String(entry)).join("\n");
			const [draft, setDraft] = react.useState(() => toText(value));
			react.useEffect(() => { setDraft(toText(value)) }, [value]);
			return jsx.jsx(Field, {
				label,
				hint,
				control: jsx.jsx("textarea", {
					className: "sh-textarea",
					value: draft,
					placeholder,
					disabled,
					rows: 4,
					spellCheck: false,
					onChange: (event) => setDraft(event.target.value),
					onBlur: () => {
						const next = {};
						for (const line of draft.split("\n")) {
							const at = line.indexOf("=");
							if (at < 0) continue;
							const key = line.slice(0, at).trim();
							const raw = Number(line.slice(at + 1).trim());
							if (key.length === 0 || !Number.isFinite(raw) || raw <= 0) continue;
							next[key] = raw;
						}
						onCommit(next);
					},
				}),
			});
		}

		/** An on/off switch, drawn the way the shell draws its own. */
		function ToggleField({ label, hint, value, disabled, onCommit }) {
			const checked = value === true;
			return jsx.jsx(Field, {
				label,
				hint,
				control: jsx.jsx("button", {
					type: "button",
					role: "switch",
					className: "sh-switch",
					"aria-checked": checked ? "true" : "false",
					disabled,
					onClick: () => onCommit(!checked),
					children: jsx.jsx("span", { className: "sh-thumb" }),
				}),
			});
		}

		/** A select bound to one config path. Options carry a label and a wire value. */
		function SelectField({ label, hint, value, options, disabled, onCommit }) {
			const current = typeof value === "string" ? value : options[0].value;
			return jsx.jsx(Field, {
				label,
				hint,
				control: jsx.jsx("select", {
					className: "sh-select",
					value: current,
					disabled,
					onChange: (event) => onCommit(event.target.value),
					children: options.map((option) => jsx.jsx("option", { value: option.value, children: option.label })),
				}),
			});
		}

		/** The section body: reads and writes this plugin's own config namespace. */
		function HandoffSection({ t, configForms }) {
			ensureStyles();
			const form = react.useMemo(() => configForms.get(NAMESPACE), [configForms]);
			const snapshot = react.useSyncExternalStore(
				(listener) => form.subscribe(listener),
				() => form.getSnapshot(),
				() => form.getSnapshot(),
			);
			const [error, setError] = react.useState();
			const [savedAt, setSavedAt] = react.useState(0);

			const config = (snapshot.value && typeof snapshot.value === "object") ? snapshot.value : {};
			const monitor = config.monitor || {};
			const policy = config.policy || {};
			const auto = config.autoHandoff || {};
			const disabled = !snapshot.writable;

			const write = react.useCallback((path, value) => {
				setError(undefined);
				form.mutate([{ op: "set", path, value }]).then((ok) => {
					if (ok === false) setError(t("saveFailed", { message: "the Host refused the write" }));
					else setSavedAt(Date.now());
				}, (failure) => {
					setError(t("saveFailed", { message: failure && failure.message ? failure.message : String(failure) }));
				});
			}, [form, t]);

			if (snapshot.status === "loading") return jsx.jsx("p", { className: "sh-note", children: t("loading") });
			if (snapshot.status === "unavailable") return jsx.jsx("p", { className: "sh-note", children: t("unavailable") });

			// The wire values stay stable; only the labels are localized.
			const levels = [
				{ value: "watch", label: t("levelWatch") },
				{ value: "warn", label: t("levelWarn") },
				{ value: "critical", label: t("levelCritical") },
			];

			return jsx.jsxs("div", { className: "sh-section", children: [
				jsx.jsx("h2", { className: "sh-title", children: t("title") }),
				jsx.jsx("p", { className: "sh-intro", children: t("intro") }),
				error === undefined ? null : jsx.jsx("p", { className: "sh-error", role: "alert", children: error }),
				disabled ? jsx.jsx("p", { className: "sh-note", children: t("readonly") }) : null,
				savedAt === 0 ? null : jsx.jsx("p", { className: "sh-saved", children: t("saved") }),

				jsx.jsxs(Group, { title: t("monitorTitle"), hint: t("monitorHint"), children: [
					jsx.jsx(ToggleField, { label: t("monitorEnabled"), value: monitor.enabled !== false, disabled, onCommit: (v) => write(["monitor", "enabled"], v) }),
					jsx.jsx(SelectField, {
						label: t("language"),
						hint: t("languageHint"),
						value: policy.language,
						options: [{ value: "zh", label: t("langZh") }, { value: "en", label: t("langEn") }],
						disabled,
						onCommit: (v) => write(["policy", "language"], v),
					}),
					jsx.jsx(NumberField, { label: t("watchRatio"), value: policy.watchRatio, fallback: 0.45, unit: t("unitRatio"), disabled, onCommit: (v) => write(["policy", "watchRatio"], v) }),
					jsx.jsx(NumberField, { label: t("warnRatio"), value: policy.warnRatio, fallback: 0.6, unit: t("unitRatio"), disabled, onCommit: (v) => write(["policy", "warnRatio"], v) }),
					jsx.jsx(NumberField, { label: t("criticalRatio"), value: policy.criticalRatio, fallback: 0.75, unit: t("unitRatio"), disabled, onCommit: (v) => write(["policy", "criticalRatio"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("upstreamTitle"), hint: t("upstreamHint"), children: [
					jsx.jsx(NumberField, { label: t("upstreamPromptLimit"), value: policy.upstreamPromptLimit, fallback: 1048576, unit: t("unitTokens"), disabled, onCommit: (v) => write(["policy", "upstreamPromptLimit"], v) }),
					jsx.jsx(MapField, { label: t("upstreamPromptLimits"), value: policy.upstreamPromptLimits, placeholder: t("upstreamLimitsPlaceholder"), disabled, onCommit: (v) => write(["policy", "upstreamPromptLimits"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("remindTitle"), hint: t("remindHint"), children: [
					jsx.jsx(NumberField, { label: t("remindCooldownMs"), value: policy.remindCooldownMs, fallback: 600000, unit: t("unitMs"), disabled, onCommit: (v) => write(["policy", "remindCooldownMs"], v) }),
					jsx.jsx(NumberField, { label: t("remindEveryTokens"), value: policy.remindEveryTokens, fallback: 50000, unit: t("unitTokens"), disabled, onCommit: (v) => write(["policy", "remindEveryTokens"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("autoTitle"), hint: t("autoHint"), children: [
					jsx.jsx(ToggleField, { label: t("autoEnabled"), value: auto.enabled !== false, disabled, onCommit: (v) => write(["autoHandoff", "enabled"], v) }),
					jsx.jsx(SelectField, { label: t("autoAtLevel"), value: auto.atLevel, options: levels, disabled, onCommit: (v) => write(["autoHandoff", "atLevel"], v) }),
					jsx.jsx(ToggleField, { label: t("autoOnAnomaly"), value: auto.onAnomaly !== false, disabled, onCommit: (v) => write(["autoHandoff", "onAnomaly"], v) }),
					jsx.jsx(NumberField, { label: t("autoAnomalyThreshold"), value: auto.anomalyThreshold, fallback: 2, disabled, onCommit: (v) => write(["autoHandoff", "anomalyThreshold"], v) }),
					jsx.jsx(ToggleField, { label: t("autoArchive"), hint: t("autoArchiveHint"), value: auto.archive === true, disabled, onCommit: (v) => write(["autoHandoff", "archive"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("compactionTitle"), hint: t("compactionHint"), children: [
					jsx.jsx(NumberField, { label: t("compactionFailureThreshold"), value: policy.compactionFailureThreshold, fallback: 3, disabled, onCommit: (v) => write(["policy", "compactionFailureThreshold"], v) }),
					jsx.jsx(NumberField, { label: t("compactionAnomalyVolumeRatio"), value: policy.compactionAnomalyVolumeRatio, fallback: 0.35, unit: t("unitRatio"), disabled, onCommit: (v) => write(["policy", "compactionAnomalyVolumeRatio"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("seedTitle"), hint: t("seedHint"), children: [
					jsx.jsx(NumberField, { label: t("seedBudgetTokens"), value: policy.seedBudgetTokens, fallback: 24000, unit: t("unitTokens"), disabled, onCommit: (v) => write(["policy", "seedBudgetTokens"], v) }),
					jsx.jsx(NumberField, { label: t("recentShareRatio"), value: policy.recentShareRatio, fallback: 0.5, unit: t("unitRatio"), disabled, onCommit: (v) => write(["policy", "recentShareRatio"], v) }),
				] }),

				jsx.jsxs(Group, { title: t("whatTitle"), children: [
					jsx.jsx("p", { className: "sh-hint", children: t("whatBody") }),
					jsx.jsx("p", { className: "sh-hint", children: t("measuredNote") }),
				] }),
			] });
		}

		/**
		 * Mount the settings section.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-handoff: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-handoff",
				order: 40,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t, configForms: ctx.configForms }),
			}, HandoffSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
