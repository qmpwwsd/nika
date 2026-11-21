// The attachment store (0.5, W2, design-W2 section 3 and 4; rules constraints 5, 9, 10, 11): checks the bytes of an upload, writes them to
// `<state>/attachments/<key>/<id>.<ext>`, looks them up for a send, removes them and prunes old ones. The user's file name never reaches
// the disk (only an extension from a fixed list), the stored name is a random id nika made, nothing about a file (name, bytes, path, id) is
// ever logged, and the only read-back is readImage (0.5.1, T61): the bytes of an unsent image attachment to the pane that owns it.
// 0.5.4 (AT): the store also keeps a small tray per pane in MEMORY (the ids of the pane's unsent files and the last part of each file name
// through clean(), the chip's label), so the session window can list them again when it opens. Nothing of it is written to disk or logged.
// Writes go through src/fwrite.js, reads through src/fsafe.js. Keep this file ASCII.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './paths.js';
import { clean } from './text.js';
import { ensureDir, writeAtomic, removeOwnFile, removeOwnDir } from './fwrite.js';
import { openRegular } from './fsafe.js';
import { loadConfig } from './store.js';
import { PANE_ID, PROJECT_KEY } from './ids.js';
import { imageTypeOf } from './image.js';
import { createLimiter } from './limiter.js';

export const UPLOAD_CAP = 12 * 1024 * 1024; // request body: base64 of 8 MiB is 11 184 812 chars plus the JSON frame
export const MAX_BYTES = 8 * 1024 * 1024; // decoded, per file
export const PER_MESSAGE = 6;
export const TRAYS_MAX = 64; // trays (one per pane) kept in memory; making the 65th forgets the oldest, in memory only
export const ID = /^[0-9a-f]{16}$/;
/** The full pasted path: one token for Claude, no space, quote, backslash, `@`, `!`, `#` or control (design 5.3). */
export const PATH_OK = /^\/[A-Za-z0-9._/+-]{1,200}$/;

const TOTAL_MAX = 256 * 1024 * 1024; // all projects together
const FILES_MAX = 500;
const EVICT_MIN_AGE = 60 * 60 * 1000; // a file that young may not be sent or read yet
const TMP_MAX_AGE = 60 * 60 * 1000; // a left-over writeAtomic temp file (a crash mid-write)
const PRUNE_EVERY = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const UPLOADS_PER_MIN = 30;
const RECORDS_MAX = 500;
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css',
  'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'sql', 'diff', 'patch',
]);
const FILE_NAME = new RegExp(`^[0-9a-f]{16}\\.(?:png|jpg|gif|webp|pdf|${[...TEXT_EXT].join('|')})$`);
const TMP_NAME = /^\.[0-9a-f]{16}\.[a-z0-9]{1,10}\.[0-9a-f]{12}\.tmp$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// tab, LF and CR are text; the other C0 controls, DEL and the C1 range are not
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }; // the stored extension of each image type imageTypeOf names
const IMAGE_TYPES = ['png', 'jpeg', 'gif', 'webp'];
const imageLimited = createLimiter(2); // module-level: at most two read-backs at once, across every store
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

/** `{ status, body: { error, message } }`; the message is the code in words and is never shown by the page. */
const fail = (status, error) => ({ status, body: { error, message: error.replace(/-/g, ' ') } });
const isMine = (st) => UID === null || st.uid === UID;
const isDiskFull = (err) => err?.code === 'ENOSPC' || err?.code === 'EDQUOT';
/** A node error code only, never the error object: its message could carry the state path. */
const codeOf = (err) => (/^[A-Z0-9_]{1,20}$/.test(err?.code) ? err.code : 'ERR');
/** The chip's label (0.5.4, AT): the text after the last `/` or `\\` of the upload's name, through clean(), at most 255; `file` when nothing is left. */
const labelOf = (name) => clean(typeof name === 'string' ? name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1) : '', 255) ?? 'file';
/** A claim's owner as `{ pid, session }` (a pid is an integer above 0, a session a non-empty string, either may be null) or null when it has neither. */
function normOwner(o) {
  if (o === null || typeof o !== 'object') return null;
  const pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : null;
  const session = typeof o.session === 'string' && o.session.length > 0 ? o.session : null;
  return pid === null && session === null ? null : { pid, session };
}
/** Same Claude? An unknown side never differs; a known side differs only when neither the session nor the pid matches (`/clear` keeps the pid, `/compact` the session). */
const sameOwner = (a, b) => a === null || b === null || (a.session !== null && a.session === b.session) || (a.pid !== null && a.pid === b.pid);
/** A known owner taking over from the one a tray holds: a part the new one does not know (`null`) keeps the old value, so a half-known claim never erases a known pid or session. */
const mergeOwner = (cur, owner) => ({ pid: owner.pid ?? cur?.pid ?? null, session: owner.session ?? cur?.session ?? null });

