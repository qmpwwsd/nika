// Session transcripts: <claudeDir>/projects/<slug>/<session-uuid>.jsonl.
// Transcripts can be hundreds of MB, so only the head and the tail are read, and parsed results are cached
// by path + mtime + size.
import fs from 'node:fs/promises';
import path from 'node:path';
import { openRegular, readAt } from '../fsafe.js';
import { mapLimit, lru } from '../util.js';
import { UUID } from '../ids.js';

export { UUID };
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const WIDE_TAIL_BYTES = 2 * 1024 * 1024;
const IO_LIMIT = 16;

/** path → parsed head and tail. An lru: collect() sizes it to the transcripts on disk (+ CACHE_SLACK); until then it holds 4096. */
export const CACHE_SLACK = 64;
export function createTranscriptCache() {
  return lru(4096);
}

/** Index of every top-level transcript: Map sessionId → { path, dir, mtimeMs, size }. Symlinks are skipped. */
export async function indexTranscripts(claudeDir) {
  const root = path.join(claudeDir, 'projects');
  const files = new Map();
  let dirs;
  try {
    dirs = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    return { files, error: `cannot read ${root}: ${err.code ?? err.message}` };
  }
  const found = [];
  await mapLimit(dirs.filter((d) => d.isDirectory()), IO_LIMIT, async (d) => {
    const dir = path.join(root, d.name);
    try {
      for (const n of await fs.readdir(dir)) {
        const m = TRANSCRIPT_FILE.exec(n);
        if (m) found.push({ id: m[1], dir, file: path.join(dir, n) });
      }
    } catch {
      // unreadable project dir
    }
  });
  await mapLimit(found, IO_LIMIT, async ({ id, dir, file }) => {
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) return;
      const prev = files.get(id);
      if (!prev || prev.mtimeMs < st.mtimeMs) files.set(id, { path: file, dir, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // vanished between readdir and lstat
    }
  });
  return { files, error: null };
}

function parseLines(text, { dropFirst, dropLast }) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // corrupt or cut line
    }
  }
  return out;
}

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const ts = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

function scan(entries, acc, { firstWins }) {
  for (const e of entries) {
    const set = (key, value) => {
      if (value === null || value === undefined) return;
      if (firstWins && acc[key] !== null) return;
      acc[key] = value;
    };
    set('cwd', str(e.cwd));
    set('gitBranch', str(e.gitBranch));
    set('version', str(e.version));
    const t = ts(e.timestamp);
    if (t !== null) {
      if (acc.startedAt === null || t < acc.startedAt) acc.startedAt = t;
      if (acc.lastTimestamp === null || t > acc.lastTimestamp) acc.lastTimestamp = t;
    }
    if (e.type === 'ai-title') set('aiTitle', str(e.aiTitle));
    if (e.type === 'custom-title') set('customTitle', str(e.customTitle));
    if (e.type === 'last-prompt') set('lastPrompt', str(e.lastPrompt));
    if (e.type === 'bridge-session') set('bridgeSessionId', str(e.bridgeSessionId));
    if (e.type === 'assistant') {
      const model = str(e.message?.model);
      if (model && !model.startsWith('<')) set('model', model);
    }
  }
}

const fields = () => ({
  cwd: null, gitBranch: null, version: null, startedAt: null, lastTimestamp: null,
  aiTitle: null, customTitle: null, lastPrompt: null, bridgeSessionId: null, model: null,
});

/** Parses one transcript (head + tail only). Head gives the starting cwd; tail values win for everything else. */
export async function readTranscript(file, cache) {
  const key = file.path;
  const hit = cache?.get(key);
  if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) return hit.data;

  const { handle, st } = await openRegular(file.path);
  let head;
  let tail;
  let bytesRead;
  try {
    const size = st.size;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      head = parseLines(await readAt(handle, 0, size), { dropFirst: false, dropLast: false });
      tail = [];
      bytesRead = size;
    } else {
      head = parseLines(await readAt(handle, 0, HEAD_BYTES), { dropFirst: false, dropLast: true });
      tail = parseLines(await readAt(handle, size - TAIL_BYTES, TAIL_BYTES), { dropFirst: true, dropLast: false });
      bytesRead = HEAD_BYTES + TAIL_BYTES;
      if (tail.length === 0) {
        // The tail sits inside one huge line (an image or tool result): widen once instead of using head values (F17).
        const wide = Math.min(size, WIDE_TAIL_BYTES);
        tail = parseLines(await readAt(handle, size - wide, wide), { dropFirst: size > wide, dropLast: false });
        bytesRead += wide;
      }
    }
  } finally {
    await handle.close();
  }

  // Whole-file case: one pass, last value wins, except cwd (the directory the session was started in).
  const fromHead = fields();
  scan(head, fromHead, { firstWins: true });
  const latest = fields();
  scan(tail.length ? tail : head, latest, { firstWins: false });

  const data = { bytesRead };
  for (const k of Object.keys(latest)) data[k] = latest[k] ?? fromHead[k];
  data.cwd = fromHead.cwd ?? latest.cwd;
  data.startedAt = fromHead.startedAt ?? latest.startedAt;
  data.lastTimestamp = latest.lastTimestamp ?? fromHead.lastTimestamp;
  // A title-only stub (one "ai-title" line, no cwd) never ran a conversation; the model hides it unless live (0.1.1).
  const talk = (e) => e.type === 'user' || e.type === 'assistant';
  data.hasConversation = head.some(talk) || tail.some(talk);

  cache?.set(key, { mtimeMs: file.mtimeMs, size: file.size, data });
  return data;
}
