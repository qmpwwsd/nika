// Keystrokes and paste into a tmux pane (threats T3, T7). Text goes through `send-keys -l --` so tmux never reads it as
// a key name or option; a paste goes through a private tmux buffer filled from stdin (argv over ~16 KB fails) and
// `paste-buffer -p` (bracketed paste); named keys come from the KEY_NAME allow-list. Every call is exec with a fixed
// argv, never a shell. The caller has already checked that the pane may receive input; the id is still validated here.
// Text goes out in the draft write's chunks (draft.js chunks(), at most 700 characters, CHUNK_GAP_MS apart): Claude reads a burst of 801+
// characters as a paste and at 1024 keeps only the last 1-2 (live check L8, S9 Q4).
// `send: true` (0.5, T54) marks the body of Send's own typing (the page's legacy text road). The route then takes a fresh capture before the
// first key and passes `send(pane, body, { recheck })`: `recheck()` is the same look again, run before every chunk after the first, and a
// refusal it returns stops there (nothing more is typed; the answer says how much was).
import { randomBytes } from 'node:crypto';
import { PANE_ID, KEY_NAME } from './ids.js';
import { chunks, CHUNK_GAP_MS } from './draft.js';
import { tmuxFailure } from './tmuxerr.js';

const MAX_TEXT = 1024; // characters
const MAX_PASTE = 16 * 1024; // UTF-8 bytes
const MAX_KEYS = 8;
const RATE = 20; // requests per pane per WINDOW_MS
const WINDOW_MS = 1000;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // C0, DEL, C1
const PASTE_STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g; // all of it except \t and \n (ESC included)

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invalid = (message) => ({ status: 400, body: { error: 'invalid', message } });
const count = (s) => [...s].length;

/** The 400 for a `send` field that is present and is not the boolean `true` (false, null, 1, 'yes', ...); null when it is absent or `true`. */
export const badSend = (body) => (body?.send !== undefined && body.send !== true ? invalid('send must be true or left out') : null);

/** Checks a request body; returns { text, paste, keys } normalised, or { error: <response> }. */
function validate(body) {
  const { text, paste, keys } = body ?? {};
  const notSend = badSend(body);
  if (notSend) return { error: notSend };
  if (text != null && typeof text !== 'string') return { error: invalid('text must be a string') };
  if (paste != null && typeof paste !== 'string') return { error: invalid('paste must be a string') };
  if (keys != null && !Array.isArray(keys)) return { error: invalid('keys must be an array') };
  if (text && paste) return { error: invalid('text and paste are mutually exclusive') };
  if (text) {
    if (count(text) > MAX_TEXT) return { error: invalid(`text is limited to ${MAX_TEXT} characters`) };
    if (CONTROL.test(text)) return { error: invalid('text must not contain control characters') };
  }
  if (paste && Buffer.byteLength(paste) > MAX_PASTE) return { error: invalid(`paste is limited to ${MAX_PASTE / 1024} KB`) };
  const list = keys ?? [];
  if (list.length > MAX_KEYS) return { error: invalid(`at most ${MAX_KEYS} keys per request`) };
  if (!list.every((k) => KEY_NAME.has(k))) return { error: invalid('unknown key name') };
  // \r\n and \r become \n; ESC and every other control but \t \n go, so the end marker of a bracketed paste cannot be forged.
  const pasted = paste ? paste.replace(/\r\n?/g, '\n').replace(PASTE_STRIP, '') : '';
  if (!text && !pasted && list.length === 0) return { error: invalid('nothing to send') };
  return { text: text || '', paste: pasted, keys: list };
}

/**
 * Sender with a sliding-window rate limit (20 requests/s per pane). `now` is a () => ms clock; `sleep(ms)` waits between text chunks.
 * send(pane, { text, paste, keys, send? }, { recheck? }) → { status, body }; 200 body is { sent: { text, paste, keys } } (characters, characters, keys).
 * `recheck` is an async () => null | { status, body }: run before every text chunk after the first; a refusal it returns is the answer, with
 * `sent` (the counts typed so far) added to its body, and no later chunk, paste or key follows.
 */
export function createKeys({ exec, tmuxBin = 'tmux', now = Date.now, sleep = realSleep } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const hits = new Map(); // pane → timestamps of requests inside the window

  function allow(pane) {
    const t = clock();
    for (const [k, v] of hits) {
      const recent = v.filter((ts) => ts > t - WINDOW_MS);
      if (recent.length) hits.set(k, recent);
      else hits.delete(k);
    }
    const recent = hits.get(pane) ?? [];
    if (recent.length >= RATE) return false;
    recent.push(t);
    hits.set(pane, recent);
    return true;
  }

  const tmux = (args, opts) => exec(tmuxBin, ['-u', ...args], opts);

  async function paste(pane, bytes) {
    const name = `nika-${randomBytes(8).toString('hex')}`;
    try {
      await tmux(['load-buffer', '-b', name, '-'], { input: Buffer.from(bytes, 'utf8') });
      await tmux(['paste-buffer', '-p', '-d', '-b', name, '-t', pane]); // -d deletes the buffer once pasted
    } catch (err) {
      try {
        await tmux(['delete-buffer', '-b', name]); // leave no stray buffer behind
      } catch {
        // there was none to delete
      }
      throw err;
    }
  }

  return {
    async send(pane, body, { recheck } = {}) {
      if (typeof pane !== 'string' || !PANE_ID.test(pane)) return invalid('invalid pane id');
      const req = validate(body);
      if (req.error) return req.error;
      if (!allow(pane)) return { status: 429, body: { error: 'busy', message: `at most ${RATE} requests per second per pane` } };
      try {
        if (req.text) {
          const parts = chunks(req.text); // a failed chunk throws: no later chunk and no named key follows
          for (let i = 0; i < parts.length; i += 1) {
            if (i > 0) {
              await sleep(CHUNK_GAP_MS);
              const refused = typeof recheck === 'function' ? await recheck() : null; // Send's typing: the screen may have changed in the pause
              if (refused) return { status: refused.status, body: { ...refused.body, sent: { text: count(parts.slice(0, i).join('')), paste: 0, keys: 0 } } };
            }
            await tmux(['send-keys', '-t', pane, '-l', '--', parts[i]]);
          }
        }
        if (req.paste) await paste(pane, req.paste);
        for (const key of req.keys) await tmux(['send-keys', '-t', pane, '--', key]);
      } catch (err) {
        return tmuxFailure(err);
      }
      return { status: 200, body: { sent: { text: count(req.text), paste: count(req.paste), keys: req.keys.length } } };
    },
  };
}
