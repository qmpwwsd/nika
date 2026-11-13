# Rules template

"Apply rules" copies a generic orchestration rules file into a registered project and wires it into the project's
`CLAUDE.md` and `AGENTS.md` (a project with only an `AGENTS.md` gets a new `CLAUDE.md` that imports it). Code: `src/rules.js`, `src/diff.js`, `src/fwrite.js`. Contract: `docs/contracts/api-app.md` §3 and §9;
write policy: ADR 0006.

## What gets written

Exactly these files, relative to the project folder (the realpath taken when the project was added):

| File | Change |
|---|---|
| `rules/orchestration.md` | the rendered template, with a marker line (below) |
| `AGENTS.md` | only an existing regular file: the same one line `@rules/orchestration.md` is appended (after a blank line) unless it is already there. nika never creates an `AGENTS.md` |
| `CLAUDE.md` | one line `@rules/orchestration.md` is appended (after a blank line) unless a line with exactly that text, ignoring surrounding spaces, is already there, or the file imports `AGENTS.md` (below); a new file is created when the project has none (its content is below) |
| `.claude/settings.local.json` | only `enabledPlugins` (below) |
| `.gitignore` | optional, off by default: one line `.claude/settings.local.json` when the file is not already covered |

Why both (0.4.0): other coding tools read `AGENTS.md`, Claude Code reads `CLAUDE.md` (it reads `AGENTS.md` only when the
project has no `CLAUDE.md`, or through an `@AGENTS.md` import, which "never makes Claude read `AGENTS.md` twice"). So both
files carry the rules, both appear in the preview, and Claude must still load the rules once. nika reads and writes
`AGENTS.md` only when it is a regular file, exactly like `CLAUDE.md` (safe read, hash, backup, modes). An *import line* is a
line that, trimmed, is exactly `@AGENTS.md` or `@./AGENTS.md`. The cases:

| The project has | nika writes |
|---|---|
| only a regular `AGENTS.md` | the rules line into `AGENTS.md`; a new `CLAUDE.md` whose whole content is `@AGENTS.md` |
| both, `CLAUDE.md` has no import line | the rules line into both |
| both, `CLAUDE.md` has an import line | the rules line into `AGENTS.md` only; `CLAUDE.md` is left as it is (the preview says "Gets the rules through @AGENTS.md."), even when it has no rules line: nika never adds one there, and never removes one |
| only a `CLAUDE.md` (even with an import line and no `AGENTS.md`) | the rules line into `CLAUDE.md` |
| neither | a new `CLAUDE.md` with `@rules/orchestration.md` |
| a symlink, folder or FIFO named `AGENTS.md`, and a `CLAUDE.md` | `AGENTS.md` is listed as skipped with a note and not followed; the rules line goes into `CLAUDE.md` |
| a symlink (or folder, FIFO) named `AGENTS.md`, and no `CLAUDE.md` | nothing: the apply is refused (`ESYMLINK` / `ENOTREG`) |

`AGENTS.md` is written before `CLAUDE.md`, so a `CLAUDE.md` that imports it never lands while it lacks the rules line. A
project's rules badge reads current only when the rules file is current and every regular instruction file carries the rules
(`CLAUDE.md` has the line, or imports `AGENTS.md` while `AGENTS.md` has it; a regular `AGENTS.md` has it). If
`AGENTS.md` appears, disappears, changes or changes type between the preview and the apply, the apply is refused and nothing
is written.

nika never runs git. Nothing is committed, staged or pushed. Folders it creates are 0755. File modes never widen: a file
that exists keeps its mode with group and other write bits cleared (`mode & ~0o022`, so an existing 0600
`settings.local.json` stays 0600 and a 0664 `CLAUDE.md` becomes 0644). A new `.claude/settings.local.json`
is 0600; a new `rules/orchestration.md`, `CLAUDE.md` or `.gitignore` is 0644. Writes go through
`checkComponents` → backup → `ensureDir` → `writeAtomic`. `rules/` and `.claude/` must be absent or real folders;
targets must be absent or regular, user-owned files with one link. A symlink, hard link, FIFO or file-where-a-folder-should-be
refuses the whole apply with the fwrite error code (`ESYMLINK`, `ENLINK`, `ENOTREG`, `ENOTDIR`); every check and backup
runs before the first write, so a refusal leaves the project untouched. A project folder that is world-writable is always
refused; a group-writable one is accepted only on Linux when its group is the user's primary group.

