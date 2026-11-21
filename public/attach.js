// Attachments in the session window (nika 0.5, design W2 sections 6 and 8; routes: docs/contracts/api-app.md). The user adds images, PDFs and
// text files (button, paste, drop on the message box), sees each one as a chip with its state (uploading, ready, failed), removes chips,
// and sends them with the message. Nothing reaches Claude before Send: a pasted or dropped file is uploaded as JSON { name, data: base64 } and
// kept by the server under a name of its own; Send names the chips by the ids the server gave back, never by a path.
// The button (W2-T6) opens no file input of its own (the webview's freezes the app on macOS): it asks the server for the desktop shell's native
// file dialog and polls for the answer. The server reads what the user picked and stores it itself, so the page gets ids, names, sizes, types
// and error codes back (never a path) and shows each file as a chip that is already ready or failed.
// Rules: every name and every line is text (h() and textContent, never markup); no inline style (classes and data attributes only); the
// server's own words never show (every code maps to a fixed line below); the page talks to the server only through the io session.js
// hands in. The pure rules come first and are tested alone; createAttachTray is the DOM side and does nothing at import.
// 0.5.4 (AT): the files of an unsent message stay on the server's side when the page leaves. The page lists them when it opens (and when the
// back/forward cache brings it back), builds the same ready chips an upload makes, and names a file the server no longer has in one note.
// Keep this file ASCII: write every symbol as an escape.
import { h, icon } from './dom.js';
import { draftSendPlan, STILL_SENDING, STILL_SENDING_MS } from './draft-sync.js';

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
const POLL_MS = 300; // between two looks at the open file dialog
const RETRY_MS = 2000; // between the list of the pane's attachments and its one retry
const RESTORE_TIMEOUT_MS = 3000; // one list request is cut after this long, so a server that never answers cannot lock the tray (about 8 s at most with the retry)
const GONE_NAME_MAX = 60; // a name in the "not restored" note is clipped to this many units
const REQ_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The error codes of a picked file, as the status the upload copy below reads them by (one table of words for both doors).
const PICK_STATUS = {
  'too-big': 413, too_large: 413, 'wrong-type': 415, empty: 400, 'secret-file': 400, 'no-project': 409, 'path-unusable': 409, 'folder-unsafe': 409, 'tray-full': 409, 'storage-full': 507, 'disk-full': 507,
};

// ---- the copy (section 8.6 and 6): fixed lines, picked by status and code only ------------------------------------------------------------

const TOO_BIG = `Too big ${MID} max 8 MB`;
const SECRET_LINE = "nika doesn't attach .env, key, certificate or credential files.";
// A credential file's name (rule 4): a copy of `isSecretName` in src/attachments.js, which browser code cannot import; a test pins that the two agree.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)|\.netrc|\.git-credentials|\.pgpass|\.npmrc|credentials|.*\.(?:key|pem|p12|pfx|jks|keystore|ovpn))$/is;
/** True for the name of a credential file (`.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ovpn`, an SSH private key, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `credentials`), any case. The tray refuses such a file before it reads a byte; the server refuses it again. */
export const isSecretName = (name) => typeof name === 'string' && SECRET_NAME.test(name.split(/[\\/]/).pop().trimEnd());
const FAILED = 'Upload failed';
const SESSION_GONE = 'The session is gone.';
const ADD_LABEL = 'Add attachments';
const CHOOSING_LABEL = `Choosing files${DOTS}`; // the paperclip's name while the shell's dialog is open
const CHOOSING_LINE = `Choose files in the system dialog${DOTS}`; // the word beside the tray for the same state (the Add project toast's wording)
const CHOOSER_OPEN = 'A file chooser is already open. Finish or cancel it first.';
const CHOOSER_GONE = 'The file chooser closed. Nothing was added.';
const CHOOSER_FAILED = "nika couldn't open the file chooser. Nothing was added.";
const UNREADABLE = "nika can't read this file (a link, a folder, or a file with another owner).";
const PATH_LINE = "nika's attachments folder has a path Claude can't take (a space or a special character). Set XDG_STATE_HOME to a plain path.";
const CANT_READ = "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.";
const DRAFT_UNREADABLE = "Claude's input holds something nika can't read back. Send or clear it in the terminal, then try again.";
const UPLOAD_409 = {
  'no-project': { short: 'Try again', line: "nika can't tell this session's project yet. Try again in a moment." },
  'path-unusable': { short: "Can't store", line: PATH_LINE },
  'folder-unsafe': { short: "Can't store", line: "nika's attachments folder isn't safe to write to (a link, or another owner). Nothing was saved." },
  'tray-full': { short: 'Too many', line: `Up to ${MAX_FILES} attachments per message.` }, // the pane's tray holds six already (a second page of the same session added them)
};
const UPLOAD_507 = {
  'storage-full': { short: 'Storage full', line: "nika's attachment storage is full (256 MB). Older attachments go after a day or two; try again later." },
  'disk-full': { short: 'Disk full', line: 'The disk is full. Nothing was saved.' },
};
const SEND_LINES = {
  'not-idle': 'A prompt is open in Claude or Stop is running. Nothing was sent; your text and attachments are kept.',
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
  'not-idle': 'a prompt opened or Stop ran',
};
const LOCKED = 'Wait until the attachments have gone, then add more.';
const REFUSE = {
  shell: "Turn Shell off to send attachments: a ! command can't carry them.",
  uploading: 'Wait until the attachments have finished uploading.',
  failed: 'Remove the attachments that failed, then send.',
  long: 'This message is too long to go with attachments. Send the text first, then the attachments.',
};
const RESTORING = 'nika is bringing back the attachments you added before. Try again in a moment.';
const RESTORE_FAILED = "nika couldn't bring back the attachments you added before. Leave this session and open it again to try once more.";
const GONE_LABEL = 'Not restored:';
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
  if (status === 400 && code === 'secret-file') return { short: 'Not attached', line: SECRET_LINE };
  if (status === 409 && Object.hasOwn(UPLOAD_409, code)) return UPLOAD_409[code];
  if (status === 507 && Object.hasOwn(UPLOAD_507, code)) return UPLOAD_507[code];
  return { short: FAILED, line: null }; // 429 after the retry, no answer, 5xx, anything the page does not know
}

