# ADR 0016 — Attachments: a JSON upload into nika's state folder, and the paths pasted at Send

Date 2026-11-14 · Status accepted (nika 0.5, W2)

## Context
The session window's message box mirrors Claude's input box (draft sync, W5). The owner wants to attach images, PDFs and text files
to a message, the way the terminal takes them: Claude Code shows a pasted image path as `[Image #N]`, and reads a pasted path of
another file with its Read tool. That raises five questions:

- **How do the bytes get from the page to the disk?** Rule 10 says writes are JSON, and the app tier is the only place with a
  secret. A file may be up to 8 MiB.
- **Where do they live, and who may read them?** Rule 5 says no path ever comes from a request. Rule 11 says nika writes only
  through `src/fwrite.js`, into its own folders, and into a project only for the rules apply.
- **When do the paths go into Claude's input?** A pasted image turns the box into `[Image #N]`, which draft sync reads as
  `unreadable: pasted` (W5): the sync would stay paused for the whole composition.
- **Who presses `Enter`, and after which check?** After the pastes the box is unreadable, so the page's Send table cannot be used.
- **What does Claude do with a file outside the project?** Under default settings it asks first.

The live facts are spike S4 (`docs/contracts/claude-tui.md` §11): a pasted PNG path becomes `[Image #N]` at once and the image
travels in the user message; a PDF or text path stays text and Claude reads it with Read; a path outside the working directory
prompts under default settings (no prompt under the user's own allow rules); answering No cuts the whole turn.

## Decision
- **Upload = JSON.** `POST /api/app/pane/:id/attachments { name, data }`, `data` standard base64, body at most 12 MiB, one upload at a
  time and 30 a minute server-wide. The type comes from the bytes only (PNG, JPEG, GIF, WebP, PDF, or strict UTF-8 text without
  controls); the page's file type and the plan's `mime` field are not used. The user's file name never reaches the disk: only an
  extension from a fixed list, for a text file.
- **Storage.** `<state>/attachments/<key>/<id>.<ext>`, folders 0700, files 0600, `<key>` the pane's repository key from nika's own
  snapshot (never from the request), `<id>` 16 random hex. Written by `writeAtomic`, deleted by `removeOwnFile`. Per-repo folders keep
  Claude's "allow reading from this folder during this session" to that repo's attachments. Files go when the user removes them
  before sending, when the window closes with them unsent *(0.5.4: no longer; they go when their session ends, see the AT amendment at the end)*, after `attachments.keepDays` (1 to 30, default 7, in Settings), and oldest
  first beyond 256 MiB or 500 files (never one younger than 1 h).
- **Nothing reaches Claude before Send.** Chips live in the page and in the state folder. Send is the draft push (unchanged), then
  `POST /api/app/pane/:id/attach-send { ids, base }`: under the pane lock nika pastes each stored path after the text (one bracketed
  paste per file, an image path alone, every other path with one leading space, see the amendment of 2026-11-16), re-reads the box before every paste and
  reads each result back with whitespace ignored (`[Image #N]` for an image, the path for any other file), and presses `Enter`
  itself, once, after a last fresh check. The send names attachments by id, never by a path.
- **Fail closed, never clean up.** Any difference stops the sequence with a 409 that says how many pastes went in. nika never clears
  a box it pasted into (it cannot read it back: owner rule of W5); the page keeps the text and the chips, and says what to do.
- **While Claude works too** (W13, ADR 0019, owner decision 2026-11-15): the send has no registry-state check; Claude queues the
  message with its images. The other checks stay.
- **The Read prompt stays the user's.** For a PDF or text file Claude asks to read a path outside the project; the existing prompt
  panel shows it and nothing is answered for the user. After a send that held such a file the page shows one notice.
- **Nothing is served back.** No route returns an attachment; no thumbnails, no previews.
- **The paperclip uses nika's own chooser** (W2-T6, owner decision 2026-11-15). The webview's `<input type="file">` freezes the app on
  macOS (wry runs a modal open panel inside a WebKit callback), so the page has none. The button asks the server
  (`POST …/attachments/pick { room }`), the server asks the shell for its native dialog (`pick-files` / `files`, the same single
  slot as Add project's folder chooser), reads the picked files itself through `fsafe` (O_NOFOLLOW, regular file, owned by the user,
  one link, at most 8 MiB from the fstat) and stores the bytes like an upload. The picked path travels from the shell to the server
  over stdio only and is dropped after the read. Paste and drop never use the chooser.
- **Tauri's own drag-and-drop handler is off** (`disable_drag_drop_handler`), so a file dropped on the message box reaches the page as
  an HTML5 drop; the page cancels drops anywhere else, and a `file:` navigation stays denied.

## Alternatives
- **Multipart or a raw body.** Breaks "JSON for writes" (rule 10) and the dispatcher's one body reader; base64 costs a third more
  bytes and is accepted for a cap of 8 MiB.
- **The shell's file dialog handing a path to the page, or a path in a request.** A path from outside the server's own checks
  (rule 5). The shipped chooser keeps the path between the shell and the server and reads the file there.
- **Storing in the project.** Rule 11 allows only the rules files there, and an attachment in the repo is git noise and a leak risk.
- **Pasting the path at attach time.** The box would read `[Image #N]` at once and pause the draft sync for the whole composition.
- **The keys route's `Enter`.** Its guard stops a bypass prompt only, not every prompt, and the box after the pastes is unreadable
  for its checks. A route that owns paste and `Enter` under one lock and one set of fresh checks is stricter.
- **Waiting for Claude to be idle before sending** (the first design, owner Q1). Replaced by the W13 decision above: with background
  agents the registry is almost never idle.

## Consequences
- Under default settings Claude asks before it reads a PDF or text file (the folder is outside the project). Option 2 of that
  prompt allows reading that repo's attachments folder for the session. Under the user's own allow rules there may be no prompt.
- nika keeps copies of the user's files on disk, in its state folder, for up to `keepDays` days; the Settings field says so. A
  file attached by mistake goes at once when it is removed or the window closes *(0.5.4: when it is removed, or its session ends; AT amendment)*.
- The store is capped at 256 MiB and 500 files in all. A full store refuses the next upload (507 `storage-full`); older files go
  after a day or two.
- A state path with a space or another special character cannot be pasted as one token: attachments refuse with 409
  `path-unusable` and a line that names `XDG_STATE_HOME`.
- The transcript keeps images as base64 and the paths (Claude's storage, not nika's). A process of the same user can read or swap
  a stored file (single-user model, rule 10). `docs/security.md` T38, T55 and residual risk o record the rest.
- Not built: thumbnails, serving a file back, attachments on the browser tier, a Retry button on a failed chip, long text with
  attachments (text over the sync envelope is refused: "send the text first, then the attachments"), Shell with attachments, SVG,
  HEIC, TIFF and archives, per-session folders.

## Amendment 2026-11-16 (0.5, final review): more refused names, a leading space for every non-image path, empty folders removed

- **More names are refused by name** (owner decision 2026-11-16), in the store, the chooser and the page's copy alike: `*.ovpn`, and the exact base names `.netrc`,
  `.git-credentials`, `.pgpass`, `.npmrc` and `credentials`, besides `.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore` and the
  SSH private key names. The name is compared after trimming trailing spaces. The chip line reads "nika doesn't attach .env, key, certificate or credential files." A
  name list is not a scan: a secret under another name is still taken (`docs/security.md` T38).
- **Every non-image path is pasted with one leading space**, also into an empty box. Without it a text file's path alone would begin with `/`, which Claude reads as a slash
  command. When the box was empty at the start, `attach-send` also checks after each paste and before the `Enter` that the text does not begin with `/`; else
  409 `screen-changed`, no `Enter`, and the box is left as it is. Checked live (spike S-F13, Claude 2.1.325): a pasted path keeps its leading space, no slash menu opens,
  and with `Enter` Claude reads the message as a prompt, not as a command (`docs/contracts/claude-tui.md` §11).
- **Empty folders go.** The prune removes a repository's empty `<key>` folder through `removeOwnDir` in `src/fwrite.js` (`lstat`, never a link, a real folder owned by
  the user, `rmdir`, so a folder that holds anything stays).
