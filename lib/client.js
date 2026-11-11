/**
 * dsh-session-delete — Client half.
 *
 * Does two things:
 *   1. adds a "Delete session" item to the session context menu;
 *   2. on click, renders a small self-drawn confirmation dialog and POSTs to
 *      `/dsh-session-delete/delete`. The host half then broadcasts
 *      `api-session/removed`, so the sidebar row goes away on its own — no page reload.
 *      If the deleted session was the one on screen, the main view is cleared back to the
 *      empty "no session" state.
 *
 * Deliberately plain DOM: no React internals and no app CSS classes, so a DSH upgrade is
 * less likely to break it.
 */
window.__ModuleLoader__.load({
	id: "@tuweizhi/dsh-session-delete",
	factory: function factory() {
		"use strict";

		const ROUTE = "/dsh-session-delete";
		const MENU_ID = "session.delete";
		const STYLE_ID = "dsh-session-delete-style";
		const OVERLAY_ID = "dsh-session-delete-overlay";

		const MESSAGES = {
			zh: {
				menuLabel: "删除会话",
				dialogTitle: "删除会话",
				description: (displayTitle) =>
					typeof displayTitle === "string" && displayTitle.trim() !== ""
						? "将删除会话「" + displayTitle + "」及其全部对话记录。"
						: "将删除该会话及其全部对话记录。",
				hint: "会话目录会被移动到 sessions-trash（可手工搬回），此操作在界面上不可撤销。",
				cancel: "取消",
				confirm: "删除",
				busy: "删除中…",
				failed: "删除失败"
			},
			en: {
				menuLabel: "Delete session",
				dialogTitle: "Delete session",
				description: (displayTitle) =>
					typeof displayTitle === "string" && displayTitle.trim() !== ""
						? "Permanently delete “" + displayTitle + "” and its whole conversation."
						: "Permanently delete this session and its whole conversation.",
				hint: "The session directory is moved into sessions-trash (you can move it back by hand). There is no undo in the UI.",
				cancel: "Cancel",
				confirm: "Delete",
				busy: "Deleting…",
				failed: "Delete failed"
			}
		};

		/** Follow the page language, not the plugin's own: the UI may be switched at runtime. */
		function strings() {
			const tag = (document.documentElement.getAttribute("lang") || navigator.language || "en").toLowerCase();
			return tag.startsWith("zh") ? MESSAGES.zh : MESSAGES.en;
		}

		function isDarkBackground(color) {
			const match = /rgba?\(([^)]+)\)/.exec(color || "");
			if (match === null) return true;
			const [r, g, b, a] = match[1].split(",").map((part) => Number.parseFloat(part));
			if (Number.isFinite(a) && a === 0) return isDarkBackground(window.getComputedStyle(document.documentElement).backgroundColor);
			if (![r, g, b].every((channel) => Number.isFinite(channel))) return true;
			return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
		}

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				"#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font:13px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;}",
				"#" + OVERLAY_ID + " .dsd-panel{min-width:320px;max-width:min(440px,92vw);padding:18px 18px 14px;border-radius:10px;border:1px solid var(--dsd-border);background:var(--dsd-bg);color:var(--dsd-fg);box-shadow:0 18px 48px rgba(0,0,0,.35);}",
				"#" + OVERLAY_ID + " .dsd-title{font-size:14px;font-weight:600;margin:0 0 8px;}",
				"#" + OVERLAY_ID + " .dsd-desc{margin:0 0 6px;opacity:.82;white-space:pre-wrap;word-break:break-word;}",
				"#" + OVERLAY_ID + " .dsd-hint{margin:0;font-size:12px;opacity:.6;}",
				"#" + OVERLAY_ID + " .dsd-error{margin:10px 0 0;color:#e5534b;font-size:12px;}",
				"#" + OVERLAY_ID + " .dsd-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}",
				"#" + OVERLAY_ID + " button{font:inherit;padding:5px 14px;border-radius:6px;cursor:pointer;border:1px solid var(--dsd-border);background:transparent;color:inherit;}",
				"#" + OVERLAY_ID + " button[data-role=confirm]{border-color:transparent;background:#d0393b;color:#fff;}",
				"#" + OVERLAY_ID + " button:disabled{opacity:.55;cursor:default;}"
			].join("");
			document.head.appendChild(style);
		}

		function closeDialog() {
			const overlay = document.getElementById(OVERLAY_ID);
			if (overlay !== null) overlay.remove();
		}

		async function requestDelete(sessionId) {
			const text = strings();
			const response = await fetch(ROUTE + "/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error(typeof payload?.error === "string" ? payload.error : text.failed);
			}
			return payload;
		}

		/**
		 * When the deleted session is the one on screen, fall back to the "no session" empty
		 * state — otherwise the chat pane keeps showing content of a session that no longer
		 * exists. `clearMain()` is the app's own cleanup path (used by "archive current
		 * session"): it clears the selection, releases the reference and closes the side panel.
		 */
		function leaveDeletedSession(ctx, sessionId) {
			try {
				const uiWorkspace = ctx.get?.("uiWorkspace");
				if (uiWorkspace === void 0) return;
				if (uiWorkspace.mainReference?.sessionId !== sessionId) return;
				uiWorkspace.clearMain?.();
			} catch (error) {
				console.warn("dsh-session-delete: could not leave the deleted session", error);
			}
		}

		function openDialog(ctx, sessionId, displayTitle) {
			closeDialog();
			ensureStyle();
			const text = strings();

			const dark = isDarkBackground(window.getComputedStyle(document.body).backgroundColor);
			const overlay = document.createElement("div");
			overlay.id = OVERLAY_ID;
			overlay.style.setProperty("--dsd-bg", dark ? "#26272b" : "#ffffff");
			overlay.style.setProperty("--dsd-fg", dark ? "#e8e8ea" : "#1f2023");
			overlay.style.setProperty("--dsd-border", dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)");

			const panel = document.createElement("div");
			panel.className = "dsd-panel";
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-modal", "true");
			panel.setAttribute("aria-label", text.dialogTitle);

			const title = document.createElement("div");
			title.className = "dsd-title";
			title.textContent = text.dialogTitle;

			const description = document.createElement("p");
			description.className = "dsd-desc";
			description.textContent = text.description(displayTitle);

			const hint = document.createElement("p");
			hint.className = "dsd-hint";
			hint.textContent = text.hint;

			const error = document.createElement("div");
			error.className = "dsd-error";
			error.hidden = true;

			const footer = document.createElement("div");
			footer.className = "dsd-footer";

			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.textContent = text.cancel;
			cancel.addEventListener("click", (event) => {
				event.stopPropagation();
				closeDialog();
			});

			const confirm = document.createElement("button");
			confirm.type = "button";
			confirm.dataset.role = "confirm";
			confirm.textContent = text.confirm;
			confirm.addEventListener("click", (event) => {
				event.stopPropagation();
				if (confirm.disabled) return;
				cancel.disabled = true;
				confirm.disabled = true;
				confirm.textContent = text.busy;
				requestDelete(sessionId).then(
					() => {
						// The host half already emitted `api-session/removed`, so the client
						// session manager drops the row by itself; if that was the session on
						// screen, also clear the main view.
						closeDialog();
						leaveDeletedSession(ctx, sessionId);
					},
					(reason) => {
						error.hidden = false;
						error.textContent = reason instanceof Error ? reason.message : String(reason);
						cancel.disabled = false;
						confirm.disabled = false;
						confirm.textContent = text.confirm;
					}
				);
			});

			overlay.addEventListener("click", (event) => {
				event.stopPropagation();
				if (event.target === overlay) closeDialog();
			});
			panel.addEventListener("click", (event) => event.stopPropagation());

			const onKeyDown = (event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					closeDialog();
				}
			};
			overlay.addEventListener("keydown", onKeyDown);

			footer.append(cancel, confirm);
			panel.append(title, description, hint, error, footer);
			overlay.append(panel);
			document.body.append(overlay);
			window.setTimeout(() => confirm.focus(), 0);
		}

		const name = "session-delete";
		const inject = ["contextMenus"];

		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.contextMenus.register({
						id: MENU_ID,
						target: "session",
						order: 700,
						resolve: (target) => {
							const sessionId = target === null || typeof target !== "object" ? void 0 : target.sessionId;
							if (typeof sessionId !== "string" || sessionId === "") return [];
							return [
								{
									id: "delete",
									// Resolved per menu open, so switching the UI language needs no reload.
									label: strings().menuLabel,
									separatorBefore: true,
									afterContent: true,
									danger: true,
									run: () => openDialog(ctx, sessionId, target.displayTitle)
								}
							];
						}
					}),
				"dsh-session-delete: session menu"
			);
		}

		return { apply, inject, name };
	}
});
