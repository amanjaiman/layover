# Layover

A calm companion for the time in between. When Claude Code or Codex starts working in a folder, Layover opens that workspace beside you: a notebook for the project, a place for the things the agent wants you to know, a list of what you'll do next, and a break when you want one. When the agent finishes, Layover tells you and stays out of the way.

Layover makes **no model calls**. It runs entirely on your machine: an Electron desktop app that hosts a loopback service, a tiny CLI that agents call, and lifecycle hooks that report start and finish without asking the model to remember anything.

Windows is the first platform. macOS is next; nothing in `src/` is Windows-only except the `.cmd` shim and the PATH helper.

## Install (Windows)

1. Run `release/Layover-Setup-<version>.exe` (per-user, no admin). It installs to `%LOCALAPPDATA%\Programs\layover`, adds a Start Menu entry, and on first launch puts `layover` on your user PATH.
2. Layover opens. Click **Connect** for Claude Code and/or Codex. That writes:
   - the `layover` skill to `~/.claude/skills/layover/` and `~/.agents/skills/layover/`
   - lifecycle hooks to `~/.claude/settings.json` and `~/.codex/hooks.json` (merged; nothing else touched)
3. Codex asks you to trust new hooks once: type `/hooks` inside Codex and approve the Layover entries. Claude Code needs nothing more.
4. Start an agent in any project folder. Layover opens that workspace.

Everything the buttons do is also a command: `layover setup --agent all`, `layover setup --agent claude --remove`, `layover status`.

Uninstall from Windows Settings, or run `Uninstall Layover.exe`. Your data in `%LOCALAPPDATA%\Layover` is kept unless you delete it. Disconnect agents first (`layover setup --remove`) if you want the hooks gone.

## What you see

- **Workspaces** (left rail): one per project folder, with a colour, a name, and a dot that breathes marigold while an agent works. Switching never loses your place or your unfinished writing.
- **Now**: one thread per agent conversation, Slack-style. The header shows the agent, what it is working on, and its status (working, waiting on you, finished, interrupted, no signal). The timeline shows each turn and the *Decisions*, *Input requested*, *Opportunities* and *Think ahead* items the agent left inside it, newest at the bottom, with the latest open item highlighted. A "Waiting on you" chip only appears when the agent is actually stopped on it (a permission prompt, or an item it marked `--waiting`). Reply inline (saved locally, never sent by itself), make a ticket from an item, copy it for the agent, or dismiss it. When a turn finishes, the thread ends with *Ready when you are* and a return action; nothing else moves.
- **Tickets**: a Linear-style tracker for what comes next. Status groups (In progress, Todo, Backlog, Done, Cancelled), keys like `LAY-12`, priority, a description, and a **prompt draft attached to each ticket**. *Copy prompt* packages title, description and draft for the agent. `Ctrl+N` creates one; the prefix is editable in Settings.
- **Notes**: the project's running notes. Autosaved, with conflict protection.
- **Break**: stretch prompts, a timer, and optional reminders (suggest, or enter the break automatically once you stop typing).
- **Return to the agent**: shows the session and a copyable resume command; Layover never pretends it can focus another window.
- **Compact companion**: the same app at 400×580, floating, with a workspace picker and short labels. `Ctrl+Shift+C`.
- **Keyboard**: `n` new ticket, `r` reply to the latest item, `j`/`k` move between tickets, `e` edit, `Esc` close, `[` collapse the sidebar, `?` the full list. `Ctrl+1…4` switch views.

The design audit that drove 0.3.1, with the open questions, is in [docs/DESIGN-AUDIT.md](docs/DESIGN-AUDIT.md).

**Focus.** The start of a turn is the one moment Layover comes forward (you just pressed Enter and are waiting). Items and completions never move the window, and a switch to another workspace is offered rather than forced while you're typing. Settings → *When an agent starts a turn* offers: bring Layover forward (default), open behind my work, only if already open, stay quiet.

## How agents reach it

**Hooks (deterministic).** `UserPromptSubmit` starts a run, `Stop` ends it as completed, `StopFailure` as failed, `Interrupt`/`SessionEnd` as cancelled. Claude's `Notification` hook turns permission prompts into "Input requested" items. Each prompt hook prints one short line so the agent knows its run id. No model reasoning is involved in lifecycle.

**Skill (voluntary).** The `layover` skill tells the agent when a decision, question, or opportunity is worth a `layover item` call, and when to stay silent. Publishing is one shell call per item, at the moment it becomes true.

**CLI.**

```
layover item --run <id> --kind decision --text "Chose email sign-in; continuing."
layover begin --agent claude --path C:\work\site --title "Build onboarding"   # for sessions without hooks
layover end --run <id> --status completed
layover open --path C:\work\site
layover state | status | setup | help
```

The packaged CLI runs on the app's own Node runtime, so users don't need Node installed.

## Development

```
npm install            # Node 22+; then approve electron's postinstall if npm asks
npm test               # store, hooks, setup, HTTP service
npm start              # dev app (data in %LOCALAPPDATA%\Layover unless LAYOVER_DATA is set)
npm run dist           # release/Layover-Setup-<version>.exe
```

Use `LAYOVER_DATA` and `LAYOVER_PORT` together to run an isolated instance. The dev CLI is `bin\layover.cmd` (uses `node`); `layover setup` from a checkout points hooks at that path.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the pieces and the event contract, and [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for what has been verified live and what has not.
