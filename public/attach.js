// Attachments in the session window (nika 0.5, design W2 sections 6 and 8; routes: docs/contracts/api-app.md). The user adds images, PDFs and
// text files (button, paste, drop on the message box), sees each one as a chip with its state (uploading, ready, failed), removes chips,
// and sends them with the message. Nothing reaches Claude before Send: a file is uploaded as JSON { name, data: base64 } and kept by the
// server under a name of its own; Send names the chips by the ids the server gave back, never by a path.
// Rules: every name and every line is text (h() and textContent, never markup); no inline style (classes and data attributes only); the
// server's own words never show (every code maps to a fixed line below); the page talks to the server only through the io session.js
// hands in. The pure rules come first and are tested alone; createAttachTray is the DOM side and does nothing at import.
// Keep this file ASCII: write every symbol as an escape.
import { h, icon } from './dom.js';
import { draftSendPlan } from './draft-sync.js';

export const MAX_FILES = 6; // per message (the server's PER_MESSAGE)
export const MAX_BYTES = 8 * 1024 * 1024; // per file, decoded (the server's MAX_BYTES)
const ID = /^[0-9a-f]{16}$/;
const SIG = /^[0-9a-f]{16}$/;
const IMAGES = new Set(['png', 'jpeg', 'gif', 'webp']);
const TYPES = new Set([...IMAGES, 'pdf', 'text']);
const DOTS = String.fromCharCode(0x2026);
const MID = String.fromCharCode(0xb7);
const BIDI_AND_CONTROLS = new RegExp(`[${[[0, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g'); // C0, DEL, C1 and the bidi marks
const NAME_MAX = 255;

// ---- the copy (section 8.6 and 6): fixed lines, picked by status and code only ------------------------------------------------------------

const TOO_BIG = `Too big ${MID} max 8 MB`;
const FAILED = 'Upload failed';
const SESSION_GONE = 'The session is gone.';
const PATH_LINE = "nika's attachments folder has a path Claude can't take (a space or a special character). Set XDG_STATE_HOME to a plain path.";
const CANT_READ = "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.";
const DRAFT_UNREADABLE = "Claude's input holds something nika can't read back. Send or clear it in the terminal, then try again.";
const UPLOAD_409 = {
  'no-project': { short: 'Try again', line: "nika can't tell this session's project yet. Try again in a moment." },
  'path-unusable': { short: "Can't store", line: PATH_LINE },
  'folder-unsafe': { short: "Can't store", line: "nika's attachments folder isn't safe to write to (a link, or another owner). Nothing was saved." },
};
const UPLOAD_507 = {
  'storage-full': { short: 'Storage full', line: "nika's attachment storage is full (256 MB). Older attachments go after a day or two; try again later." },
  'disk-full': { short: 'Disk full', line: 'The disk is full. Nothing was saved.' },
};
const SEND_LINES = {
  'not-idle': 'Attachments go when Claude is waiting. Nothing was sent; your text and attachments are kept.',
  'mode-unknown': CANT_READ,
  'input-unreadable': CANT_READ,
  'draft-unreadable': DRAFT_UNREADABLE,
  'draft-changed': "Claude's input changed while nika was getting ready. Nothing was sent; try again.",
  'shell-mode': "Claude's input is in ! mode. Press Backspace in the terminal to leave it, then send again.",
  'cursor-not-at-end': "Claude's input is in vim normal mode or its cursor isn't at the end. Press i (or End) in the terminal, then send again.",
  'vim-normal': "Claude's input is in vim normal mode or its cursor isn't at the end. Press i (or End) in the terminal, then send again.",
  'screen-changed': "Claude's screen changed, so nothing was sent.",
  'busy-switching': 'Another action is running on this session. Try again in a moment.',
  'path-unusable': PATH_LINE, // the stored path was refused at the send: the same folder problem as at the upload
};
const GENERIC_SEND = "nika couldn't send the attachments. Nothing was sent; your text and attachments are kept.";
const NO_ANSWER = "nika did not answer, so it is not known whether anything was sent. Check Claude's input in the terminal. Your text and attachments are kept here.";
const TOO_MANY_KEYS = 'Too many keys at once; try again.';
const STOP_REASONS = {
  'screen-changed': "Claude's screen changed (a prompt, a menu or a search may be open; Esc closes a search)",
  'not-idle': 'Claude started working',
};
const REFUSE = {
  shell: "Turn Shell off to send attachments: a ! command can't carry them.",
  uploading: 'Wait until the attachments have finished uploading.',
  failed: 'Remove the attachments that failed, then send.',
  working: 'Attachments go when Claude is waiting. Wait for this turn to end, or press Stop. Your text and attachments are kept.',
  long: 'This message is too long to go with attachments. Send the text first, then the attachments.',
};
const READ_NOTICE = [
  "Claude may ask to read the attached file: it is in nika's attachments folder, outside the project. Answer in the prompt panel.",
  "Claude may ask to read the attached files: they are in nika's attachments folder, outside the project. Answer in the prompt panel.",
];

// ---- pure rules --------------------------------------------------------------------------------------------------------------------------

/** "820 B", "14 KB", "1.2 MB". Anything that is not a size reads as 0 B. */
export function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = Math.round(n / 1024);
  return kb < 1024 ? `${kb} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name as the chip shows it: no control or bidi characters, at most 255 units, "file" when nothing is left. */
export function shownName(name) {
  const s = typeof name === 'string' ? name.replace(BIDI_AND_CONTROLS, '').trim().slice(0, NAME_MAX) : '';
  return s === '' ? 'file' : s;
}

/** The symbol a chip of this server type draws. */
export const typeIcon = (type) => (IMAGES.has(type) ? 'image' : type === 'pdf' ? 'file' : 'text');

/** What a refused upload shows: { short, line } = the chip's reason and the problem line (null: none). `code` is the route's `error`. */
export function uploadView(r, name = 'file') {
  const { status, code } = r ?? {};
  if (status === 413) return { short: TOO_BIG, line: null }; // the store's `too-big` and the dispatcher's `too_large` read the same
  if (status === 415 && code === 'wrong-type') return { short: 'Not supported', line: `${name}: use PNG, JPEG, GIF, WebP, PDF or UTF-8 text.` };
  if (status === 400 && code === 'empty') return { short: 'Empty file', line: null };
  if (status === 409 && Object.hasOwn(UPLOAD_409, code)) return UPLOAD_409[code];
  if (status === 507 && Object.hasOwn(UPLOAD_507, code)) return UPLOAD_507[code];
  return { short: FAILED, line: null }; // 429 after the retry, no answer, 5xx, anything the page does not know
}

const stopped = (k, n, reason) => `nika put ${k} of ${n} attachment${n === 1 ? '' : 's'} into Claude's input, then stopped without pressing Enter: ${reason}. Send or clear Claude's input in the terminal (Esc twice), then send again. Your text and attachments are kept here.`;

/**
 * What a send that did not go shows. r = { status, body } (body: the route's { error, pasted, id? }); ctx = { total, nameOf(id) }.
 * Returns { line, gone, goneId }: gone = the pane is gone; goneId = the chip the server says is no longer on disk (16 hex or null).
 */
export function sendView(r, { total = 1, nameOf = () => null } = {}) {
  const status = r?.status ?? 0;
  const body = r?.body !== null && typeof r?.body === 'object' && !Array.isArray(r.body) ? r.body : {};
  const code = typeof body.error === 'string' ? body.error : '';
  const pasted = Number.isInteger(body.pasted) && body.pasted > 0 ? Math.min(body.pasted, total) : 0;
  const out = (line, extra = {}) => ({ line, gone: false, goneId: null, ...extra });
  if (status === 404) return out(SESSION_GONE, { gone: true });
  if (status === 0) return out(NO_ANSWER);
  const named = typeof body.id === 'string' && ID.test(body.id) ? body.id : null;
  if (pasted > 0) { // some went in: the user must clear Claude's input before sending again
    if (code === 'not-taken') return out(stopped(pasted, total, `Claude didn't take ${(named && nameOf(named)) || 'the file'}`));
    if (Object.hasOwn(STOP_REASONS, code)) return out(stopped(pasted, total, STOP_REASONS[code]));
    return out(stopped(pasted, total, status === 429 ? 'too many keys at once' : 'nika could not finish'));
  }
  if (status === 429) return out(TOO_MANY_KEYS);
  if (status === 409 && code === 'attachment-gone') return out(`${(named && nameOf(named)) || 'An attachment'} is no longer on disk. Remove it and add it again.`, { goneId: named });
  if (status === 409 && Object.hasOwn(SEND_LINES, code)) return out(SEND_LINES[code]);
  return out(GENERIC_SEND);
}

/** The base64 of a File, through FileReader (the default `read` of createAttachTray). */
function readBase64(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const s = String(reader.result);
      const at = s.indexOf(',');
      if (at < 0) reject(new Error('read'));
      else resolve(s.slice(at + 1));
    });
    reader.addEventListener('error', () => reject(new Error('read')));
    reader.readAsDataURL(f);
  });
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---- the tray ------------------------------------------------------------------------------------------------------------------------------

