/**
 * dsh-session-delete — Host half.
 *
 * Adds "really delete this session" to DSH: the session directory is moved into
 * `<sessions-root>-trash` (never shredded, so it can be restored by hand) and the
 * session is dropped from the workspace bookkeeping, the archived set and the pinned set.
 *
 * Unlike the archive action in the built-in sidebar, deletion also works for a session
 * that is *live* — open in the UI, or with an agent still running. That is the whole
 * point of this plugin, and it is why the order below matters:
 *
 *   1. cancel the agent and wait (bounded) for it to go idle;
 *   2. detach the live entry from the session store → emits `session/disposed`, which is
 *      what makes the persistence backend flush, release its write lease and close the
 *      file handle, and what makes the official session controller broadcast
 *      `api-session/removed` so connected clients drop the row without a page reload;
 *   3. detach the agent entry and dispose its scope;
 *   4. `fs.rename` the directory away, retrying while Windows still reports the handle
 *      as busy (an unclosed handle makes the rename fail with EPERM).
 *
 * Routes (self-prefixed; the browser half calls them directly):
 *   GET  /dsh-session-delete             liveness
 *   GET  /dsh-session-delete/list        session inventory (debugging)
 *   GET  /dsh-session-delete/diag        loaded revision + which internal hooks exist
 *   POST /dsh-session-delete/delete      { sessionId } → { ok, sessionId, title, movedTo, wasLive }
 *
 * No file in app.asar is touched and no typert code generation is involved: every step
 * goes through services DSH already ships (webServer / workspaceRegistry /
 * sessionPersistence / sessions / agents), feature-detected because they are internals.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const name = "dsh-session-delete";
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

const ROUTE = "/dsh-session-delete";
const BODY_LIMIT = 64 * 1024;
/** Bumped per release; `/diag` reports it so you can tell which code the process loaded. */
const REVISION = "0.1.0";

/** Loopback is the only peer allowed to run a destructive POST (remote access proxies in). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	res.end(body);
}

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body is not valid JSON");
	}
}

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Resolve a session's on-disk directory: `<root>/<projectSlug>/<id>/`.
 * The directory name has to be the session id itself, otherwise no directory is reported
 * (better to leave the files alone than to move the wrong folder).
 */
async function locateSession(ctx, sessionId) {
	const snapshots = await ctx.sessionPersistence.list();
	for (const snapshot of snapshots) {
		if (snapshot.header.id !== sessionId) continue;
		const file = snapshot.location?.path;
		if (typeof file !== "string" || file === "") return { snapshot, dir: void 0 };
		const dir = path.dirname(file);
		return { snapshot, dir: path.basename(dir) === sessionId ? dir : void 0 };
	}
	return { snapshot: void 0, dir: void 0 };
}

/** Wait for a promise that may hang; on timeout carry on — cleanup must not block deletion. */
function settle(promise, ms) {
	if (typeof promise?.then !== "function") return Promise.resolve();
	return Promise.race([
		Promise.resolve(promise).catch(() => void 0),
		new Promise((resolve) => setTimeout(resolve, ms).unref?.())
	]);
}

/** SessionStore and AgentRegistry both keep `store: Map<id, entry>` of entered entries. */
function storeOf(service) {
	const store = service?.store;
	return store instanceof Map ? store : void 0;
}

/**
 * Drop the in-process entry the same way the official shutdown path does:
 * `detachEntered()` emits `session/disposed` / `agent/disposed`, which removes the row on
 * the client and closes the persistence write handle (without it a rename on Windows is
 * bound to fail with EPERM).
 * @returns whether a `disposed` event was actually emitted by the store.
 */
function detachEntered(service, id) {
	const store = storeOf(service);
	if (store === void 0) return false;
	const entry = store.get(id);
	if (entry === void 0) return false;
	if (typeof service.detachEntered === "function") {
		try {
			service.detachEntered(entry);
		} catch (error) {
			service.ctx?.logger?.warn?.(`dsh-session-delete: detachEntered failed: ${message(error)}`);
		}
		if (!store.has(id)) return true;
	}
	/* Cross-version fallback: at least drop the entry so it cannot hold the next operation up. */
	store.delete(id);
	return false;
}

