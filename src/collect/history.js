// Session history for the app tier: the transcript paginated from disk, newest page first.
// The request carries a session id and byte offsets, never a path: the file comes from nika's own transcript index and
// is opened through fsafe (O_NOFOLLOW, regular, owned by this user, single link). Every string is agent-controlled, so
// text goes through cleanBlock() and the page renders it with textContent.
import { openRegular } from '../fsafe.js';
import { IMAGE_REF, SUBAGENT_ID, TOOL_USE_ID, UUID } from '../ids.js';
import { IMAGE_MEDIA, base64Size, checkImageBlock } from '../image.js';
import { clean, cleanBlock } from '../text.js';
import { createLimiter } from '../limiter.js';
import { readSubagents, subagentTranscripts } from './subagents.js';
import { indexTranscripts } from './transcripts.js';

const WINDOW = 1024 * 1024; // bytes read per request
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ENTRY_MAX = 32 * 1024; // bytes per entry text
const MAX_READS = 4;
const INDEX_TTL_MS = 10_000;
const LINKED_TOOLS = new Set(['Agent', 'Task']); // Claude's subagent tool: `Agent` in 2.1.325, `Task` in older builds
const LINE_MAX = 16 * 1024 * 1024; // 0.5.1 (C): one transcript line (newline included) is read whole up to this size; a longer line is skipped
const SCAN_MAX = 32 * 1024 * 1024; // how far back the start of a long line is searched
const IMAGES_MAX = 8; // pictures listed per tool result; the rest are counted in `imagesMore`
const PART_MAX = 1000; // parts of a tool result looked at for pictures (the part index in a ref has at most three digits)
const LONG_CACHE_MAX = 16; // remembered long-line pages
const LONG_ENTRIES_MAX = 500; // 0.5.1 (round RV, I4): entries kept from one long line, the LAST ones; more is a cut page (`cut: true`)
const LONG_CACHE_TEXT_MAX = 1024 * 1024; // a long-line page whose entry text adds up to more than this (characters) is never remembered

const limited = createLimiter(MAX_READS); // module-level: shared by every request
// One long-line read or one picture read at a time across the server (T60).
const longLimited = createLimiter(1);
// The read slots and their ONE order (0.5.4 SF, item 7; RV051 M2): imageGate -> limited -> longLimited. A path takes some of them, always in this
// order, never the other way round:
//   - a history page read (readPage) takes `limited`, then `longLimited` only when its window lies inside one long line (longPage); never the gate;
//   - a picture read (readImage) takes `imageGate`, then `limited`, then `longLimited`.
// The gate lets one picture read at a time wait for the single long slot inside `limited`: without it four queued pictures held all four `limited`
// slots and delayed page reads that never needed the long slot. No cycle is possible: every wait is for a slot that comes later in the order than
// any slot the waiter holds, and the last one (`longLimited`) is held only by a task that waits for nothing. Taking `longLimited` first on the
// picture path would deadlock (a picture holds it and waits for `limited`, whose slots are held by page reads that wait for it).
const imageGate = createLimiter(1);

const fail = (status, error, message) => ({ status, body: { error, message } });
const notFound = (message = 'no such session') => fail(404, 'not_found', message);

/**
 * The tool-use id of each Agent/Task call entry (0.5, W8). It lives only here: an entry never carries it, so no response can show it. It is
 * compared for equality with a subagent meta's `toolUseId` (linkSubagents) and nowhere else.
 */
const CALL_ID = new WeakMap();

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

/**
 * `{ media, size }` of an `image` block: the name of the media type when the source is base64 and its media type is exactly one of the four
 * (`png`, `jpeg`, `gif`, `webp`), else null; `size` is the decoded size estimated from the base64 length (null when the data is not a string or
 * its length is not a multiple of 4, and when `media` is null). Nothing is decoded or tested here: this runs for every block of every page.
 */
function imageMeta(b) {
  const s = b.source;
  if (s === null || typeof s !== 'object' || s.type !== 'base64' || typeof s.media_type !== 'string' || !Object.hasOwn(IMAGE_MEDIA, s.media_type)) {
    return { media: null, size: null };
  }
  return { media: IMAGE_MEDIA[s.media_type], size: base64Size(s.data) };
}

