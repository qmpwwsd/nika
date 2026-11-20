// The in-page image viewer (nika 0.5.1 item C; design DES-A sections 1.5, 2.1, 2.6 and 2.7, docs/design/spec.md 9.18).
// Screenshots you paste, drop or pick, and images in the Transcript, open large over the page in a native modal <dialog>. The page holds the
// markup (<dialog id="img-dlg"> with #img-h, #img-meta, #img-x, #img-full, #img-state, #img-state-t, #img-retry, #img-close: see session.html);
// this file fills it. Bytes come from the app tier as { type, data } (base64 JSON): dataUrlOf turns that into a data URL only when the type is one
// of the four known and the data is plain base64, and the URL is set as the <img> source and nowhere else (never in markup). Every line the viewer
// shows comes from imageLine (fixed copy keyed by status): the server's own words are never displayed. Every string is text (textContent and
// attributes, never markup); no inline style (the page's stylesheet sizes the picture); the file does nothing at import.
// Keep this file ASCII: write every symbol as an escape.

/** The four image types nika shows, by the short name the routes use. SVG is never one of them. */
export const IMAGE_MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });
/** The most base64 characters the page accepts: 8 MiB decoded (src/image.js B64_MAX is the server's copy). */
export const B64_MAX = 11184812;
/** The most transcript thumbnails one window loads (session.js counts them). */
export const MAX_THUMBS = 24;
/** 0.5.4 SF (RV051 M1): the most decoded bytes the held thumbnails add up to (session.js sums each tile's declared size; one without a size counts as the 8 MiB largest). */
export const MAX_THUMB_BYTES = 32 * 1024 * 1024;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([\s\S]*)$/;

/** The route's answer { type, data } as 'data:<mime>;base64,<data>', or null unless the type is a key of IMAGE_MIME and data is 4 to B64_MAX characters of base64 (a multiple of 4). */
export function dataUrlOf(body) {
  const type = body?.type;
  const data = body?.data;
  if (typeof type !== 'string' || !Object.hasOwn(IMAGE_MIME, type)) return null;
  if (typeof data !== 'string' || data.length < 4 || data.length > B64_MAX || data.length % 4 !== 0 || !B64.test(data)) return null;
  return `data:${IMAGE_MIME[type]};base64,${data}`;
}

