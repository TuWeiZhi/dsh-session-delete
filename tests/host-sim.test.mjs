/**
 * Host-simulation tests for the delete sequence.
 *
 * There is no real DSH process here: `ctx` is a hand-written fake that mirrors only the
 * shapes the host half touches (webServer.register / workspaceRegistry.queue / SessionStore
 * and AgentRegistry `store` + `detachEntered` / sessionPersistence.list). That is exactly the
 * point — these tests pin the *order* of the shutdown sequence and the "exactly one removal
 * broadcast" rule, which are the two things a DSH internal change or a careless refactor
 * would silently break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, name as pluginName, inject } from "../lib/index.js";

// ------------------------------------------------------------------ fake host ----

/**
 * Build a fake DSH host.
 * @param {object} options
 * @param {object[]} options.sessions snapshots: `{ id, title?, file? }`
 * @param {string[]} [options.liveSessions] ids present in the live session store
 * @param {string[]} [options.liveAgents] ids present in the live agent registry
 */
async function makeHost({ sessions: sessionSpecs = [], liveSessions = [], liveAgents = [], archived = [], pinned = [] }) {
	const base = await mkdtemp(path.join(tmpdir(), "dsd-"));
	const sessionsRoot = path.join(base, "sessions");
	const snapshots = [];
	for (const spec of sessionSpecs) {
		const dir = path.join(sessionsRoot, "slug", spec.id);
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${spec.id}.jsonl`);
		await writeFile(file, '{"type":"session.start"}\n', "utf8");
		snapshots.push({
			header: { id: spec.id, title: spec.title ?? null, cwd: base },
			location: { path: file },
			sizeBytes: 23
		});
	}

	const calls = [];
	const emitted = [];
	const warnings = [];
	let state = { archivedSessionIds: [...archived], pinnedSessionIds: [...pinned], workspaces: [] };

	const sessionStore = new Map(liveSessions.map((id) => [id, { id, session: { id } }]));
	const agentStore = new Map(liveAgents.map((id) => [id, { id, agent: { id } }]));

	const sessions = {
		store: sessionStore,
		get: (id) => sessionStore.get(id)?.session,
		detachEntered(entry) {
			calls.push(`sessions.detachEntered:${entry.id}`);
			sessionStore.delete(entry.id);
			// The real store emits `session/disposed` here; the fake records it as the effect
			// that closes the persistence handle (see the rename in the assertions).
			onDisposed(entry.id);
		}
	};
	/** Called whenever the fake session store emits `session/disposed`. */
	function onDisposed(id) {
		calls.push(`disposed:${id}`);
	}

	const agents = {
		store: agentStore,
		get: (id) => agentStore.get(id)?.agent,
		detachEntered(entry) {
			calls.push(`agents.detachEntered:${entry.id}`);
			agentStore.delete(entry.id);
		}
	};

	const registry = {
		async sessionKnown(id) {
			return snapshots.some((snapshot) => snapshot.header.id === id);
		},
		async enqueueOperation(operation) {
			calls.push("enqueueOperation");
			return await operation();
		},
		list() {
			return [];
		},
		requireState() {
			return { ...state };
		},
		async setState(next) {
			calls.push("setState");
			state = { ...next };
		}
	};

	const services = {
		sessions,
		agents,
		sessionPersistence: { list: async () => snapshots },
		sessionProjectionCache: {
			table: {
				deleted: [],
				async delete(id) {
					this.deleted.push(id);
					calls.push(`projection.delete:${id}`);
				}
			}
		}
	};

	let handler;
	const ctx = {
		effect(fn) {
			const result = fn();
			return typeof result === "function" ? result : () => void 0;
		},
		webServer: {
			register(route) {
				handler = route.handler;
				calls.push(`route:${route.kind}:${route.path}`);
				return () => void 0;
			}
		},
		workspaceRegistry: registry,
		sessionPersistence: services.sessionPersistence,
		get: (service) => services[service],
		emit: (event, id) => emitted.push({ event, id }),
		logger: {
			info: () => void 0,
			warn: (message) => warnings.push(message)
		}
	};

	// Live agents get the two members the shutdown path uses.
	for (const id of liveAgents) {
		const agent = agentStore.get(id).agent;
		agent.cancel = (cause) => calls.push(`cancel:${id}:${cause.kind}`);
		agent.whenIdle = async () => {
			calls.push(`whenIdle:${id}`);
		};
		agent.scope = {
			dispose: async () => {
				calls.push(`scope.dispose:${id}`);
			}
		};
	}

	return {
		base,
		sessionsRoot,
		trashRoot: `${sessionsRoot}-trash`,
		snapshots,
		services,
		calls,
		emitted,
		warnings,
		state: () => state,
		handler: () => handler,
		ctx
	};
}

/** Minimal IncomingMessage stand-in. */
function makeRequest({ method, url, body, headers = {}, remoteAddress = "127.0.0.1" }) {
	const payload = body === void 0 ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	return {
		method,
		url,
		headers,
		socket: { remoteAddress },
		async *[Symbol.asyncIterator]() {
			for (const chunk of payload) yield chunk;
		}
	};
}

/** Minimal ServerResponse stand-in that records what was written. */
function makeResponse() {
	const chunks = [];
	return {
		statusCode: void 0,
		headers: void 0,
		body: () => Buffer.concat(chunks).toString("utf8"),
		json() {
			return JSON.parse(this.body());
		},
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
		},
		end(chunk) {
			if (chunk !== void 0) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		}
	};
}

async function call(host, request) {
	const response = makeResponse();
	await host.handler()(makeRequest(request), response);
	return response;
}

const deleteCall = (sessionId, extra = {}) =>
	call(
		extra.host,
		{
			method: "POST",
			url: "/dsh-session-delete/delete",
			body: { sessionId },
			headers: { host: "127.0.0.1:3593", ...extra.headers },
			remoteAddress: extra.remoteAddress
		}
	);

// --------------------------------------------------------------------- shape ----

test("plugin declares the exact services the delete sequence needs", () => {
	assert.equal(pluginName, "dsh-session-delete");
	assert.deepEqual(inject, ["webServer", "workspaceRegistry", "sessionPersistence"]);
});

test("apply() registers one prefixed route under /dsh-session-delete", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);
	assert.deepEqual(host.calls.filter((entry) => entry.startsWith("route:")), ["route:prefix:/dsh-session-delete"]);
});

// ----------------------------------------------------------------- live delete ----

test("deleting a live session stops it, detaches both registries, then moves the directory", async () => {
	const host = await makeHost({
		sessions: [{ id: "session-live", title: "Live one" }],
		liveSessions: ["session-live"],
		liveAgents: ["session-live"]
	});
	apply(host.ctx);

	const response = await deleteCall("session-live", { host });
	const payload = response.json();

	assert.equal(response.statusCode, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.sessionId, "session-live");
	assert.equal(payload.title, "Live one");
	assert.equal(payload.wasLive, true);

	// Order matters: stop → detach session (closes the handle) → detach agent → dispose scope.
	const ordered = host.calls.filter((entry) => !entry.startsWith("route:"));
	const cancelAt = ordered.indexOf("cancel:session-live:disposed");
	const whenIdleAt = ordered.indexOf("whenIdle:session-live");
	const detachSessionAt = ordered.indexOf("sessions.detachEntered:session-live");
	const detachAgentAt = ordered.indexOf("agents.detachEntered:session-live");
	const disposeAt = ordered.indexOf("scope.dispose:session-live");
	assert.ok(cancelAt >= 0, "agent must be cancelled");
	assert.ok(whenIdleAt > cancelAt, "must wait for idle after cancelling");
	assert.ok(detachSessionAt > whenIdleAt, "session detach must come after the agent stopped");
	assert.ok(detachAgentAt > detachSessionAt, "agent detach must come after the session detach");
	assert.ok(disposeAt > detachAgentAt, "scope dispose must come last");
	assert.ok(ordered.indexOf(`projection.delete:session-live`) > disposeAt, "cache cleanup after the shutdown");

	// No synthetic broadcast: the store's `session/disposed` already reached the client.
	assert.deepEqual(host.emitted, []);

	// The directory really left `sessions/` and landed in `sessions-trash/`.
	const moved = await readdir(host.trashRoot);
	assert.equal(moved.length, 1);
	assert.ok(moved[0].endsWith("__session-live"), `trashed name keeps the id: ${moved[0]}`);
	await assert.rejects(() => stat(path.join(host.sessionsRoot, "slug", "session-live")));
	assert.equal(payload.movedTo, path.join(host.trashRoot, moved[0]));
});

// ---------------------------------------------------------------- idle delete ----

test("deleting an idle session still moves the directory and broadcasts exactly one removal", async () => {
	const host = await makeHost({ sessions: [{ id: "session-idle" }] });
	apply(host.ctx);

	const payload = (await deleteCall("session-idle", { host })).json();

	assert.equal(payload.ok, true);
	assert.equal(payload.wasLive, false);
	assert.equal((await readdir(host.trashRoot)).length, 1);

	// Nothing lived in the store, so the plugin must broadcast the removal itself — once.
	assert.deepEqual(host.emitted, [{ event: "api-session/removed", id: "session-idle" }]);
	assert.equal(host.calls.some((entry) => entry.startsWith("cancel:")), false, "no agent to cancel");
});

test("archived/pinned bookkeeping rows are dropped for the deleted session", async () => {
	const host = await makeHost({
		sessions: [{ id: "session-archived" }],
		archived: ["session-archived", "session-keep"],
		pinned: ["session-archived"]
	});
	apply(host.ctx);

	await deleteCall("session-archived", { host });

	const state = host.state();
	assert.deepEqual(state.archivedSessionIds, ["session-keep"]);
	assert.deepEqual(state.pinnedSessionIds, []);
});

// --------------------------------------------------------------- error paths ----

test("an unknown session is refused without touching the filesystem", async () => {
	const host = await makeHost({ sessions: [{ id: "session-known" }] });
	apply(host.ctx);

	const payload = (await deleteCall("session-nope", { host })).json();

	assert.equal(payload.ok, false);
	assert.match(payload.error, /no such session/);
	assert.equal(host.calls.some((entry) => entry.startsWith("sessions.detachEntered")), false);
	assert.equal(host.calls.includes("enqueueOperation"), false, "must fail before entering the operation queue");
	await assert.rejects(() => readdir(host.trashRoot));
});

test("a missing sessionId is rejected", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);

	const payload = (await deleteCall(void 0, { host })).json();
	assert.equal(payload.ok, false);
	assert.match(payload.error, /missing sessionId/);
});

test("destructive POSTs from a foreign origin are rejected", async () => {
	const host = await makeHost({ sessions: [{ id: "session-csrf" }] });
	apply(host.ctx);

	const response = await deleteCall("session-csrf", { host, headers: { origin: "https://evil.example" } });

	assert.equal(response.statusCode, 403);
	assert.equal(response.json().ok, false);
	await assert.rejects(() => readdir(host.trashRoot));
	assert.equal(host.calls.includes("enqueueOperation"), false);
});

test("destructive POSTs from a non-loopback peer are rejected", async () => {
	const host = await makeHost({ sessions: [{ id: "session-lan" }] });
	apply(host.ctx);

	const response = await deleteCall("session-lan", { host, remoteAddress: "192.168.1.20" });

	assert.equal(response.statusCode, 403);
	await assert.rejects(() => readdir(host.trashRoot));
});

// ----------------------------------------------------------------- inventory ----

test("GET /list reports every session with its workspace flags", async () => {
	const host = await makeHost({
		sessions: [
			{ id: "session-a", title: "A" },
			{ id: "session-b", title: "B" }
		],
		archived: ["session-b"],
		pinned: ["session-a"]
	});
	apply(host.ctx);

	const response = await call(host, { method: "GET", url: "/dsh-session-delete/list" });
	const payload = response.json();

	assert.equal(response.statusCode, 200);
	assert.deepEqual(
		payload.sessions.map((session) => [session.id, session.archived, session.pinned]),
		[
			["session-a", false, true],
			["session-b", true, false]
		]
	);
});

test("GET /diag reports the revision and which internal hooks this build exposes", async () => {
	const host = await makeHost({ sessions: [], liveSessions: ["session-x"], liveAgents: ["session-y"] });
	apply(host.ctx);

	const payload = (await call(host, { method: "GET", url: "/dsh-session-delete/diag" })).json();

	assert.equal(payload.ok, true);
	assert.equal(payload.revision, "0.1.0");
	assert.deepEqual(payload.supports, { sessionsDetachEntered: true, agentsDetachEntered: true });
	assert.deepEqual(payload.live, { sessions: ["session-x"], agents: ["session-y"] });
});

test("GET / is a liveness probe and unsupported methods get 405", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);

	const root = (await call(host, { method: "GET", url: "/dsh-session-delete" })).json();
	assert.equal(root.service, "dsh-session-delete");

	const put = await call(host, { method: "PUT", url: "/dsh-session-delete/delete" });
	assert.equal(put.statusCode, 405);
});

// ------------------------------------------------------- degraded DSH builds ----

test("a DSH without detachEntered still deletes and still broadcasts once", async () => {
	const host = await makeHost({ sessions: [{ id: "session-old" }], liveSessions: ["session-old"] });
	// Simulate an older build: the store exists but has no detachEntered.
	host.services.sessions.detachEntered = void 0;
	apply(host.ctx);

	const payload = (await deleteCall("session-old", { host })).json();

	assert.equal(payload.ok, true);
	assert.equal((await readdir(host.trashRoot)).length, 1);
	assert.deepEqual(host.emitted, [{ event: "api-session/removed", id: "session-old" }]);
	assert.equal(host.services.sessions.store.has("session-old"), false, "the fallback must still drop the entry");
});

test.after(async () => {
	// Temp dirs are per-test; nothing global to tear down. Kept as a hook in case a shared
	// fixture is added later.
	await rm(path.join(tmpdir(), "dsd-nonexistent"), { recursive: true, force: true });
});
