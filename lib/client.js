/**
 * Browser half of `dsh-file-upload`.
 *
 * Served by `dsh-client-modules` at `/plugins/dsh-file-upload/client.js` and
 * executed as a classic script: the only thing this file may do at top level is
 * register a factory on the page's module table, and everything with a side
 * effect (including this plugin's own wiring) lives inside the factory closure,
 * which materializes on first require.
 *
 * The affordance is one control in the composer's right-hand input seat. It
 * uploads through the plugin's own host channel and then writes the returned
 * `@`-mentions into the draft, so what the model receives is ordinary prompt
 * text that the person can see, edit, or delete before sending — no hidden
 * attachment state, and no host-side rewriting of user input.
 */
window.__ModuleLoader__.load({
	id: "dsh-file-upload",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The host channel and endpoint registered by this package's node half. */
		const CHANNEL = "/dsh-upload";
		const ENDPOINT = "save";

		/**
		 * Client-side fast-path limits. The host enforces the authoritative
		 * policy; these exist only so an obviously oversized batch fails in the
		 * browser instead of after a 40 MB base64 round trip.
		 */
		const MAX_FILES = 20;
		const MAX_FILE_BYTES = 25 * 1024 * 1024;

		/** Selector for the input snapshot, kept stable so the hook stays cheap. */
		const selectDraft = (state) => state.draft;

		/** Stand-in used when the input hook is absent; never calls a hook itself. */
		const noDraft = () => undefined;

		/**
		 * Encode browser bytes as canonical base64.
		 *
		 * `btoa` needs a binary string, and spreading a large array into
		 * `String.fromCharCode` overflows the argument list, so the conversion
		 * walks the buffer in fixed-size chunks.
		 *
		 * @param data - Raw file bytes.
		 * @returns Canonical base64 with no line breaks.
		 */
		function bytesToBase64(data) {
			let binary = "";
			const chunk = 32768;
			for (let offset = 0; offset < data.length; offset += chunk) binary += String.fromCharCode(...data.subarray(offset, offset + chunk));
			return btoa(binary);
		}

		/**
		 * Human-readable size for a refusal message.
		 *
		 * @param bytes - Byte count.
		 * @returns A short decimal size string.
		 */
		function formatBytes(bytes) {
			return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
		}

		/**
		 * Validate a picked batch before any bytes leave the browser.
		 *
		 * @param files - Files chosen by the person.
		 * @returns A refusal message, or undefined when the batch may proceed.
		 */
		function preflight(files) {
			if (files.length > MAX_FILES) return `最多 ${String(MAX_FILES)} 个文件一次 (max ${String(MAX_FILES)} files per upload)`;
			for (const file of files) {
				if (file.size === 0) return `"${file.name}" 是空文件 (empty file)`;
				if (file.size > MAX_FILE_BYTES) return `"${file.name}" 超过 ${formatBytes(MAX_FILE_BYTES)} (too large)`;
			}
			return undefined;
		}

		/**
		 * Build the composer control bound to one plugin activation.
		 *
		 * @param ctx - Client plugin context; used to reach the host channel.
		 * @returns The React component registered into the input seat.
		 */
		function createUploadControl(ctx) {
			return function UploadControl(props) {
				const { sessionId, inputActions } = props;
				// The draft is readable two ways and both are contractual for this
				// seat: the zone's owner prop (`input`) and ui-conversation's
				// `useInput` selector hook. Prefer the hook so the label reflects
				// live edits, and fall back to the owner prop when the hook is
				// unavailable. Neither branch may fabricate a draft: writing a
				// guess into `setDraft` would silently discard what the person typed.
				const readDraft = typeof props.useInput === "function" ? props.useInput : noDraft;
				const liveDraft = readDraft(selectDraft);
				const draft = typeof liveDraft === "string" ? liveDraft : typeof props.input?.draft === "string" ? props.input.draft : undefined;
				const [busy, setBusy] = React.useState(false);
				const [notice, setNotice] = React.useState(undefined);
				const pickerRef = React.useRef(null);
				const abortRef = React.useRef(undefined);
				// The draft this render saw is frozen into the click handler's
				// closure, so an upload that takes a while would otherwise write
				// back a stale snapshot and discard whatever was typed meanwhile.
				// The ref always holds the latest value for the insertion step.
				const draftRef = React.useRef(draft);

				React.useEffect(() => {
					draftRef.current = draft;
				}, [draft]);
				React.useEffect(() => () => {
					abortRef.current?.abort();
				}, []);
				React.useEffect(() => {
					if (notice === undefined) return undefined;
					const timer = setTimeout(() => setNotice(undefined), 10000);
					return () => clearTimeout(timer);
				}, [notice]);

				const canInsert = typeof draft === "string" && typeof inputActions?.setDraft === "function";

				async function upload(chosen) {
					const files = [...chosen];
					if (files.length === 0) return;
					const refusal = preflight(files);
					if (refusal !== undefined) {
						setNotice({ tone: "error", text: refusal });
						return;
					}
					const connection = ctx.get("connection");
					if (connection === undefined) {
						setNotice({ tone: "error", text: "connection 服务不可用 (host channel unavailable)" });
						return;
					}
					setBusy(true);
					setNotice(undefined);
					const controller = new AbortController();
					abortRef.current = controller;
					try {
						const encoded = await Promise.all(files.map(async (file) => ({
							name: file.name,
							...(file.type === "" ? {} : { mediaType: file.type }),
							data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
						})));
						const result = await connection.rpc.call(CHANNEL, ENDPOINT, { sessionId, files: encoded }, controller.signal);
						if (result.ok !== true) {
							setNotice({ tone: "error", text: result.error.message });
							return;
						}
						const mentions = result.value.files
							.map((file) => file.mention)
							.filter((mention) => typeof mention === "string" && mention !== "")
							.join(" ");
						if (mentions === "") {
							setNotice({ tone: "error", text: "host returned no file references" });
							return;
						}
						// Read the draft through the ref, not the render closure: the
						// person may have typed while the bytes were in flight.
						const current = typeof draftRef.current === "string" ? draftRef.current : "";
						inputActions.setDraft(current.trimEnd() === "" ? mentions : `${current.trimEnd()} ${mentions}`);
						const count = result.value.files.length;
						setNotice({ tone: "ok", text: `已上传 ${String(count)} 个文件到工作区 (uploaded to the workspace)` });
					} catch (error) {
						if (controller.signal.aborted) return;
						setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
					} finally {
						abortRef.current = undefined;
						setBusy(false);
					}
				}

				const button = React.createElement(
					"button",
					{
						type: "button",
						disabled: busy,
						title: canInsert
							? `上传文件到工作区并插入 @ 引用 (upload files, insert @mentions)`
							: `上传文件到工作区 (upload files; the composer draft is not writable in this seat)`,
						"aria-label": "上传文件 (upload files)",
						onClick: () => pickerRef.current?.click(),
					},
					busy ? "…" : "📎",
				);
				const picker = React.createElement("input", {
					ref: pickerRef,
					type: "file",
					multiple: true,
					style: { display: "none" },
					onChange: (event) => {
						const chosen = event.target.files ?? [];
						// Reset first: picking the same file twice must fire change again.
						event.target.value = "";
						void upload(chosen);
					},
				});
				const status = notice === undefined
					? null
					: React.createElement(
						"span",
						{
							role: "status",
							title: notice.text,
							style: {
								maxWidth: "220px",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								color: notice.tone === "error" ? "var(--dsw-alias-label-warning, #c0392b)" : "var(--dsw-alias-label-tertiary, inherit)",
								fontSize: "12px",
							},
						},
						notice.text,
					);
				return React.createElement(
					"span",
					{ style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
					picker,
					button,
					status,
				);
			};
		}

		/** Cordis services this client plugin reads. */
		const inject = ["slots", "connection"];

		/**
		 * Register the composer control.
		 *
		 * @param ctx - Client plugin context.
		 */
		function apply(ctx) {
			const UploadControl = createUploadControl(ctx);
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "file-upload",
				order: 100,
			}, UploadControl));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "file-upload";
		return module.exports;
	}
});