/** What a picked file that failed shows: the upload copy for the same code, plus the two codes only the chooser has. `code` is the entry's `error`. */
export function pickView(code, name = 'file') {
  if (code === 'unreadable') return { short: "Can't read", line: `${name}: ${UNREADABLE}` };
  if (code === 'invalid') return { short: "Can't read", line: null };
  return uploadView({ status: Object.hasOwn(PICK_STATUS, code) ? PICK_STATUS[code] : 0, code }, name);
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

/** A name in the "not restored" note: clipped to GONE_NAME_MAX units with an ellipsis (a long unbroken name must not push the note wider than the composer). */
const clip = (s) => (s.length > GONE_NAME_MAX ? `${s.slice(0, GONE_NAME_MAX - 1)}${DOTS}` : s);

/** The line of the "not restored" note for these names (already through shownName): one name is told, two or more are counted. */
export function goneLine(names) {
  if (names.length === 1) return `${clip(names[0])}: nika no longer has its copy (attachments are kept for a few days). Add it again if you still need it.`;
  return `${names.length} attachments: nika no longer has their copies (attachments are kept for a few days). Add them again if you still need them.`;
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
 * io: paneId; path(tail) -> the pane's route for 'attachments', 'attachments/<id>', 'attachments/pick', 'attachments/pick/<reqId>' or 'attach-send'
 * (session.js owns every /api/app string);
 * call(path, { method, json, signal }) -> { status, body } (never rejects; an aborted `signal` answers { status: 0 });
 * ds = the draft sync (screen, send, submitted, beginSend, endSend); enqueueJob(run) -> Promise (the keys chain); say, announce, showProblem(msg, kind, ms),
 * clearProblem, showNotice, setGone; box() -> { value, shell }; cols(); clearBox(value) (clears the message
 * box when it still holds `value`); focusBox(). Optional: read(file) -> base64 (default: FileReader), sleep(ms), waitHold() -> Promise
 * (resolves at once with no redraw hold, else when it ends; the attach-send request goes after it).
 * Returns { wire, enable, pending, sending, send, restore }.
 */
export function createAttachTray(io) {
  const chips = []; // { key, name, state: 'uploading' | 'ready' | 'failed', meta, type, id, file, started, removed, el }
  const read = io.read ?? readBase64;
  const sleep = io.sleep ?? wait;
  let seq = 0;
  let enabled = true;
  let sending = false;
  let queued = false; // pump is running
  let picking = false; // the shell's file dialog is open for this page
  let note = null; // the line beside the tray that says so (made in wire)
  let noticed = false; // the Read notice shows once per page
  let over = 0; // drag enter minus leave: the box is "dropping" while a file is over it or one of its children
  let restoring = false; // the list of the pane's attachments is out (at most about 8 s): add, pick and send wait for it
  let goneNote = null; // the "not restored" note beside the tray (made in wire)

  const el = (id) => document.getElementById(id);
  const deletePath = (id) => io.path(`attachments/${id}`); // ids reach here only after they matched ID
  const lock = () => !enabled || sending;

  /** A ready image's name as a button that opens the viewer (0.5.1 C): the bytes come from the attachment image route, by the id the server gave. */
  function openButton(chip) {
    const btn = h('button', {
      type: 'button',
      class: 'att-n att-open',
      title: chip.name,
      'aria-label': `View ${chip.name}`,
      text: chip.name,
      onclick: () => io.view({ name: chip.name, meta: chip.meta, load: () => io.get(io.path(`attachments/${chip.id}/image`)), opener: btn }),
    });
    return btn;
  }

  function paint(chip) {
    const { li, holder, meta, x } = chip.el;
    if (!chip.el.open && chip.state === 'ready' && chip.id && IMAGES.has(chip.type)) { // the id is the server's, checked when the upload answered // a ready chip never goes back to a plain name
      li.replaceChildren(holder, openButton(chip), meta, x);
      chip.el.open = true;
    }
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
    showGone([]);
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
    if (isSecretName(chip.file.name)) { // never read: the name alone decides (rule 4)
      chip.file = null;
      const v = uploadView({ status: 400, code: 'secret-file' }, chip.name);
      fail(chip, v.short, v.line);
      return;
    }
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
    if (!io.paneId || files.length === 0) return;
    if (restoring) return io.showProblem(RESTORING, 'warn', 4000);
    if (lock()) return io.showProblem(LOCKED, 'warn', 4000); // a paste, a drop or a pick while a send is out (or input is off): said, not dropped
    let added = 0;
    for (const f of files) {
      if (chips.length >= MAX_FILES) {
        io.showProblem(`Up to ${MAX_FILES} attachments per message.`, 'warn', 4000);
        break;
      }
      const chip = { key: (seq += 1), name: shownName(f.name), state: 'uploading', meta: `Uploading${DOTS}`, type: null, id: null, file: f, started: false, removed: false, el: null };
      chips.push(chip);
      added += 1;
      el('att-tray').append(build(chip));
      if (f.size > MAX_BYTES) { // never read or posted
        chip.file = null;
        fail(chip, TOO_BIG, null);
      }
    }
    if (added > 0) showGone([]);
    show();
    pump();
  }

  // ---- the button: the shell's own file dialog (W2-T6) -------------------------------------------------------------------------------------

  /** Disabled while input is off or a dialog is open. */
  function syncButton() {
    el('att-btn').disabled = !enabled || picking;
  }

  /**
   * The state "a file dialog is open" (owner rule: colour, icon and word): aria-busy gives the paperclip its busy colour and progress cursor
   * (session.css, never the dimmed off look), the clip becomes the spinner, the button is named "Choosing files", and a line beside the tray says it.
   */
  function chooserLook(on) {
    const btn = el('att-btn');
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    btn.setAttribute('aria-label', on ? CHOOSING_LABEL : ADD_LABEL);
    btn.replaceChildren(on ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : icon('attach'));
    note.textContent = on ? CHOOSING_LINE : '';
    note.hidden = !on;
  }

  /** Starts the dialog and waits for it. Resolves the entries it returned, or null (cancelled, or a refusal that has already been said). */
  async function choose(room) {
    const start = await io.call(io.path('attachments/pick'), { method: 'POST', json: { room } });
    const said = (line, kind = 'error', ms) => { io.showProblem(line, kind, ms); return null; };
    if (start.status === 429) return said(CHOOSER_OPEN, 'warn', 4000);
    if (start.status === 404) {
      io.setGone();
      return said(SESSION_GONE);
    }
    if (start.status === 409 && start.body?.error === 'no-project') return said(UPLOAD_409['no-project'].line);
    const reqId = start.body?.reqId;
    if (start.status !== 202 || typeof reqId !== 'string' || !REQ_ID.test(reqId)) return said(CHOOSER_FAILED);
    for (;;) {
      await sleep(POLL_MS);
      const r = await io.call(io.path(`attachments/pick/${reqId}`));
      if (r.status === 404) return said(CHOOSER_GONE, 'warn');
      const state = r.status === 200 ? r.body?.state : null;
      if (state === 'pending') continue;
      if (state === 'cancelled') return null;
      if (state === 'done' && Array.isArray(r.body.files)) return r.body.files;
      return said(CHOOSER_FAILED);
    }
  }

  /** The entries a dialog returned, as chips in their final state: the server has already read and stored each file, so nothing is uploaded here. */
  function addPicked(files) {
    const trusted = (f) => f !== null && typeof f === 'object' && f.ok === true && ID.test(f.id ?? '') && TYPES.has(f.type);
    const discard = (f) => { if (trusted(f)) io.call(deletePath(f.id), { method: 'DELETE' }); }; // a copy the tray has no room or no right to keep
    if (lock()) { // input went off, or a send began, while the dialog was open
      files.forEach(discard);
      return io.showProblem(LOCKED, 'warn', 4000);
    }
    let full = false;
    for (const f of files) {
      if (chips.length >= MAX_FILES) {
        full = true;
        discard(f);
        continue;
      }
      const ready = trusted(f);
      const name = shownName(f?.name);
      const chip = { key: (seq += 1), name, state: ready ? 'ready' : 'failed', meta: ready ? formatSize(f.size) : '', type: ready ? f.type : null, id: ready ? f.id : null, file: null, started: true, removed: false, el: null };
      chips.push(chip);
      el('att-tray').append(build(chip));
      if (ready) {
        io.announce(`Attached ${name}, ${chip.meta}.`);
      } else {
        const v = f?.ok === false ? pickView(f.error, name) : { short: FAILED, line: null };
        fail(chip, v.short, v.line);
      }
    }
    if (full) io.showProblem(`Up to ${MAX_FILES} attachments per message.`, 'warn', 4000);
    show();
  }

  /** The paperclip. The page opens no file input; the room left in the tray goes to the server, which asks the shell for its dialog. */
  async function pick() {
    if (!io.paneId) return;
    if (restoring) return io.showProblem(RESTORING, 'warn', 4000);
    if (lock() || picking) return;
    const room = MAX_FILES - chips.length;
    if (room < 1) return io.showProblem(`Up to ${MAX_FILES} attachments per message.`, 'warn', 4000);
    showGone([]);
    picking = true;
    syncButton();
    chooserLook(true);
    try {
      const files = await choose(room);
      if (files) addPicked(files);
    } finally {
      picking = false;
      syncButton();
      chooserLook(false);
      el('att-btn').focus();
    }
  }

  // ---- Send (section 6) ---------------------------------------------------------------------------------------------------------------------

  async function send(value) {
    if (restoring) return io.showProblem(RESTORING, 'warn', 4000); // a message never goes without the chips that are about to come back
    if (chips.length === 0) return;
    if (sending) { // the last attachment send is still in flight: say so, send and queue nothing; the text and the chips stay
      io.showProblem(STILL_SENDING, 'warn', STILL_SENDING_MS);
      return;
    }
    const refuse = (message) => io.showProblem(message, 'error'); // nothing is sent; the text and the chips stay
    if (io.box().shell) return refuse(REFUSE.shell);
    if (chips.some((c) => c.state === 'uploading')) return refuse(REFUSE.uploading);
    if (chips.some((c) => c.state === 'failed')) return refuse(REFUSE.failed);
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
        await io.waitHold?.(); // F10: the request waits for nika's own redraw hold, as the draft sync's write does (the server decides on its own fresh capture)
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
      io.ds.submitted({ status: 200, body: { draft: null } }); // the screen the sync holds is from before the Enter: no step may pull the sent text back before the next capture
      io.clearBox(value);
      chips.length = 0;
      el('att-tray').replaceChildren();
      show();
      showGone([]);
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

  // ---- Restore (0.5.4, AT): the chips of an unsent message come back ---------------------------------------------------------------------

  /** A listed file as the server states it. Nothing is trusted: an id, a type, a size and a name, each checked. */
  const valid = (f) => f !== null && typeof f === 'object'
    && typeof f.id === 'string' && ID.test(f.id) && TYPES.has(f.type)
    && Number.isInteger(f.size) && f.size >= 1 && f.size <= MAX_BYTES
    && typeof f.name === 'string' && f.name.length <= NAME_MAX;

  /** The answer is a list: 200 with a plain object holding the two arrays. */
  const listed = (r) => r.status === 200 && r.body !== null && typeof r.body === 'object' && Array.isArray(r.body.files) && Array.isArray(r.body.gone);

  /**
   * The "not restored" note: its own state (colour, icon and words), never the warn alert. An empty list hides and empties it.
   * Returns the note's words (`Not restored: ...`), or '' when there is nothing to say, so merge() can announce the same text.
   */
  function showGone(list) {
    const names = (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string').slice(0, MAX_FILES).map(shownName);
    if (names.length === 0) {
      if (goneNote) {
        goneNote.replaceChildren();
        goneNote.hidden = true;
      }
      return '';
    }
    if (goneNote) {
      goneNote.replaceChildren(icon('file-off'), h('p', {}, h('b', { text: GONE_LABEL }), h('span', { text: ` ${goneLine(names)}` })));
      goneNote.hidden = false;
    }
    return `${GONE_LABEL} ${goneLine(names)}`;
  }

  /** One list request, cut after RESTORE_TIMEOUT_MS (no AbortSignal.timeout: older web views lack it). An abort answers { status: 0 } like any failure. */
  async function get() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), RESTORE_TIMEOUT_MS);
    try {
      return await io.call(io.path('attachments'), { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The list made true on the page: ready chips the server no longer lists go (no request, no line: another page of this session sent or removed
   * them, or the server dropped them), listed files no chip has come as ready chips (the same build as a picked file), and uploading and failed chips
   * stay as they are. Focus never moves.
   */
  function merge(body) {
    const files = [];
    for (const f of body.files) {
      if (files.length >= MAX_FILES) break;
      if (valid(f) && !files.some((g) => g.id === f.id)) files.push(f);
    }
    for (const chip of chips.slice()) {
      if (chip.state !== 'ready' || files.some((f) => f.id === chip.id)) continue;
      chips.splice(chips.indexOf(chip), 1);
      chip.el.li.remove();
    }
    let added = 0;
    for (const f of files) {
      if (chips.length >= MAX_FILES) break;
      if (chips.some((c) => c.id === f.id)) continue;
      const chip = { key: (seq += 1), name: shownName(f.name), state: 'ready', meta: formatSize(f.size), type: f.type, id: f.id, file: null, started: true, removed: false, el: null };
      chips.push(chip);
      el('att-tray').append(build(chip));
      added += 1;
    }
    show();
    const gone = showGone(body.gone);
    // One call holds everything this restore says (a second call would replace the first in the live region): the restored count, then the note's words.
    const said = [added > 0 ? `Restored ${added} attachment${added === 1 ? '' : 's'} from before.` : '', gone].filter(Boolean).join(' ');
    if (said) io.announce(said);
  }

  /**
   * Asks the server for the pane's unsent attachments and brings them back (page open, and a page that returns from the back/forward cache).
   * One retry after RETRY_MS; 404 (the session is gone) is left to the mirror's own flow. While it runs, add, pick and send wait (at most about 8 s).
   */
  async function restore() {
    if (!io.paneId || restoring || sending) return;
    restoring = true;
    let r;
    try {
      r = await get();
      if (r.status !== 404 && !listed(r)) {
        await sleep(RETRY_MS);
        r = await get();
      }
    } catch {
      r = { status: 0, body: null };
    } finally {
      restoring = false;
    }
    if (r.status === 404) return;
    if (!listed(r)) return io.showProblem(RESTORE_FAILED, 'warn', 8000);
    merge(r.body);
  }

  // ---- the page's side: the ways in --------------------------------------------------------------------------------------------------------

  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  function wire() {
    el('att-btn').addEventListener('click', pick);
    note = h('p', { class: 'att-pick', role: 'status', hidden: true });
    goneNote = h('div', { class: 'att-gone', role: 'status', hidden: true });
    el('att-tray').after(note, goneNote);
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
      look(!lock()); // adding is closed (sending, or input off): no drop look
    });
    box.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // cancelled even when closed, so a drop never opens the file
      e.dataTransfer.dropEffect = lock() ? 'none' : 'copy';
      look(!lock());
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
    // The cursor outside the box says no (the box's own handler sets its effect).
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!box.contains(e.target)) e.dataTransfer.dropEffect = 'none';
    });
    document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('pageshow', (e) => { if (e?.persisted === true) restore(); }); // back from the back/forward cache: the server's list may have changed meanwhile
  }

  function enable(on) {
    enabled = on === true;
    syncButton();
    for (const chip of chips) chip.el.x.disabled = !enabled;
  }

  return { wire, enable, pending: () => chips.length > 0 || restoring, sending: () => sending, send, restore };
}