## Template and placeholders

The built-in template is `templates/orchestration.md`. A placeholder is `{{dotted.key}}` (letters and digits, dots between
parts; spaces inside the braces are allowed). Values come from `config.json` (already validated) and the project's plugin
selection; there is no escaping. An unknown key, a key that names a group instead of a value, or a stray `{{` / `}}` is an
error (`400 invalid`, message starts with `template:`), so a literal `{{` cannot appear in a template.

| Placeholder | Value |
|---|---|
| `{{models.orchestrator}}` `{{models.reasoner}}` `{{models.builder}}` `{{models.scout}}` | the project's own model for the role (Choose models… on the project page), else `models.*` from Settings |
| `{{panePlacement}}` | `beside` or `under-last` |
| `{{limits.maxAgents}}` | `limits.maxAgents` (agents per orchestrator; a project as a whole runs at most three times that, never more than 24) |
| `{{permissionMode}}` | `permissionMode` (`default` means no `--permission-mode` flag) |
| `{{remoteControl}}` | `off`, `on (name prefix: <prefix>)` or `on (name prefix: the project name)` |
| `{{plugins}}` | the project's selected plugins as `` `name@marketplace` `` separated by commas, or `none` |

## The marker and the state of the rules file

The first line of the written file is

```
<!-- nika:orchestration v<templateVersion> sha256:<sha256 of everything after this line> -->
```

`rulesState` (also `Project.rules.state`) reads `rules/orchestration.md` and reports:

| State | Meaning |
|---|---|
| `none` | no file |
| `nika` | marker present, the hash matches the body, template version is current, and every regular instruction file carries the rules (below) |
| `outdated` | marker present, body unmodified, written by an older template version; or current but a regular `CLAUDE.md` / `AGENTS.md` that Apply would still change |
| `foreign` | anything else: no marker, a body edited by hand, a newer version, or a file that cannot be read safely |

The instruction files count the way Apply plans them: `AGENTS.md` (when regular) has the rules line; `CLAUDE.md` has the line, or has an import line while a regular `AGENTS.md` has it; a missing `CLAUDE.md` counts as not covered (Apply would create it). A non-regular `AGENTS.md` beside a `CLAUDE.md` is ignored; a project Apply would refuse (an unreadable instruction file, a lone symlinked `AGENTS.md`) is judged by the rules file alone.

`TEMPLATE_VERSION` (in `src/rules.js`) is bumped when the built-in template or its placeholder set changes. The state says
who wrote the file; whether a write is needed is the preview's `action` (a `nika` file still shows `update` after a
setting such as `limits.maxAgents` changed). Applying over a `foreign` file needs `overwriteForeign`; the old file is
backed up first.