- **A page that goes into the back/forward cache keeps its chips.** `pagehide` with `persisted === true` no longer deletes the files of ready chips; a page that never
  returns leaves them to the expiry *(0.5.4: leaving the page of any kind deletes nothing; see the AT amendment)*. The attachment send waits for the redraw hold like Send does.
- **Not fixed, recorded:** the check that allows one upload at a time per pane runs after the request body is read, so several bodies of up to 12 MiB can sit in memory at
  once (the app secret is needed and admission is limited to 30 a minute); and a picked file on a hung network mount keeps the chooser slot busy until the mount
  answers (`docs/security.md` T38, T55 and residual o).

## Amendment 2026-11-20 (0.5.4, AT): the chips come back when you return to a session

- **Why.** The owner (2026-11-19): pasted files must not disappear when the chat is closed and opened again. The text came back, because it lives in
  Claude's own input box; the chips did not, because they lived only in the page, and leaving the page deleted their files (design W2's decision 9,
  made for privacy so that a file attached by mistake would not wait for `keepDays`; no owner answer is cited for it).
- **The server keeps a tray per pane, in memory** (owner answer Q1 = A, 2026-11-20: memory only; a tray file that survives a restart may come later on
  top). The ids of the pane's unsent files, in the order stored, with the last part of each file name through `clean()` as the chip's label (`src/attachments.js`).
  It is bound to the pane's repository key and to the one live Claude that claimed the pane, by its pid or by the session in the pane, so `/clear` and
  `/compact` keep it. At most 6 per pane (a 7th save is 409 `tray-full`, checked before the rate slot) and 64 trays. Nothing new is written to disk, and
  the file name still never reaches the disk.
