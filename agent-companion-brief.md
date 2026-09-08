# Agent Companion — Product and Engineering Brief

Working name · September 6, 2026 · Discussion draft

## 1. What we want to build

A lightweight companion app for people working with AI agents. When an agent starts work, it can open the app with the correct project context and publish useful updates as it progresses. The user chooses how to spend that time: capture ideas, draft future prompts, consider agent suggestions, organize project work, or take a deliberate break.

The app helps people stay connected to their project without requiring them to actively collaborate on the task currently running. When the agent finishes, the app lets them know. They can return to the agent or continue what they are doing.

The app should become a persistent home for the user's thoughts and future work around a project, across many agent runs. It supports Codex and Claude Code, including people using both across multiple projects.

**Core principle:** The agent provides context; the app provides interaction. A second AI agent inside the app is unnecessary.

## 2. The problem and intended benefits

Agent work creates an uncertain waiting period. Users have delegated the next step, but may not know whether the wait will last seconds or minutes. Opening social media can turn a brief gap into a longer departure from the project and make resuming harder.

The app offers several legitimate ways to use that gap:

- **Protect attention:** Provide an intentional place to remain instead of drifting into a feed.
- **Maintain continuity:** Keep notes, decisions, and unfinished thoughts attached to the right project.
- **Prepare future work:** Draft the next prompt or capture an idea without interrupting the current run.
- **Improve collaboration:** Surface meaningful assumptions, questions, and opportunities from the working agent.
- **Recover deliberately:** Take a break without continually checking whether the agent has finished.

Productivity is a choice. The app should not make rest feel like failure or turn every wait into homework. Learning activities were discussed as a possible avenue, but an AI tutor or conversational learning mode is not agreed launch scope.

## 3. Decisions established in the discussion

| Topic | Direction |
|---|---|
| Agent support | Support both Codex and Claude Code. Verify the particular supported surfaces during integration work. |
| Engineering sequence | Prove the essential integration, then build the full agreed product. |
| Meaning of prototype | A technical integration phase, not a reduced product experiment that replaces the full build. |
| Required integration | Open the app with project context, accept updates throughout work, and receive completion state. |
| Writing back | Test it, but treat it as a nice-to-have. The user can return to the agent to interrupt or provide guidance. |
| User choice | Let users choose a productive view or a break view. |
| Persistence | Keep project work, notes, drafts, and saved items across runs. |
| Multiple projects | Provide workspace navigation with isolated project context. |
| Agent contributions | Support suggestions, decisions, questions, and opportunities, not only next tasks. |
| Attention | Keep the experience quiet and useful without creating an overwhelming feed. |
| Cost | Core features require no additional model calls. Avoid extra agent turns just to maintain the widget. |

The view names, exact visual arrangement, notification rules, and implementation choices below are proposed expressions of this direction, rather than final specifications.

## 4. Phase one: technical integration validation

Build the real communication foundation with a minimal inspection UI. Keep reusable integration code for the finished app. This phase establishes what actually works in the user's agent environments; documentation alone is not sufficient evidence.

### Required tests, separately for Codex and Claude Code

| Test | Passing outcome |
|---|---|
| Open with context | An agent action launches or reveals the app and routes to the intended project, task, and run. |
| Ongoing updates | Several meaningful items arrive while a real run continues, without waiting for the final response. |
| Completion | The app receives completion and offers a clear path back to the source agent. |
| Project isolation | Two concurrent projects receive only their own content. |
| Concurrent runs | Finishing one run does not mark other runs in that project complete. |
| Persistence | Reopening the app preserves notes, drafts, and received items. |
| Recovery | Duplicate, delayed, and out-of-order events do not corrupt state. Missing completion is shown as unknown or disconnected, not guessed as success. |
| Cancellation and failure | These are distinguishable from successful completion wherever the integration exposes them. Document any detection gaps. |
| Focus behavior | Incoming events do not overwrite a draft or unexpectedly switch an engaged user to another project. |
| Cost and overhead | The app itself makes zero inference calls. Record added agent calls, payload size, and observable latency overhead. |

“Ongoing” means the agent can publish multiple updates during execution. It does not require token streaming, frequent commentary, or uninterrupted access while the model is thinking.