/**
 * io: paneId; path(tail) -> the pane's route for 'attachments', 'attachments/<id>' or 'attach-send' (session.js owns every /api/app string);
 * call(path, { method, json }) -> { status, body } (never rejects); appFetch(path, { method, keepalive }) (the pagehide delete);
 * ds = the draft sync (screen, send, beginSend, endSend); enqueueJob(run) -> Promise (the keys chain); say, announce, showProblem(msg, kind, ms),
 * clearProblem, showNotice, setGone; box() -> { value, shell }; working() -> Claude is busy; cols(); clearBox(value) (clears the message
 * box when it still holds `value`); focusBox(). Optional: read(file) -> base64 (default: FileReader), sleep(ms).
 * Returns { wire, enable, pending, sending, send }.
 */
export function createAttachTray(io) {
  const chips = []; // { key, name, state: 'uploading' | 'ready' | 'failed', meta, type, id, file, started, removed, el }
  const read = io.read ?? readBase64;
  const sleep = io.sleep ?? wait;
  let seq = 0;
  let enabled = true;
  let sending = false;
  let queued = false; // pump is running
  let noticed = false; // the Read notice shows once per page
  let over = 0; // drag enter minus leave: the box is "dropping" while a file is over it or one of its children

  const el = (id) => document.getElementById(id);
  const deletePath = (id) => io.path(`attachments/${id}`); // ids reach here only after they matched ID
  const lock = () => !enabled || sending;

  function paint(chip) {
    const { li, holder, meta, x } = chip.el;
    li.setAttribute('data-s', chip.state);
    if (chip.state === 'uploading') li.setAttribute('aria-busy', 'true');
    else li.removeAttribute('aria-busy');
    if (chip.state === 'uploading') holder.replaceChildren(h('span', { class: 'spin' }));
    else if (chip.state === 'failed') holder.replaceChildren(icon('warn'));
    else holder.replaceChildren(icon(typeIcon(chip.type)));
    meta.textContent = chip.meta;
    x.disabled = !enabled;
    if (sending) x.setAttribute('aria-disabled', 'true');
    else x.removeAttribute('aria-disabled');
  }

  const paintAll = () => {
    for (const chip of chips) paint(chip);
    if (sending) el('att-tray').setAttribute('aria-busy', 'true');
    else el('att-tray').removeAttribute('aria-busy');
  };

  function build(chip) {
    const holder = h('span', { class: 'att-i', 'aria-hidden': 'true' });
    const meta = h('span', { class: 'att-m' });
    const x = h('button', { type: 'button', class: 'att-x', 'aria-label': `Remove ${chip.name}`, title: `Remove ${chip.name}`, onclick: () => remove(chip) }, icon('x'));
    const li = h('li', { class: 'att' }, holder, h('span', { class: 'att-n', title: chip.name, text: chip.name }), meta, x);
    chip.el = { li, holder, meta, x };
    paint(chip);
    return li;
  }

  const show = () => { el('att-tray').hidden = chips.length === 0; };

  function fail(chip, short, line) {
    chip.state = 'failed';
    chip.meta = short;
    paint(chip);
    io.announce(`${chip.name} can't be attached: ${short}.`);
    if (line) io.showProblem(line, 'error', 8000);
  }

  function remove(chip) {
    if (lock()) return;
    const i = chips.indexOf(chip);
    if (i < 0) return;
    chips.splice(i, 1);
    chip.el.li.remove();
    if (chip.state === 'ready') io.call(deletePath(chip.id), { method: 'DELETE' });
    else if (chip.state === 'uploading') chip.removed = true; // its upload answers later; the file is deleted then
    show();
    const next = chips[i] ?? chips[i - 1];
    if (next) next.el.x.focus();
    else io.focusBox();
    io.announce(`Removed ${chip.name}.`);
  }

  async function upload(chip) {
    chip.started = true;
    const path = io.path('attachments');
    let r;
    try {
      const data = await read(chip.file);
      if (chip.removed) return;
      const body = { name: chip.file.name.slice(0, NAME_MAX), data };
      r = await io.call(path, { method: 'POST', json: body });
      if (r.status === 429) {
        await sleep(1000); // the server takes one upload at a time: once more
        if (chip.removed) return;
        r = await io.call(path, { method: 'POST', json: body });
      }
    } catch {
      r = { status: 0, body: null };
    } finally {
      chip.file = null;
    }
    const ok = r.status === 200 && ID.test(r.body?.id ?? '') && TYPES.has(r.body?.type);
    if (chip.removed) { // gone from the tray while uploading
      if (ok) io.call(deletePath(r.body.id), { method: 'DELETE' });
      return;
    }
    if (ok) {
      Object.assign(chip, { state: 'ready', id: r.body.id, type: r.body.type, meta: formatSize(r.body.size) });
      paint(chip);
      io.announce(`Attached ${chip.name}, ${chip.meta}.`);
      return;
    }
    if (r.status === 404) io.setGone();
    const v = r.status === 404 ? { short: FAILED, line: SESSION_GONE } : uploadView({ status: r.status, code: r.body?.error }, chip.name);
    fail(chip, v.short, v.line);
  }

  /** One upload at a time (the server takes one at a time, and a file is held in memory only while it goes). */
  async function pump() {
    if (queued) return;
    queued = true;
    try {
      for (let chip = chips.find((c) => c.state === 'uploading' && !c.started); chip; chip = chips.find((c) => c.state === 'uploading' && !c.started)) await upload(chip);
    } finally {
      queued = false;
    }
  }

  function add(files) {
    if (lock() || !io.paneId) return;
    for (const f of files) {
      if (chips.length >= MAX_FILES) {
        io.showProblem(`Up to ${MAX_FILES} attachments per message.`, 'warn', 4000);
        break;
      }
      const chip = { key: (seq += 1), name: shownName(f.name), state: 'uploading', meta: `Uploading${DOTS}`, type: null, id: null, file: f, started: false, removed: false, el: null };
      chips.push(chip);
      el('att-tray').append(build(chip));
      if (f.size > MAX_BYTES) { // never read or posted
        chip.file = null;
        fail(chip, TOO_BIG, null);
      }
    }
    show();
    pump();
  }

  // ---- Send (section 6) ---------------------------------------------------------------------------------------------------------------------

  async function send(value) {
    if (sending || chips.length === 0) return;
    const refuse = (message) => io.showProblem(message, 'error'); // nothing is sent; the text and the chips stay
    if (io.box().shell) return refuse(REFUSE.shell);
    if (chips.some((c) => c.state === 'uploading')) return refuse(REFUSE.uploading);
    if (chips.some((c) => c.state === 'failed')) return refuse(REFUSE.failed);
    if (io.working()) return refuse(REFUSE.working);
    const screen = io.ds.screen();
    const plan = draftSendPlan({ value, shell: false, screen, cols: io.cols() });
    if (plan.act === 'refuse') return refuse(plan.message);
    if (plan.act === 'legacy') return refuse(screen ? REFUSE.long : CANT_READ);
    if (!screen) return refuse(CANT_READ); // an empty message: only Claude's own box can say what Enter would do
    if (screen.state === 'unreadable') return refuse(DRAFT_UNREADABLE);

    const sent = chips.slice();
    const ids = sent.map((c) => c.id);
    sending = true;
    paintAll();
    io.ds.beginSend(); // the background sync holds still until this send is over
    const own = el('send');
    own.setAttribute('aria-busy', 'true');
    let out;
    try {
      out = await io.enqueueJob(async () => {
        if (plan.act === 'push') { // the text first: a push that does not land sends nothing
          const p = await io.ds.send(plan.text);
          if (!p.ok) return { blocked: p.message };
        }
        const sig = io.ds.screen()?.sig;
        if (typeof sig !== 'string' || !SIG.test(sig)) return { blocked: CANT_READ };
        return io.call(io.path('attach-send'), { method: 'POST', json: { ids, base: sig } });
      });
    } catch {
      out = { status: 0, body: null }; // the job itself failed: what went out is not known
    } finally {
      sending = false;
      paintAll();
      io.ds.endSend();
      own.removeAttribute('aria-busy');
    }
    if (out.blocked) return refuse(out.blocked);
    if (out.status === 200) {
      io.clearBox(value);
      chips.length = 0;
      el('att-tray').replaceChildren();
      show();
      io.clearProblem();
      const n = sent.length;
      io.say(`Sent ${n} attachment${n === 1 ? '' : 's'}${value.trim() === '' ? '' : ' and your message'} to ${io.paneId}`);
      const files = sent.filter((c) => !IMAGES.has(c.type)).length;
      if (files > 0 && !noticed) {
        noticed = true;
        io.showNotice(READ_NOTICE[files === 1 ? 0 : 1]);
      }
      return;
    }
    const v = sendView(out, { total: ids.length, nameOf: (id) => chips.find((c) => c.id === id)?.name ?? null });
    if (v.gone) io.setGone();
    const gone = v.goneId === null ? null : chips.find((c) => c.id === v.goneId);
    if (gone) {
      gone.state = 'failed';
      gone.meta = 'Gone';
      paint(gone);
    }
    refuse(v.line);
  }

  // ---- the page's side: the ways in --------------------------------------------------------------------------------------------------------

  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  function wire() {
    const input = el('att-input');
    el('att-btn').addEventListener('click', () => { if (!lock()) input.click(); });
    input.addEventListener('change', () => {
      const picked = Array.from(input.files ?? []);
      input.value = '';
      add(picked);
    });
    el('composer').addEventListener('paste', (e) => { // a pasted screenshot or file; text alone is the browser's own paste
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      add(Array.from(files));
    });
    const box = el('composer-box');
    const look = (on) => {
      box.classList.toggle('dropping', on);
      el('att-drop').hidden = !on;
    };
    box.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      over += 1;
      look(true);
    });
    box.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      look(true);
    });
    box.addEventListener('dragleave', () => {
      over = Math.max(0, over - 1);
      if (over === 0) look(false);
    });
    box.addEventListener('dragend', () => {
      over = 0;
      look(false);
    });
    box.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return; // a text drag into the box stays the browser's
      e.preventDefault();
      over = 0;
      look(false);
      add(Array.from(e.dataTransfer.files ?? []));
    });
    // A file dropped anywhere else would make the window open it: cancel it (the shell's navigation guard denies file: as well).
    for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('pagehide', () => { // files attached by mistake should not wait for the expiry
      for (const chip of chips) {
        if (chip.state !== 'ready') continue;
        try {
          io.appFetch(deletePath(chip.id), { method: 'DELETE', keepalive: true }).catch(() => {});
        } catch {
          // the page is leaving; the server's expiry takes the file
        }
      }
    });
  }

  function enable(on) {
    enabled = on === true;
    el('att-btn').disabled = !enabled;
    for (const chip of chips) chip.el.x.disabled = !enabled;
  }

  return { wire, enable, pending: () => chips.length > 0, sending: () => sending, send };
}
