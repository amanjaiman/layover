# Architecture

Layover is three pieces that share one event contract. The UI never talks to an agent directly, and no piece ever calls a model.

```
 Claude Code / Codex ──hooks──▶ layover.cmd hook <agent> ──HTTP──▶ ┌───────────────────────┐
                     ──skill──▶ layover item / begin / end ──HTTP──▶ │  Layover.exe (main)    │
                                                                    │  store.js  service.js  │◀──IPC──▶ renderer (Now · Next · Notes · Break)
                                                                    │  bridge.js settings.js │
                                                                    └───────────────────────┘
                                                                     %LOCALAPPDATA%\Layover\data\{events.jsonl,user.json}
```

## Pieces

| Path | Role | Runtime |
|---|---|---|
| `src/main/main.js` | Electron main: single instance, window, tray, notifications, IPC, spool ingest, PATH setup | Electron |
| `src/main/service.js` | Loopback HTTP on `127.0.0.1:43137`, bearer token, Host/Origin checks | Electron main |
| `src/main/store.js` | Append-only event log (fsync per event) + atomic user document; derived state | plain Node |
| `src/main/settings.js` | App settings, defaults, validation | plain Node |
| `src/main/bridge.js`, `codex-rpc.js` | Optional Codex write-back (ported from phase one) | plain Node |
| `src/main/updates.js` | Release check against GitHub and the hand-off to the install script | plain Node |
| `src/cli/layover.js` | The `layover` command | Node, or `Layover.exe` with `ELECTRON_RUN_AS_NODE` |
| `src/cli/hook.js` | Pure mapping from hook JSON to events | plain Node |
| `src/cli/setup.js` | Installs skill + hooks, merges into agent config, PATH helper | plain Node |
| `src/cli/client.js` | HTTP client, app launcher, spool fallback | plain Node |
| `src/renderer/*` | The app UI; vanilla JS, foundations tokens | Chromium, sandboxed, no Node |
| `skills/layover/SKILL.md` | The agent skill; `__CLI__` is resolved at install | text |
| `bin/layover.cmd` | Shim: runs the CLI on the app's Node in a packaged install, on `node` in a checkout | cmd |

Packaged layout, Windows: `<install>\Layover.exe`, `<install>\bin\layover.cmd` (+ `layover-fast.cmd`), `<install>\resources\src\**` (unpacked copy of the CLI and its imports), `<install>\resources\skills\layover\SKILL.md`, `<install>\resources\app.asar` (the app). macOS: `Layover.app/Contents/MacOS/Layover`, `Contents/bin/layover` (+ `layover-fast`), `Contents/Resources/src/**`, `Contents/Resources/skills/**`, `Contents/Resources/app.asar`. The CLI finds the app as `../../../MacOS/Layover` or `../../../Layover.exe` from its own folder; the app finds the CLI as `<resourcesPath>/../bin/`. Data lives in `%LOCALAPPDATA%\Layover` or `~/Library/Application Support/Layover`. Installers: `scripts/install.ps1` and `scripts/install.sh` download the latest GitHub release built by `.github/workflows/release.yml` (NSIS on a Windows runner; zip and dmg on a macOS runner, since electron-builder refuses to package macOS elsewhere).

## Identity

- **project**: `p_` + sha1 of the canonical folder path (lower-cased, forward slashes). Same folder, same workspace, for every agent. Manual workspaces get `m_…`.
- **task**: `<agent>:<session id>`, one per conversation.
- **run**: `<task>:<prompt or turn id>`, one per period of execution.

Human-readable names travel with events (`projectName`, `title`) and are shown; ids are never shown unless the user asks how to return.

## Event contract

`POST /api/events` (one) or `/api/events/batch` (≤50). Every event: `id`, `type`, `project`, `task`, `agent` (`claude|codex|test`), plus `run` and integer `seq` for everything except `session`.

| type | fields | semantics |
|---|---|---|
| `session` | `name`, `source`, `sessionId`, `projectName`, `projectPath` | registers the conversation; idempotent upsert |
| `start` | `title`, `source`, `lifecycle` (`hooks|voluntary|wrapper`) | creates the run; a hook-driven start closes any still-active hook-driven run of the same task as `cancelled` |
| `heartbeat` | | refreshes `lastSeen` (voluntary runs only need it) |
| `item` | `item`, `kind` (`suggestion|decision|question|opportunity`), `status` (`open|resolved|dismissed`), `revision` ≥ 1, `text` ≤ 12k, `title`, `waiting`, `origin` (`agent|notification`) | higher revision wins; same revision with different content is rejected |
| `end` | `status` (`completed|failed|cancelled|unknown`), `note` | higher `seq` wins; a delayed `start` never reopens |

