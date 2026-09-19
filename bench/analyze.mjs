#!/usr/bin/env node
// Turns bench/results/runs.jsonl into a summary: per-condition medians, the with/without delta,
// and a markdown table. Medians rather than means — a single slow API call should not decide the
// headline number, and n is small.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'results');
const rows = fs.readFileSync(path.join(OUT, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));

const num = (a) => a.filter(v => typeof v === 'number' && Number.isFinite(v));
const median = (a) => { const s = num(a).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => { const s = num(a); return s.length ? s.reduce((p, c) => p + c, 0) / s.length : null; };
const r0 = (v) => v == null ? null : Math.round(v);
const r2 = (v) => v == null ? null : +v.toFixed(4);

const FIELDS = ['wall_ms', 'local_ms', 'duration_api_ms', 'ttft_ms', 'num_turns', 'prompt_tokens', 'input_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'total_tokens', 'total_cost_usd'];

/**
 * Wall clock minus the time Claude Code spent waiting on the API: process startup plus everything
 * the harness runs locally, which is where Layover's hooks land. Model latency varies by seconds
 * between identical runs and swamps a 100 ms hook; this number does not move with it.
 */
function pick(row, field) {
  if (field === 'wall_ms') return row.wall_ms;
  if (field === 'local_ms') {
    const api = row.metrics?.duration_api_ms;
    return api == null ? null : row.wall_ms - api;
  }
  return row.metrics?.[field];
}

function summarize(subset) {
  const out = { n: subset.length };
  for (const f of FIELDS) out[f] = { median: median(subset.map(r => pick(r, f))), mean: mean(subset.map(r => pick(r, f))) };
  out.tool_calls = { median: median(subset.map(r => r.tools?.total)), mean: mean(subset.map(r => r.tools?.total)) };
  out.layover_cli_calls = { median: median(subset.map(r => r.tools?.layoverCalls)), mean: mean(subset.map(r => r.tools?.layoverCalls)) };
  out.layover_items = { median: median(subset.map(r => r.layover_items)), mean: mean(subset.map(r => r.layover_items)) };
  out.errors = subset.filter(r => r.metrics?.is_error || r.exit_code !== 0).length;
  return out;
}

function delta(on, off, field, stat = 'median') {
  const a = on[field]?.[stat], b = off[field]?.[stat];
  if (a == null || b == null) return { abs: null, pct: null };
  return { abs: a - b, pct: b === 0 ? null : ((a - b) / b) * 100 };
}

const summary = { meta, groups: {} };
const kinds = [...new Set(rows.map(r => r.kind))];

for (const kind of kinds) {
  const inKind = rows.filter(r => r.kind === kind);
  const tasksIn = [...new Set(inKind.map(r => r.task))];
  const conds = [...new Set(inKind.map(r => r.condition))];
  const g = { overall: {}, byTask: {} };
  for (const cond of conds) g.overall[cond] = summarize(inKind.filter(r => r.condition === cond));
  g.overall.delta = Object.fromEntries([...FIELDS, 'tool_calls'].map(f => [f, delta(g.overall.on, g.overall.off, f)]));
  if (g.overall['on-nohook']) {
    g.overall.delta_skill_only = Object.fromEntries([...FIELDS].map(f => [f, delta(g.overall['on-nohook'], g.overall.off, f)]));
    g.overall.delta_hook_line = Object.fromEntries([...FIELDS].map(f => [f, delta(g.overall.on, g.overall['on-nohook'], f)]));
  }
  for (const t of tasksIn) {
    const e = {};
    for (const cond of conds) e[cond] = summarize(inKind.filter(r => r.condition === cond && r.task === t));
    e.delta = Object.fromEntries([...FIELDS, 'tool_calls'].map(f => [f, delta(e.on, e.off, f)]));
    g.byTask[t] = e;
  }
  summary.groups[kind] = g;
}

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

// ------------------------------------------------------------------ markdown

const fmt = (v, unit = '') => v == null ? '—' : (unit === 'ms' ? `${r0(v)} ms` : unit === '$' ? `$${r2(v)}` : unit === 'tok' ? r0(v).toLocaleString('en-US') : String(+v.toFixed(2)));
const signed = (v, unit) => v == null ? '—' : (v > 0 ? '+' : '') + fmt(v, unit).replace('$-', '-$');
const pct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

function table(g, title) {
  const rowsOut = [
    ['Wall-clock latency', 'wall_ms', 'ms'],
    ['Local time (wall − API)', 'local_ms', 'ms'],
    ['API time (reported)', 'duration_api_ms', 'ms'],
    ['Time to first token', 'ttft_ms', 'ms'],
    ['Assistant turns', 'num_turns', ''],
    ['Tool calls', 'tool_calls', ''],
    ['Prompt tokens (in+cache)', 'prompt_tokens', 'tok'],
    ['Output tokens', 'output_tokens', 'tok'],
    ['Total tokens', 'total_tokens', 'tok'],
    ['Cost', 'total_cost_usd', '$'],
  ];
  const lines = [
    `#### ${title}  (n=${g.off.n} without, ${g.on.n} with)`, '',
    '| Metric | Without Layover | With Layover | Δ | Δ% |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [label, field, unit] of rowsOut) {
    const a = g.off[field]?.median, b = g.on[field]?.median;
    const d = g.delta[field] || delta(g.on, g.off, field);
    lines.push(`| ${label} | ${fmt(a, unit)} | ${fmt(b, unit)} | ${signed(d.abs, unit)} | ${pct(d.pct)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const md = [];
md.push('# Layover agent-performance benchmark', '');
md.push(`Model \`${meta.model}\` · Claude Code ${meta.claudeVersion} · ${meta.reps} repetitions per task per condition · generated ${meta.at}`, '');
if (summary.groups.probe) {
  md.push(table(summary.groups.probe.overall, 'Static overhead (identical trivial prompt, no work done)'));
  const p = summary.groups.probe.overall;
  if (p['on-nohook']) {
    md.push('Split of the prompt-token overhead, from the same probe:', '',
      '| Layer | Median prompt tokens | Δ vs. previous row |', '| --- | ---: | ---: |',
      `| Nothing connected | ${fmt(p.off.prompt_tokens.median, 'tok')} | — |`,
      `| Skill installed, hook line off | ${fmt(p['on-nohook'].prompt_tokens.median, 'tok')} | ${signed(p.delta_skill_only.prompt_tokens.abs, 'tok')} (the skill's entry in the system prompt) |`,
      `| Skill + hook line (default) | ${fmt(p.on.prompt_tokens.median, 'tok')} | ${signed(p.delta_hook_line.prompt_tokens.abs, 'tok')} (the \`UserPromptSubmit\` line, once per turn) |`, '');
  }
}
if (summary.groups.task) {
  // Pooling medians across different tasks compares nothing in particular. Pair each run with the
  // run of the same task and repetition in the other condition, and report the median paired delta.
  const taskRows = rows.filter(r => r.kind === 'task');
  const pairs = [];
  for (const r of taskRows.filter(r => r.condition === 'off')) {
    const on = taskRows.find(x => x.condition === 'on' && x.task === r.task && x.rep === r.rep);
    if (on) pairs.push({ task: r.task, rep: r.rep, off: r, on });
  }
  const paired = (field) => pairs.map(p => {
    const val = (r) => field === 'tool_calls' ? r.tools?.total : pick(r, field);
    const a = val(p.on), b = val(p.off);
    return (a == null || b == null) ? null : a - b;
  });
  summary.groups.task.paired = { n: pairs.length };
  md.push(`#### Coding tasks, paired by task and repetition (n=${pairs.length} pairs)`, '',
    'Each row is the median of (with Layover − without Layover) over the ' + pairs.length + ' pairs, with the full range.', '',
    '| Metric | Median Δ | Range of Δ |', '| --- | ---: | ---: |');
  for (const [label, field, unit] of [
    ['Wall-clock latency', 'wall_ms', 'ms'],
    ['Local time (wall − API)', 'local_ms', 'ms'],
    ['API time (reported)', 'duration_api_ms', 'ms'],
    ['Assistant turns', 'num_turns', ''],
    ['Tool calls', 'tool_calls', ''],
    ['Prompt tokens (in+cache)', 'prompt_tokens', 'tok'],
    ['Output tokens', 'output_tokens', 'tok'],
    ['Cost', 'total_cost_usd', '$'],
  ]) {
    const d = num(paired(field));
    summary.groups.task.paired[field] = { median: median(d), min: Math.min(...d), max: Math.max(...d) };
    md.push(`| ${label} | ${signed(median(d), unit)} | ${signed(Math.min(...d), unit)} … ${signed(Math.max(...d), unit)} |`);
  }
  md.push('');

  // The noise floor: how much the same task moves between repetitions with nothing connected.
  md.push('The spread between repetitions of the same task with nothing connected — the noise these deltas sit inside:', '',
    '| Task | Wall-clock, 3 runs without Layover | Prompt tokens, 3 runs without Layover |', '| --- | ---: | ---: |');
  for (const t of Object.keys(summary.groups.task.byTask)) {
    const off = taskRows.filter(r => r.condition === 'off' && r.task === t);
    const w = off.map(r => r.wall_ms), pt = off.map(r => r.metrics.prompt_tokens);
    md.push(`| ${t} | ${w.map(v => fmt(v, 'ms')).join(' · ')} | ${pt.map(v => fmt(v, 'tok')).join(' · ')} |`);
  }
  md.push('');
  for (const [t, g] of Object.entries(summary.groups.task.byTask)) md.push(table(g, `Task: ${t}`));
}
if (meta.cli) {
  md.push('#### Layover CLI, measured directly (no agent)', '', '| Call | Median | Mean | Range |', '| --- | ---: | ---: | ---: |');
  for (const [k, v] of Object.entries(meta.cli)) md.push(`| \`${k}\` | ${v.median} ms | ${v.mean} ms | ${v.min}–${v.max} ms |`);
  md.push('');
}
md.push('#### Items Layover received', '');
const taskRows = rows.filter(r => r.kind === 'task' && r.condition === 'on');
const kindCount = {};
for (const r of taskRows) for (const k of r.layover_item_kinds || []) kindCount[k] = (kindCount[k] || 0) + 1;
md.push(`${taskRows.reduce((a, r) => a + (r.layover_items || 0), 0)} items across ${taskRows.length} runs` +
  (Object.keys(kindCount).length ? ` — ${Object.entries(kindCount).map(([k, v]) => `${v} ${k}`).join(', ')}` : '') + '.', '');

fs.writeFileSync(path.join(OUT, 'REPORT.md'), md.join('\n'));
console.log(md.join('\n'));
