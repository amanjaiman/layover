# Agent performance benchmark

What does Layover cost the agent it sits beside? This harness runs the same coding tasks twice —
once with the Layover skill and lifecycle hooks connected, once with nothing connected — and records
latency, tokens, turns and cost for each run.

```
node bench/bench.mjs --reps 3 --model sonnet     # full suite (~20 agent runs)
node bench/bench.mjs --probe-only                # just the static prompt-overhead probe
node bench/analyze.mjs                           # summary.json + REPORT.md from runs.jsonl
```

Results land in `bench/results/`: `runs.jsonl` (one line per run), `summary.json`, `REPORT.md`, and
`layover-state.json` (what Layover actually received — including the synthetic items the CLI suite
posts to time `layover item`, which are not agent behaviour). `REPORT.md` is generated — don't
hand-edit it.
[`RESULTS.md`](RESULTS.md) is the write-up of the run committed here.

## What it measures

**Static overhead.** An identical trivial prompt (`Reply with exactly: OK`) in both conditions. The
model does no work either way, so the difference in prompt tokens is exactly what Layover adds to a
turn before anything happens: the skill's entry in the system prompt, plus the line the
`UserPromptSubmit` hook prints into context.

**Task overhead.** Three ordinary coding tasks on a fixture project (`bench/fixture`), each with a
real design decision in it — the kind of moment the skill tells the agent to publish. This is where
the variable cost shows up: extra `layover item` calls, and the turns they occupy.

**CLI latency.** The hooks and `layover item` measured directly as subprocesses, without an agent in
the loop, so the per-call cost is separable from model variance.

## How the two conditions are kept comparable

- Each run gets a fresh copy of `bench/fixture` and a fresh session id.
- Each condition gets its own `CLAUDE_CONFIG_DIR`. `off` is empty; `on` is whatever
  `layover setup --agent claude` writes, and nothing else. Neither inherits the operator's own
  skills, hooks or settings.
- Conditions are interleaved, and their order flips on every repetition, so drift in API latency
  lands on both sides.
- `prompt_tokens` is `input + cache_creation + cache_read` — the whole prompt the model saw,
  independent of how warm the cache happened to be. Compare tokens on that; `total_cost_usd` moves
  with cache warmth and is the noisier number.

## Caveats

- `bench/headless-host.mjs` runs the real store and the real loopback service without the Electron
  window. Everything the agent touches — hook, CLI, HTTP surface — is the production path; only the
  UI is absent, and a GUI cannot run in a headless container anyway.
- Latency figures come from a checkout, where the CLI runs on the system Node. The packaged CLI runs
  on Electron's bundled Node, which starts at a different speed.
- Whether the agent publishes an item at all is a model decision, so the number of `layover item`
  calls varies between repetitions of the same task. That variance is the point, not noise to
  average away — read the per-run rows in `runs.jsonl` alongside the medians.