`rulesState` also returns `git` (a `.git` file or folder exists in the project folder) and `settingsIgnored`
(`.claude/settings.local.json` is covered by the project's `.gitignore`). `settingsIgnored` is an approximation: some
line of `.gitignore`, trimmed, equals one of `.claude/settings.local.json`, `.claude/`, `.claude`, `.claude/*`,
`*.local.json`, `settings.local.json` (also with a leading `/`, or `**/` where it makes sense). Negations, nested or global
ignore files and patterns not in that list are not understood.

## `.claude/settings.local.json`

Only `enabledPlugins` is written, and only for projects that have a plugin selection in `config.json`
(`perProject[<key>].plugins` in `config.json`, chosen on the project page). Without one the file is left as it is. An empty list is "none", not a selection: it is not kept, so unticking every plugin leaves the file's plugins as they are.

- Every selected plugin is set to `true`.
- Entries that are `true` in the file but not selected are removed.
- Entries that are `false` and not selected stay as they are.
- Every other key is copied verbatim and in order. The file is parsed as JSON for that, but `hooks`, `permissions`, `env`,
  `apiKeyHelper`, `mcpServers`, `model` and every other key are never interpreted, shown or sent. After the merge the written text is parsed again and every other key must be deep-equal
  to the original, otherwise the apply is refused.
- Invalid JSON, a non-object, an empty file, a non-object `enabledPlugins`, or a `__proto__`, `constructor` or `prototype`
  key at any depth is `400 invalid`.
- The file is rewritten as `JSON.stringify(obj, null, 2)` plus a newline, so a file with other formatting is reformatted
  when `enabledPlugins` changes (values are preserved, not bytes). If nothing changes the file is not touched.

## Preview, hash and apply

`preview` reads the project and returns, for each file it plans, `action` (`create`, `update`, `unchanged`, `skipped` for a non-regular `AGENTS.md`), a unified
diff (`src/diff.js`, 3 lines of context, `--- a/<path>` / `+++ b/<path>`), plus `foreign`, `keysPreserved` and `optional`
flags, a `note` on a skipped `AGENTS.md` and on a `CLAUDE.md` that gets the rules through `@AGENTS.md`, `warnings`, the `backupDir` and a `hash`. The hash is a sha256 over every listed file's path, the hash of its
current content and the content planned for it, so it changes when the project files or the settings that feed the
template change.

For `.claude/settings.local.json` the preview shows less than it plans. Its `diff` is computed only between
`{"enabledPlugins": <old>}` and `{"enabledPlugins": <new>}` (pretty JSON; a missing file has an empty
"before", a file without `enabledPlugins` has `{}`), and the entry carries `keptKeys`, the number of other top-level keys the
file has. The values of those keys (`env`, `permissions`, `hooks`, ...) never reach the page, not even in an error
message. The `hash` still covers the full file, so a change to a hidden value after the preview makes `apply` answer
`409 conflict`.

`apply` recomputes the plan: a different hash is `409 conflict`, a foreign rules file without
`overwriteForeign` is `409 foreign`, a refusal by the write layer is `409 refused` with the fwrite `code`. The optional
`.gitignore` entry is written only with `gitignore: true`.

## Backups

Before a file that exists is overwritten, its current content is copied to
`${XDG_STATE_HOME or ~/.local/state}/nika/backups/<key>/<YYYYMMDDTHHMMSSZ>/<relative path>` (folders 0700, files 0600),
never into the repository. If that folder name already exists (two applies in one second) `-1`, `-2`, ... is appended. The
folder is created only when something was backed up. The copies are byte-for-byte, so a backup of
`.claude/settings.local.json` holds whatever the original held. The last 10 backup folders of a project are kept: after a
successful apply the older ones are removed (only entries named like these stamps that are real directories owned by you;
a symlink, a file or any other name in that folder is left alone). `nika doctor` prints the folder. To restore, copy the
file back by hand.

## Local template

`rules.localTemplate` in `config.json` is `null` (built-in) or a file name matching `^[A-Za-z0-9_-]{1,64}\.md$`. The file
lives at `<config dir>/templates/<name>` (default `~/.config/nika/templates/`), a copy made when the template was imported,
never a path into a repository. It is read through `src/fsafe.js` (regular file owned by the user, no symlink, at most
256 KB, valid UTF-8; the `templates` folder must be a real folder) and rendered with the same placeholders, marker and
rules as the built-in one; it must not contain unknown placeholders. `GET /api/app/templates` lists the file names in that
folder (names matching the pattern above, regular user-owned files only, sorted, at most 50; `[]` when the folder is
missing), never contents or paths. A missing or unsafe local template is a refusal
(`409 refused`, code `ENOENT`, `ESYMLINK`, `EFBIG`, ...), never a silent fallback to the built-in template. The marker's
version is always the current `TEMPLATE_VERSION`: for a local template it means "rendered by this nika's placeholder set".