/**
 * Make a still-running agent stop: the first half of the official teardown — abort only,
 * never destroy. Stopping before the detach keeps it from writing through a closed handle.
 */
async function stopAgent(agent) {
	try {
		agent.cancel?.({ kind: "disposed" });
	} catch {
		/* already tearing down — fine */
	}
	await settle(agent.whenIdle?.(), 5000);
}

/**
 * Move with retries: the session directory may still hold a handle for a moment (a flush in
 * flight, an indexer scanning), which surfaces as EPERM/EBUSY on Windows. Wait and retry.
 */
async function moveToTrash(from, to) {
	let last;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			last = error;
			const code = error?.code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`session directory is still in use, cannot move it to the trash (${last?.code ?? "unknown"}): ${message(last)}`);
}

async function deleteSession(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("missing sessionId");

	const registry = ctx.workspaceRegistry;
	if (!(await registry.sessionKnown(sessionId))) throw new Error("no such session — it may have been deleted already");

	const { snapshot, dir } = await locateSession(ctx, sessionId);

	// Live sessions (opened, or with a running agent) are deletable too: take them out of the
	// runtime through the official path first so the persistence layer closes its handle,
	// then move the directory into the trash.
	const sessions = ctx.get?.("sessions");
	const agents = ctx.get?.("agents");
	const liveSession = sessions?.get?.(sessionId);
	const liveAgent = agents?.get?.(sessionId);
	let disposedByStore = false;

	const result = await registry.enqueueOperation(async () => {
		// 0) Still alive: make it stop, then drop the runtime entry the official way.
		//    The session detach has to happen after the stop and before the scope dispose —
		//    `session/disposed` is delivered through the agent's carrier, and both the client
		//    row removal and the persistence flush/handle close hang off that event.
		if (liveAgent !== void 0) await stopAgent(liveAgent);
		disposedByStore = detachEntered(sessions, sessionId);
		detachEntered(agents, sessionId);
		await settle(liveAgent?.scope?.dispose?.(), 3000);

		// 1) Bookkeeping: detach from every workspace, clear archived/pinned leftovers.
		for (const entity of registry.list()) {
			if (entity.sessionIds.includes(sessionId)) await entity.detachSession(sessionId);
		}
		const state = registry.requireState();
		const archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
		const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
		if (
			archivedSessionIds.length !== state.archivedSessionIds.length ||
			pinnedSessionIds.length !== state.pinnedSessionIds.length
		) {
			await registry.setState({ ...state, archivedSessionIds, pinnedSessionIds });
		}

		// 2) Move: into `<sessions-root>-trash/<timestamp>__<id>`, restorable by hand.
		let movedTo = null;
		if (dir !== void 0) {
			const root = path.dirname(path.dirname(dir));
			const trashRoot = `${root}-trash`;
			await fs.mkdir(trashRoot, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			movedTo = path.join(trashRoot, `${stamp}__${sessionId}`);
			await moveToTrash(dir, movedTo);
		}

		// 3) Projection cache, best effort: entries are bound to a log identity, a leftover
		//    row can never resurrect the session.
		try {
			await ctx.get?.("sessionProjectionCache")?.table?.delete?.(sessionId);
		} catch {
			/* purely derived data — failing to drop it changes nothing */
		}

		ctx.logger?.info?.(
			`dsh-session-delete: deleted session ${sessionId} (${liveSession !== void 0 || liveAgent !== void 0 ? "live" : "idle"}) → ${movedTo ?? "(no file on disk)"}`
		);
		return {
			ok: true,
			sessionId,
			title: snapshot?.header?.title ?? null,
			movedTo,
			wasLive: liveSession !== void 0 || liveAgent !== void 0
		};
	});

	// 4) Broadcast: this is the channel the official delete uses
	//    (`session/disposed` → `api-session/removed`). Going through detachEntered already
	//    emitted it, and emitting twice makes the client record two removals — so only send
	//    a synthetic one when the store did not.
	if (!disposedByStore) ctx.emit("api-session/removed", sessionId);
	return result;
}

async function listSessions(ctx) {
	const snapshots = await ctx.sessionPersistence.list();
	const registry = ctx.workspaceRegistry;
	const state = registry.requireState();
	const workspaceOf = new Map();
	for (const entity of registry.list()) for (const id of entity.sessionIds) workspaceOf.set(id, entity.path);
	const archived = new Set(state.archivedSessionIds);
	const pinned = new Set(state.pinnedSessionIds);
	return snapshots.map((snapshot) => ({
		id: snapshot.header.id,
		title: snapshot.header.title ?? null,
		cwd: snapshot.header.cwd ?? null,
		sizeBytes: snapshot.sizeBytes,
		workspace: workspaceOf.get(snapshot.header.id) ?? null,
		archived: archived.has(snapshot.header.id),
		pinned: pinned.has(snapshot.header.id),
		path: snapshot.location?.path ?? null
	}));
}

/** Reject destructive requests that cannot have come from this machine's own UI. */
function checkOrigin(req) {
	const peer = req.socket?.remoteAddress;
	if (typeof peer === "string" && peer !== "" && !LOOPBACK.has(peer)) return "only local requests are allowed";
	const origin = req.headers?.origin;
	const host = req.headers?.host;
	if (typeof origin === "string" && origin !== "" && (typeof host !== "string" || !origin.endsWith(`//${host}`))) {
		return "cross-origin request rejected";
	}
	return void 0;
}

export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE,
				handler: async (req, res) => {
					const action = new URL(req.url ?? "/", "http://localhost").pathname
						.slice(ROUTE.length)
						.replace(/^\/+/, "")
						.replace(/\/+$/, "");
					try {
						if (req.method === "GET" && action === "") {
							return sendJson(res, 200, { ok: true, service: "dsh-session-delete", revision: REVISION });
						}
						if (req.method === "GET" && action === "list") {
							return sendJson(res, 200, { ok: true, sessions: await listSessions(ctx) });
						}
						if (req.method === "GET" && action === "diag") {
							const clientModules = ctx.get?.("clientModules");
							const graph = clientModules?.graph?.();
							const sessions = ctx.get?.("sessions");
							const agents = ctx.get?.("agents");
							return sendJson(res, 200, {
								ok: true,
								revision: REVISION,
								registered: clientModules !== undefined,
								table: clientModules?.table === undefined ? null : [...clientModules.table.keys()],
								entries: graph?.entries?.map((entry) => ({
									id: entry.id,
									rev: entry.rev,
									url: entry.url,
									inject: entry.inject ?? null
								})) ?? null,
								batches: graph?.batches?.map((batch) => ({ phase: batch.phase, url: batch.url })) ?? null,
								// Runtime inventory: exactly the ids that used to be blocked by
								// "this session is in use".
								live: {
									sessions: [...(storeOf(sessions)?.keys() ?? [])],
									agents: [...(storeOf(agents)?.keys() ?? [])]
								},
								supports: {
									sessionsDetachEntered: typeof sessions?.detachEntered === "function",
									agentsDetachEntered: typeof agents?.detachEntered === "function"
								}
							});
						}
						if (req.method !== "POST") {
							return sendJson(res, 405, { ok: false, error: `unsupported method ${req.method}` });
						}
						const denied = checkOrigin(req);
						if (denied !== void 0) return sendJson(res, 403, { ok: false, error: denied });

						const body = await readJson(req);
						if (action === "delete") {
							return sendJson(res, 200, await deleteSession(ctx, body.sessionId));
						}
						return sendJson(res, 404, { ok: false, error: `unknown action ${action}` });
					} catch (error) {
						ctx.logger?.warn?.(`dsh-session-delete: ${action || "(root)"} failed: ${message(error)}`);
						return sendJson(res, 200, { ok: false, error: message(error) });
					}
				}
			}),
		"dsh-session-delete: routes"
	);
}
