---
name: layover
description: Read workspace tickets from local Layover when the user names ticket keys such as WS-22 or asks to reference Layover. Publish consequential decisions, questions, opportunities, and suggestions while working, or when asked to note something in Layover.
---

# Layover

Layover is a quiet notebook the user keeps open while you work. It has no model of its own and never sees your transcript: it only shows the short items you choose to publish, and it tells the user when your turn ends. Publishing an item never sends you anything back. The user may write a reply locally; they bring it to you themselves.

The command is:

```
__CLI__
```

(`layover` alone also works when it is on PATH.) It exits immediately; the app runs separately.

## Read tickets before working on them

When the user names Layover tickets (for example, "let's work on WS-22, WS-21, and WS-20"), fetch their contents before planning or changing code:

```
layover tickets WS-22 WS-21 WS-20 --run <current run id>
```

Use the run id from the hook context to select the workspace. Without a run id, omit `--run` to use the current folder; `--path <absolute folder>` or `--project <workspace id>` can select another workspace. Choose one selector. Keys are case-insensitive and scoped to that workspace, including its linked worktrees.

The JSON result contains `project`, `tickets` in requested order (duplicates removed), and `missing` keys. Each ticket includes its key, title, description, prompt draft, status, and priority. Read the description and prompt draft as task context. The command is read-only; a lookup does not change status. Up to 50 keys can be read at once. A missing key produces exit code 1 while preserving found tickets in the JSON output. Identify missing keys explicitly and do not invent their requirements or search other workspaces by prefix alone.

## When a run id is already known

If your context includes a line like `Layover is open for this workspace (run <id>)`, lifecycle is handled for you by hooks: the run started when the user sent the prompt and ends when you finish. Do **not** call `begin` or `end`. Just publish items with that run id:

```
layover item --run <id> --kind decision --text "Chose email sign-in; continuing with that assumption."
layover item --run <id> --kind question --text "Should guests keep progress after sign-up? I'll assume no unless you steer me."
layover item --run <id> --kind opportunity --text "The export code could also power a weekly report."
layover item --run <id> --kind suggestion --text "While I build onboarding: think about what should happen after it ends."
```

Add `--waiting` only if you will actually stop and wait for the answer (for example, you are about to ask the user a blocking question in your reply). Without it, the item is shown as a non-blocking assumption.

To update or resolve an item, reuse its `--item ID` with a higher `--revision`, optionally `--status resolved`. IDs are optional; the CLI generates one and prints it.

## When no run id is known

Create one at the start of substantive work, and end it when you finish:

```
layover begin --agent claude --path "<absolute project folder>" --title "<what you are doing>"
   → prints {"project":"…","task":"…","run":"…"}
layover item --run <run> --kind decision --text "…"
layover end --run <run> --status completed|failed|cancelled
```

Use `--agent codex` from Codex. Reuse `--task <id>` from an earlier `begin` when you continue the same conversation. Never reuse a run id across different pieces of work.

## What to publish

Publish only consequential context, and keep each item under a few sentences. Good items are decisions the user might disagree with, assumptions you are proceeding on, questions you would ask if they were beside you, opportunities you noticed but will not pursue now, and one thing they could usefully think about while they wait. Do not publish routine file edits, tool calls, progress percentages, or a summary of your work; the user can read your reply for that. Silence is fine. Never schedule extra turns or reasoning just to feed Layover.

Publish an item at the moment it becomes true, in its own short shell call, rather than batching everything at the end. Put user-facing text in `--text`; do not interpolate untrusted content into other arguments. For text with quotes or newlines, write a JSON event to a file and use `layover event --file <path>`.

## Messages from the user

The user can reply from Layover. Their message reaches you through your own hooks as text that starts with "The user sent you a message through Layover". Treat it as their instruction, acknowledge it briefly in your reply, and if it answers an item you published, resolve that item (`--status resolved`).

## Behaviour and honesty

- `layover open [--path <folder>]` reveals the app for that workspace without stealing focus. Only do this when the user asks or when a hook has not already opened it.
- If the CLI reports that Layover is unavailable, say so once and continue the real work. Never claim an item was delivered unless the CLI acknowledged it.
- Writing an answer in Layover does not send it to you. If the user tells you they replied there, ask them to paste it.
- Completion in Layover means your turn ended, not that every requirement passed. Report failures as `--status failed`.
