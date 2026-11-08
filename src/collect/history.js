// Session history for the app tier: the transcript paginated from disk, newest page first.
// The request carries a session id and byte offsets, never a path: the file comes from nika's own transcript index and
// is opened through fsafe (O_NOFOLLOW, regular, owned by this user, single link). Every string is agent-controlled, so
// text goes through cleanBlock() and the page renders it with textContent.
import { openRegular } from '../fsafe.js';
import { UUID } from '../ids.js';
import { clean, cleanBlock } from '../text.js';
import { indexTranscripts } from './transcripts.js';

const WINDOW = 1024 * 1024; // bytes read per request
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ENTRY_MAX = 32 * 1024; // bytes per entry text
const MAX_READS = 4;
const INDEX_TTL_MS = 10_000;

/** Runs at most `max` async tasks at once; the rest wait in FIFO order. A slot is released even when a task throws. */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve)); // the finishing task hands its slot over
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const limited = createLimiter(MAX_READS); // module-level: shared by every request

const fail = (status, error, message) => ({ status, body: { error, message } });
const notFound = (message = 'no such session') => fail(404, 'not_found', message);

/** undefined/null → dflt; a safe integer or a digit string → number; anything else → NaN. */
function intParam(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  return typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
}

async function findTranscript(claudeDir, cache, id, now) {
  const memo = cache?.historyIndex;
  const t = now();
  if (memo && memo.dir === claudeDir && t - memo.at < INDEX_TTL_MS && memo.files.has(id)) return memo.files.get(id);
  const { files } = await indexTranscripts(claudeDir);
  if (cache && typeof cache === 'object') cache.historyIndex = { dir: claudeDir, at: t, files };
  return files.get(id);
}

/** Bytes [start, end) of an open file. Raw bytes, because byte offsets matter and a window can begin mid-character. */
async function readRange(handle, start, end) {
  const buf = Buffer.alloc(end - start);
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await handle.read(buf, got, buf.length - got, start + got);
    if (bytesRead === 0) break; // file shrank
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

const isoOf = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Text over ENTRY_MAX bytes is cut (on a character boundary) and flagged; the rest is cleaned for display. */
function fit(raw) {
  let s = raw;
  let truncated = false;
  if (Buffer.byteLength(s) > ENTRY_MAX) {
    truncated = true;
    s = Buffer.from(s.slice(0, ENTRY_MAX)).subarray(0, ENTRY_MAX).toString('utf8').replace(/�$/, '');
  }
  return { text: cleanBlock(s) ?? '', truncated };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

/** One content block → { kind, raw, tool? } or null when it carries nothing worth showing. */
function fromBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'text') return typeof b.text === 'string' ? { kind: 'text', raw: b.text } : null;
  if (b.type === 'thinking') return typeof b.thinking === 'string' ? { kind: 'thinking', raw: b.thinking } : null;
  if (b.type === 'tool_use') return { kind: 'tool_use', raw: JSON.stringify(b.input) ?? '', tool: clean(b.name, 100) };
  if (b.type === 'tool_result') return { kind: 'tool_result', raw: resultText(b.content) };
  return null;
}

/** One transcript line → history entries (a message may hold several blocks). Non-conversation lines give none. */
function entriesOf(line) {
  if ((line.type !== 'user' && line.type !== 'assistant') || !line.message || typeof line.message !== 'object') return [];
  const { content } = line.message;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const at = isoOf(line.timestamp);
  const out = [];
  for (const b of blocks) {
    const part = fromBlock(b);
    if (!part) continue;
    const { text, truncated } = fit(part.raw);
    if (!text && part.kind !== 'tool_result') continue; // empty text/thinking is noise; an empty tool result still happened
    const entry = { at, role: line.type, kind: part.kind, text };
    if (part.kind === 'tool_use' && part.tool) entry.tool = part.tool;
    entry.truncated = truncated;
    out.push(entry);
  }
  return out;
}

/**
 * Entries of the window bytes [start, start + buf.length). The first line is skipped unless the window starts at 0
 * (it is cut). Lines are kept whole: when `limit` falls inside a line, the whole line stays, so no entry is lost between
 * pages; a page can therefore hold a few entries more than `limit`. Lines over one window are skipped.
 */
function pageOf(buf, start, limit) {
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(0x0a);
    from = nl < 0 ? buf.length : nl + 1;
  }
  const lines = [];
  for (let a = from; a < buf.length;) {
    let b = buf.indexOf(0x0a, a);
    if (b < 0) b = buf.length;
    if (b > a) {
      let entries = [];
      try {
        const v = JSON.parse(buf.toString('utf8', a, b));
        if (v && typeof v === 'object') entries = entriesOf(v);
      } catch {
        // corrupt line, or a line cut by the window end
      }
      if (entries.length) lines.push({ off: start + a, entries });
    }
    a = b + 1;
  }
  let count = 0;
  let i = lines.length;
  while (i > 0 && count < limit) {
    i -= 1;
    count += lines[i].entries.length;
  }
  const kept = lines.slice(i);
  // Where the next (older) page ends: the first kept line; with nothing kept, the first whole line of the window, or
  // the window start when it holds none (one line longer than the window), so every page moves back.
  const next = kept.length ? kept[0].off : start + (from < buf.length ? from : 0);
  const exhausted = start === 0 && i === 0; // the window reaches the file start and every entry line in it is kept
  return { entries: kept.flatMap((l) => l.entries), nextBefore: exhausted || next === 0 ? null : next };
}

/**
 * GET /api/app/session/:id/history. `deps` = { claudeDir, cache?, now? }; `cache` is the collector cache object (the
 * transcript index is kept on it for 10 s). Returns { status, body } with body { entries, nextBefore } (oldest first).
 */
export async function readHistory(sessionId, { before, limit } = {}, { claudeDir, cache, now = Date.now } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return notFound();
  const lim = intParam(limit, DEFAULT_LIMIT);
  if (!(lim >= 1 && lim <= MAX_LIMIT)) return fail(400, 'invalid', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  const bef = intParam(before, null);
  if (bef !== null && !(bef >= 0)) return fail(400, 'invalid', 'before must be a byte offset');

  const clock = typeof now === 'function' ? now : Date.now;
  const file = await findTranscript(claudeDir, cache, sessionId, clock);
  if (!file) return notFound();

  return limited(async () => {
    let opened;
    try {
      opened = await openRegular(file.path);
    } catch {
      return notFound('transcript not readable');
    }
    try {
      const end = bef ?? opened.st.size;
      if (end > opened.st.size) return fail(400, 'invalid', 'before is beyond the end of the transcript');
      const start = Math.max(0, end - WINDOW);
      return { status: 200, body: pageOf(await readRange(opened.handle, start, end), start, lim) };
    } catch {
      return notFound('transcript not readable');
    } finally {
      await opened.handle.close();
    }
  });
}
