# Layover agent-performance benchmark

Model `sonnet` · Claude Code 2.1.266 (Claude Code) · 3 repetitions per task per condition · generated 2026-09-09T04:30:24.036Z

#### Static overhead (identical trivial prompt, no work done)  (n=8 without, 8 with)

| Metric | Without Layover | With Layover | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| Wall-clock latency | 3490 ms | 4142 ms | +652 ms | +18.7% |
| Local time (wall − API) | 1277 ms | 2455 ms | +1178 ms | +92.3% |
| API time (reported) | 2097 ms | 1452 ms | -645 ms | -30.8% |
| Time to first token | 1339 ms | 1636 ms | +297 ms | +22.2% |
| Assistant turns | 1 | 1 | 0 | 0.0% |
| Tool calls | 0 | 0 | 0 | — |
| Prompt tokens (in+cache) | 43,896 | 44,278 | +382 | +0.9% |
| Output tokens | 4 | 4 | 0 | 0.0% |
| Total tokens | 43,900 | 44,282 | +382 | +0.9% |
| Cost | $0.035 | $0.0356 | +$0.0006 | +1.7% |

Split of the prompt-token overhead, from the same probe:

| Layer | Median prompt tokens | Δ vs. previous row |
| --- | ---: | ---: |
| Nothing connected | 43,896 | — |
| Skill installed, hook line off | 44,030 | +134 (the skill's entry in the system prompt) |
| Skill + hook line (default) | 44,278 | +248 (the `UserPromptSubmit` line, once per turn) |

#### Coding tasks, paired by task and repetition (n=9 pairs)

Each row is the median of (with Layover − without Layover) over the 9 pairs, with the full range.

| Metric | Median Δ | Range of Δ |
| --- | ---: | ---: |
| Wall-clock latency | +4470 ms | -19088 ms … +13074 ms |
| Local time (wall − API) | +1264 ms | +938 ms … +1744 ms |
| API time (reported) | +3318 ms | -20194 ms … +11785 ms |
| Assistant turns | 0 | -2 … +2 |
| Tool calls | 0 | -2 … +2 |
| Prompt tokens (in+cache) | +2,621 | -46,120 … +148,580 |
| Output tokens | +209 | -711 … +1,660 |
| Cost | +$0.0012 | -$0.011 … +$0.0467 |

The spread between repetitions of the same task with nothing connected — the noise these deltas sit inside:

| Task | Wall-clock, 3 runs without Layover | Prompt tokens, 3 runs without Layover |
| --- | ---: | ---: |
| pagination | 57408 ms · 54027 ms · 57123 ms | 477,658 · 533,950 · 436,620 |
| discount | 38709 ms · 44914 ms · 58896 ms | 383,049 · 429,391 · 383,295 |
| idempotency | 43008 ms · 30951 ms · 33956 ms | 331,237 · 281,892 · 331,017 |

#### Task: pagination  (n=3 without, 3 with)

| Metric | Without Layover | With Layover | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| Wall-clock latency | 57123 ms | 52623 ms | -4500 ms | -7.9% |
| Local time (wall − API) | 3099 ms | 4036 ms | +938 ms | +30.3% |
| API time (reported) | 54280 ms | 48467 ms | -5813 ms | -10.7% |
| Time to first token | 1858 ms | 1115 ms | -743 ms | -40.0% |
| Assistant turns | 12 | 13 | +1 | +8.3% |
| Tool calls | 11 | 12 | +1 | +9.1% |
| Prompt tokens (in+cache) | 477,658 | 541,017 | +63,359 | +13.3% |
| Output tokens | 5,988 | 5,670 | -318 | -5.3% |
| Total tokens | 482,819 | 546,375 | +63,556 | +13.2% |
| Cost | $0.2097 | $0.2269 | +$0.0171 | +8.2% |

#### Task: discount  (n=3 without, 3 with)

| Metric | Without Layover | With Layover | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| Wall-clock latency | 44914 ms | 43386 ms | -1528 ms | -3.4% |
| Local time (wall − API) | 2802 ms | 4110 ms | +1308 ms | +46.7% |
| API time (reported) | 42112 ms | 39276 ms | -2836 ms | -6.7% |
| Time to first token | 2030 ms | 1363 ms | -667 ms | -32.9% |
| Assistant turns | 11 | 11 | 0 | 0.0% |
| Tool calls | 10 | 10 | 0 | 0.0% |
| Prompt tokens (in+cache) | 383,295 | 384,623 | +1,328 | +0.3% |
| Output tokens | 4,157 | 4,251 | +94 | +2.3% |
| Total tokens | 387,455 | 388,847 | +1,392 | +0.4% |
| Cost | $0.1735 | $0.1747 | +$0.0012 | +0.7% |

#### Task: idempotency  (n=3 without, 3 with)

| Metric | Without Layover | With Layover | Δ | Δ% |
| --- | ---: | ---: | ---: | ---: |
| Wall-clock latency | 33956 ms | 38426 ms | +4470 ms | +13.2% |
| Local time (wall − API) | 2790 ms | 4127 ms | +1336 ms | +47.9% |
| API time (reported) | 30981 ms | 34299 ms | +3318 ms | +10.7% |
| Time to first token | 967 ms | 2867 ms | +1900 ms | +196.5% |
| Assistant turns | 10 | 9 | -1 | -10.0% |
| Tool calls | 9 | 8 | -1 | -11.1% |
| Prompt tokens (in+cache) | 331,017 | 284,897 | -46,120 | -13.9% |
| Output tokens | 3,459 | 3,353 | -106 | -3.1% |
| Total tokens | 334,489 | 288,250 | -46,239 | -13.8% |
| Cost | $0.1516 | $0.1406 | -$0.011 | -7.3% |

#### Layover CLI, measured directly (no agent)

| Call | Median | Mean | Range |
| --- | ---: | ---: | ---: |
| `hook_UserPromptSubmit` | 162.9 ms | 164.2 ms | 149–188.3 ms |
| `hook_Stop` | 166.4 ms | 161.9 ms | 149.2–172.5 ms |
| `item` | 159.4 ms | 159.7 ms | 149.4–174.7 ms |
| `hook_PostToolUse_fast` | 2.2 ms | 2.3 ms | 1.9–3 ms |
| `node_baseline` | 24.9 ms | 24.7 ms | 21.8–27 ms |
| `client_request` | 96.3 ms | 96.5 ms | 87.9–104.7 ms |

#### Items Layover received

0 items across 9 runs.
