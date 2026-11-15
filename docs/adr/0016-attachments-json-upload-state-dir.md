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
  before sending, when the window closes with them unsent, after `attachments.keepDays` (1 to 30, default 7, in Settings), and oldest
  first beyond 256 MiB or 500 files (never one younger than 1 h).
- **Nothing reaches Claude before Send.** Chips live in the page and in the state folder. Send is the draft push (unchanged), then
  `POST /api/app/pane/:id/attach-send { ids, base }`: under the pane lock nika pastes each stored path after the text (one bracketed
  paste per file, an image path alone, a non-image path with one leading space after text), re-reads the box before every paste and
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
  file attached by mistake goes at once when it is removed or the window closes.
- The store is capped at 256 MiB and 500 files in all. A full store refuses the next upload (507 `storage-full`); older files go
  after a day or two.
- A state path with a space or another special character cannot be pasted as one token: attachments refuse with 409
  `path-unusable` and a line that names `XDG_STATE_HOME`.
- The transcript keeps images as base64 and the paths (Claude's storage, not nika's). A process of the same user can read or swap
  a stored file (single-user model, rule 10). `docs/security.md` T38, T55 and residual risk o record the rest.
- Not built: thumbnails, serving a file back, attachments on the browser tier, a Retry button on a failed chip, long text with
  attachments (text over the sync envelope is refused: "send the text first, then the attachments"), Shell with attachments, SVG,
  HEIC, TIFF and archives, per-session folders.