/**
 * What the bytes are, from the magic at offset 0 (never from the name): `{ type, ext }` with type png|jpeg|gif|webp|pdf|text, or
 * `{ error: 'empty' }` / `{ error: 'wrong-type' }`. Text is strict UTF-8 without C0 controls (but tab, LF, CR), DEL and C1; its
 * extension is the name's, kept only when it is in TEXT_EXT, else `txt`. A PNG named `notes.txt` is stored as `.png`.
 */
export function sniff(buf, name) {
  if (!buf?.length) return { error: 'empty' };
  const image = imageTypeOf(buf); // PNG, JPEG, GIF or WebP: the one list of signatures lives in src/image.js
  if (image) return { type: image, ext: IMAGE_EXT[image] };
  if (buf.toString('latin1', 0, 5) === '%PDF-') return { type: 'pdf', ext: 'pdf' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { error: 'wrong-type' };
  }
  if (CONTROLS.test(text)) return { error: 'wrong-type' };
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(typeof name === 'string' ? name : '')?.[1].toLowerCase();
  return { type: 'text', ext: TEXT_EXT.has(ext) ? ext : 'txt' };
}

// A file nika never takes, whatever its bytes are (rule 4, the owner's "don't collect sensitive data"): by base name, any case, `.env`, `.env.*`,
// `.envrc`, `.envrc.*`, `*.key`, `*.pem`, the keystores `*.p12`, `*.pfx`, `*.jks` and `*.keystore`, the OpenVPN profiles `*.ovpn`, the credential files
// `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc` and `credentials` (exact base names; owner decision 2026-11-16), and the SSH private keys by exact name
// (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and the FIDO forms `id_ecdsa_sk`, `id_ed25519_sk`; never their `.pub` files, never another name that only
// starts with `id_`). A name that only contains one of the exact names (`netrc`, `.netrc.bak`, `credentials.txt`, `my-credentials`) is not on the list.
// public/attach.js keeps a copy of this pattern (browser code cannot import it); a test pins that the two agree.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)|\.netrc|\.git-credentials|\.pgpass|\.npmrc|credentials|.*\.(?:key|pem|p12|pfx|jks|keystore|ovpn))$/is;
/** True for the name (or the last part of a path) of a credential file (`.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ovpn`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `credentials`, an SSH private key), case-insensitive. */
export const isSecretName = (name) => typeof name === 'string' && SECRET_NAME.test(name.split(/[\\/]/).pop().trimEnd());

/** Step 1 of the upload: exactly `name` (a string, at most 255 UTF-16 units) and `data` (standard base64). null = fine, else the 400 (`secret-file` for a credential file's name). */
export function checkUploadBody(body) {
  const ok = body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 2 && Object.hasOwn(body, 'name') && Object.hasOwn(body, 'data')
    && typeof body.name === 'string' && body.name.length <= 255
    && typeof body.data === 'string' && body.data.length % 4 === 0 && BASE64.test(body.data);
  if (!ok) return fail(400, 'invalid');
  return isSecretName(body.name) ? fail(400, 'secret-file') : null;
}

/**
 * `env` picks the state dir; `loadKeepDays()` (default: `attachments.keepDays` of config.json, read at every prune) gives the days a
 * file stays; `setTimer(fn, ms)` returns a handle and `clearTimer(handle)` stops it (default: setInterval/clearInterval); `log(line)`
 * receives `nika: attachments: <code>` lines only.
 */
