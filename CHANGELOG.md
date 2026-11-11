# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-11

First public release. Distilled from a local profile plugin that had been running
against DSH `0.2.2-rc.1`.

### Added

- **Delete session** action on the sidebar context menu, with a confirmation dialog.
- Real deletion of **live** sessions: the agent is cancelled and awaited, the session is
  detached from the in-process session and agent registries (which lets the persistence
  layer flush, release its write lease and close its file handle), then the directory is
  moved to `<DSH_HOME>/sessions-trash/<timestamp>__<session-id>`.
- Reactive list update through the official `api-session/removed` event — no page reload.
- Main view falls back to the empty state when the deleted session was the focused one.
- Retrying directory move for Windows handle contention (`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`),
  with the concrete error code surfaced when retries are exhausted.
- `GET /dsh-session-delete/diag` reporting the loaded revision, live session/agent ids and
  which internal hooks the running DSH build exposes.
- `npm run check`: manifest/bundle/icon/locale self-check plus host-simulation tests for the
  delete sequence (live and idle sessions, single removal event, trash landing, error paths).

### Notes

- The host half registers an HTTP route in-process, so installing or replacing the plugin
  requires a DSH restart (or a plugin disable/enable toggle) to take effect.
- Removal is not shredded: the directory is moved, so a session can be restored by hand.