Rules the store enforces: an `id` used twice must carry identical JSON (retries are free, reuse is an error); project/task/agent of a run never change; a task's project/agent never change. Statuses are computed at read time: a voluntary run with no event for 2 minutes shows `disconnected` ("no recent signal", not failure); a hook-driven run does so after 6 hours. A notification item resolves itself when its run ends.

User content (notes, tickets, responses to items, dismissals, place) lives in `user.json` and is never sent anywhere. Tickets carry `number` (per-workspace counter), `status` (`backlog|todo|progress|done|cancelled`), `priority` (0–4), `description` and a `prompt` draft; the displayed key is the workspace prefix plus the number. Phase-two "Next" entries migrate to tickets on first load. Notes use optimistic revisions: a stale save returns a conflict and the UI keeps both texts.

## Hook mapping

| Hook | Claude Code | Codex | Layover |
|---|---|---|---|
| `SessionStart` | ✓ | ✓ | `session` |
| `UserPromptSubmit` | ✓ | ✓ | `start` (`lifecycle: hooks`, title = first line of the prompt); prints the run id as context |
| `Stop` | ✓ | ✓ | `end completed` |
| `StopFailure` | ✓ | | `end failed` |
| `Interrupt` | | ✓ | `end cancelled` |
| `SessionEnd` | ✓ | ✓ | `end cancelled` for any still-active run (only if one exists) |
| `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`) | ✓ | | `item` with `waiting: true`, origin `notification` |

Claude's `Stop` does not fire on a user interrupt (documented); the next prompt's `start` closes the orphaned run as `cancelled`, and a session that ends without a `Stop` does the same through `SessionEnd`.

Hooks call `layover.cmd hook <agent>`, which reads JSON from stdin, maps it, checks the app (`/health`), launches `Layover.exe --background` (or `--open` when the setting says so) if needed, and posts. If the app cannot be started, events are written to `data/spool/` and ingested on the next launch. Measured cost on this machine: ~130 ms per hook with the app running.

## Opening and focus

- `layover open` and an explicit `--open` launch route to the workspace and bring the window forward (an explicit request is allowed to take focus).
- A hook-driven `start` follows the setting *When an agent starts a turn*: **Bring Layover forward** (default; the window is briefly pinned on top while shown and focused, because Windows refuses foreground changes from background processes), **Open behind my work** (show inactive), **Only if already open**, **Stay quiet**. Items and `end` events never move the window.
- The renderer switches workspaces on its own only when the user is not engaged (no keystroke or click in the last few seconds, no cursor in an editor). Otherwise it offers a switch in a toast that stays until answered.
- Completion shows a banner in that workspace and, if Layover is not the foreground window, a silent Windows toast. Neither changes the selected workspace.

## Updates

Layover does not update itself. Every few hours (and on demand from Preferences) the main process asks `api.github.com` for the latest release of the repo; that is the only request the app makes off the machine, and the switch in Preferences turns it off. A newer release shows as a rail button, a one-time toast, a tray menu entry and the Updates block in Preferences. **Install and restart** runs the same script a fresh install uses, pinned to the new release's tag (`scripts/install.ps1` or `install.sh` with `LAYOVER_VERSION`); that script stops Layover, replaces it, reconnects the agent hooks and reopens it. On Windows the script is started through WMI (`Win32_Process.Create`) because every child of Layover dies with it (Chromium keeps its tree in a job object) and the script has to stop Layover; on macOS a detached `sh` is enough. Output goes to `update.log` in the data root. Proper in-app auto-update (electron-updater) is off the table while the macOS build is unsigned: Squirrel refuses unsigned updates.

## Security boundaries

Loopback only; a random bearer token in `%LOCALAPPDATA%\Layover\token`; requests with an `Origin` header or a foreign `Host` are refused. The renderer is sandboxed with context isolation, a strict CSP, and no Node access; agent text is inserted with `textContent` only. This protects the browser boundary, not against another process running as the same user.

## Phase-one carry-over

Kept: event ids, immutable routing, revision rules, `seq`-ordered terminal state, presence-free open requests, the Codex App Server write-back bridge and its receipt/ack flow. Replaced: SQLite with JSONL + atomic JSON (no native module, identical guarantees for an append-only log); the browser inspector with the Electron app; the process wrapper with agent hooks (the wrapper's `COMPANION_CONTEXT` idea survives as the hook context line).