export function createAttachments({
  env = process.env, now = Date.now, loadKeepDays = async () => (await loadConfig(env)).config.attachments.keepDays,
  setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = clearInterval, log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const records = new Map(); // id -> { id, pane, key, path, type, size, at, sent }; only what this process issued, oldest dropped past RECORDS_MAX
  const trays = new Map(); // pane -> { key, owner, items: [{ id, name, gone? }] } (0.5.4, AT): memory only; the names are never written or logged
  const stamps = []; // admission times of the last minute
  let inflight = false;
  let writing = null; // the key folder the one save in flight writes into: no prune (startup, timer or the save's own) removes it
  let timer = null;
  const note = (err) => log(`nika: attachments: ${codeOf(err)}`);
  const rootDir = () => path.join(stateDir(env), 'attachments');
  const unmoved = async (p) => (await fs.realpath(p)) === p; // no folder on the way became a link since nika made the path

  /** The file check the send and the list share: the record's file is still the one nika wrote. Throws what openRegular or realpath throw. */
  async function intact(r) {
    const { handle, st } = await openRegular(r.path); // O_NOFOLLOW, regular, owned by the user, one link
    await handle.close(); // the content is never read back
    return st.size === r.size && (await unmoved(r.path)); // false: resized, or a folder on the way became a link
  }

  /** The removal of one own file: false for a moved folder or an absent file; throws for a symlink or a second link. Forgets the record. */
  async function deleteFile(r) {
    const dir = path.dirname(r.path);
    if (!(await unmoved(dir))) return false; // removeOwnFile looks at the last folder only
    const removed = await removeOwnFile(dir, path.basename(r.path));
    records.delete(r.id);
    return removed;
  }

  /** A new tray for the pane, the newest in the Map; at TRAYS_MAX the oldest is forgotten from memory only (its files wait for pruning). */
  function newTray(pane, key, owner) {
    trays.delete(pane);
    if (trays.size >= TRAYS_MAX) trays.delete(trays.keys().next().value);
    const t = { key, owner, items: [] };
    trays.set(pane, t);
    return t;
  }

  const dropGone = (t) => { t.items = t.items.filter((i) => !i.gone); };

  /**
   * The user removed or sent `id` on this pane: it leaves the tray, and so do the gone items (the "not restored" note ends). The tray goes
   * with its last item. Any id works for the note: a removal of an unknown id still ends it.
   */
  function release(pane, id) {
    const t = trays.get(pane);
    if (!t) return;
    t.items = t.items.filter((i) => i.id !== id && !i.gone);
    if (t.items.length === 0) trays.delete(pane);
  }

  /** The tray and its unsent files go (its session ended). Files that were sent are Claude's and stay; a refused removal is logged as a code and left for pruning. */
  async function dropTray(pane) {
    const t = trays.get(pane);
    if (!t) return;
    trays.delete(pane); // first, so a save or a list that runs meanwhile sees no tray
    for (const { id } of t.items) {
      const r = records.get(id);
      if (!r || r.sent || r.pane !== pane) continue; // gone, marked sent while this loop waited (Claude's now), or not this pane's record
      try {
        await deleteFile(r);
      } catch (err) {
        note(err);
      }
    }
  }

  /**
   * Prune (design 4.4). Only names nika writes, in real user-owned key folders, as regular single-link files, are looked at, and every
   * removal goes through src/fwrite.js (removeOwnFile for a file, removeOwnDir for an emptied key folder), which follow nothing. The folder in `writing` is never removed.
   * Never throws; `full` = still over a cap for `need` more bytes (and one more file) after removing everything that may go;
   * `failed` = the caps could not be checked (an error at the top level, or a key folder that could not be listed): a save then refuses.
   */
  async function sweep(need = 0) {
    const out = { removed: 0, total: 0, full: false, failed: false };
    const root = rootDir();
    try {
      try {
        await fs.lstat(root);
      } catch (err) {
        if (err.code === 'ENOENT') return out;
        throw err;
      }
      await ensureDir(root); // a symlink, a foreign owner or a group/world-writable root is refused here
      const keepMs = (await loadKeepDays()) * DAY;
      const t = now();
      const drop = async (dir, name) => {
        try {
          if (!(await removeOwnFile(dir, name))) return false;
          records.delete(name.slice(0, 16));
          out.removed += 1;
          return true;
        } catch (err) {
          if (err.code !== 'ENOENT') note(err);
          return false;
        }
      };
      const files = [];
      const folders = [];
      for (const key of await fs.readdir(root)) {
        if (!PROJECT_KEY.test(key)) continue;
        const dir = path.join(root, key);
        const st = await fs.lstat(dir).catch(() => null);
        if (!st?.isDirectory() || !isMine(st)) continue; // a symlink, a file or a foreign folder is never followed or counted
        folders.push({ key, dir });
        let names;
        try {
          names = await fs.readdir(dir);
        } catch (err) {
          note(err);
          out.failed = true; // this folder's files are missing from the total
          continue;
        }
        for (const name of names) {
          const isTmp = TMP_NAME.test(name);
          if (!isTmp && !FILE_NAME.test(name)) continue;
          const f = await fs.lstat(path.join(dir, name)).catch(() => null);
          if (!f?.isFile() || !isMine(f) || f.nlink !== 1) continue;
          const expired = t - f.mtimeMs > (isTmp ? TMP_MAX_AGE : keepMs);
          if (!(expired && (await drop(dir, name))) && !isTmp) files.push({ dir, name, size: f.size, at: f.mtimeMs }); // one that would not go still counts
        }
      }
      let total = files.reduce((n, f) => n + f.size, 0);
      let count = files.length;
      const over = () => total + need > TOTAL_MAX || count + (need ? 1 : 0) > FILES_MAX;
      files.sort((a, b) => a.at - b.at); // oldest first
      for (const f of files) {
        if (!over() || t - f.at < EVICT_MIN_AGE) break; // sorted: every later file is younger than the first one that is too young
        if (await drop(f.dir, f.name)) {
          total -= f.size;
          count -= 1;
        }
      }
      for (const { key, dir } of folders) {
        if (key === writing) continue;
        try {
          await removeOwnDir(dir); // an empty folder only (a non-empty one stays), looked at with lstat and never followed (R3 F4)
        } catch (err) {
          note(err); // swapped for a link or a file since it was listed: left alone, a code in the log
        }
      }
      out.total = total;
      out.full = over();
    } catch (err) {
      note(err);
      out.failed = true;
    }
    return out;
  }

  /** Steps 5 to 11 of the upload; `buf` is a Buffer (the decoded body of an upload, or the bytes the file chooser read). */
  async function store({ pane, key, name, buf }) {
    if (!Buffer.isBuffer(buf)) return fail(400, 'invalid');
    if (buf.length > MAX_BYTES) return fail(413, 'too-big');
    const kind = sniff(buf, name);
    if (kind.error) return fail(kind.error === 'empty' ? 400 : 415, kind.error);
    let dir;
    try {
      const root = rootDir();
      await ensureDir(root);
      dir = await fs.realpath(await ensureDir(path.join(root, key)));
    } catch (err) {
      note(err);
      return isDiskFull(err) ? fail(507, 'disk-full') : fail(409, 'folder-unsafe');
    }
    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.${kind.ext}`;
    const target = path.join(dir, file);
    if (!PATH_OK.test(target)) return fail(409, 'path-unusable');
    const swept = await sweep(buf.length);
    if (swept.failed) return fail(507, 'disk-full'); // the caps could not be checked: refuse rather than write past them
    if (swept.full) return fail(507, 'storage-full');
    try {
      await writeAtomic(dir, file, buf, { mode: 0o600 }); // unlinks its temp file when it fails
    } catch (err) {
      note(err);
      return isDiskFull(err) ? fail(507, 'disk-full') : fail(500, 'write-failed');
    }
    records.set(id, { id, pane, key, path: target, type: kind.type, size: buf.length, at: now(), sent: false });
    if (records.size > RECORDS_MAX) records.delete(records.keys().next().value);
    let tray = trays.get(pane);
    if (!tray || tray.key !== key) tray = newTray(pane, key, null); // a direct call: the routes bind the tray first
    dropGone(tray); // the user adds a file: the "not restored" note ends
    tray.items.push({ id, name: labelOf(name) });
    return { status: 200, body: { id, type: kind.type, size: buf.length } };
  }

  function stop() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  /**
   * The admission every save passes, whichever door it came through (the upload route, or the file chooser's reads): the pane and key
   * shapes, the rate limit and the one save at a time. `buf()` makes the bytes only once the save is admitted.
   */
  async function admitted({ pane, key, name }, buf) {
    if (typeof pane !== 'string' || !PANE_ID.test(pane)) return fail(404, 'not_found');
    if (typeof key !== 'string' || !PROJECT_KEY.test(key)) return fail(409, 'no-project');
    const tray = trays.get(pane);
    if (tray && tray.key === key && tray.items.filter((i) => !i.gone).length >= PER_MESSAGE) return fail(409, 'tray-full'); // before the rate slot: a refusal uses none
    const t = now();
    while (stamps.length && t - stamps[0] >= 60_000) stamps.shift();
    if (inflight || stamps.length >= UPLOADS_PER_MIN) return fail(429, 'busy'); // checked and set before any await: two calls cannot both pass
    stamps.push(t);
    inflight = true;
    writing = key;
    try {
      return await store({ pane, key, name, buf: buf() });
    } finally {
      writing = null;
      inflight = false;
    }
  }

  return {
    /** Design 3.2 steps 4 to 11. `pane` and `key` come from nika's own snapshot, never from the request; resolves `{ status, body }`. */
    async save({ pane, key, name, data }) {
      const bad = checkUploadBody({ name, data });
      if (bad) return bad;
      return admitted({ pane, key, name }, () => Buffer.from(data, 'base64'));
    },

    /** The same save for bytes the server read itself (the file chooser, W2-T6): `bytes` is a Buffer; every rule of save() applies. */
    saveBytes({ pane, key, name, bytes }) {
      return admitted({ pane, key, name }, () => bytes);
    },

    /** The send's file check (design 4.3): an unsent id this process issued for this pane, whose file is still the one nika wrote. */
    async lookup(pane, id) {
      const r = records.get(id);
      if (!r || r.pane !== pane || r.sent) return null;
      try {
        if (!(await intact(r))) return null;
        return { id: r.id, path: r.path, type: r.type, size: r.size };
      } catch (err) {
        note(err);
        return null;
      }
    },

    /**
     * The one read-back (0.5.1, C; T61): the bytes of an own, unsent IMAGE of this pane as `{ type, data }` (base64), for the page's viewer; null for
     * every miss, so the route is no oracle (unknown or malformed id, another pane's, sent, not an image type, file gone, swapped, linked, resized, moved
     * or no longer the type it was). Two reads at a time; the record is checked again once a slot is free. A failure is logged as its code only.
     */
    async readImage(pane, id) {
      const open = () => {
        const r = records.get(id);
        return r && r.pane === pane && !r.sent && IMAGE_TYPES.includes(r.type) ? r : null;
      };
      if (!open()) return null;
      return imageLimited(async () => {
        const r = open(); // sent or removed while it waited
        if (!r) return null;
        let opened;
        try {
          opened = await openRegular(r.path); // O_NOFOLLOW, regular, owned by the user, one link
        } catch (err) {
          note(err);
          return null;
        }
        try {
          if (opened.st.size !== r.size || r.size > MAX_BYTES) return null;
          const buf = Buffer.alloc(r.size);
          let got = 0;
          while (got < buf.length) {
            const { bytesRead } = await opened.handle.read(buf, got, buf.length - got, got);
            if (bytesRead === 0) break;
            got += bytesRead;
          }
          if (got !== buf.length || !(await unmoved(r.path)) || imageTypeOf(buf) !== r.type) return null;
          return { type: r.type, data: buf.toString('base64') };
        } catch (err) {
          note(err);
          return null;
        } finally {
          await opened.handle.close();
        }
      });
    },

    /** Deletes an unsent file of this pane now. false for unknown, another pane's, sent, already gone or refused (no oracle). */
    async remove(pane, id) {
      release(pane, id); // the chip is gone for good, even when the removal below is refused
      const r = records.get(id);
      if (!r || r.pane !== pane || r.sent) return false;
      try {
        return await deleteFile(r);
      } catch (err) {
        note(err); // a symlink or a second link: the file stays for pruning, which refuses it again
        return false;
      }
    },

    /** After the Enter: these files are Claude's now and can no longer be looked up or removed (pruning still ages them out). */
    markSent(ids) {
      for (const id of ids ?? []) {
        const r = records.get(id);
        if (!r) continue;
        r.sent = true;
        release(r.pane, id);
      }
    },

    /** Is there a tray for this pane? Synchronous, no I/O. */
    hasTray: (pane) => typeof pane === 'string' && trays.has(pane),

    /**
     * Binds the pane's tray to its project key and the Claude in it (`claim` = `{ key, owner }` from nika's own snapshot, never a request): makes the tray if there is none,
     * keeps it (taking a known owner) when key and owner agree, and drops it, deleting its unsent files, when they do not. Never rejects.
     */
    async bindTray(pane, claim) {
      try {
        if (typeof pane !== 'string' || !PANE_ID.test(pane) || typeof claim?.key !== 'string' || !PROJECT_KEY.test(claim.key)) return;
        const owner = normOwner(claim.owner);
        const t = trays.get(pane);
        if (t && (t.key !== claim.key || !sameOwner(t.owner, owner))) await dropTray(pane);
        const cur = trays.get(pane);
        if (!cur) newTray(pane, claim.key, owner);
        else if (owner !== null) cur.owner = mergeOwner(cur.owner, owner);
      } catch (err) {
        note(err);
      }
    },

    /**
     * The pane's unsent files for the session window: `{ files: [{ id, name, type, size }], gone: [name] }`. No tray lists empty and makes none; a tray of another key or
     * another Claude is dropped first (its files deleted). Each item gets the send's file check; a miss is marked gone, keeps its place and is listed again until the
     * user adds, removes or sends something on the pane. Never rejects.
     */
    async listTray(pane, claim) {
      const out = { files: [], gone: [] };
      try {
        if (typeof pane !== 'string' || !PANE_ID.test(pane) || typeof claim?.key !== 'string' || !PROJECT_KEY.test(claim.key)) return out;
        const owner = normOwner(claim.owner);
        const t = trays.get(pane);
        if (!t) return out;
        if (t.key !== claim.key || !sameOwner(t.owner, owner)) {
          await dropTray(pane);
          return out;
        }
        if (owner !== null) t.owner = mergeOwner(t.owner, owner);
        if (t.items.length === 0) {
          trays.delete(pane);
          return out;
        }
        const checked = [];
        for (const item of [...t.items]) {
          let r = null;
          const rec = records.get(item.id);
          if (rec && rec.pane === pane && !rec.sent) { // the send's check: the record exists, is this pane's and unsent (a gone item's record was deleted when it was marked, so it stays gone)
            try {
              if (await intact(rec)) r = rec;
            } catch (err) {
              if (err?.code !== 'ENOENT') note(err); // an expired or removed file is normal
            }
          }
          checked.push([item, r]);
        }
        if (trays.get(pane) !== t) return out; // dropped or emptied while the files were checked
        for (const [item, r] of checked) {
          if (!t.items.includes(item)) continue; // removed or sent meanwhile
          if (r) {
            out.files.push({ id: item.id, name: item.name, type: r.type, size: r.size });
            continue;
          }
          item.gone = true;
          records.delete(item.id);
          out.gone.push(item.name);
        }
      } catch (err) {
        note(err);
        return { files: [], gone: [] };
      }
      return out;
    },

    /** For every tray whose pane `isGone(pane)` names (gone from tmux, or dead): the tray goes and its unsent files are deleted. Resolves how many; never rejects. */
    async dropPanes(isGone) {
      let n = 0;
      try {
        if (typeof isGone !== 'function') return 0;
        for (const pane of [...trays.keys()]) {
          if (!isGone(pane)) continue;
          await dropTray(pane);
          n += 1;
        }
      } catch (err) {
        note(err);
      }
      return n;
    },

    async prune({ need = 0 } = {}) {
      const { removed, total } = await sweep(need);
      return { removed, total };
    },

    /** Prunes now and every 24 h (the timer is unref'd). Resolves when the first prune is done; it never rejects. */
    start() {
      stop();
      timer = setTimer(() => sweep(), PRUNE_EVERY); // sweep never rejects
      timer?.unref?.();
      return sweep().then(() => {});
    },

    stop,
  };
}