/** A size in words: '0 B' to '1023 B', then '841 KB' (whole, 1024-based), from 1 MB '1.2 MB' (one decimal). A negative, fractional or non-number gives ''. */
export function sizeLabel(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = Math.round(bytes / 1024);
  return kb < 1024 ? `${kb} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

const GENERIC = 'The image could not be loaded.';
const LINES = new Map([
  [404, 'This image is no longer available.'],
  [413, 'This image is too large to show here (over 8 MB).'],
  [415, 'nika shows PNG, JPEG, GIF and WebP images only.'],
  ['loading', 'Loading image\u2026'],
  ['decode', 'The image data could not be shown.'],
]);

/** The fixed line for a state: an HTTP status (404, 413, 415, or anything else), 'loading' or 'decode'. Anything unknown gives the generic line; never server text. */
export const imageLine = (status) => LINES.get(status) ?? GENERIC;

const hide = (node, on) => {
  if (on) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
};
const NO_RETRY = new Set([404, 413, 415]); // the same request would give the same answer

/**
 * The viewer on the page's <dialog id="img-dlg">: { open({ name, meta, src, load, opener }), close(), isOpen() }.
 * - open shows the dialog modally (focus on the X button) with `name` as the heading and the picture's alt text and `meta` beside it (the natural
 *   size is added once the picture has loaded). `src` is an already built data URL (checked again here); else `load()` -> Promise<{ status, body }>
 *   is called, with a loading line first; a 200 whose body passes dataUrlOf shows the picture, 404, 413 and 415 show their fixed lines, status 0, a
 *   server error or any other status shows the generic line and a Retry button (which calls `load` again), and a body that is not a good image shows
 *   the 415 line. With neither, the 404 line shows. The returned promise settles when the load is over and never rejects. An answer for an earlier open,
 *   or for a viewer closed meanwhile, is dropped.
 * - The picture failing to decode shows the decode line (no Retry: the bytes would be the same).
 * - Esc (the browser's own cancel), the X, the Close button and a click on the backdrop close it; focus goes back to `opener` when it is still on the
 *   page, else to the message box (#composer). The picture is dropped from the page on close, so a big data URL is not kept.
 */
export function createImageViewer({ dialog } = {}) {
  if (!dialog || typeof dialog.showModal !== 'function' || typeof dialog.addEventListener !== 'function') throw new TypeError('the image viewer needs its dialog element');
  const get = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the image viewer needs #${id} in the page`);
    return node;
  };
  const E = { head: get('img-h'), meta: get('img-meta'), x: get('img-x'), full: get('img-full'), state: get('img-state'), text: get('img-state-t'), retry: get('img-retry'), close: get('img-close') };
  const icon = E.state.firstElementChild; // the warning icon in front of the line: hidden while loading
  const S = { gen: 0, load: null, opener: null, meta: '', shown: false };

  // The state line is a role="status" live region, so it is never hidden: one that goes from hidden to visible together with its text may not be
  // announced. It stays rendered and only its text changes (empty when there is nothing to say; the icon and Retry are hidden then).
  /** The state line: `text`, with the warning icon unless `warn` is false, and the Retry button when `retry` is true. */
  const note = (text, { warn = true, retry = false } = {}) => {
    E.text.textContent = text;
    if (icon) hide(icon, !warn);
    hide(E.retry, !retry);
  };
  /** Nothing to say: the text empty, no icon, no Retry. The element itself stays in place. */
  const clearNote = () => {
    E.text.textContent = '';
    if (icon) hide(icon, true);
    hide(E.retry, true);
  };
  const hideImage = () => {
    S.shown = false;
    E.full.removeAttribute('src');
    hide(E.full, true);
  };
  const showImage = (url) => {
    E.full.setAttribute('src', url);
    hide(E.full, false);
    S.shown = true;
    clearNote();
  };
  const fail = (status) => {
    hideImage();
    note(imageLine(status), { retry: S.load !== null && !NO_RETRY.has(status) });
  };

  async function run(gen, load) {
    hideImage();
    note(imageLine('loading'), { warn: false });
    let r = null;
    try {
      r = await new Promise((resolve) => { resolve(load()); }); // a load that throws at once is a lost request too
    } catch {
      r = null;
    }
    if (gen !== S.gen) return;
    const status = Number.isInteger(r?.status) ? r.status : 0;
    if (status !== 200) {
      fail(status);
      return;
    }
    const url = dataUrlOf(r.body);
    if (url === null) fail(415);
    else showImage(url);
  }

  /** A data URL the page built itself: one of the four types and the same checks as dataUrlOf, else it is not shown. */
  const checkedSrc = (src) => {
    const m = typeof src === 'string' ? DATA_URL.exec(src) : null;
    return m !== null && dataUrlOf({ type: m[1], data: m[2] }) === src ? src : null;
  };

  function open({ name, meta, src, load, opener } = {}) {
    const title = typeof name === 'string' && name ? name : 'Image';
    S.gen += 1;
    const gen = S.gen;
    S.opener = opener ?? null;
    S.meta = typeof meta === 'string' ? meta : '';
    S.load = src === undefined || src === null ? (typeof load === 'function' ? load : null) : null;
    E.head.textContent = title;
    E.meta.textContent = S.meta;
    E.full.setAttribute('alt', title);
    hideImage();
    if (!dialog.open) dialog.showModal();
    E.x.focus();
    if (src !== undefined && src !== null) {
      const url = checkedSrc(src);
      if (url === null) fail(415);
      else showImage(url);
      return Promise.resolve();
    }
    if (S.load === null) {
      fail(404);
      return Promise.resolve();
    }
    return run(gen, S.load);
  }

  const close = () => {
    if (dialog.open) dialog.close();
  };

  dialog.addEventListener('close', () => {
    S.gen += 1; // an answer still on its way is dropped
    S.load = null;
    hideImage();
    clearNote();
    const o = S.opener;
    S.opener = null;
    if (o && o.isConnected !== false && typeof o.focus === 'function') o.focus();
    else document.getElementById('composer')?.focus();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // only the backdrop: everything inside the dialog is a child
  E.x.addEventListener('click', close);
  E.close.addEventListener('click', close);
  E.retry.addEventListener('click', () => {
    const load = S.load;
    if (typeof load !== 'function') return; // closing clears it, so a Retry that outlives the dialog does nothing
    S.gen += 1;
    E.x.focus(); // the Retry button is about to hide: focus must not fall out of the modal
    run(S.gen, load);
  });
  E.full.addEventListener('load', () => {
    if (!S.shown) return;
    const w = E.full.naturalWidth;
    const ht = E.full.naturalHeight;
    if (!(Number.isInteger(w) && w > 0 && Number.isInteger(ht) && ht > 0)) return;
    E.meta.textContent = S.meta ? `${S.meta} \u00b7 ${w} \u00d7 ${ht}` : `${w} \u00d7 ${ht}`;
  });
  E.full.addEventListener('error', () => {
    if (!S.shown) return;
    hideImage();
    note(imageLine('decode'));
  });

  return { open, close, isOpen: () => dialog.open === true };
}