- **`GET /api/app/pane/:id/attachments`** lists `{ files: [{ id, name, type, size }], gone: [name] }`. The page builds ready chips from it when the
  session window opens and when it comes back from the back/forward cache. A file whose copy is gone (expired, evicted, removed behind nika's back) is
  left out, and one note says so ("Not restored:", with its own colour tokens `--att-gone*` and icon `i-file-off`). A pane with no tray lists empty; the
  page waits at most 8 s for the list. The route takes no upload rate slot and does not stamp the pane for the typed `/compact` (ADR 0014 amendment).
- **Leaving the page deletes nothing.** Files go when the user removes them, sends them, when the session ends (the pane is gone or dead, or another
  Claude or project claims it), and after `keepDays`. This replaces "when the window closes with them unsent" and "A file attached by mistake goes at
  once when it is removed or the window closes" above.
- **Alternatives.** Browser storage (`localStorage`) for the ids and names: rejected, because the names would reach the webview's disk store and the
  restore would take ids and names from the page. A tray file on disk that also survives an app restart: not built (Q1 = A).
- **Consequences.** Unsent files can stay until `keepDays` when the user never comes back to a session whose pane stays open (`docs/security.md` T81).
  An app restart forgets the tray. A tmux restart that reuses a pane id, with no listing in between and no claim on one side, could show old chips in a
  new session (T80). The list is a route that serves names, never bytes (T82); the tray is bounded (T83).

## Amendment 2026-11-20 (0.5.4, LT): the unsent text comes back too

- **Why.** The owner (2026-11-20) added LT to 0.5.4: text longer than draft sync mirrors must survive leaving a session and coming back, like the
  chips. Text that fits survives because it sits in Claude's own input box. Text outside the sync's envelope lived only in the page: leaving lost it, or
  brought back the last shorter version that Claude's input still held. Owner answer Q1 = A: short text that is still waiting to go into Claude's input
  (no readable box, a paused sync, a held or failing write) is kept by the same mechanism.
- **The tray keeps one text per pane, in memory.** While the message box holds text the sync does not mirror, or text that waits, the page writes it with
  `PUT /api/app/pane/:id/kept-draft { text, shell }`; it clears it when the text goes to Claude (sent or mirrored), the terminal's text wins, or the box is
  emptied. `GET` of the same route gives it back when the session window opens again. The text shares the tray's binding (project key; the Claude in the
  pane by pid or session) and its end (the session ends, another Claude or project claims the pane, an app restart). At most 16 KB of UTF-8, Send's paste
  limit (`KEPT_CAP` 34 KB for the body); a longer text is not kept, and the page says so (the `over` note, `Not kept:`). Nothing is written to disk. The
  routes stamp nothing for the typed `/compact`.
- **Put back, never pushed over.** The page puts the text back only into an empty box the user has not typed in, or, on a return from the back/forward
  cache, into a box that still holds the copy this page saved (owner answer LT-BF = A), and never copies it into Claude's input by itself while Claude's
  input holds other text. A leave-time write counts as the copy this page saved only when it answered 200. Send works on it as on any text; nika still
  never clears Claude's input to make room (owner decision 2026-11-14).
- **A restore that cannot answer is tried again, a bounded number of times.** A restore that ended on 404, or stopped, is re-tried from the next captures
  (one GET per 2 s, at most 3 re-tries per chain; then `RESTORE_TEXT_FAILED` once and nothing asks again). A boot restore and a back/forward return are
  first tries, never re-tries; a return that arrives while a restore runs takes the server's copy once that restore ends. No capture re-try starts while a
  Send runs, and while a re-try is pending the page does not pull Claude's input and refuses Tab on a suggestion (`RESTORING_TEXT`).
- **Alternatives.** Browser storage: rejected for AT's reasons (the user's prompt would reach the webview's disk store). Typing long text into Claude's
  input in pieces: the envelope exists because nika cannot read such text back. A file in nika's state folder that survives a restart: not built; the
  owner chose memory only for AT (Q1 = A).
- **Consequences.** The user's unsent text lives in nika's memory until it is sent, cleared, its session ends or the app quits (`docs/security.md` T85).
  The tray's binding to the pane's project and its one live Claude is what keeps the text with its own session (T84), the route is no typing path (T86), and a clear that never arrives can bring a sent text back once (T87). Known limits: with two pages of the same pane, a returning page whose box holds text it
  never saved keeps its box and its save replaces the other page's copy; while a restore is unanswered, and after it fails until the next edit, typed
  text is not kept, a `pagehide` there sends nothing, and text typed in the seconds a re-try is pending replaces Claude's input text the box does not
  show; a GET that hangs holds Send and Tab for up to 3 s per re-try; another page's copy can be lost when a Send's clear fails while a save is in
  flight.

Details: `docs/design/spec.md` §9.27 and `docs/contracts/api-app.md` (the tray list and the kept-draft routes).