/** The `image` parts among the first PART_MAX parts of a tool result's content: `{ list: [{ j, media, size }] (at most IMAGES_MAX), more }`. */
function resultImages(content) {
  if (!Array.isArray(content)) return { list: [], more: 0 };
  const found = [];
  for (let j = 0; j < content.length && j < PART_MAX; j += 1) {
    const p = content[j];
    if (p && typeof p === 'object' && p.type === 'image') found.push({ j, ...imageMeta(p) });
  }
  return { list: found.slice(0, IMAGES_MAX), more: Math.max(0, found.length - IMAGES_MAX) };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

/** One content block -> { kind, raw, tool?, call?, media?, size?, images?, more? } or null when it carries nothing worth showing. */
function fromBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'text') return typeof b.text === 'string' ? { kind: 'text', raw: b.text } : null;
  if (b.type === 'thinking') return typeof b.thinking === 'string' ? { kind: 'thinking', raw: b.thinking } : null;
  if (b.type === 'tool_use') {
    const call = LINKED_TOOLS.has(b.name) && typeof b.id === 'string' && TOOL_USE_ID.test(b.id) ? b.id : null;
    return { kind: 'tool_use', raw: JSON.stringify(b.input) ?? '', tool: clean(b.name, 100), call };
  }
  if (b.type === 'image') return { kind: 'image', raw: '', ...imageMeta(b) };
  if (b.type === 'tool_result') {
    const { list, more } = resultImages(b.content);
    return { kind: 'tool_result', raw: resultText(b.content), images: list, more };
  }
  return null;
}

/**
 * One transcript line → history entries (a message may hold several blocks). Non-conversation lines give none.
 * `off` is the byte offset of the line; an entry id is "<off>:<index of its block>", the same on every page.
 */
function entriesOf(line, off) {
  const blocks = blocksOf(line);
  const at = isoOf(line.timestamp);
  const out = [];
  for (const [i, b] of blocks.entries()) {
    const entry = entryOf(b, i, off, at, line.type);
    if (entry) out.push(entry);
  }
  return out;
}

/** The content blocks of a user/assistant line (a plain string is one text block); none for any other line. */
function blocksOf(line) {
  if ((line.type !== 'user' && line.type !== 'assistant') || !line.message || typeof line.message !== 'object') return [];
  const { content } = line.message;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}

/** The entry of block `i` of the line at `off`, or null when the block shows nothing. */
function entryOf(b, i, off, at, role) {
  const part = fromBlock(b);
  if (!part) return null;
  const { text, truncated } = fit(part.raw);
  if (!text && part.kind !== 'tool_result' && part.kind !== 'image') return null; // empty text/thinking is noise; an empty tool result or a picture still happened
  const entry = { id: `${off}:${i}`, at, role, kind: part.kind, text };
  if (part.kind === 'tool_use' && part.tool) entry.tool = part.tool;
  if (part.kind === 'image') {
    entry.media = part.media;
    entry.size = part.size;
  }
  entry.truncated = truncated;
  if (part.images?.length) {
    entry.images = part.images.map((p) => ({ ref: `${off}:${i}.${p.j}`, media: p.media, size: p.size }));
    entry.imagesMore = part.more;
  }
  if (part.call) CALL_ID.set(entry, part.call);
  return entry;
}

/**
 * The last `max` entries of a line (oldest first), built from the end so that the blocks before them cost nothing but being skipped; `cut` is true
 * when an earlier block would have shown an entry too (a block that shows nothing never counts). 0.5.1, round RV (I4).
 */
function tailEntriesOf(line, off, max) {
  const blocks = blocksOf(line);
  const at = isoOf(line.timestamp);
  const out = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const entry = entryOf(blocks[i], i, off, at, line.type);
    if (!entry) continue;
    if (out.length === max) return { entries: out.reverse(), cut: true };
    out.push(entry);
  }
  return { entries: out.reverse(), cut: false };
}

