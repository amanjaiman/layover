# Design audit · Layover 0.3.0 on real data

2026-09-08. Method: the installed app was restarted with a DevTools port and driven over the Chrome DevTools Protocol (screenshots, DOM reads, clicks) against the user's own workspaces, threads and tickets. Screenshots of every view, both window modes, and every sheet and popover were reviewed. Findings are grouped by what to do with them.

## A. Bugs and things that only showed up on real data (fix without discussion)

| # | Where | What | Fix |
|---|---|---|---|
| A1 | Now, thread header and turn dividers | The raw prompt is the title. Long prompts truncate mid-sentence, and turns triggered by background-task notifications show `<task-notification> <task-id>…` verbatim. | Clean titles: strip tags and markdown, first sentence, ≤ 80 chars. Turns whose prompt is a system notification become "Follow-up from a background task". Empty titles become "Turn N". |
| A2 | Now, completed turns | Every finished turn keeps its full "Ready when you are" block with Return / Got it, so a five-turn conversation stacks three prominent blocks. | Only the latest ended turn is prominent, and only while no newer turn has started. Older completions collapse to the quiet one-line form automatically. |
| A3 | Now, thread header subtitle | Shows the session UUID ("Claude Code session 34e04550-…"). | Subtitle becomes "Claude Code · 5 turns · started 12:04 AM". The UUID stays in the Return sheet where it is useful. |
| A4 | Compact Now | Timeline rows overflow the card: completion rows and turn dividers are clipped at the right edge. Grid children default to their intrinsic width. | `min-width: 0` on timeline children; dividers ellipsize; completion actions wrap under the text. |
| A5 | Settings, This workspace | Colour swatches stack vertically. The `.row` utility was never defined in the app stylesheet. | Define `.row`. |
| A6 | Settings, About / Agents | Long paths break mid-word ("la / yover.cmd"). | `overflow-wrap: anywhere` instead of `word-break: break-all`. |
| A7 | Runs popover (status chip) | Duplicates the threads with raw prompt titles and a lifecycle footnote nobody needs. | Replace with a small workspace popover: folder path with Open, conversation count, and the ticket prefix. Runs live in the threads. |
| A8 | Thread header elapsed time | "Working · 1 min" never updates while you watch. | Refresh thread headers on the 30-second tick. |

## B. Consistency (small, no debate needed)

| # | Where | What | Fix |
|---|---|---|---|
| B1 | Tickets toolbar | "New ticket" (btn.small, 7 px padding) is shorter than the filter segment (3 px track + 6 px buttons). | One toolbar height: 34 px for both. Keep the full labelled button; the main action of a page should read as a button, not a glyph. A plus-only affordance can live in the rail later if the page ever gets busier. |
| B2 | Break | Content is capped at 560 px, so the expanded view is two-thirds empty. | Two columns in expanded mode: timer on the left, stretch card and reminder controls on the right; single column in compact. |
| B3 | Thread header | The return affordance is an unlabeled arrow icon. | Label it "Return" in expanded mode; icon-only in compact. |
| B4 | Tickets row | Priority glyph draws three faint bars for "no priority". | Draw nothing for none; bars only when set. |
| B5 | Now empty threads | "Working quietly. Items the agent leaves for you will appear here." is the only body of an active thread with no items, and it repeats per thread. | Keep it, but only on the thread that is currently working. |
| B6 | Tab counts | "Tickets 1" counts active tickets; "Now 1" counts open items. Both look the same but mean different things. | Keep counts, add a tooltip on each tab saying what is counted. |

## C. Experience questions (your call; my recommendation in bold)

**C1. Should resolved things be dismissable?** Today: items have Dismiss; completed turns collapse to a line after Got it; whole conversations move to "Earlier" after 24 h of silence. What is missing is a way to put a *finished conversation* away deliberately. **Recommendation:** an "Archive" action in the thread header menu that moves the conversation to Earlier immediately, plus A2 above so old completions stop shouting on their own. No badges, no "unread" counts: archived means out of sight, not overdue.

**C2. Should "Tickets" be renamed?** "Now · Tickets · Notes · Break" is the one tab that sounds like a work tool. Candidates: *Next* (calm, pairs with Now, what the tab was called before), *Later*, *Queue*, *Plans*. **Recommendation: rename the tab to "Next"** and keep the tracker exactly as it is; the objects are still tickets with keys in the CLI and docs, but the room you walk into is called Next. "New ticket" becomes "New" with the key shown once it exists.

**C3. Threads: newest at the bottom (Slack) or at the top?** Bottom matches chat and keeps the completion row where the eye lands after scrolling. Top matches a feed and shows the latest without scrolling in compact mode. **Recommendation: keep bottom**, but auto-scroll the working thread to its end when the view opens, and cap visible entries at 10 with "Show earlier" (already there).

**C4. Should the header status chip open anything?** It currently opens the runs list (A7). **Recommendation:** it opens the workspace popover (folder, prefix, conversations); everything else is in the threads.

**C5. Notes: keep one long page, or sections?** One page is calm and honest about what it is. **Recommendation: keep one page** for now; revisit when Notes are used for more than a few screens.

## D. Additions worth making

| # | Addition | Why | Shape |
|---|---|---|---|
| D1 | Page shortcuts | Fast without a modifier when you are not typing. | `n` new ticket (Next page) · `r` reply to the latest open item (Now) · `e` edit selected ticket · `j` / `k` move ticket selection · `Esc` close detail · `[` collapse rail · `?` shortcut sheet. Modifier shortcuts stay as they are. |
| D2 | Collapsible rail | More room for threads; the rail is rarely needed while reading. | 56 px icon rail with workspace tokens and dots; toggle with `[` and a chevron at the rail foot; remembered across restarts. |
| D3 | Ticket ↔ turn linking | *Copy prompt* already puts the key in the prompt. | When a turn's prompt contains a key like `LAY-12`, the thread shows the ticket chip, the ticket moves to In progress when the turn starts, and the completion row offers "Mark LAY-12 done". No model call, one regex. |
| D4 | Archive conversation | See C1. | Thread header menu: Archive · How to return · Copy session id. |
| D5 | Shortcut help | Discoverability for D1. | `?` opens a sheet listing shortcuts; Settings keeps the summary line. |
| D6 | Live elapsed time | See A8. | Tick refresh. |

Not recommended now: a second AI inside the app, a full transcript feed, badges or unread counts, or rich text in Notes. They would trade the calm for busyness the brief warns against.

## Applied

0.3.1: A1–A8, B1–B5, D1 (`n`, `r`, `e`, `j`/`k`, `Esc`, `[`, `?`), D2, D5, D6.

0.3.2, after the decisions: C1 (Archive/Restore per conversation, and quiet conversations move to Archive on their own after 30 minutes), C2 (tab renamed Next; statuses Up next / Someday / Done / Dropped; "New", "Add to Next"), C3 and C5 as recommended, C4 (workspace popover), D3 (a turn whose prompt carries a key links to the entry, moves it to In progress, and offers "Mark done" at completion), D4 (conversation menu). Second visual pass fixes: collapsed-rail selection, entry detail header rows, compact Settings labels, offer toasts dismissed on switch, and real-time updates (only typing in a field defers a refresh, retried within two seconds, scroll position kept). Settings became three tabs: Agents, Workspace, Preferences.
