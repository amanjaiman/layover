# Layover

A calm companion for the time in between. When Claude Code or Codex starts working in a folder, Layover opens that workspace beside you: a notebook for the project, a place for the things the agent wants you to know, a list of what you'll do next, and a break when you want one. When the agent finishes, Layover tells you and stays out of the way.

Layover makes **no model calls**. It runs entirely on your machine: an Electron desktop app that hosts a loopback service, a tiny CLI that agents call, and lifecycle hooks that report start and finish without asking the model to remember anything.

Windows is the first platform. macOS is next; nothing in `src/` is Windows-only except the `.cmd` shim and the PATH helper.

## Install

One command, like most developer tools. Both scripts download the latest GitHub release, install per-user, connect Claude Code and Codex, and open the app.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/amanjaiman/layover/main/scripts/install.ps1 | iex
```

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/amanjaiman/layover/main/scripts/install.sh | sh
```

The macOS build is unsigned; the script clears the quarantine flag so Gatekeeper lets it run. On macOS the compact companion also lives in the menu bar: click the Layover icon for a popover that closes when you click away (Settings → Preferences). Releases are built by the GitHub workflow on a tag push (`git tag v0.5.0 && git push --tags`); macOS artifacts come from a macOS runner.

### Updating

Layover checks GitHub for a newer release every few hours (Settings → Preferences → Updates; the switch there turns it off, and it is the only request the app makes off your machine). When one exists you get a small **Layover x.y.z available** button in the sidebar and an entry in the tray menu. **Install and restart** runs the install script above for that exact release: Layover quits, the new version replaces it, the agent hooks are reconnected, and it reopens. Rerunning the one-liner by hand does the same.

### Manual install (Windows)

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
- **Now**: one thread per agent conversation, Slack-style. The header shows the agent, what it is working on, and its status (working, waiting on you, finished, interrupted, no signal). The timeline shows each turn and the *Decisions*, *Input requested*, *Opportunities* and *Think ahead* items the agent left inside it, newest at the bottom, with the latest open item highlighted. A "Waiting on you" chip only appears when the agent is actually stopped on it (a permission prompt, or an item it marked `--waiting`). Reply inline and **send it**: the agent's own hooks hand your message over at its next pause (after a tool call, as the turn ends, or with your next prompt), and the thread shows when that happened. There is also a composer under every live thread. Proposals can be added to Next; anything can be dismissed. When a turn finishes, the thread ends with *Ready when you are* and a return action; nothing else moves. A conversation that has been quiet for 30 minutes slides into the Archive on its own; the conversation menu can archive or restore it any time.
- **Next**: what you want to do next, Linear-style underneath but calm on the surface. Groups: In progress, Up next, Someday, Done, Dropped. Each entry has a key like `LAY-12`, a priority, a description, and a **prompt draft**. *Copy prompt* packages title, description and draft for the agent, key included; when an agent starts a turn with that key in the prompt, the entry moves to In progress, the thread shows the key, and the completion row offers *Mark done*. `n` or `Ctrl+N` creates one; the prefix is editable in Settings → Workspace.
- **Notes**: the project's running notes. Autosaved, with conflict protection.
- **Break**: stretch prompts, a timer, and optional reminders (suggest, or enter the break automatically once you stop typing).
- **Return to the agent**: brings forward the window the session started in (terminal, VS Code, the Claude desktop app), which the hook recorded at session start. If that window is gone or unknown, a sheet shows the session and a copyable resume command instead.
- **Compact companion**: the same app at 400×580, floating, with a workspace picker and short labels. `Ctrl+Shift+C`.
- **Keyboard**: `n` new in Next, `r` reply to the latest item, `j`/`k` move through Next, `e` edit, `Esc` close, `[` collapse the sidebar, `?` the full list. `Ctrl+1…4` switch views.

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
