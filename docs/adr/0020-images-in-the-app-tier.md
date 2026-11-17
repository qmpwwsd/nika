# ADR 0020 — Images in the app tier: base64 JSON, `data:` URLs, long lines read whole

Date 2026-11-17 · Status accepted (nika 0.5.1, C; owner decision Q1, 2026-11-17)

## Context
The session window shows Claude's transcript, but a message's picture is invisible today:

- **Images are skipped.** `image` content blocks (a pasted screenshot, a Read of a PNG) and `image` parts of a tool result produce no entry, so
  the history shows the `[Image #N]` text and nothing else.
- **Long lines are lost.** An image travels in the transcript as base64 on one line. The history reads a 1 MiB window per request and skipped
  any single line longer than that, so a screenshot's whole message vanished from the history, text included.
- **A composer chip has no picture.** An attachment the user adds before Send shows a name and a size; the owner wants a thumbnail.

Constraints that stay: the page is served with a strict CSP (`img-src 'self' data:`, no inline script or style); every app route needs the
per-launch secret in the `X-Nika-App` header, which an `<img src>` cannot send; the server has zero npm dependencies; a transcript is
agent-writable, so every byte in it is untrusted (`docs/security.md` T59, T60, T61; rules 4, 6 and 9).

## Decision
- **Base64 JSON, not a raw image route.** Three app-tier routes answer `{ type, data }` with `no-store` and `nosniff`:
  `GET /api/app/session/:id/image/:ref`, `GET /api/app/session/:id/subagents/:agentId/image/:ref` and
  `GET /api/app/pane/:id/attachments/:att/image` (`docs/contracts/api-app.md`). The page fetches them with its normal authenticated call.
- **`data:` URLs on the page.** The page builds `data:<MIME from a fixed table>;base64,<validated base64>` and sets it as an `<img src>`
  only, never in markup. The CSP does not change.
- **The server decides what an image is** (`src/image.js`): base64 source only; the declared type must be PNG, JPEG, GIF or WebP; the bytes'
  magic number must match it; at most 8 MiB decoded; never SVG. The server re-encodes the bytes it decoded, so the transcript's own string never reaches the page.
- **The request names an offset, never a path.** `ref` is `<line offset>:<block>[.<part>]`, the same text as a history entry's `id` or an
  `images[].ref`. The file comes from nika's transcript index by session id (and the subagent listing for an agent id).
- **History lists pictures without reading them.** An `image` entry carries `media` and an estimated `size` (from the base64 length); a tool result
  carries up to 8 `images[]` and `imagesMore`. Nothing is decoded while paging.
- **Long lines are read whole**, up to 16 MiB with the start searched at most 32 MiB back. One long or image read runs at a time, inside the
  existing 4-slot limiter; a 16-entry cache keyed by device, inode and line end holds parsed entries (copies, never bytes) for lines that end
  with a newline.
- **One stored file is served back**: an unsent image attachment of the asking pane, after the same open, size, place and magic-byte checks
  the send uses, with one 404 for every miss. No other kind of file is ever served. This amends ADR 0016 (which built no thumbnails and no read-back).

## Alternatives
- **A raw image route with a cookie or a token in the URL.** Rejected: an `<img>` cannot send `X-Nika-App`; a cookie would be a second credential
  that every local page could trigger requests with, and the secret never touches a URL, a cookie or markup (rule 10).
- **`blob:` URLs** (fetch, `URL.createObjectURL`). Rejected: needs `blob:` in `img-src`, a CSP change on a page that has none; the memory
  saved over a `data:` URL does not matter at 8 MiB and 24 thumbnails.
- **Thumbnails made on the server.** Rejected: needs an image library (against the zero-dependency rule) or a decoder written by us for four formats, and a
  decoder of untrusted bytes in the server is a bigger risk than handing the bytes to the webview's own decoder.
- **Serve the transcript's base64 string as it is.** Rejected: unused bits in the last character and any whitespace or variation would pass through;
  the server decodes, checks and encodes its own string.
- **Skip long lines as before and show a placeholder.** Rejected: the owner's screenshots are exactly those lines, and the message's text is lost with them.

## Consequences
- The page can show a transcript's pictures and a thumbnail on every image chip, from one authenticated call each (lazy, at most 24 per window).
- A decoder bug in WebKit for one of the four formats is the residual exposure, the same as any image the user opens (T59).
- A page of history that holds a long line can cost up to 16 MiB of reading and parsing, and a step-back scan up to 32 MiB; limits, the single long slot
  and the cache bound it (T60). The cache would serve stale entries only if a transcript were rewritten in place at the same size (it is append-only).
- The attachment store gains its first read-back (T61); `docs/security.md` T38 and the rules' file list say so. The browser tier gets none of it:
  all three routes are absent there (404).
- Not built: SVG, HEIC, TIFF, BMP, video, PDF thumbnails, saving or copying an image from the viewer, a `blob:` path.
