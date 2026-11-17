// The images nika shows (0.5.1, C; ADR 0020; docs/security.md T59): PNG, JPEG, GIF and WebP, told apart by their magic bytes and never
// by a name or a declared type alone. Pure functions, no file access. A transcript is agent-writable, so a forged `image` block is the
// case this file is for: SVG and every other type is refused, the bytes must match the type the block declares, and the size is capped.
// attachments.js uses imageTypeOf for its four image types too, so there is one list of signatures. Keep this file ASCII.

export const IMAGE_MAX = 8 * 1024 * 1024; // decoded bytes, the same cap as an upload (attachments.js MAX_BYTES)
export const B64_MAX = 11184812; // 4 * ceil(IMAGE_MAX / 3): the most base64 characters that can decode to IMAGE_MAX bytes
/** The declared media types that are accepted, and the name each one has everywhere else (the `media` field, the route's `type`). */
export const IMAGE_MEDIA = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' });

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const fail = (status, error, message) => ({ status, error, message });
/** Do the bytes at `at` of `buf` spell `text` (a latin1 string)? */
const spells = (buf, at, text) => {
  for (let i = 0; i < text.length; i += 1) if (buf[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/**
 * What the bytes are, from the magic at offset 0: `'png' | 'jpeg' | 'gif' | 'webp'`, or null for anything else (SVG, PDF, text, a short
 * or empty buffer, a value that is not a buffer). PNG: the 8-byte signature. JPEG: FF D8 FF. GIF: `GIF87a` or `GIF89a`. WebP: `RIFF`, four
 * size bytes, `WEBP`.
 */
export function imageTypeOf(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 3) return null;
  if (buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && (spells(buf, 0, 'GIF87a') || spells(buf, 0, 'GIF89a'))) return 'gif';
  if (buf.length >= 12 && spells(buf, 0, 'RIFF') && spells(buf, 8, 'WEBP')) return 'webp';
  return null;
}

/**
 * The decoded size of base64 text, estimated from its length and its trailing `=` (nothing is decoded and no character is tested, so this
 * is safe to run on every image block while paging): `length / 4 * 3` minus the padding. Null when the value is not a string or its
 * length is not a multiple of 4.
 */
export function base64Size(data) {
  if (typeof data !== 'string' || data.length % 4 !== 0) return null;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, (data.length / 4) * 3 - pad);
}

/**
 * One transcript `image` content block (or one image part of a tool result) -> `{ type, bytes }` when it is a picture nika may show, else
 * `{ status, error, message }` (413 `too-large`, 415 `not-image`; the message is the code in words and carries nothing of the block).
 * Checks, in order: the source is base64; the declared media type is one of the four; the data is a string, not over B64_MAX (413), a
 * multiple of 4 and valid base64 (415); the decoded size is at most IMAGE_MAX (413); the bytes are the declared type (415).
 */
export function checkImageBlock(part) {
  const source = part?.source;
  if (source === null || typeof source !== 'object' || source.type !== 'base64') return fail(415, 'not-image', 'not a supported image');
  const declared = typeof source.media_type === 'string' && Object.hasOwn(IMAGE_MEDIA, source.media_type) ? IMAGE_MEDIA[source.media_type] : null;
  if (declared === null) return fail(415, 'not-image', 'not a supported image');
  const { data } = source;
  if (typeof data !== 'string') return fail(415, 'not-image', 'not a supported image');
  if (data.length > B64_MAX) return fail(413, 'too-large', 'image too large');
  if (data.length % 4 !== 0 || !BASE64.test(data)) return fail(415, 'not-image', 'not a supported image');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > IMAGE_MAX) return fail(413, 'too-large', 'image too large');
  if (imageTypeOf(bytes) !== declared) return fail(415, 'not-image', 'not a supported image');
  return { type: declared, bytes };
}