/**
 * Entries of the window bytes [start, start + buf.length). The first line is skipped unless the window starts at 0
 * (it is cut). Lines are kept whole: when `limit` falls inside a line, the whole line stays, so no entry is lost between
 * pages; a page can therefore hold a few entries more than `limit`. `noLine` is true when the window starts inside a line and holds no complete
 * line (it lies inside one line that is longer than the window, 0.5.1): the caller then reads that line whole (longPage).
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
        if (v && typeof v === 'object') entries = entriesOf(v, start + a);
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
  return { entries: kept.flatMap((l) => l.entries), nextBefore: exhausted || next === 0 ? null : next, noLine: start > 0 && from >= buf.length };
}

/** Fills `buf` from the file at `start` (up to `len` bytes); returns the number of bytes read, fewer only when the file shrank. */
async function fill(handle, buf, start, len) {
  let got = 0;
  while (got < len) {
    const { bytesRead } = await handle.read(buf, got, len - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

/**
 * The start of the line that ends at `end`, by scanning back from `end - 2` (the byte at `end - 1` is the line's own newline, or the last byte of
 * a line cut by `end`) in WINDOW chunks for the last newline: the offset after it, 0 when the file start is reached first, null when SCAN_MAX
 * bytes hold no newline. Throws when the file shrank under the scan.
 */
async function lineStart(handle, end) {
  const top = end - 1;
  const floor = Math.max(0, top - SCAN_MAX);
  const chunk = Buffer.allocUnsafe(WINDOW);
  for (let hi = top; hi > floor;) {
    const lo = Math.max(floor, hi - WINDOW);
    if (await fill(handle, chunk, lo, hi - lo) < hi - lo) throw new Error('transcript shrank');
    const nl = chunk.lastIndexOf(0x0a, hi - lo - 1);
    if (nl >= 0) return lo + nl + 1;
    hi = lo;
  }
  return floor === 0 ? 0 : null;
}

/**
 * The page for the one line that ends at `end`: its entries (none for a line that is cut, still being written, or over LINE_MAX) and where the next
 * page ends. At most LONG_ENTRIES_MAX entries, the last ones; `cut` is true when earlier ones were left out (0.5.1, round RV, I4).
 */
async function readLongLine(handle, end) {
  const ls = await lineStart(handle, end);
  if (ls === null) return { entries: [], nextBefore: Math.max(0, end - SCAN_MAX) || null, cut: false }; // moves back as a window would
  if (end - ls > LINE_MAX) return { entries: [], nextBefore: ls || null, cut: false };
  let page = { entries: [], cut: false };
  try {
    const v = JSON.parse((await readRange(handle, ls, end)).toString('utf8'));
    if (v && typeof v === 'object') page = tailEntriesOf(v, ls, LONG_ENTRIES_MAX);
  } catch {
    // a line cut by `end`, or one still being written
  }
  return { entries: page.entries, nextBefore: ls || null, cut: page.cut };
}

/** The characters of entry text a page holds (what decides whether it is worth remembering, LONG_CACHE_TEXT_MAX). */
const textSize = (entries) => entries.reduce((n, e) => n + e.text.length, 0);

/** Entry copies that keep the tool-use id of a call entry (CALL_ID is keyed by object) and share nothing mutable with the original. */
function copyEntries(entries) {
  return entries.map((e) => {
    const c = { ...e };
    if (e.images) c.images = e.images.map((p) => ({ ...p }));
    if (CALL_ID.has(e)) CALL_ID.set(c, CALL_ID.get(e));
    return c;
  });
}

// Long-line pages already read, by `dev:ino:end` (entries only, never bytes), oldest dropped first. A transcript only grows, so the line that ends at
// `end` stays the same once it has ended with a newline; a line still being written is never kept. Stored and returned as copies, taken before
// linkSubagents adds `subagent` to the entries of the response.
const longCache = new Map();

/** The page for a window that lies inside one line (pageOf's `noLine`): from the cache, or read whole inside longLimited. `terminated`: the byte at `end - 1` is a newline. */
function longPage(opened, end, terminated) {
  return longLimited(async () => {
    const key = `${opened.st.dev}:${opened.st.ino}:${end}`;
    const hit = longCache.get(key);
    if (hit) return { entries: copyEntries(hit.entries), nextBefore: hit.nextBefore };
    const page = await readLongLine(opened.handle, end);
    if (terminated && !page.cut && textSize(page.entries) <= LONG_CACHE_TEXT_MAX) {
      longCache.set(key, { entries: copyEntries(page.entries), nextBefore: page.nextBefore });
      if (longCache.size > LONG_CACHE_MAX) longCache.delete(longCache.keys().next().value);
    }
    return page;
  });
}

/**
 * Adds `subagent: "<agent id>"` to the Agent/Task call entries whose tool-use id exactly one meta of this session's subagents folder names and
 * whose subagent has a transcript in the folder listing (so the subagent route would find it). Two metas with one id link neither. Built
 * only when the page holds such a call; the metas are read again every time (they change while an agent runs). A failure leaves the page
 * without links, never without entries. The tool-use id itself is used here and goes nowhere.
 */
async function linkSubagents(entries, parent) {
  const calls = entries.filter((e) => CALL_ID.has(e));
  if (!calls.length) return;
  try {
    const [subs, files] = await Promise.all([readSubagents(parent), subagentTranscripts(parent)]);
    const owner = new Map(); // tool-use id → the agent id that names it, or null when two metas do
    for (const s of subs) if (s.toolUseId !== null) owner.set(s.toolUseId, owner.has(s.toolUseId) ? null : s.id);
    for (const e of calls) {
      const agent = owner.get(CALL_ID.get(e));
      if (agent && files.has(agent)) e.subagent = agent;
    }
  } catch {
    // no links this time
  }
}

/** limit and before from a request → { lim, bef } or { failure }. One place for both routes. */
function paging({ before, limit }) {
  const lim = intParam(limit, DEFAULT_LIMIT);
  if (!(lim >= 1 && lim <= MAX_LIMIT)) return { failure: fail(400, 'invalid', `limit must be an integer from 1 to ${MAX_LIMIT}`) };
  const bef = intParam(before, null);
  if (bef !== null && !(bef >= 0)) return { failure: fail(400, 'invalid', 'before must be a byte offset') };
  return { lim, bef };
}

/**
 * One page of the transcript at `file`, inside the shared limiter (4 reads in flight across both routes): open it through fsafe, read the
 * window that ends at `bef` (default the end), cut the page (a window inside one long line is read whole, longPage), close. `after(entries)` runs inside the same slot once the file is closed.
 */
function readPage(file, bef, lim, after) {
  return limited(async () => {
    let opened;
    try {
      opened = await openRegular(file);
    } catch {
      return notFound('transcript not readable');
    }
    let page;
    try {
      const end = bef ?? opened.st.size;
      if (end > opened.st.size) return fail(400, 'invalid', 'before is beyond the end of the transcript');
      const start = Math.max(0, end - WINDOW);
      const win = await readRange(opened.handle, start, end);
      page = pageOf(win, start, lim);
      if (page.noLine) page = await longPage(opened, end, win[win.length - 1] === 0x0a);
    } catch {
      return notFound('transcript not readable');
    } finally {
      await opened.handle.close();
    }
    if (after) await after(page.entries);
    const body = { entries: page.entries, nextBefore: page.nextBefore };
    if (page.cut) body.cut = true; // only a long-line page that left out earlier entries of its line says so
    return { status: 200, body };
  });
}

/**
 * GET /api/app/session/:id/history. `deps` = { claudeDir, cache?, now? }; `cache` is the collector cache object (the
 * transcript index is kept on it for 10 s). Returns { status, body } with body { entries, nextBefore } (oldest first).
 * An Agent/Task call entry may carry `subagent` (see linkSubagents).
 */
export async function readHistory(sessionId, { before, limit } = {}, { claudeDir, cache, now = Date.now } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return notFound();
  const { lim, bef, failure } = paging({ before, limit });
  if (failure) return failure;

  const clock = typeof now === 'function' ? now : Date.now;
  const file = await findTranscript(claudeDir, cache, sessionId, clock);
  if (!file) return notFound();

  return readPage(file.path, bef, lim, (entries) => linkSubagents(entries, file));
}

/**
 * GET /api/app/session/:id/subagents/:agentId/history (0.5, W8): the same page, read from the subagent's `agent-<agentId>.jsonl`. The request
 * carries two ids and byte offsets, never a path: the session comes from nika's transcript index, the file from nika's own listing of that
 * session's subagents folder (real directories only), and is opened through fsafe. Checks run in this order: session id, agent id, limit,
 * before, the session in the index, the agent in the listing, the file, `before` against the file's size. Entries never carry `subagent`.
 */
export async function readSubagentHistory(sessionId, agentId, { before, limit } = {}, { claudeDir, cache, now = Date.now } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return notFound();
  if (typeof agentId !== 'string' || !SUBAGENT_ID.test(agentId)) return notFound('no such subagent');
  const { lim, bef, failure } = paging({ before, limit });
  if (failure) return failure;

  const clock = typeof now === 'function' ? now : Date.now;
  const file = await findTranscript(claudeDir, cache, sessionId, clock);
  if (!file) return notFound();
  const target = (await subagentTranscripts(file)).get(agentId);
  if (!target) return notFound('no such subagent');

  return readPage(target, bef, lim);
}

/** Bytes of the line that starts at `off`, its newline included when it has one; null when that is more than LINE_MAX bytes (nothing more is read). */
async function readLineAt(handle, off, size) {
  const chunk = Buffer.allocUnsafe(WINDOW);
  const pieces = [];
  let total = 0;
  for (let pos = off; pos < size;) {
    const got = await fill(handle, chunk, pos, Math.min(WINDOW, size - pos));
    if (got === 0) break;
    const nl = chunk.subarray(0, got).indexOf(0x0a);
    const take = nl >= 0 ? nl + 1 : got;
    total += take;
    if (total > LINE_MAX) return null;
    pieces.push(Buffer.from(chunk.subarray(0, take)));
    if (nl >= 0) break;
    pos += got;
  }
  return Buffer.concat(pieces, total);
}

/** One picture of the transcript `file`: the line that starts at `off`, its block `i` and, for a tool result, its part `j`. Every miss is the same 404. */
async function imageAt(file, off, i, j) {
  const noImage = () => notFound('no such image');
  let opened;
  try {
    opened = await openRegular(file);
  } catch {
    return noImage();
  }
  try {
    const { handle, st } = opened;
    if (off >= st.size) return noImage();
    if (off > 0) {
      const prev = Buffer.alloc(1);
      const { bytesRead } = await handle.read(prev, 0, 1, off - 1);
      if (bytesRead !== 1 || prev[0] !== 0x0a) return noImage(); // not the start of a line
    }
    const raw = await readLineAt(handle, off, st.size);
    if (raw === null) return fail(413, 'too-large', 'image too large');
    const v = JSON.parse(raw.toString('utf8'));
    const content = v?.message?.content;
    if ((v?.type !== 'user' && v?.type !== 'assistant') || !Array.isArray(content)) return noImage();
    let part = content[i];
    if (j !== null) {
      if (part?.type !== 'tool_result' || !Array.isArray(part.content)) return noImage();
      part = part.content[j];
    }
    if (part === null || typeof part !== 'object' || part.type !== 'image') return noImage();
    const checked = checkImageBlock(part);
    if (checked.error) return fail(checked.status, checked.error, checked.message);
    return { status: 200, body: { type: checked.type, data: checked.bytes.toString('base64') } };
  } catch {
    return noImage(); // not JSON, or the file went away
  } finally {
    await opened.handle.close();
  }
}

/**
 * GET /api/app/session/:id/image/:ref and .../subagents/:agentId/image/:ref (0.5.1, C; T59): the picture a history entry names. `agentId` is null
 * for the session's own transcript. `ref` is "<line offset>:<block>" or "<line offset>:<block>.<part>" (an entry id, or an `images[].ref`). Checks, in
 * order: session id, agent id, ref, the session in the index, the agent in the listing, then the file inside the image gate, one limited slot and one
 * longLimited slot (in that order; see the slots comment at the top). Returns { status, body }: 200 `{ type, data }` (canonical base64 of the decoded bytes, never the transcript's own string), 404 `not_found`
 * for every miss, 413 `too-large`, 415 `not-image` (checkImageBlock). The request names an offset, never a path.
 */
export async function readImage(sessionId, agentId, ref, { claudeDir, cache, now = Date.now } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return notFound();
  if (agentId !== null && (typeof agentId !== 'string' || !SUBAGENT_ID.test(agentId))) return notFound('no such subagent');
  const m = typeof ref === 'string' ? IMAGE_REF.exec(ref) : null;
  if (!m) return notFound('no such image');

  const clock = typeof now === 'function' ? now : Date.now;
  const file = await findTranscript(claudeDir, cache, sessionId, clock);
  if (!file) return notFound();
  let target = file.path;
  if (agentId !== null) {
    target = (await subagentTranscripts(file)).get(agentId);
    if (!target) return notFound('no such subagent');
  }
  return imageGate(() => limited(() => longLimited(() => imageAt(target, Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])))));
}
