# nika 0.3–0.5: full Claude Code control from the app (design)

Status: for owner approval, 2026-11-08. Decisions: owner, 2026-11-08 (§2). Nothing open.

## 1. Intent

The owner drives Claude Code agents from nika's desktop app. In 0.2 the app shows history and a live pane mirror,
types into a pane, spawns agents and starts the orchestrator. Everything else still needs the terminal: switching
permission modes, finding commands, stopping a turn or a session, picking a model whose exact ID you don't know,
adding plugins, skills and MCP servers. And the app does not show how agents relate to each other.

Goal: everything the owner does in the Claude CLI can be done from the app, every state is visible at a glance, and
nika itself still makes no network connections and never handles a secret.

## 2. Decisions (owner, 2026-11-08)

| # | Topic | Decision |
|---|---|---|
| 1 | bypassPermissions (#2) | Opt-in levels Off (default) / Allowed / Always, global plus per-project override, stored in nika's config and passed as a launch flag; raising needs a typed confirmation; red badge; nika never writes Claude's `permissions` key |
| 2 | Stopping (#3) | Stop = Esc (ends the current turn, session stays). End session = `/exit` (clean exit, resumable). No kill |
| 3 | `claude` CLI | nika runs `claude plugin …` and `claude mcp …` with fixed argv, app tier only; Claude Code does downloads and writes its own files |
| 4 | New reads | Command/skill frontmatter (name, description); marketplace catalogs Claude Code already downloaded; `claude mcp list` reduced to name, scope, status. Never `~/.claude.json`, tokens, env, headers, `claude mcp get` |
| 5 | MCP meaning (#8) | nika manages MCP servers for Claude sessions (presets, add, remove, scope, status, sign-in via `claude mcp login`); nika never calls Figma, Jira, … itself |
| 6 | MCP secrets | nika never takes a token: OAuth servers use Sign in; token-only servers get the exact terminal command |
| 7 | Verified marketplaces (#5) | Anthropic's two marketplaces are Verified; anything added is "Added by you" and installs warn that plugins run code |
| 8 | Project level (#6) | `local` by default, "Share with team" = `project`; nika's own `enabledPlugins` writer is retired |
| 9 | Session controls (#1) | Mode switcher, `/` command palette, `!` shell toggle, permission-prompt buttons, quick actions (compact, clear, model, rewind). Not possible via tmux: image paste, file drag |
| 10 | Agent graph (#4) | Top-down tree per project, app only: orchestrator → spawned agents → subagents; hand-started sessions are separate roots; plain SVG; teammates later |
| 11 | Models (#7) | Dropdown with Latest, Aliases, Older, Custom ID…; list ships with nika, no API call |
| 12 | Delivery | 0.3 = #1 #3 #7; 0.4 = #4 #2; 0.5 = #5 #6 #8. Design doc and plan on a `docs/` branch, committed only with approval |
| 13 | Mode styling | "All modes must change visual styling" — every permission mode (and every on/off state) has its own color, icon and label wherever it shows |
| 14 | Bypass reach | Always applies to every nika spawn in the project, including `nika spawn` run by the orchestrator or another agent |
| 15 | Sandbox | The optional "run agents in Claude Code's sandbox" switch ships with bypass in 0.4 |
| 16 | Commits | Standing approval for commits and pushes on the three feature branches, each ending at its merge |
| 17 | figmosha | Status card, Start/Stop of its bridge, and per-project agent access (§8.8) |

## 3. Goals, non-goals, anti-goals

Goals:
- 0.3: the session window does every common CLI action with a button or the palette, and the current mode is always
  visible and styled per mode.
- 0.4: one picture of who spawned whom in a project; bypass available on purpose, impossible to miss when on.
- 0.5: browse, install, enable and remove plugins and MCP servers at user or project level from the app.

Non-goals:
- nika as an MCP client (no Figma, Jira or Jam data inside nika).
- Any network connection made by nika's own code.
- nika handling tokens, API keys, MCP headers or env values.
- Image paste or file drag into a session.
- Agent-team teammates in the graph (Claude Code does not document where it stores them).
- Driving Claude headless (`-p --input-format stream-json`) instead of the TUI in tmux.
- Any change to the browser tier on :3335 (stays read-only).

Anti-goals (a failure even if it works):
- A session in bypass that does not look different from the others.
- nika reading, showing or logging a secret (token, env value, header, MCP URL with credentials).
- nika writing Claude's settings files, `~/.claude.json` or `.mcp.json` itself.
- A mode switch, End session or prompt button reaching a pane that is not a live Claude pane.
- An install from an unverified marketplace without a warning.

## 4. Constraints

- `rules/project-rules.md` applies. §5 lists the only relaxations, owner-approved 2026-11-08; each lands with the
  release that needs it, in the same PR.
- Zero npm dependencies; no new Rust crate (tray warning state uses the existing stdio `status` message).
- Every route, collector, store function and write path gets a (+) and a (−) test; `test/hygiene.test.js` stays green.
- Fixtures are synthetic: footer phrases, prompt layouts, frontmatter files and CLI outputs are written by hand, never
  copied from a real session, transcript or settings file.
- WCAG 2.2 AA, light and dark; state is never shown by color alone.
- Every pane action reuses the 0.2 eligibility check: live Claude pane or nika-started pane whose current command
  looks like claude.

## 5. Rule changes (owner-approved 2026-11-08)

| Rule | Release | Change |
|---|---|---|
| 3 (subprocesses) | 0.5 | Add: `claude` CLI calls go through per-command argv builders (no generic pass-through), every user value is regex-validated, never starts with `-`, and follows `--` where the CLI accepts it |
| 4 (reads) | 0.3 | App tier also reads the YAML frontmatter (first 4 KB; keys `name`, `description`, `argument-hint`, `user-invocable`) of command and skill files in `~/.claude/{commands,skills}`, `<project>/.claude/{commands,skills}` and installed plugins' `commands/` and `skills/` |
| 4 (reads) | 0.5 | App tier also reads: allow-listed fields of `claude plugin … --json` and `claude plugin marketplace list --json`; downloaded marketplace catalogs (allow-listed fields); `claude mcp list` reduced to name and status. Still never `~/.claude.json`, `.mcp.json`, `claude mcp get`. The `settings.local.json` exception is removed |
| 11 (writes) | 0.5 | `.claude/settings.local.json` leaves nika's write set. Claude Code's own CLI writes Claude's settings, `~/.claude.json` and `.mcp.json` on the user's confirmed request; nika never writes them |
| 12 (agent control) | 0.3 | Add: Stop sends `Escape`; End session types `/exit` (never `kill-pane`); mode switch presses `BTab` at most 6 times, re-reading the footer after each press |
| 12 (agent control) | 0.4 | Replace "bypassPermissions is refused …" with the opt-in levels of §7.5. `--permission-mode bypassPermissions` stays refused as a plain permission mode and the CLI has no bypass flag |
| 3, 5 (figmosha) | 0.5 | nika may run the picked figmosha folder's `start-bridge.sh` through `/bin/bash` with fixed argv on the user's click; the folder enters only through the native picker |
| 4, 13 (figmosha) | 0.5 | App tier may send `GET /status` to the figmosha bridge on `127.0.0.1:<port>` and read allow-listed fields; the only HTTP request nika makes, loopback only |
| 13 (desktop shell) | 0.5 | Still no outbound connection from nika's code. `claude` subprocesses connect on user action (marketplace and plugin downloads, MCP sign-in). The child env list gains `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lowercase forms) when set |

New ADRs: 0010 session control through the TUI (keys and footer parsing, not stream-json); 0011 bypass opt-in;
0012 agent graph and parent links; 0013 plugins, marketplaces and MCP delegated to the `claude` CLI.

## 6. Release 0.3: session control (#1, #3, #7, mode styling)

### 6.1 Current mode

- Source: the footer line Claude Code draws under its prompt. nika already captures the pane for the mirror; plain
  row text is the concatenation of each row's span `t` values (`src/mirror.js`). A new `src/mode.js`
  `modeFromRows(rows)` scans the bottom 6 rows against a fixed table of footer phrases and returns one of
  `manual` (Claude's `default`), `acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk`, `unknown`.
- Manual is reported only on a positive marker (V11 finds the footer text Claude shows in default mode). No recognized
  phrase = `unknown`, never manual, so a renamed bypass or auto footer can never pass as Manual. Any unrecognized
  footer that contains "bypass" is reported as `bypassPermissions` (fail loud). A dialog covering the footer = unknown.
- For panes nika launched, the start mode (from the launch flag) is shown, styled "unconfirmed", until the footer
  confirms or changes it.
- The capture response gains `mode`. The app-tier dashboard snapshot gains `mode` per agent with an eligible pane,
  from the same capture cache (bottom rows only, ≤ 4 concurrent captures, 3 s refresh).
- V11 records the exact footer phrase and color per mode in the installed Claude Code; V12 checks whether transcripts
  record the mode per message (if yes, sessions without a pane can show it too).

### 6.2 Mode styling (owner requirement)

| Mode | Label | Icon idea | Color role |
|---|---|---|---|
| manual | Manual | hand | neutral |
| acceptEdits | Accept edits | pencil | violet |
| plan | Plan | pause / map | teal |
| auto | Auto | bolt | amber |
| bypassPermissions | Bypass | shield with slash | red, loudest (also a striped frame) |
| dontAsk | Don't ask | lock | slate |
| unknown | Mode ? | question mark | dashed outline |

- Session window: 3 px frame on top of the window, a header pill (icon + label), composer border tint.
- Dashboard agent rows and graph nodes: the same pill.
- Colors are design tokens in `docs/design/spec.md` for light and dark: pill text ≥ 4.5:1, frame ≥ 3:1 against its
  background; hues close to Claude Code's own footer colors (V11) so the mirror and the app agree.
- A mode change is announced through an `aria-live="polite"` region.
- The same rule covers every other on/off state in the app (shell toggle, pass-through, bypass level, MCP status).

### 6.3 Mode switcher

- Segmented control in the session header: Manual, Accept edits, Plan, Auto, and Bypass only when nika launched the
  pane with bypass Allowed or Always. Don't ask is never a target (not in Claude's cycle); it shows as current only.
- Runs only while Claude is idle at its prompt with no permission prompt or dialog open (else 409 `not-idle`):
  the cycle can pass through Auto or Bypass on the way to the target, and no tool call may run in between.
- `POST /api/app/pane/:id/mode {target}`: read mode; if equal, done; else press `BTab`, poll the footer every 150 ms
  for up to 1.5 s, repeat; at most 6 presses. Back at the start mode without the target → 409 `not-in-cycle` (target
  greyed out for this pane). Unknown mode → 409 `mode-unknown` (UI offers the Shift+Tab chip instead). One switch in
  flight per pane; presses count toward the 20/s key limit.
- Claude's cycle: auto → default → acceptEdits → plan → bypassPermissions → auto; auto appears only when available
  for the account, bypass only when launched with it allowed.

### 6.4 Command palette

- Opens on `/` as the first composer character or the Commands button; type to filter, ↑↓, Enter inserts
  `/name ` with the argument hint as placeholder, Esc closes. Sending uses the existing keys route.
- `GET /api/app/commands?project=<key>` (new `src/collect/commands.js`) merges:
  1. built-ins: curated list in `src/commands-builtin.js` (name, one-line description, `dialog: true` when it opens a
     TUI dialog such as `/config`, `/mcp`, `/plugin`, `/resume`), refreshed each release from the docs commands page;
  2. user: `~/.claude/commands/*.md`, `~/.claude/skills/*/SKILL.md`;
  3. project: `<root>/.claude/commands/*.md`, `<root>/.claude/skills/*/SKILL.md`;
  4. plugins: for each entry of `installed_plugins.json`, `<installPath>/commands/*.md` and
     `<installPath>/skills/*/SKILL.md`, shown as `/<plugin>:<name>` (V13 naming). `installPath` must resolve inside
     the plugins cache dir.
- Reads: first 4 KB via `src/fsafe.js`; frontmatter only, a minimal `key: value` scalar parser; keys `name`,
  `description`, `argument-hint`, `user-invocable` (`false` hides it). Name `^[a-z0-9][a-z0-9:_-]{0,63}$`,
  description ≤ 200 chars, all text through `clean()`. Bodies are never read.
- Bounds: ≤ 200 files per dir, ≤ 1000 entries, 10 s cache. A skill wins over a command of the same name (Claude's rule).

### 6.5 Shell toggle

Composer button "Shell (!)" with its own styling (color + `$` icon). Sending in shell mode sends `C-u`, then `!`,
then the text, then Enter (Claude's shell mode needs `!` at the start of an empty prompt).

### 6.6 Permission-prompt buttons

`src/mode.js` `promptFromRows(rows)` detects Claude's permission prompt (question line plus numbered options with a
selection marker) and returns `{question, options:[{n, label}]}` or null; strict pattern, unknown layouts give no
buttons. The capture response gains `prompt`. The composer area shows one button per option (label ≤ 80 chars,
`clean()`) plus "Esc = No". A button sends the digit (V14: whether Claude needs Enter after the digit).

### 6.7 Quick actions

One row in the session window: Stop (while busy), Compact (`/compact` + Enter), Clear (`/clear`, confirm), Model ▾
(the §6.9 dropdown → `/model <id>` + Enter), Rewind (Esc Esc on an empty prompt opens Claude's rewind menu in the
mirror), End session. All but End and the mode switch use the keys route.

### 6.8 Stop and End session

- Stop = `Escape`. Ends the current turn, keeps work done; queued messages go next. It stops the whole session,
  including running subagents (Claude cannot stop one subagent alone); the tooltip says so.
- End session: confirm dialog ("Claude exits and the pane closes. Resume later with Copy resume command.") →
  `POST /api/app/pane/:id/end`: if busy, `Escape` and wait ≤ 2 s for idle; then `C-u`, `/exit`, `Enter`; after 3 s check
  the pane's current command. `{ended: true}` or `{ended: false}` with "Claude didn't exit; use Stop or the terminal".
  Never `kill-pane`.
- A spawned agent's pane closes when `_run-agent` exits after writing `.rc`; the orchestrator window closes with its
  last pane (V15).
- Reachable from the session window, the dashboard row menu and the graph node menu.

### 6.9 Model dropdown

- `src/models.js` catalog `[{id, label, group, note}]`, also served as `GET /api/app/models`:
  - Latest: `claude-fable-5-1` Fable 5.1, `claude-opus-5-5` Opus 5.5, `claude-sonnet-5-5` Sonnet 5.5,
    `claude-haiku-5-5` Haiku 5.5.
  - Aliases: `best`, `fable`, `opus`, `sonnet`, `haiku`, `opusplan` (Opus in plan mode, Sonnet otherwise),
    `opus[1m]`, `sonnet[1m]` (1M context).
  - Older: 5.0 and 4.x IDs confirmed by V16 against the model-config docs; anything unconfirmed is left out.
  - Custom ID…: reveals a text field validated by `MODEL_ID`.
- `MODEL_ID` becomes `^(?:claude-[a-z0-9-]{3,60}|opus|sonnet|haiku|fable|best|opusplan)(?:\[1m\])?$`. Brackets are
  safe: argv only, no shell; tmux format expansion only touches `#`, which stays impossible.
- UI: native `<select>` with `<optgroup>` plus the Custom option. Used in Settings (per role), the spawn sheet,
  orchestrator start and the session's Model action. A saved ID not in the catalog shows as Custom.

### 6.10 API (0.3, app tier only)

| Route | Notes |
|---|---|
| `GET /api/app/pane/:id/capture` | adds `mode`, `prompt` |
| `POST /api/app/pane/:id/mode` | `{target}` ∈ manual, acceptEdits, plan, auto, bypassPermissions; 409 `not-in-cycle` / `mode-unknown` / `not-idle` / `busy-switching` |
| `POST /api/app/pane/:id/end` | `{}`; eligibility as keys; returns `{ended}` |
| `GET /api/app/commands?project=<key>` | merged list, ≤ 1000 |
| `GET /api/app/models` | catalog |
| dashboard snapshot (app tier) | agent `mode` |

### 6.11 Tests

Mode parser (+ every phrase, − garbage, partial rows, escape-laden text); prompt parser (+ 2- and 3-option prompts,
− look-alike text in history); switcher with fake exec (+ reaches target, − not in cycle, − unknown, − 6-press cap);
end route (+, − ineligible pane, − claude keeps running); commands collector (+ each source, − symlink, − oversize,
− bad name, − markup in description stays text, − `installPath` outside the cache); `MODEL_ID` (+ aliases and `[1m]`,
− `claude-;rm`, `#`, leading `-`); UI (no HTML sinks, `<select>` present, one CSS class per mode).

### 6.12 0.3 build amendments (2026-11-09)

Where the build differs from §6.1–§6.9, `docs/contracts/api-app.md` §3 is the source of truth:

- **Mode reads (§6.1, §6.10).** The dashboard polls `GET /api/app/modes` (one `{ mode, confirmed }` per eligible pane);
  `/api/agents` is unchanged. While a prompt or dialog covers the footer, capture and `/modes` show the last mode read
  from that pane (or, for a pane nika started, its launch mode) with `confirmed: false`. A held value is display
  only: the mode route reads the footer itself.
- **Prompt buttons (§6.6).** A button posts `{ n, sig }` to `POST /api/app/pane/:id/answer`, not to the keys route. The
  route takes a fresh capture, refuses a changed or already answered prompt, and types the digit alone. "Esc = No"
  stays on the keys route.
- **End and quick actions (§6.7, §6.8).** End types `/exit` only into an empty input and presses `Enter` only when the
  input reads exactly that, else it removes its own text and answers 409; it sends no `C-u` first. Compact, Clear and
  Model use the new `POST /api/app/pane/:id/command` with the same typing rules; Stop and Rewind stay on the keys route.
- **Bypass (§6.3).** Never a switch target in 0.3 and no Bypass segment (0.4). The cycle may still pass through it when
  Claude's cycle holds it, which is why a switch runs only while idle.
- **Switch timing (§6.3).** Built: after each `BTab` the footer is read every 300 ms for up to 1.8 s (`pollMs` and
  `settleMs` in `src/session-control.js`), not 150 ms for 1.5 s; at most 6 presses. Authoritative: contract §3, mode route.
- **Command names and bounds (§6.4).** Built: a bare name must match `COMMAND_NAME` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`,
  `src/ids.js`), not `^[a-z0-9][a-z0-9:_-]{0,63}$`. Per scan: at most 200 files per folder, 2000 files opened, 1000 entries
  (built-ins included), cached 10 s per project (`src/collect/commands.js`). Authoritative: contract §3, commands route.
- **End timing (§6.8).** Built: after `Escape` End waits 1 s once, then takes one fresh capture (no 2 s wait for idle).
  `C-u` is never sent first: it is sent only to remove nika's own text (after a failed echo or a stray `i`). Authoritative: contract §3,
  End steps 2–7.
- **Start orchestrator (§6.9).** One click, no per-start model picker in 0.3 (controller ruling 2026-11-09). It uses the
  Settings "Orchestrator" model, which is chosen from the model dropdown there (catalog list or Custom ID).
- **Prompt button label (§6.6).** Built: the cancel button shows the keycap "Esc" followed by "Cancel, same as No", not
  "Esc = No" (`public/session.js`; spec 9.5 of `docs/design/spec.md`). It sends `Escape` through the keys route.

## 7. Release 0.4: agent graph and bypass (#4, #2)

### 7.1 Graph data

- Session nodes: the project's agents from the snapshot (name, state, mode, model, role).
- Subagent nodes: `subagents/agent-<id>.meta.json` (`agentType`, `description`, `model`, `spawnDepth`, `toolUseId`,
  `finished`).
- Edges: spawned (orchestrator session → spawned agent, §7.2); subagent (session → its subagents, by directory);
  nested subagent (`spawnDepth` > 1): parent = the subagent whose transcript holds the Agent `tool_use` with that
  `toolUseId` (V17; bounded scan of sibling transcripts' tail chunks, ≤ 50 files, ≤ 256 KB each; fallback: attach to
  the session).
- Roots: orchestrators and sessions without a parent link (started by hand). Ended nodes follow the dashboard's
  window. ≤ 300 nodes per project; more collapse into "+N ended".

### 7.2 Parent link at spawn

`nika spawn` runs inside the orchestrator's pane (through its Bash tool), so `TMUX_PANE` in its env is the caller's
pane. Spawn validates it (`PANE_ID`, present in `list-panes`), maps it to a session through the registry's
`tmuxPane`, and writes `parent: {pane, sessionId}` into `<name>.agent.json`. App-started agents have no parent and
are roots. The link is display-only (env and files are agent-writable): never used for permissions or limits, like
`.pane`.

### 7.3 Graph API

`GET /api/app/projects/:key/graph` → `{nodes, edges, etag}`, 304 on the same ETag, polled every 3 s.

### 7.4 Graph UI

- Project view → Agents, with a List | Graph toggle (remembered per viewer).
- Top-down tidy tree: depth = row, leaves evenly spaced, parents centered; stable order by start time so live updates
  don't reshuffle. Built with `createElementNS`, text via `textContent`.
- Node card: name, model label, state dot, mode pill (§6.2). Solid edge = spawned, dashed = subagent.
- Pan (drag, scroll), zoom (Ctrl+wheel, pinch, + − Fit buttons).
- Keyboard: arrows move parent/child/sibling, Enter opens the session window, `m` opens the node menu (Open, Stop,
  End session). The List view is a `role="tree"` with the same hierarchy for screen readers.
- Subagent nodes open a side panel (type, description, model, state); no subagent transcript in 0.4.

### 7.5 Bypass levels

- Config: `bypass: {level: 'off'|'allowed'|'always', perProject: {<key>: 'off'|'allowed'|'always'}}`, default off.
  Effective level = `perProject[key]` if set, else `level`.
- Raising a level (Settings for global, Project view for a project) opens a dialog: what bypass does (Claude runs every
  tool without asking, including shell commands and edits outside the project; deny lists are advisory; a prompt
  injection can act as you). The user types `bypass`; the PUT carries `confirm: "bypass"`; the store refuses a raise
  without it. Lowering needs no confirmation.
- `PERMISSION_MODES` stays without `bypassPermissions`; the CLI gets no bypass flag; bypass reaches argv only from
  the effective level.

### 7.6 Bypass in argv

- Allowed → `--allow-dangerously-skip-permissions`: bypass joins the Shift+Tab cycle, the agent starts in the
  configured permission mode.
- Always → `--permission-mode bypassPermissions` instead of the configured mode.
- Same for spawned agents and the orchestrator, including `nika spawn` run from an agent's Bash (owner, decision 14).
  `_run-agent` reads the effective level from nika's config at launch; never from `<name>.agent.json`, env or any
  other agent-writable input. The deny lists stay (V18: whether `--disallowedTools` still applies in
  bypass; if not, the dialog and `docs/security.md` say so).
- nika never sets `skipDangerousModePermissionPrompt`; if Claude asks to confirm bypass at start (V19), the user
  answers in the mirror.

### 7.7 Bypass visibility

- Red banner in every app view while any level is above off ("Bypass: global Allowed · 2 projects Always"), linking
  to the setting.
- Tray: warning icon state plus a menu line.
- Bypass agents: red pill and striped red frame (§6.2).
- `nika doctor` prints the levels.
- Each spawn with bypass appends one line (time, project key, agent name, level) to `<stateDir>/audit.log`
  (0600, via `src/fwrite.js`, rotated at 1 MB).

### 7.8 Sandbox switch (owner, decision 15)

- Settings switch "Run agents in Claude Code's sandbox", global plus per-project override, default off; applies to
  spawned agents and the orchestrator.
- Passed through the `--settings` JSON nika already gives spawned agents (and a new one for the orchestrator).
  V25: the exact sandbox settings keys, macOS and Linux support and prerequisites, and how sandbox and bypass interact.
- The bypass dialog offers to turn the sandbox on in the same step. A sandboxed agent shows a "Sandboxed" badge with
  its own icon; an unsandboxed bypass agent shows the loudest styling.
- Rule 12's "planned as an optional Settings switch" becomes this section. Adds about 1 day to 0.4.

### 7.9 Tests

Store (+ raise with confirm, − raise without, − bad level, + per-project override wins); argv snapshots for off,
allowed, always (spawn and orchestrator; − a level written into `.agent.json` is ignored); sandbox settings JSON
(+ on, + off, + per-project override); `--permission-mode bypassPermissions` refused at API, CLI and spawn;
parent link (+ valid caller pane, − pane not listed, − malformed env); graph assembly (+ spawned edge, + nested
subagent, − cycle in links ignored, − > 300 nodes collapse); UI (banner, tray status flag, no HTML sinks).

## 8. Release 0.5: plugins, marketplaces, skills, MCP (#5, #6, #8)

### 8.1 `claude` CLI runner

- `src/claude-cli.js`: `execFile(findClaude(), args, {shell: false})`; args come only from per-command builders
  (`pluginInstall(plugin, scope)`, `mcpAddHttp(name, url, scope)`, …), never from a request.
- Validation: `PLUGIN_NAME`; `MARKETPLACE_NAME ^[A-Za-z0-9._-]{1,100}$`; `MCP_NAME ^[A-Za-z0-9_-]{1,64}$`; scope from a
  fixed set; sources per §8.3; no value starts with `-`; `--` before positionals where supported (V20).
- cwd: the project root (realpath from the store) for project and local scope; `HOME` for user scope.
- Env: the server's env (already rebuilt by the shell) plus proxy variables when set (§5). No `SSH_AUTH_SOCK`, so
  private marketplaces over SSH are unsupported in the app (documented; use the terminal).
- Output: `--json` where supported, parsed through a per-command field allow-list; stdout cap 2 MB. Errors show the
  last 5 stderr lines through `clean()`, with URL credentials redacted (`https://user:pass@…` → `https://***@…`).
- Timeouts: list 20 s; install, update, marketplace add 180 s; MCP sign-in 300 s.

### 8.2 Operations

Writes are async: `POST …` → 202 `{op}`; `GET /api/app/ops/:op` → `{state: queued|running|ok|failed, title, message}`.
One write op at a time (Claude's settings files are shared), ≤ 10 queued, kept in memory for 10 min. An activity
panel shows running and recent ops. On server shutdown nika SIGTERMs its own running `claude` CLI child (a nika
subprocess, not an agent).

### 8.3 Marketplaces

- List: `claude plugin marketplace list --json` → name, source kind and repo/URL ("local folder" for paths),
  last update.
- Catalog: `claude plugin list --available --json` if it carries name, marketplace, description, version, category
  (V21); else the downloaded `marketplace.json` under the plugins dir via `fsafe` (≤ 2 MB; fields `plugins[].name`,
  `description`, `version`, `category`, `tags`, `author.name`).
- Verified = name `claude-plugins-official` with source `anthropics/claude-plugins-official`, or `claude-community`
  with `anthropics/claude-plugins-community`. Any other → "Added by you". An official name with another source →
  red "Name looks official, source is not".
- Add: GitHub `owner/repo[@ref|#ref]` (`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}(?:[@#][A-Za-z0-9._/-]{1,100})?$`);
  `https://` URL ≤ 2048 chars, no userinfo, no whitespace or controls; local folder through the native picker (the
  path never comes from a request). `http:`, `file:`, `ssh:` and `git@` refused. Scope: user (default) or project
  (writes `extraKnownMarketplaces` into the project's committed `.claude/settings.json`; the sheet says so).
- One click: "Add Anthropic community marketplace" (`anthropics/claude-plugins-community`).
- Update (refresh), Remove (confirm). Never automatic.

### 8.4 Install and manage plugins

- Browse: tabs per marketplace, search over name, description and tags, category chips, Verified badge; card shows
  name, description, version, marketplace and installed state per scope.
- Install sheet, scope:
  - "All projects" = user (default from Settings);
  - "This project, only me" = local (default from a Project view);
  - "This project, whole team" = project (committed `.claude/settings.json`; the sheet says so).

  The sheet shows the exact command. From an unverified marketplace it also shows "Plugins can run code on your
  machine (hooks, MCP servers, commands). Install only from sources you trust." and needs the "I trust this source"
  checkbox.
- Installed: `claude plugin list --json` → name, marketplace, version, scope, enabled. Row actions: Enable/Disable
  (in its scope), Update, Uninstall (confirm). The Project view shows what is active there (user + project + local).

### 8.5 Retire nika's `enabledPlugins` writer

`rules apply` stops writing `.claude/settings.local.json`; preview drops that diff. If `plugins.perProject[key]` is
non-empty, the Project view shows a one-time card "Enable these N plugins for this project only?" which queues
`claude plugin enable <p> -s local` ops (V10 from 0.2: per-project enable of a user-disabled plugin); then the key
leaves the config. Rules template text about plugins is reviewed by the builder.

### 8.6 Skills

Settings and the Project view list skills (user, project, and per plugin) from the §6.4 collector: name, description,
source. Read-only; no install, because no standalone skill registry exists (skills ship with plugins).

### 8.7 MCP servers

- Presets in `src/mcp-catalog.js`, each verified against the vendor's official docs at build time (V22); unverified
  ones are left out:
  - Figma: remote HTTP `https://mcp.figma.com/mcp`, Sign in;
  - Atlassian (Jira, Confluence): remote, Sign in;
  - Jam: remote, Sign in;
  - Playwright: local stdio `npx -y @playwright/mcp@<pinned version>`, labelled "Runs a program from npm on your
    machine";
  - more (GitHub, Linear, Sentry, Notion, …) only with an official remote endpoint;
  - figmosha is not an MCP server; it gets its own card (§8.8).
- Custom server: name; HTTP (`https://…`, or `http://` only for `127.0.0.1` / `localhost`) or stdio (command
  `^[A-Za-z0-9._/@+-]{1,256}$`, ≤ 32 args of ≤ 512 chars, no controls). No env values or headers in the app: a server
  that needs them gets the terminal command with a `<YOUR_TOKEN>` placeholder and a Copy button.
- Scope: user (all projects) | local (this project, only me; default from a Project view) | project (`.mcp.json`,
  committed; the sheet says so).
- Status: only on the user's Refresh, never polled (`claude mcp list` health-checks servers and may start local
  programs). Parsed to `{name, status}` with status ∈ Connected, Needs authentication, Failed to connect, Pending
  approval, Disabled; everything else on the line is dropped (it can hold tokens). V23: exact output, `--json`.
  Each status has its own color, icon and label.
- Sign in: `claude mcp login <name>` op (listed in Claude Code's CLI reference, 2026-11-08); Claude opens the system
  browser and stores the token; nika never sees it. V24: exists in the installed version and works from a non-TTY
  child. Fallbacks, in order: the `/mcp` dialog in a live session (palette entry, answered in the mirror), then the
  terminal command. Sign out: `claude mcp logout <name>`, same fallbacks.
  Remove: `claude mcp remove <name> -s <scope>` (confirm).
- Pending approval (project `.mcp.json`): "Approve in a Claude session (`/mcp`)"; nika writes no approval settings.

### 8.8 figmosha (owner, decision 17)

figmosha (`github.com/denysosadchyi/figmosha2`, MIT) is a local Python bridge on `127.0.0.1:8787` plus a Figma Desktop
plugin; agents drive it with its CLI through Bash, following its `AGENTS.md`. The bridge runs any JavaScript in the
open Figma file for any local process, and checks GitHub for updates every 6 h by itself.

- Folder: picked once through the native folder picker (never from a request), stored as realpath in
  `integrations.figmosha.dir`; it must hold `figmosha.py` and `start-bridge.sh` as regular files owned by the user.
  Port stored as `integrations.figmosha.port` (default 8787, 1024–65535).
- Status card (Settings → Integrations, and the Project view when enabled): bridge up or down, figmosha version,
  connected Figma files (names through `clean()`). nika sends `GET http://127.0.0.1:<port>/status` (V26) with
  `Host: 127.0.0.1:<port>` and no `Origin`; 1 s timeout, 64 KB cap, allow-listed fields; polled every 5 s only while
  the card is visible. Up, down and error states each have their own color, icon and label.
- Start / Stop: `/bin/bash <dir>/start-bridge.sh` and `… --stop` with fixed argv, cwd = the folder, only on the user's
  click, as ops (§8.2). The card says that the bridge checks GitHub for updates and offers a toggle that sets
  `FIGMOSHA_NO_UPDATE_CHECK=1` when nika starts it (off by default, figmosha's own default).
- Agent access: a per-project toggle "Agents can use figmosha" (default off) with a checkbox override in the spawn
  sheet and orchestrator start. When on, the launch adds `--add-dir <dir>` and one line to the guard prompt: figmosha
  is at that folder, read its `AGENTS.md` before using it. `nika spawn` uses the project setting. Agents with access
  show a "figmosha" badge. Bash permission prompts for its CLI stay as they are.
- macOS and Linux only (`start-bridge.ps1` is not used).

### 8.9 API (0.5, app tier only)

| Route | Notes |
|---|---|
| `GET /api/app/marketplaces` | list + verified flag |
| `POST /api/app/marketplaces` | `{source \| pick, scope, project?}` → op |
| `POST /api/app/marketplaces/:name/update` · `DELETE /api/app/marketplaces/:name` | op |
| `GET /api/app/marketplaces/:name/plugins` | catalog |
| `GET /api/app/plugins/installed?project=<key>` | per scope |
| `POST /api/app/plugins/{install,uninstall,enable,disable,update}` | `{plugin, scope, project?, trust?}` → op |
| `GET /api/app/skills?project=<key>` | from the commands collector |
| `GET /api/app/mcp/catalog` | presets |
| `POST /api/app/mcp/status` | `{project?}` → op (runs `claude mcp list`) |
| `POST /api/app/mcp` | `{preset \| custom, scope, project?}` → op |
| `DELETE /api/app/mcp/:name?scope&project` | op |
| `POST /api/app/mcp/:name/{login,logout}` | op |
| `GET /api/app/ops/:op` | op state |
| `GET /api/app/figmosha` | folder set?, bridge status, connected files |
| `POST /api/app/figmosha/pick` | native folder picker relay |
| `POST /api/app/figmosha/{start,stop}` | `{noUpdateCheck?}` → op |
| `PUT /api/app/settings` | gains `integrations.figmosha` (port, per-project access) |

### 8.10 Tests

Argv builders (+ each command, − leading `-`, − bad scope, − regex misses, − shell metacharacters stay one argv
item); output parsers (+ synthetic JSON, − extra fields dropped, − URLs and tokens never in the result); verified
check (+ both official, − official name with other source); source validation (+ GitHub, https; − `http:`, `file:`,
`git@`, userinfo); ops queue (+ order, − 11th queued refused, − timeout → failed); migration card (+ ops queued,
− empty list no card); rules apply no longer touches `settings.local.json`; figmosha (+ status parse from a local
fake server, − extra fields dropped, − timeout = down, − folder without `figmosha.py` refused, − symlinked script
refused, + argv snapshot for start/stop, + `--add-dir` only when access is on); hygiene outbound check still green
(the probe targets `127.0.0.1` only).

## 9. New threats (added to `docs/security.md`)

| # | Threat | Mitigation |
|---|---|---|
| T18 | A same-user process edits nika's config to raise bypass | A raise through the API needs the typed confirmation; a hand edit still works (same-user trust, rule 10) but is loud: banner, tray, red agents, audit log, `nika doctor` |
| T19 | Argument injection into the `claude` CLI | Per-command builders, regex allow-lists, no leading `-`, `--`, `execFile` without a shell |
| T20 | Malicious or compromised marketplace or plugin | Verified = name + source; warning and trust checkbox for others; exact command shown; never auto-install or auto-update |
| T21 | Secrets in CLI output | Field allow-lists; MCP status = name + status only; stderr redaction; never `claude mcp get`, never read `~/.claude.json` or `.mcp.json` |
| T22 | Agent-written command or skill files | Frontmatter only, 4 KB, `fsafe`, `clean()`, `textContent`; plugin `installPath` must be inside the cache |
| T23 | Mode switch runaway, wrong target, or a tool call running while the cycle passes Auto or Bypass | Idle-only, ≤ 6 presses, footer re-read after each, stop on unknown, one switch per pane; Manual only on a positive marker |
| T24 | `claude mcp list` starts local server programs | Only on explicit Refresh |
| T25 | OAuth through `claude mcp login` | Claude owns the browser flow and the token; nika applies a timeout and redacts output |
| T26 | End session or prompt button reaches the wrong pane | 0.2 eligibility check, fresh parse, confirmation for End |
| T27 | Third-party npm code in presets (Playwright) | Pinned version, label, user confirmation |
| T28 | Spoofed spawn parent link | Display-only |
| T29 | Proxy variables passed to the child | Only the standard names, only when set, never logged |
| T30 | nika runs `start-bridge.sh` from a folder agents can write | Only on the user's click, fixed argv, folder from the picker, regular user-owned file; documented as same-user trust (an agent that edits the script gets code run on Start) |
| T31 | Probe of a third-party local server | Fixed `127.0.0.1:<port>`, GET only, no `Origin`, 1 s timeout, 64 KB cap, field allow-list, `clean()` |
| T32 | An agent with figmosha access can change any open Figma file | Per-project opt-in, off by default, "figmosha" badge on agents with access |

## 10. Verification tasks

Environment: a throwaway project in a scratch tmux session. Tasks that only watch a session (V11–V19) use the owner's
normal Claude login. Tasks that install or add anything (V20–V23) use a throwaway `CLAUDE_CONFIG_DIR`, so the owner's
real plugins, marketplaces and MCP servers stay untouched. V24 needs the owner for one browser sign-in. Only
hand-written fixtures enter the repo.

Outcome policy: a negative result stops only the feature that depends on it. Independent work continues, and the
owner gets the options (cut, fallback, or wait) before that feature goes on (ORCHESTRATION §2). Each release records
the Claude Code version its parsers were checked against. At runtime every parser fails closed: unrecognized output
hides that control and shows "Not supported with this Claude Code version".

| # | Question | Needed by |
|---|---|---|
| V11 | Footer phrase and color per mode in the installed Claude Code | 0.3 |
| V12 | Do transcripts record the permission mode per message? | 0.3 |
| V13 | Command and skill naming for plugins (`/<plugin>:<name>`), allowed name characters | 0.3 |
| V14 | Permission prompt layout; does a digit select without Enter? | 0.3 |
| V15 | tmux behavior when claude exits in a spawned pane and in the orchestrator window | 0.3 |
| V16 | Which 5.0 and 4.x model IDs the docs confirm (Sonnet 5.5 full ID included) | 0.3 |
| V17 | Nested subagent parent from `toolUseId` / `spawnDepth` | 0.4 |
| V18 | `--disallowedTools` and deny settings under bypass | 0.4 |
| V19 | Does Claude ask to confirm bypass at startup? | 0.4 |
| V25 | Claude Code sandbox settings keys, platform support, interaction with bypass | 0.4 |
| V20 | `--` support and argument order in `claude plugin` and `claude mcp` subcommands; non-TTY, env-cleared child works | 0.5 |
| V21 | `claude plugin list --available --json` fields; marketplace cache paths | 0.5 |
| V22 | Official endpoints for Figma, Atlassian, Jam; pinned Playwright MCP package | 0.5 |
| V23 | `claude mcp list` output format, `--json`, which servers it starts | 0.5 |
| V24 | `claude mcp login` from a non-TTY child | 0.5 |
| V26 | figmosha `/status` fields, `start-bridge.sh` from a non-TTY child and `--stop`, whether `--add-dir` plus the prompt line is enough for an agent to use it | 0.5 |

## 11. Delivery

- Order 0.3 → 0.4 → 0.5. Branches `feat/0.3-session-control`, `feat/0.4-graph-bypass`, `feat/0.5-extensions`; each a
  PR to `master`, then the release procedure in `docs/packaging.md`.
- Standing approval (owner, 2026-11-08) for commits and pushes on each feature branch, recorded in
  `rules/project-rules.md` when the branch is cut; it ends when that branch merges. The orchestrator commits after its
  own checks; subagents never commit. Merging, tags, publishing and the `docs/control-panel-plan` commit each still
  need explicit approval.
- Per release:
  1. scout + V-tasks (Haiku scout, claude-code-guide, real CLI in a scratch session);
  2. design pass for the UI (Opus): tokens, layouts, states; owner reviews mockups;
  3. contracts, rules, ADR (Fable or Opus);
  4. builders (Sonnet), ≤ 3 in parallel, disjoint files;
  5. independent security review;
  6. release.
- Rough agent time: 0.3 about 1 day, 0.4 about 2 days (with the sandbox switch), 0.5 about 2–2.5 days (with figmosha). Owner time per release: about 20 min of
  mockup review plus the approvals.

## 12. Left to the builder and designer

Exact colors and icons (within §6.2), graph layout details, polling intervals within the stated bounds, error copy,
ranking of palette results, panel placement.

## 13. Calls made in this design (owner to check)

1. Spec lives in `docs/superpowers/specs/`, the plan in `docs/superpowers/plans/`.
2. The mode is read from Claude's footer in the pane, not from a headless protocol.
3. End session is its own route: Esc if busy, then `C-u`, `/exit`, Enter, then an exit check.
4. The shell toggle clears the prompt (`C-u`) before typing `!`.
5. Bypass config shape `bypass.level` + `bypass.perProject`; a raise needs the typed word `bypass`; no CLI bypass
   flag; an audit log line per bypass spawn.
6. Spawn parent from the caller's `TMUX_PANE`, display-only; app-started agents are roots.
7. Subagent nodes open a details panel; no subagent transcript view in 0.4.
8. `claude` CLI write ops run one at a time.
9. Proxy variables pass through to the child; `SSH_AUTH_SOCK` does not (no private SSH marketplaces from the app).
10. Custom MCP servers: no env or headers in the app; stdio commands are typed.
11. MCP presets beyond the four named only with an official remote endpoint.
12. A one-time card migrates `plugins.perProject` to `claude plugin enable -s local`.
13. Mode switch only while idle with no prompt open; Manual only on a positive footer marker, else "Mode ?".
14. V-tasks that install anything use a throwaway Claude config dir; observation tasks use the normal login.
15. A negative V-task stops only its feature, and the owner chooses cut, fallback or wait; parsers fail closed and hide
    their control.
16. MCP sign-in falls back to the `/mcp` dialog in a live session, then to the terminal command.
17. figmosha: per-project agent access (off by default) gives `--add-dir` plus one guard-prompt line; the update-check
    toggle defaults to figmosha's own behavior (check on).
18. Bypass `Always` for orchestrator-spawned agents is read from config at launch, never from agent-writable files.

## 14. Open

Nothing open. All owner questions answered on 2026-11-08.
