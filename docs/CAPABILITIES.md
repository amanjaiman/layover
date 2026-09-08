# Capabilities and evidence

What was actually exercised on this machine (Windows 11, Claude Code 2.1.263, Codex CLI 0.153.4, Layover 0.2.0, 2026-09-08), what was only unit-tested, and what is not claimed. Documentation is not validation; this file only records things that were run.

## Live runs

| Test | Claude Code | Codex |
|---|---|---|
| Hooks fire and reach the app | **Pass.** `SessionStart`, `UserPromptSubmit`, `Stop` observed for a fresh `claude -p` session; a task, a run titled from the prompt, and completion appeared in the app. | **Pass.** `SessionStart`, `UserPromptSubmit`, `Stop` reported `Completed` by `codex exec --dangerously-bypass-hook-trust`; task, run and completion appeared. |
| Agent learns its run id from the hook context line | **Pass.** The model used the exact run id in its `layover item` call. | **Pass.** Same. |
| Skill discovered and invoked | **Pass.** `~/.claude/skills/layover` used from a prompt naming the skill. | **Pass.** `~/.agents/skills/layover` used via `$layover`. Executed through PowerShell inside Codex's Windows sandbox; the CLI read the token and reached the loopback service. |
| Item published before the final reply | **Pass.** One `decision` item. | **Pass.** One `question` item. |
| Completion closes the run | **Pass** (`Stop`, 8 s turn). | **Pass** after making the Stop hook synchronous; with `async: true` Codex exec exited first and `SessionEnd` recorded the run as `cancelled`. |
| Hook command form | Double-quoted path worked; unquoted forward-slash path (current default) works. | Double-quoted path **failed** (`hook: … Failed`): Codex runs hooks in PowerShell Core (verified with a probe printing `$PSVersionTable.PSEdition`). Unquoted path works; paths with spaces get `& '…'`. |
| Hook trust | None needed. | Required once (`/hooks` in Codex). Tests used the bypass flag; the interactive trust flow was **not** exercised. |
| Cost | Hook: ~130 ms per event with the app running (packaged shim on the app's own Node). Context line: ~70 tokens per prompt, switchable off. The `claude -p` test turn cost $0.15 total, dominated by the prompt itself. | Hook latency identical. The Codex turn used 13.7k tokens including skill reading. |

Both agents ran in scratch folders on this machine's own accounts. Each live run was a fresh non-interactive session; attachment to an already-open desktop conversation was not tested here (the `SessionStart` hook fires for `resume` and `startup`, so an open interactive session will register itself on its next prompt).

## Automated (npm test, 22 tests)

- Store: persistence across reopen, duplicate ids, id reuse with different content, immutable run/task identity, delayed start after end, out-of-order end sequence, item revision rules, concurrent runs, hook-turn supersession, voluntary staleness vs hook runs, notification auto-resolve, validation before write, notes revision conflict, Next/response/dismissal persistence, manual workspaces, torn last line tolerance.
- Hook mapping: every event above, `__latest__` resolution, notification filtering, disabling the context line.
- Setup: merge into existing `settings.json` preserving foreign hooks, idempotent reinstall, stale path detection, removal leaving other hooks intact, refusing to overwrite malformed JSON, command quoting.
- Service: token and Origin/Host enforcement, single and batch events, rejection, open routing.

## Focus on turn start (v0.3)

- A turn-start hook with the app running in the tray creates and shows the window; verified with the packaged shim (~195 ms).
- Keyboard focus: with the window merely shown, Windows left focus with the terminal (measured with `GetForegroundWindow`: the Claude Code process kept it). v0.3 therefore attaches thread input to the foreground window and calls `SetForegroundWindow` from a short PowerShell helper, spawned by the app only when it is not already focused. Measured with the installed 0.3.0 build after a turn-start hook: Layover was the **topmost visible window** in the z-order (ahead of Claude, ChatGPT, Windows Terminal, Edge), so the window does come forward. Keyboard focus could not be judged: the desktop was locked, then `ShellExperienceHost` held the foreground for the whole measurement window, which is what Windows reports when nobody is interacting. Remaining human check: send a prompt from a terminal and confirm Layover is in front *and* focused. If it is in front but not focused, the fallback is to have the hook process (a child of the foreground terminal) call `AllowSetForegroundWindow` for Layover's pid before posting the event.

## Manual checks in the app (dev build, screenshots in this session)

Workspace rail with colours and working dot; Now view as per-agent threads with turn dividers, highlighted latest item, inline reply, completion entry with return action; Tickets view (status groups, keys, priority, detail panel with description and prompt draft, Copy prompt) in expanded and compact layouts; onboarding sheet; light and dark themes. Spool ingest on launch (events written while the app was down appeared after it started). Single-instance handoff (`--open` from a second process reaches the running app). PATH added on first launch of the packaged app. Packaged CLI runs without Node installed on PATH.

Not manually exercised end-to-end yet: compact mode window sizing, break reminders over a real interval, Windows toast click-through, notes conflict banner with two windows, the Codex write-back sheet against a live App Server (bridge code is the phase-one implementation, unit-level only here).

## Known limits (honest list)

- **Interrupt detection in Claude Code** is inferred: `Stop` does not fire on Escape, so an interrupted turn stays "working" until the next prompt or session end closes it as *interrupted*. Codex has a real `Interrupt` hook.
- **A crashed agent** leaves a hook-driven run active; Layover shows *No recent signal* only after 6 hours. Voluntary (`layover begin`) runs go to *No recent signal* after 2 minutes of silence, which may simply be thinking.
- **Return to agent** cannot focus another window. It shows the session id and a copyable `claude --resume` / `codex resume` command.
- **Write-back** exists only for a Codex thread explicitly bound to a local App Server endpoint; no Claude write-back. Saved replies are copied by hand.
- **Codex hooks need one-time trust** in the Codex UI; until then Codex runs are invisible (the skill still works if invoked).
- **Unsigned installer**: SmartScreen will warn. Per-user install, no admin.
- **macOS**: not built. The code avoids Windows-only APIs except the `.cmd` shim and the PATH helper.
