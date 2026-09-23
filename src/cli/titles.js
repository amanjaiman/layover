// Reads the name the agent itself gave a conversation, the one its own sidebar or resume list shows.
// Claude Code appends `{"type":"ai-title","aiTitle":…}` to the session transcript and re-appends it
// every few messages; `/rename` appends `{"type":"custom-title","customTitle":…}`, which wins.
// Codex appends `{"id","thread_name","updated_at"}` to $CODEX_HOME/session_index.jsonl when a thread
// is named (verified against the 0.156 app server's thread/name/set). Last line wins in both.
import fs from 'node:fs';
import path from 'node:path';
import { codexDir } from './setup.js';

const CHUNK = 1 << 20; // the title is re-appended often, so the last megabyte nearly always has it

/** Complete lines from one byte range of a file (a line cut by the range start is dropped). */
function linesAt(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  const lines = buf.subarray(0, n).toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines;
}

/** Scan a JSONL file from the end for the last line `pick` accepts; falls back to the first chunk. */
function lastMatch(file, needle, pick) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    const ranges = size > CHUNK ? [[size - CHUNK, CHUNK], [0, CHUNK]] : [[0, size]];
    for (const [start, length] of ranges) {
      let found = '';
      for (const line of linesAt(fd, start, length)) {
        if (!line.includes(needle)) continue;
        try { found = pick(JSON.parse(line)) || found; } catch { /* a line still being written */ }
      }
      if (found) return found;
    }
    return '';
  } finally { fs.closeSync(fd); }
}

export function cleanThreadTitle(s) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

export function claudeThreadTitle(transcript, session) {
  if (!transcript) return '';
  let custom = '', ai = '';
  lastMatch(transcript, 'title"', d => {
    if (d.sessionId && session && d.sessionId !== session) return '';
    if (d.type === 'custom-title' && d.customTitle) custom = d.customTitle;
    if (d.type === 'ai-title' && d.aiTitle) ai = d.aiTitle;
    return custom || ai;
  });
  return cleanThreadTitle(custom || ai);
}

export function codexThreadTitle(session, home = codexDir()) {
  if (!session) return '';
  return cleanThreadTitle(lastMatch(path.join(home, 'session_index.jsonl'), session, d => d.id === session ? d.thread_name : ''));
}

/** The agent's own name for this conversation, or '' when it has not named it (yet). */
export function threadTitle(agent, input) {
  const session = String(input?.session_id || input?.thread_id || '');
  try {
    return agent === 'claude' ? claudeThreadTitle(input?.transcript_path, session) : agent === 'codex' ? codexThreadTitle(session) : '';
  } catch { return ''; }
}
