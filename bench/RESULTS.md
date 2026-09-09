# What Layover costs the agent

Sonnet 5 (Claude Code 2.1.266), three coding tasks on a fixture project, three repetitions each,
run twice: once with the Layover skill and lifecycle hooks connected, once with nothing connected.
Plus a trivial-prompt probe that isolates the fixed overhead, and a direct measurement of the CLI.
All 18 task runs completed without error. Generated numbers are in
[`results/REPORT.md`](results/REPORT.md); every run is in `results/runs.jsonl`.

## The short version

| | Cost with Layover connected |
| --- | --- |
| Prompt tokens, per turn | **+382** (+0.9% of a 44k-token prompt) |
| Local time, per session | **+1.2 s** (four hook invocations) |
| Local time, per tool call | **+13 ms** (the `PostToolUse` fast shim) |
| Assistant turns, tool calls | **no change** (median Δ 0 across 9 paired runs) |
| Cost of a task | **+$0.001** median, inside the noise |
| Items the agent actually published | **0 across 9 task runs** |

Nothing here is load-bearing on a coding turn. The token cost is a rounding error against a prompt
that is already 44,000 tokens before the first file is read, and the latency is local work that
happens while the model is not waiting.

## Where the tokens go

An identical trivial prompt, 8 runs per condition, plus 4 runs with the skill installed but
`hookContext` turned off. Prompt tokens are `input + cache_creation + cache_read` — the whole prompt
the model saw, so the number does not move with how warm the cache happened to be.

| | Median prompt tokens | Δ |
| --- | ---: | ---: |
| Nothing connected | 43,896 | — |
| Skill installed, hook line off | 44,030 | **+134** — the skill's name and description in the system prompt |
| Skill + hook line (default) | 44,278 | **+248** — the `UserPromptSubmit` line, once per turn |

The 134 tokens are paid once per session; the 248 are paid on every turn. Spread across the whole
run they were invisible: the median paired difference on real tasks was +2,621 prompt tokens, but
the same task with nothing connected varied by up to 97,000 tokens between repetitions.

The full body of `SKILL.md` (~4,500 characters) is **not** in that number. It loads only if the
agent opens the skill, which it never did here.

## Where the time goes

Model latency swings by seconds between identical runs and drowns a 150 ms hook, so the useful
measure is wall clock minus the API time Claude Code reports — process startup plus everything run
locally, which is where the hooks land.

| | Local time, median | |
| --- | ---: | --- |
| Trivial prompt, nothing connected | 1,277 ms | |
| Trivial prompt, Layover connected | 2,455 ms | **+1,178 ms** |
| Coding task, paired difference | | **+1,264 ms** (range +938 … +1,744, positive in all 9 pairs) |

That is four blocking hooks per session — `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` —
at roughly 170 ms each of Node startup and one loopback request, plus the shell that runs them. It
is flat: a task with ten tool calls costs about 130 ms more than one with none, which is the
`PostToolUse` shim at ~13 ms per call. Measured on its own the shim is 2.2 ms; the rest is the shell
Claude Code spawns to run it.

Measured directly, without an agent in the loop:

| Call | Median |
| --- | ---: |
| `layover hook claude` (`UserPromptSubmit`) | 162.9 ms |
| `layover hook claude` (`Stop`) | 166.4 ms |
| `layover item` | 159.4 ms |
| `layover-fast hook claude` (`PostToolUse`, nothing queued) | 2.2 ms |
| — bare `node -e ''`, for reference | 24.9 ms |
| — Node + the CLI's transport + one loopback request | 96.3 ms |

Most of a call is process startup, not Layover's work. Node itself is 25 ms; loading the CLI's
transport and issuing one request from a cold process is 96 ms; the CLI's remaining imports and its
`/health` pre-flight take it to ~160 ms. The request itself, measured warm and in-process, is 2.5 ms
— the 96 ms figure is dominated by a cold process's first `fetch`. The `PostToolUse` path skips all
of it by checking for a file before Node starts at all, which is why it costs 2.2 ms instead of 160.

## The agent published nothing

Across nine task runs with the hook line in context on every turn and the skill listed in the system
prompt, Sonnet 5 made **zero** `layover item` calls. Verified two ways: no matching command in any
transcript, and no items in the store.

So the numbers above are the *floor* — Layover's fixed cost, with none of its variable cost. Each
item the agent does publish costs one `layover item` call (~165 ms) plus the model round trip that
carries it. In this suite a turn's prompt averaged ~35,000 tokens, so an extra round trip is roughly
35,000 cache-read tokens and ~1–2 s — call it **$0.01 and a second or two per published item**. Three
items in a turn is around 5% of a task's cost. (Derived from this suite's per-turn prompt size, not
measured directly — no item was ever published.)

Whether that silence is the right behaviour is a product question, not a performance one. The skill
tells the agent that silence is fine and to publish only consequential context, and these three
tasks — add pagination, add a discount field, add an idempotency key — were unambiguous enough that
it evidently judged nothing worth the user's attention. A suite built around genuinely contested
decisions would likely produce items, and would be the better test of the variable cost.

## What this does not cover

- One model (Sonnet 5), one agent (Claude Code), three tasks, three repetitions. Nine pairs is
  enough to see a 1.2 s local-time shift that is positive in every pair; it is nowhere near enough
  to resolve a 1% difference in tokens or cost.
- Latency was measured from a checkout, where the CLI runs on the system Node. The packaged CLI runs
  on Electron's bundled Node and will start at a different speed.
- The Electron window was not running — `bench/headless-host.mjs` serves the real store over the real
  loopback service without it. Everything the agent touches is the production path, but a real
  desktop app also competes for CPU, and window focus work is not counted here.
- Codex was not tested.
