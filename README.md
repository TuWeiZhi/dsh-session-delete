# dsh-session-delete

> Actually delete a DeepSeek Harness session — **including the one you are looking at right now**.

Right-click a session in the sidebar → **Delete session**. No "this session is in use"
refusal, no full page reload, no ghost row left behind.

[中文说明](./README.zh.md)

---

## Why this plugin exists

DeepSeek Harness stores every session as its own directory on disk
(`<DSH_HOME>/sessions/<session-id>/`). The built-in sidebar can *archive* a session
(hide it from the list), but there was no way to **remove** one:

- Deleting the directory by hand fails on Windows while DSH still holds a write
  handle into it (`EPERM`), and on every platform the sidebar keeps showing the row
  until the whole page is reloaded.
- A session you merely *opened once* stays resident in the DSH process, so the
  "switch to another session first" workaround does not help — switching only
  changes which session the UI focuses.

This plugin does the shutdown sequence in the right order and then moves the
directory away.

## What it does

- **Deletes live sessions too.** The session is stopped (`cancel` + wait for idle),
  detached from the in-process session/agent registries — which is what makes the
  persistence layer flush and release its file handles — and only then moved on disk.
- **Never reloads the page.** The host half emits the official
  `api-session/removed` event, so the sidebar row disappears reactively.
- **Clears the main view.** If you deleted the session that is currently open, the
  workspace falls back to the empty "no session" state instead of pointing at a
  corpse.
- **Recoverable.** The directory is moved to `<DSH_HOME>/sessions-trash/<timestamp>__<session-id>`,
  not shredded. Move it back by hand to restore.
- **Retries the move.** On Windows an antivirus or indexer can hold the directory for
  a moment; the move is retried (~6 s) and reports the offending error code if it
  still fails.

## Install

From the DSH **Plugins** page, add `@tuweizhi/dsh-session-delete` — or from a shell:

```bash
dsh plugin --profile <profile-name> add @tuweizhi/dsh-session-delete
```

Installing is not retroactive: the **host half needs a DSH restart** (or a plugin
toggle in the Plugins page) because it registers an HTTP route and event listeners
in-process. The **browser half** loads with the next page load.

## Usage

1. Right-click any session in the sidebar — running, open, or idle.
2. Choose **Delete session**.
3. Confirm. The row disappears immediately; the directory is moved to `sessions-trash`.

There is no undo in the UI. To bring a session back, quit DSH and move its directory
out of `sessions-trash` back under `sessions/`:

```bash
# example (paths are yours)
mv "<DSH_HOME>/sessions-trash/2026-11-11T12-00-00-000Z__session-abc" "<DSH_HOME>/sessions/session-abc"
```

## How it works

The host half ([`lib/index.js`](./lib/index.js)) registers a small HTTP surface under
`/dsh-session-delete` (`list`, `diag`, `delete`) and runs this sequence inside the
workspace registry's operation queue:

1. If the session has a live agent, `agent.cancel({ kind: "disposed" })` and wait for
   `whenIdle()` (bounded wait).
2. `sessions.detachEntered(entry)` — removes it from the live session store and emits
   `session/disposed`. That single event is what makes DSH's JSONL persistence backend
   flush, release its write lease and close the file handle, and what makes the official
   session controller broadcast `api-session/removed` to every connected client.
3. `agents.detachEntered(entry)` and a bounded `scope.dispose()` to release the agent's
   own context.
4. Drop the session from the workspace bookkeeping (archived/pinned lists).
5. `fs.rename` the directory into `sessions-trash`, retrying on `EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`.
6. Clear the session's projection-cache row (best effort).

A fallback `ctx.emit("api-session/removed", id)` fires only when step 2 could not run,
so clients never receive a duplicate removal.

The browser half ([`lib/client.js`](./lib/client.js)) adds the context-menu item, the
confirmation dialog, and — after a successful delete — calls `uiWorkspace.clearMain()`
if the deleted session was the focused one.

`GET /dsh-session-delete/diag` reports the loaded revision plus which internal hooks
(`detachEntered` on sessions/agents, etc.) the running build actually exposes. If a
future DSH version renames something, `/diag` is the first place to look.

## Requirements

- DSH `>= 0.2.1-alpha.1` (developed and verified against `0.2.2-rc.1`), Node.js `>= 22.19.0`.
- The plugin touches internal services (`sessions`, `agents`, `workspaceRegistry`,
  `sessionPersistence`). Every call is feature-detected, but a DSH release that
  changes those internals can degrade the plugin — check `/diag` after upgrading DSH.

## Development

```bash
npm run check   # file/manifest self-check + host-simulation tests
```

- `scripts/verify.mjs` — manifest, bundle patch, icon budget, locale JSON, absolute-path
  and `node --check` hygiene checks.
- `tests/*.test.mjs` — spins up a fake DSH host (registries, persistence, web server)
  and asserts the delete sequence: live vs. idle session, single `api-session/removed`,
  directory landing in `sessions-trash`, and error paths.

## License

MIT © 2026 TuWeiZhi