### Optional return-path investigation

Test whether the app can target an existing agent conversation while it is running, idle, or waiting for input. Determine whether delivery steers the current run, queues a later message, interrupts work, or starts another turn. Check acknowledgment and failure behavior; do not equate a successful send with the agent having applied the guidance.

Distinguish integration with an existing user session from launching a new agent session controlled by the app. The latter does not prove the former works.

If a reliable return path exists, expose it as an explicit user action. If it does not, provide copyable content and a return-to-agent action. This result does not block the full product.

### Integration approach to investigate

Use a shared app event interface with separate Codex and Claude Code adapters. MCP tools and/or a CLI can carry structured context. Skills or agent instructions can explain when to publish useful items. Where supported, deterministic lifecycle hooks may provide start, stop, or failure signals without requiring model reasoning.

An MCP tool being available does not prove the agent will call it at every necessary moment. Validate both transport reliability and invocation reliability. Avoid relying solely on a voluntary final tool call for completion if the environment offers a more dependable signal.

Official documentation provides starting points: [Codex MCP](https://developers.openai.com/codex/extend/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Claude Code hooks](https://code.claude.com/docs/en/hooks). These references do not establish that this app's launch, completion, or return flow has been tested. **No integration experiments have been performed as part of this brief.**

### Exit decision

Proceed to the full product once the required path works for both agents on the chosen initial surfaces, with documented limitations and acceptable overhead. Resolve any failed required capability before building features that depend on it. Record optional write-back support independently; its absence is not a failed gate.

Deliverables: working adapters and event interface, a small test harness, a capability matrix by agent/surface, test evidence, and a decision on the production app architecture.

## 5. Phase two: the full product

### Project workspace

Provide a workspace with project navigation inspired by Slack's ability to move between contexts. Each project holds its own notes, drafts, saved work, agent items, and run history. Switching projects restores the user's place and unfinished writing.

Use three internal identities: a **project** for durable context, a **task** for a conversation or piece of work, and a **run** for one period of agent execution. Show human-readable names in the interface. Support multiple tasks and agents inside the same project without mixing their source or status.

### Notes and future prompts

Users can write and edit project notes, record decisions, draft future agent prompts, and save ideas or work to pursue later. Autosave writing and preserve it across app restarts and completion notifications.

Saving a draft is not authorization to execute it. Provide a simple way to copy selected content for an agent. Add direct delivery only where verified and clearly user initiated.

### “For you”: agent-originated context

“For you” is a working label for items the agent offers. It is broader than a task list:

| Item | Example | Baseline actions |
|---|---|---|
| Think ahead | “I'm building onboarding. Think about what should happen after it ends.” | Draft a response, save, dismiss |
| Decision made | “I chose email sign-in and am continuing with that assumption.” | Note agreement or a concern, return to agent |
| Input requested | “Should guests save progress? I'll assume no unless you steer me.” | Write an answer, save, return to agent |
| Opportunity | “The export code could also support a weekly report.” | Save to future work, dismiss |

Every item retains its source task/run. Clearly distinguish a nonblocking assumption from a request on which the agent is actually waiting. Writing an answer locally must never imply the agent has received it.

Let the agent update, resolve, or supersede an existing item. The user can promote a suggestion into their own future-work list. Agent suggestions are not automatically user commitments.

### Break and attention modes

Offer a quiet break view with simple stretch prompts, a timer, or rest. Use predefined content; model generation is unnecessary. Preserve the selected project underneath the break experience.

Include optional time-based break reminders. Users control whether they are enabled, their interval, and whether they merely suggest or automatically enter break mode. An enabled automatic transition must preserve work and avoid disrupting active typing. Exact timing behavior remains a design decision.

### Completion and return

Show a gentle completion message, such as “Ready when you are.” Let users return to the source agent or remain in the app. Preserve the current activity in either case.

Provide the strongest reliable return mechanism for each supported surface. If opening an exact conversation is unavailable, clearly identify the source task and supply an honest fallback rather than suggesting exact navigation worked.

## 6. What the app might look and feel like

It should feel like a useful notebook beside the agent. A compact window and an expanded workspace are proposed forms of the same app. Design language and styling will be determined through future explorations.

### Compact companion

Display the project, current run state, and one chosen activity. The user can switch among agent context, drafting, notes, and a break. Additional suggestions stay accessible without competing for the main area.

Example content hierarchy:

> **Website refresh** · Codex working  
> **For you**  
> I'm simplifying the homepage. What should a first-time visitor do next?  
> [Write a thought] [Save for later]  
> Notes · Next · Break · Expand

On completion, the status changes and a return action appears. The app does not replace the user's writing with the finished result.

### Expanded workspace

Use a project sidebar and a main working area. Proposed destinations are **Now / For you**, **Next**, **Notes**, and **Break**. “Next” contains user-chosen future work and drafts; “For you” contains agent-originated items. Run details and history can remain secondary.

The workspace can become the user's primary place for organizing thoughts and future work around agents without needing a full issue tracker, team chat system, or embedded code editor.

### Attention rules to carry into design

- Show one relevant item prominently, with other items available on demand.
- Do not show a transcript-style stream of routine file edits or tool calls.
- Allow silence: agents should publish consequential context, not fill a quota.
- Never steal focus on every update or switch projects because another run finished.
- Make opening behavior configurable; distinguish first launch from later updates.
- Do not turn ignored suggestions into overdue obligations or punitive badges.
- Move temporary items into history after a run; preserve user responses and explicitly saved work.
- Keep completion visible even during a break, without requiring immediate return.
- Support keyboard navigation, readable contrast, and reduced motion.

## 7. Cost and implementation principles

Core navigation, storage, timers, templates, notifications, and copying content require no model calls. The app should remain useful when an agent sends only minimal context and lifecycle events.

Agent-prepared items can add tokens, tool calls, and latency even when they do not require separate model turns. Keep payloads short and send only meaningful updates. Do not schedule extra reasoning turns to invent activities, summarize the feed, or check whether work finished.

A local app service and local persistent storage are a proposed starting architecture, not a settled stack choice. Keep the UI separate from the adapter layer so both agents share product behavior. Prefer local operation without a required cloud backend for the initial product; account sync and collaboration are not agreed requirements.

Proposed event concepts are: open project, start run, upsert item, resolve item, and end run. Include stable event IDs, project/task/run IDs, source agent, timestamps, and item revisions as needed. Treat agent-supplied text as content, not executable commands. Send only context needed for the experience rather than copying entire transcripts by default.

## 8. Example full experience

1. The user asks Codex to build an onboarding flow.
2. The integration opens the companion in the correct project and marks the run active.
3. Codex leaves one question about the first-time user experience.
4. The user chooses to draft tomorrow's prompt instead. Their choice is respected.
5. Codex publishes a meaningful assumption. It becomes available without interrupting the draft.
6. The user switches to a second project, where Claude Code is also working. Each project retains its own content.
7. An opted-in break reminder appears. The user takes a short stretch break.
8. Codex finishes. The app shows completion without switching the current project or ending the break.
9. The user returns when ready, optionally copying their saved thought into the agent conversation.

## 9. Remaining decisions

- Which Codex surfaces are supported first: desktop, CLI, IDE, or a defined combination?
- Which operating systems are in the initial release, and what installation/package format fits them?
- How do projects map across repositories, worktrees, folders, and agent sessions?
- Should the companion float, dock, minimize to a tray, or offer multiple window behaviors?
- What are the default opening and notification preferences?
- What exact break activities and reminder controls should ship?
- What history retention and export controls should users have?
- Which optional return capabilities are reliable on each agent surface?
- What is the final name and visual identity?

These decisions refine implementation and interaction. They do not reopen the agreed scope or make write-back a prerequisite.

## 10. What success means

Engineering success means reliable context routing and lifecycle updates across both agents, durable user content, graceful recovery, and no inference calls from the app's core experience.

Product success means users can capture a thought, choose rest, and resume their project without losing their place. Useful saved drafts, smooth returns, and low perceived interruption matter more than time spent inside the app. The completed product should support the full agreed workflow while staying quiet enough that using it never feels like managing another inbox.
