# nika 0.2 UI design spec

Status: **accepted for Phase 4** with the decisions below. Scope: the app-tier webview (Tauri), the tray menu and the read-only browser tier on `:3335`.
Inputs: `rules/project-rules.md`, `docs/contracts/api-app.md`, `docs/adr/`, the 0.1 UI in `public/`.

## Decisions (owner and orchestrator, 2026-11-08) — these override anything below

1. **Build variant A · Console**, plus B's one-line plain-language summary at the top of the dashboard and in the tray status line. C's ⌘K palette is out of scope for 0.2.
2. **Theme:** follow the OS (`prefers-color-scheme`) by default, with a manual override in Settings: System / Light / Dark (stored in `config.json`, `ui.theme`).
3. **Tray status line:** counts only (e.g. "2 busy · 1 needs you"); never agent or project names.
4. **Permission modes:** show both `default` labelled "Claude Code default (no flag)" and `manual` labelled "Manual: ask every time"; `bypassPermissions` never appears.
5. **Rules preview of `.claude/settings.local.json`:** show only the `enabledPlugins` block plus "N other keys kept"; the server never sends other keys' values to the page (Appendix A Q1 resolved).
6. **No `color-mix()` or `:has()`** in the real CSS (WebKitGTK < 2.42 on Linux); tokens are precomputed.
7. **Zoom shortcuts** stay enabled in the Tauri webview (accessibility).
8. Contract additions for Phase 4 (Appendix A data gaps): a stable `id` per history entry, the project `key` on dashboard groups, the agent `role` and an `attention` reason, and a route listing local rules templates.

Mockups (self-contained, offline, open by double-click):

| File | Direction | One line |
|---|---|---|
| `docs/design/variants/a.html` | **A · Console** (recommended) | Sidebar of projects, dense agent rows, split session window |
| `docs/design/variants/b.html` | B · Queue | Attention-first "Now" feed, calm cards, full-screen focus session |
| `docs/design/variants/c.html` | C · Board | One lane per project with live terminal tails, ⌘K palette, tmux status line |
| `docs/design/variants/session-controls.html` | 0.3 session controls (§2.8, §9) | Every permission mode in light and dark, switcher states, quick actions, prompt buttons, shell, palette, End dialog, dashboard rows. Static, no mock bar |

Each mockup has a dashed **mock bar** on top (not part of the design): Screen, State, Theme (System/Light/Dark), Window size (Fit, 720×480, 1024×700, 1440×900), Reduced motion, and links between variants. URLs keep state: `a.html#session/permission`, `c.html?theme=dark&size=720x480#dashboard/many`.

All mock data is synthetic (`demo-api`, `builder-1`, `~/projects/…`, repeated-digit UUIDs). Every data string in the mocks goes through `textContent` exactly as the real app must.

---

## 1. Information architecture and navigation

### 1.1 Objects

| Object | Identity in the UI | Source |
|---|---|---|
| Project | name (repo dir basename), `PROJECT_KEY` internally, never a path in a URL | `GET /api/app/projects` |
| Agent (Claude session) | agent name (or "untitled session"), status, model, pane `%n`, branch | `/api/agents` groups + registry |
| Rules state | `none · nika · outdated · foreign` | `projects[].rules.state` |
| Settings | defaults for every project: config keys (models, remoteControl, permissionMode, panePlacement, limits, rules template). Read only here: `perProject` | `GET/PUT /api/app/settings` |
| Project setup (0.3.4) | one project's own settings: its plugins (0.4 adds models) | `GET/PUT /api/app/projects/:key/config` |
| Environment | tmux present, claude present, version | `/api/app/me` + `/api/agents` errors |

### 1.2 Screens and routes (app tier)

Routes are hash routes inside the single webview page; nothing in a route is a path or a free string.

| # | Screen | Route | Reached from |
|---|---|---|---|
| 1 | Dashboard | `#dashboard` | Mod+1, logo, back |
| 2 | Project view | `#project/<PROJECT_KEY>` | project name anywhere, tray item |
| 2b | Spawn agent (dialog) | over project view | "Spawn agent" in project view or dashboard group |
| 3 | Apply rules (dialog) | over project view | rules badge, "Apply rules…", Add-project toast |
| 4 | Settings | `#settings` | Mod+, , gear |
| 5 | Session window | `#session/<UUID>` | agent name, "Open", "Answer", tray |
| 6 | Tray menu | native (Tauri), not in the webview | menu-bar / panel icon |
| 7 | Browser tier | `http://127.0.0.1:3335/` (separate page) | user's browser |

```text
            tray ──── Open nika / project item / "N need you"
              │
              ▼
 ┌────────── Dashboard ◄──────────── back (⌘[ / Alt+←) ───────────┐
 │   │            │                                               │
 │   │            ├── agent name / Answer ──► Session window ─────┘
 │   │            └── project name ──► Project view ──┬─► Spawn dialog
 │   │                                                ├─► Apply rules dialog
 │   └── Settings (⌘,)                                 └─► Session window
 └── Add project (⌘O) → native folder picker → toast → [Apply rules]
```

Rules for every direction:
- One window. Dialogs are modal (`<dialog>.showModal()`), never nested; opening one closes any other.
- The session window is a screen, not a dialog: it keeps the app chrome so the user can jump to any other agent.
- "Needs you" (attention) always sorts first, everywhere: queue, groups, tray, palette.
- Ended agents are collapsed by default ("N ended" disclosure) and never count toward the attention badge. Built amendment 2026-11-09 (0.3.1): on the dashboard "Show ended" hides them (off: no "Ended" section, and a group with nothing live says "No live agents."; on: every "Ended (n)" section is open until folded by hand, and the checkbox resets those folds); until 0.4.0 the project view always showed its open "Ended" section (superseded below). **(built amendment 2026-11-13 (0.4.0))** Finished is hidden by default everywhere (owner: "finished must be hidden by default everywhere"). Every view has **one remembered "Show ended" toggle, off by default**, and it hides two things together: ended sessions and Claude's finished or stopped subagents. The dashboard keeps its checkbox in the header bar (`nika.showEnded`); the **project page has its own** in the same style, in its header bar before the actions (`nika.showEndedProject`), and no longer forces its "Ended" section open. The browser tier is the same page code, so it follows the dashboard rule. **(built amendment 2026-11-15 (0.5, W8))** The session window now lists its session's subagents, folded at the top of its Transcript column, with **its own remembered "Show ended" box inside that list** (`nika.showEndedSession`; §9.17); it does not follow the dashboard's. A stored value that is not exactly `true`, or storage that is blocked, means off. Under a row, "N subagents · M running" counts only what is shown; running subagents always show; while the rest is hidden a muted "+K ended" follows the count. A row with subagents but nothing running and nothing shown draws one muted line, "No subagents running +K ended" (a row with no subagents at all draws none; the line is not interactive, the toggle lives in the view's header bar). The CLI follows the same rule: `nika status` prints no ended rows and one muted line, "… N ended hidden (nika status --ended)"; `--ended` lists the latest 5 per project, `--full` lists them all and implies `--ended`; Every project added to nika is listed, also one with no session in the window ("no sessions yet" for `--since all`, else "no sessions in the last 7d" and so on); a folder never added shows only while a session runs there, or with `--ended`. `--json` always carries every agent.
- The browser tier shows the same dashboard data with every privileged control removed (not disabled) and one info line pointing to the app.

### 1.3 The three directions

#### A · Console (recommended)

```text
┌────────────┬──────────────────────────────────────────────────────────┐
│ nika 0.2   │ Dashboard     ◆2 need you ○3 waiting ●4 working   [Filter⌘F] │
│ Dashboard ⌘1│ ┌ Waiting on you ─────────────────────────────────────┐ │
│ Settings  ⌘,│ │◆ Needs you reviewer-2  opus  Asking to run a command  │ │
│            │ │◆ Needs you designer    opus  Asking you a question    │ │
│ PROJECTS  + │ └─────────────────────────────────────────────────────┘ │
│ DA demo-api ◆1│ demo-api  ✓ Rules current  ~/projects/demo-api  [▶][+] │
│ WC web-con… ◆1│ │● Working  builder-1  sonnet  Implement cursor…  now %12│ │
│ IS infra-…   1│ │○ Waiting  scout-1    haiku   List every caller… 11m %13│ │
│ DS docs-site │ ▸ 1 ended                                               │
│ ● tmux 3.5a  │                                                         │
└────────────┴──────────────────────────────────────────────────────────┘
```

- Shell: left sidebar 232 px (brand, Dashboard, Settings, project list with attention counts, environment footer); collapses to a 60 px icon rail at window width ≤ 900 px. Built amendment 2026-11-09 (0.3.1): with no projects the list shows "No projects yet." and "Add a repo with + to start agents and apply rules here."; below it a "Detected" sub-heading lists up to 8 unregistered repositories with live agents (needs-you count, then live count, then name), each row linking to its group heading on the dashboard plus a small "Add project" button (`aria-label` "Add <name> as a project") that opens the same folder picker; the list is hidden when empty. Built amendment 2026-11-13 (0.4, F1b): past 8 rows the list ends with one ghost button "N more" (`aria-label` "Show N more detected repositories", `data-fk="det-more"`; the 60 px rail uses `--fs-small` and no side padding); it shows the rest in the same order, then leaves, and focus goes to the first row that was behind it. The state is `state.expanded` id `detected`, so it survives redraws.
- Dashboard: "Waiting on you" queue on top, then one group per project of dense 40 px rows (status · name · model · prompt + branch · last activity · pane · ⋯).
- Project view: agents on the left (a "Show ended" checkbox in the header bar, §1.2), three cards on the right (Rules, Project setup, New agents: mode, pane and limit, each the project's own or Settings'; §3.17). **(built amendment 2026-11-09 (0.3.4))** The Plugins card became **Project setup**; its button opens the Choose plugins dialog (§3.15) instead of leaving for Settings.
- Spawn: right side sheet (480 px). Rules: large modal with file list + diff + notes.
- Session: split view, transcript (38 %, min 300 px) | live terminal, composer under the terminal.
- Strengths: highest density, everything one click away, scales to 50+ agents, closest to 0.1's mental model (groups by repo), keyboard-friendly, least novel.
- Weaknesses: the most "tool-like" look; attention can be missed if the queue scrolls away (mitigated by sidebar counts, tray dot and live-region announcements).

#### B · Queue

```text
┌───────────────────────── [ Now ②  Projects  Settings ] ─── ● ready [+ Add project] ┐
│  2 agents need you.                                                               │
│  1 waiting for a prompt, 4 working                                                │
│  (All) (demo-api) (web-console) …                                                 │
│  ┃◆ reviewer-2 · demo-api                       Waiting on you 4 min  [Answer]      │
│  ┃  Asking to run a command: rm -rf dist && npm run build                         │
│  ┃◆ designer · web-console …                                                      │
│  Your turn   ○ scout-1 · ○ orchestrator                                           │
│  Working     ● builder-1 · ● builder-ui · …  [Show 2 more]                        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- Top bar with a centred 3-segment nav (Now with attention badge, Projects, Settings). Rounded type, 15 px base, pill buttons, radii 8/12/18.
- "Now" is a feed ordered by what needs the user: large "Needs you" cards with a 6 px status edge, small "Your turn" cards, a compact "Working" list, ended folded.
- Session is a **focus mode**: the top nav hides, the terminal takes the window, the transcript is a drawer (push ≥ 1180 px, overlay below; Mod+Shift+H).
- Spawn: centred modal with "More options" disclosure. Rules: two steps (review accordions → confirm).
- Strengths: calmest, clearest "what do I do next", best first-run experience, large targets.
- Weaknesses: lowest density (about 8 agents per screen vs about 18 in A), projects are one click further away, the 2-step rules flow adds a click, focus mode hides context.

#### C · Board

```text
┌ nika / all projects ──────── [🔍 Jump to an agent, project or action ⌘K] ─── [+][⚙] ┐
│ Board ◆2 ○3 ●4 ■2                                                     [x] Live tails │
│ ┌ demo-api ✓ ◆1○1●2 ┐ ┌ web-console ↻ ◆1○1●1 ┐ ┌ infra-… ! ●1■1 ┐ ┌ docs-site ┐       │
│ │◆ reviewer-2 [Answer]│ │◆ designer   [Answer] │ │● migrate-…     │ │ No agents │       │
│ │ ▌1. Yes 2. … 3. No  │ │ ▌…                  │ │ ▌✻ Re-running…  │ │ [▶] [+]   │       │
│ │● builder-1          │ │○ orchestrator orch  │ │ ▸ 1 ended      │ └───────────┘       │
│ │ ▌+ return rows…     │ │ ▌> _                │ └────────────────┘                     │
│ └─────────────────────┘ └─────────────────────┘                                        │
│[nika] ◆2 ○3 ●4 ■2   tmux 3.5a · claude 2.1.319                              app · 14:02│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Horizontal lanes (304 px, scroll-snap) per project; agent tiles show the last 3–4 terminal rows ("live tails"); attention tiles get a 2 px rose outline and an Answer button. Lanes stack vertically ≤ 860 px.
- Bottom tmux-style status line (counts, environment, tier, clock). ⌘K command palette (Needs you / Agents / Projects / Actions).
- Settings as config-key rows (mono keys, exactly as stored). Rules as all diffs stacked with sticky file headers and a +/− rail.
- Session: mirror-dominant, right "Timeline" rail 360 px (tab when narrow), command-line composer with inline keycaps.
- Strengths: most "alive", best for watching many agents work, power-user speed with ⌘K, feels native to tmux users.
- Weaknesses: highest runtime cost (one capture per visible tile; see §8.6), noisy, horizontal scrolling with 5+ projects, weakest for screen-reader users (tails are hidden from AT by design), lowest text contrast inside tiles (11 px mono).

#### Comparison

| Criterion | A Console | B Queue | C Board |
|---|---|---|---|
| Agents visible at 1440×900 | ~18 rows | ~8 cards | ~10 tiles |
| Clicks to answer a waiting agent | 1 (queue row) | 1 (Answer) | 1 (Answer) |
| Clicks to a project's rules | 1 (sidebar) + 1 | 2 + 1 | 1 + 1 |
| Works at 720×480 | yes (rail, tabs) | yes | yes (stacked lanes) |
| Extra server load | none | none | ≤ 12 tile captures at 1 Hz |
| Screen-reader clarity | high (rows, landmarks) | high | medium |
| Learning curve for 0.1 users | lowest | medium | medium |
| Visual identity | neutral grey, colour = status only | soft violet, rounded | dark-first teal, mono |

### 1.4 Recommendation

Build **A · Console**, and take three things from the others:

1. From B: the dashboard's first line is a plain-language summary ("2 agents need you · 3 waiting · 4 working") and the tray's first item says the same thing.
2. From C: the ⌘K palette as a later addition (Phase 5), and optional 4-row live tails in the **project view only** (off by default, at most 8 panes, 1 Hz).
3. From C: the status line counts as text in the sidebar footer when the window is narrow.

Why A: it is the densest and least surprising evolution of 0.1, it scales to 50+ agents without new server load, and every interaction is a standard pattern (sidebar nav, list rows, side sheet, modal, split view, tabs).

---

## 2. Design tokens

### 2.1 Canonical tokens (Variant A), pasteable

The real app follows the OS theme (there is no theme key in `config.json`); the mockups use `[data-theme]` only for the mock toggle.

```css
:root {
  color-scheme: light dark;
  /* type */
  --font: system-ui, -apple-system, "Segoe UI", Cantarell, "Noto Sans", Ubuntu, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace;
  --fs-cap: 0.6875rem;   /* 11px: key caps, tiny meta */
  --fs-small: 0.75rem;   /* 12px: meta, help, counts */
  --fs-body: 0.8125rem;  /* 13px: body, rows, buttons */
  --fs-h3: 0.875rem;     /* 14px: panel titles */
  --fs-h2: 0.9375rem;    /* 15px: group / card titles */
  --fs-h1: 1.125rem;     /* 18px: screen title */
  --fs-display: 1.375rem;/* 22px: empty-state titles */
  --fs-term: 0.75rem;    /* 12px: terminal mirror, composer */
  --lh-body: 1.45;       /* mirror: 1.35 */
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;
  /* space (4px grid) */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;
  /* shape */
  --r-sm: 4px; --r-md: 6px; --r-lg: 10px; --r-pill: 999px;
  /* sizes */
  --h-ctl: 28px; --h-ctl-lg: 32px; --h-row: 40px; --side-w: 232px; --side-rail: 60px;
  /* motion */
  --dur-1: 120ms; --dur-2: 200ms; --dur-3: 320ms; --ease: cubic-bezier(0.2, 0, 0, 1);
  /* elevation */
  --elev-1: 0 1px 2px rgb(16 20 28 / 8%);
  --elev-2: 0 8px 24px -8px rgb(16 20 28 / 28%);
  --elev-3: 0 24px 56px -12px rgb(16 20 28 / 38%);
  --scrim: rgb(16 20 28 / 45%);
  /* colour roles: light */
  --bg: #f3f4f6; --bg-alt: #e8eaee; --surface: #ffffff; --surface-2: #f1f3f6; --surface-3: #e3e7ed;
  --line: #dde1e7; --line-strong: #868e9a;
  --text: #16181d; --text-muted: #545b66;
  --accent: #1d55d0; --on-accent: #ffffff; --accent-soft: #e4ecfc; --focus: #1d55d0;
  /* status: shared by all directions */
  --busy: #17753a; --busy-soft: #e1f4e7;
  --idle: #8a5300; --idle-soft: #fcf0d8;
  --attn: #b0125c; --attn-soft: #fce6ef;
  --ended: #5f6772; --ended-soft: #edeff2;
  --danger: #b42318; --danger-soft: #fde9e7;
  --diff-add: #e3f5e8; --diff-del: #fce9e9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --elev-1: none; --elev-2: 0 8px 24px -8px rgb(0 0 0 / 60%); --elev-3: 0 24px 56px -12px rgb(0 0 0 / 70%);
    --scrim: rgb(0 0 0 / 60%);
    --bg: #16181c; --bg-alt: #1c1f24; --surface: #202328; --surface-2: #272b31; --surface-3: #30353c;
    --line: #30353d; --line-strong: #6f7783;
    --text: #e9ebef; --text-muted: #a4abb6;
    --accent: #7fa8ff; --on-accent: #0b1a3a; --accent-soft: #1d2b4a; --focus: #7fa8ff;
    --busy: #5fd08a; --busy-soft: #173523;
    --idle: #f0b45a; --idle-soft: #3a2b12;
    --attn: #ff80b5; --attn-soft: #41182c;
    --ended: #9aa3ae; --ended-soft: #2a3038;
    --danger: #ff8a80; --danger-soft: #431b18;
    --diff-add: #163322; --diff-del: #3d1b1e;
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-1: 0ms; --dur-2: 0ms; --dur-3: 0ms; }
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }
}
```

Usage rules:
- Colour carries status only. Chrome stays neutral; `--accent` marks interaction (primary button, links, focus, selected nav).
- `--text-muted` is the lightest text allowed. Never put muted text on `--surface-3`.
- `--line` separates; `--line-strong` outlines interactive controls (inputs, secondary buttons, `kbd` keycaps) because it clears 3:1. **(built amendment 2026-11-09 (0.3.3))**
- Soft backgrounds (`--*-soft`) always carry their own foreground (`--busy` on `--busy-soft`, never `--text-muted`).

### 2.2 Status: colour + shape + words

| State (`data-s`) | Visible label | Glyph (CSS, `aria-hidden`) | Colour | SR text on rows | Live announcement on change |
|---|---|---|---|---|---|
| `attn` | Needs you | filled diamond (rotated square) | `--attn` | "Needs you: Asking to run a command" | "reviewer-2 in demo-api needs you: Asking to run a command" |
| `idle` | Waiting | hollow ring 2 px | `--idle` | "Waiting for your next prompt" | "scout-1 in demo-api is waiting for your prompt" |
| `busy` | Working | filled dot + spinning arc (static arc with reduced motion) | `--busy` | "Working" | none (too frequent) |
| `ended` | Ended | small square | `--ended` | "Ended, exit 0" | "builder-0 in demo-api ended" |

Rules badge: `nika ✓ Rules current` (busy colours), `↻ Rules outdated` (idle), `! Rules not by nika` (attn), `– No rules` (outlined, muted). Glyph + word, never colour alone.

### 2.3 Type scale

| Token | rem | px | Weight | Use |
|---|---|---|---|---|
| `--fs-display` | 1.375 | 22 | 600 | empty-state title |
| `--fs-h1` | 1.125 | 18 | 600 | screen title (`h1`) |
| `--fs-h2` | 0.9375 | 15 | 600 | group, card, dialog section |
| `--fs-h3` | 0.875 | 14 | 600 | panel header |
| `--fs-body` | 0.8125 | 13 | 400/500 | body, rows, buttons |
| `--fs-small` | 0.75 | 12 | 400/600 | meta, help, counts, errors (600) |
| `--fs-cap` | 0.6875 | 11 | 600/700 | key caps, diff action letters only |
| `--fs-term` | 0.75 | 12 | 400/700 | mirror, composer, diffs (mono) |

Numbers use `font-variant-numeric: tabular-nums` (`.num`). Mono is used for pane ids, branches, paths, plugin ids, model ids in config, diffs and the mirror; never for prose.

### 2.4 Spacing, radii, elevation, sizes

- Spacing: 4 px grid. Row padding 4/8/4/12; card padding 14; screen gutter 16; section gap 20–24; dialog body padding 16.
- Radii: 4 (chips, keys, kbd), 6 (buttons, inputs, menus), 10 (cards, dialogs, row lists), 999 (status pills, rules badge).
- Elevation: 1 = resting cards (light only), 2 = menus, toasts, jump-to-live, 3 = dialogs. Dark mode uses lines instead of `--elev-1`.
- Control heights: 28 (buttons, search), 32 (inputs, large buttons, stepper), 26 (the Shell toggle), 24 minimum for any target.

### 2.5 Motion

| Token | Duration | Used for |
|---|---|---|
| `--dur-1` | 120 ms | hover, pressed, switch thumb |
| `--dur-2` | 200 ms | toast in, dialog in (fade + 8 px rise + 0.99 scale) |
| `--dur-3` | 320 ms | side sheet in (24 px slide) |
| loops | 1.1 s | busy arc rotation; 0.8 s button spinner; 1.4 s skeleton sweep |

Reduced motion (OS setting): all durations become 0; the busy arc stays drawn but static; skeletons become flat `--surface-2`; the mirror never smooth-scrolls. No motion is ever needed to understand state.

### 2.6 Direction overrides (B and C)

Status, diff and danger tokens are identical in all three directions; only chrome changes.

```css
/* B · Queue */
:root { --font: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Cantarell, "Noto Sans", sans-serif;
  --fs-cap: .75rem; --fs-small: .8125rem; --fs-body: .9375rem; --fs-h3: 1rem; --fs-h2: 1.125rem; --fs-h1: 1.375rem; --fs-display: 1.75rem; --fs-term: .8125rem; --lh-body: 1.5;
  --r-sm: 8px; --r-md: 12px; --r-lg: 18px; --h-ctl: 36px;
  --bg: #f1f0f6; --bg-alt: #e9e7f1; --surface: #fff; --surface-2: #f7f6fb; --surface-3: #ebe8f6; --line: #e0dde9; --line-strong: #8a869c;
  --text: #1c1a2b; --text-muted: #57536a; --accent: #5a3dcc; --on-accent: #fff; --accent-soft: #ece8fd; --focus: #5a3dcc; }
/* B dark */
  --bg: #16141d; --bg-alt: #1b1924; --surface: #211e2b; --surface-2: #292635; --surface-3: #332f44; --line: #36324a; --line-strong: #787290;
  --text: #eeecf6; --text-muted: #aca7c2; --accent: #b6a6ff; --on-accent: #1d1442; --accent-soft: #2e2754; --focus: #b6a6ff;

/* C · Board */
:root { --fs-h3: .8125rem; --fs-h2: .875rem; --fs-h1: 1rem; --fs-display: 1.25rem; --r-sm: 3px; --r-md: 4px; --r-lg: 6px; --lane-w: 304px;
  --bg: #e7ebf0; --bg-alt: #eef1f5; --surface: #fbfcfd; --surface-2: #f1f4f7; --surface-3: #e2e8ef; --line: #cfd6df; --line-strong: #7a8596;
  --text: #101924; --text-muted: #4b5667; --accent: #006a82; --on-accent: #fff; --accent-soft: #d9eff4; --focus: #006a82;
  --sl-bg: #101924; --sl-fg: #dce5ef; }
/* C dark */
  --bg: #111823; --bg-alt: #151e2b; --surface: #1a2433; --surface-2: #212d3f; --surface-3: #2a384c; --line: #2b394d; --line-strong: #62758e;
  --text: #dce5ef; --text-muted: #97a6b9; --accent: #5fd3ea; --on-accent: #062731; --accent-soft: #123645; --focus: #5fd3ea;
  --sl-bg: #5fd3ea; --sl-fg: #062731;
```

### 2.7 Terminal mirror palette

The mirror is dark by default in both app themes (terminal output is authored for dark backgrounds). A per-viewer "Light" toggle swaps the 16-colour palette; it is stored in `localStorage` only.

```css
.term {
  --term-bg: #16181d; --term-fg: #dadee5; --term-cursor: #f2f4f7;
  --a0: #3b4048; --a1: #f47c7f; --a2: #7fd187; --a3: #e8c27e; --a4: #72b4ff; --a5: #d58cec; --a6: #5cc9d9; --a7: #c9cdd5;
  --a8: #868e9b; --a9: #ff9696; --a10: #9be69b; --a11: #f6d892; --a12: #97caff; --a13: #e5a9f6; --a14: #83deec; --a15: #f3f5f8;
  background: var(--term-bg); color: var(--term-fg);
}
.term[data-surface="light"] {
  --term-bg: #fbfbfc; --term-fg: #1f2329; --term-cursor: #1f2329;
  --a0: #1f2329; --a1: #c0222b; --a2: #1b7a35; --a3: #875800; --a4: #0b58c2; --a5: #8a3aae; --a6: #0a6e80; --a7: #58606b;
  --a8: #6b7380; --a9: #a10e24; --a10: #126128; --a11: #6c4700; --a12: #0a4aa3; --a13: #742a99; --a14: #085a6a; --a15: #3b424b;
}
.f0 { color: var(--a0) } /* … .f15, .b0 … .b15 the same way */
.fdb { color: var(--term-bg) } .bdf { background: var(--term-fg) } /* reverse video on default colours */
.sb { font-weight: 700 } .sd { opacity: .6 } .si { font-style: italic } .su { text-decoration: underline }
.tc { background: var(--term-cursor); color: var(--term-bg) }                       /* cursor, mirror focused */
.term:not(:focus-within) .tc { background: none; outline: 1px solid var(--term-cursor); outline-offset: -1px } /* hollow when unfocused */
```

Colours 16–255 and `[r,g,b]` are absolute: they are set through CSSOM (`span.style.color = …`) and are **not** remapped by the light surface. This is why the mirror defaults to dark.

### 2.8 Permission modes (0.3)

Owner requirement (2026-11-08): "All modes must change visual styling, because it don't understand if smth enabled." Every permission mode has its own colour, icon and word wherever it shows (session header, window frame, message box, switcher, dashboard rows, later graph nodes). Colour never travels alone. Mockup: `docs/design/variants/session-controls.html`.

#### 2.8.1 Tokens

Three tokens per mode, light and dark:

- `--m-<mode>`: text and icon colour of the tag; text of the pressed switcher segment.
- `--m-<mode>-soft`: tag fill, pressed segment fill. Always carries its own `--m-<mode>` text (§2.1 rule).
- `--m-<mode>-line`: tag edge, the 3 px window frame, the message-box edge, the pressed segment edge.

Bypass adds `--m-bypass-on` (text on the solid bypass fill) and `--m-bypass-stripe` (second colour of the striped frame). Shell (§9.6) adds `--shell` and `--on-shell`, aliases of `--text` and `--surface`.

```css
:root { /* light */
  --m-manual: #56575c;  --m-manual-soft: #ececef;  --m-manual-line: #86878d;
  --m-edits: #5137c4;   --m-edits-soft: #eeebfd;   --m-edits-line: #7a64e0;
  --m-plan: #0b6868;    --m-plan-soft: #ddf2f1;    --m-plan-line: #2a8e8e;
  --m-auto: #625a00;    --m-auto-soft: #f6f2c0;    --m-auto-line: #968a00;
  --m-bypass: #b3261e;  --m-bypass-soft: #fde7e5;  --m-bypass-line: #c0261c; --m-bypass-on: #ffffff; --m-bypass-stripe: #16181d;
  --m-dontask: #8a2597; --m-dontask-soft: #f7e4f8; --m-dontask-line: #a843b3;
  --m-unknown: #545b66; --m-unknown-soft: #ffffff; --m-unknown-line: #7c8490;
  --shell: var(--text); --on-shell: var(--surface);
}
/* dark: in tokens.css put this in BOTH dark blocks (the prefers-color-scheme one and :root[data-theme="dark"]) */
  --m-manual: #c4c5ca;  --m-manual-soft: #2d2e33;  --m-manual-line: #8c8d93;
  --m-edits: #b9aeff;   --m-edits-soft: #29244d;   --m-edits-line: #8e7ff0;
  --m-plan: #72cfcf;    --m-plan-soft: #13302f;    --m-plan-line: #3aa2a2;
  --m-auto: #e9d84c;    --m-auto-soft: #33310f;    --m-auto-line: #bcae22;
  --m-bypass: #ff6b61;  --m-bypass-soft: #46191a;  --m-bypass-line: #ff5a4f; --m-bypass-on: #2a0605; --m-bypass-stripe: #ffd8d4;
  --m-dontask: #eaa0ea; --m-dontask-soft: #3a1d3d; --m-dontask-line: #c46fc8;
  --m-unknown: #a4abb6; --m-unknown-soft: #202328; --m-unknown-line: #6f7783;
```

`--shell` and `--on-shell` are `var()` aliases, so they follow the theme without a dark copy. All values are plain hex: no `color-mix()`, no alpha (an alpha edge would make the 3:1 figure depend on what is behind it).

One class per mode sets a local "current mode" trio; tags, frames, segments and the message box read only `--mc*`:

```css
.m-manual  { --mc: var(--m-manual);  --mc-soft: var(--m-manual-soft);  --mc-line: var(--m-manual-line); }
.m-edits   { --mc: var(--m-edits);   --mc-soft: var(--m-edits-soft);   --mc-line: var(--m-edits-line); }
.m-plan    { --mc: var(--m-plan);    --mc-soft: var(--m-plan-soft);    --mc-line: var(--m-plan-line); }
.m-auto    { --mc: var(--m-auto);    --mc-soft: var(--m-auto-soft);    --mc-line: var(--m-auto-line); }
.m-bypass  { --mc: var(--m-bypass);  --mc-soft: var(--m-bypass-soft);  --mc-line: var(--m-bypass-line); }
.m-dontask { --mc: var(--m-dontask); --mc-soft: var(--m-dontask-soft); --mc-line: var(--m-dontask-line); }
.m-unknown { --mc: var(--m-unknown); --mc-soft: var(--m-unknown-soft); --mc-line: var(--m-unknown-line); }
```

Where the CSS lives: the `--m-*` and `--shell` tokens, the `.m-*` classes, `.mode` (§2.8.5), `.onoff` (§9.6) and `.msw` (§9.3) go in `public/tokens.css`, which both the dashboard and the session window load. Page-only rules stay with their page: the frame, the message-box edge, quick actions, prompt panel and palette in `public/session.css`; the row mode column in `public/app.css`.

| API `mode` | `MODE_META.cls` | Label | Icon (`#i-m-*`) | Claude's footer (xterm-256) | nika hue |
|---|---|---|---|---|---|
| `manual` | `m-manual` | Manual | hand | `⏸ manual mode on`, 246 grey | graphite (neutral) |
| `acceptEdits` | `m-edits` | Accept edits | pencil | `⏵⏵ accept edits on`, 147 lavender | violet, hue 251 |
| `plan` | `m-plan` | Plan | folded map | `⏸ plan mode on`, 73 teal | teal, hue 180 |
| `auto` | `m-auto` | Auto | bolt | `⏵⏵ auto mode on`, 220 gold | gold, hue 55 |
| `bypassPermissions` | `m-bypass` | Bypass | shield with a slash | not observed (claude-tui.md §7) | red, filled, striped frame |
| `dontAsk` | `m-dontask` | Don't ask | padlock | `⏵⏵ don't ask on`, 211 pink | orchid, hue 293–300 (not pink, see 2.8.4) |
| `unknown` | `m-unknown` | Mode ? | question mark in a circle | no recognised phrase | grey, dashed |

#### 2.8.2 Contrast (computed, WCAG 2.x relative luminance)

Text pairs need 4.5:1, frames and edges 3:1. "Edge" is the lowest of the line colour against `--bg`, `--surface` and `--surface-2` (the frame touches the header `--surface` and the window chrome; the tag edge sits on `--surface`, `--surface-2` on row hover, `--attn-row` in attention rows). 0 failures.

| Mode | Light: text on soft | text on `--surface` | text on `--attn-row` | edge ≥ | Dark: text on soft | text on `--surface` | text on `--attn-row` | edge ≥ |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| Manual | 6.11 | 7.21 | 6.55 | 3.22 | 7.86 | 9.15 | 9.06 | 4.30 |
| Accept edits | 6.66 | 7.80 | 7.09 | 4.00 | 7.26 | 7.93 | 7.85 | 4.37 |
| Plan | 5.65 | 6.57 | 5.98 | 3.53 | 7.74 | 8.66 | 8.58 | 4.65 |
| Auto | 6.16 | 7.04 | 6.40 | 3.18 | 9.07 | 10.80 | 10.70 | 6.24 |
| Bypass | 5.52 | 6.54 | 5.94 | 5.34 | 5.32 | 5.65 | 5.60 | 4.63 |
| Don't ask | 6.23 | 7.52 | 6.84 | 4.59 | 7.53 | 8.04 | 7.97 | 4.37 |
| Mode ? | 6.85 | 6.85 | 6.23 | 3.40 | 6.81 | 6.81 | 6.75 | 3.14 |

Other pairs:

| Pair | Needs | Light | Dark |
|---|---|--:|--:|
| `--m-bypass-on` on `--m-bypass` (filled tag, pressed segment) | 4.5:1 | 6.54 | 6.68 |
| `--m-bypass` fill against `--bg` / `--surface` | 3:1 | 5.94 / 6.54 | 6.37 / 5.65 |
| `--m-bypass-stripe` against `--bg` / `--surface` | 3:1 | 16.14 / 17.76 | 13.56 / 12.03 |
| `--on-shell` on `--shell` (shell chip on) | 4.5:1 | 17.76 | 13.20 |
| `--shell` edge against `--surface` | 3:1 | 17.76 | 13.20 |
| `--idle` on `--accent-soft` (palette "Opens a dialog" note on the active row) | 4.5:1 | 5.34 | 7.60 |
| `--surface` on `--danger` (End session button, filled) | 4.5:1 | 6.57 | 6.90 |
| `--danger` on `--danger-soft` (End failure alert) | 4.5:1 | 5.63 | 6.53 |

Unconfirmed tags are hollow, so their text sits on whatever is behind (`--surface` or `--attn-row`): the "text on `--surface`" and "text on `--attn-row`" columns cover them. `--m-unknown-line` is darker than `--line-strong` in light (#7c8490 vs #868e9a) because `--line-strong` is 2.98:1 on `--surface-2`.

#### 2.8.3 Icons

16×16 stroke symbols in the existing sprite style (`fill: none; stroke: currentColor; stroke-width: 1.6; round caps and joins`), drawn from scratch:

```html
<symbol id="i-m-manual" viewBox="0 0 16 16"><path d="M4.5 9V5.5M7 8V3M9.5 8V3.5M12 9V5.5M4.5 9v1.5a4 4 0 0 0 4 4h.5a3 3 0 0 0 3-3V9M4.5 11 2.9 9.4"/></symbol>
<symbol id="i-m-edits" viewBox="0 0 16 16"><path d="M10.5 2.8l2.7 2.7L6 12.7l-3.3.6.6-3.3zM9 4.3l2.7 2.7"/></symbol>
<symbol id="i-m-plan" viewBox="0 0 16 16"><path d="M1.8 4.2 5.6 2.6l4.8 1.6 3.8-1.6v9.2l-3.8 1.6-4.8-1.6-3.8 1.6zM5.6 2.6v9.2M10.4 4.2v9.2"/></symbol>
<symbol id="i-m-auto" viewBox="0 0 16 16"><path d="M9 1.8 3.6 9h4l-.8 5.2L12.4 7h-4z"/></symbol>
<symbol id="i-m-bypass" viewBox="0 0 16 16"><path d="M8 1.8 13 3.6V8c0 3-2.1 5.1-5 6.4C5.1 13.1 3 11 3 8V3.6zM2.2 2.2l11.6 11.6"/></symbol>
<symbol id="i-m-dontask" viewBox="0 0 16 16"><rect x="3.2" y="7" width="9.6" height="7" rx="1.5"/><path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7M8 9.8v1.4"/></symbol>
<symbol id="i-m-unknown" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3v.3M8 11.5v.2"/></symbol>
```

Session-control icons (§9) live in the same sprite: `i-shell` (`$`), `i-stop`, `i-compact`, `i-clear`, `i-model`, `i-rewind`, `i-end` (power), `i-cmd` (slash in a box), `i-dialog` (window), `i-chev`, `i-info`. Their paths are in the mockup's sprite; copy them from there.

#### 2.8.4 Why these hues

- **Close to Claude's footer, so the mirror and the app agree**: Manual grey, Accept edits lavender/violet, Plan teal, Auto gold.
- **Don't ask is orchid, not Claude's pink 211** (owner decision 2026-11-09, final). Pink 211 (#ff87af) is almost exactly nika's `--attn` in dark (#ff80b5), and "Needs you" must stay unique. Orchid sits between Accept edits (251) and Needs you (330). Don't ask is the rarest mode (nika never switches to or from it).
- **Plan uses a map, not ⏸.** Claude draws ⏸ for both Manual and Plan, and nika's mirror already uses a square for "Paused".
- **Auto gold (hue 55) vs Waiting amber (hue 36)**: kept apart by hue, by shape (square tag vs round pill) and by the bolt.
- **Manual graphite vs Ended grey**: Ended is a round pill with a small square glyph; Manual is a square tag with a hand.
- **Bypass is the loudest**: the only filled tag, the only striped frame and a red message-box edge (0.4 adds a red switcher segment, §9.3).

#### 2.8.5 The mode tag

Modes are **square-cornered tags with an edge**; agent status stays a **round pill with a glyph** (§2.2). The two never share a shape, so "what the agent is doing" and "what it may do" can't be confused even in greyscale.

```css
.mode { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px 0 6px;
  border: 1px solid var(--mc-line); border-radius: var(--r-sm); background: var(--mc-soft); color: var(--mc);
  font-size: var(--fs-small); font-weight: 600; white-space: nowrap; }
.mode .ic { width: 14px; height: 14px; }
.mode[data-confirmed="false"], .mode.m-unknown { border-style: dashed; background: transparent; }
.mode .mnote { font-weight: 400; padding-left: 5px; border-left: 1px dashed var(--mc-line); }   /* "unconfirmed" */
.mode.m-bypass { background: var(--m-bypass); border-color: var(--m-bypass); color: var(--m-bypass-on); }
.mode.m-bypass[data-confirmed="false"] { border-style: solid; }   /* bypass never looks weaker */
.mode.m-bypass .mnote { border-left-color: var(--m-bypass-on); }
.mode.icon-only { padding: 0 4px; gap: 0; }   /* label moves to .sr-only and title */
```

Markup (`modeEl`): `span.mode.<cls>[data-confirmed][title]` > icon (`aria-hidden`) + `span.sr-only` "Permission mode: " + `span` label + optional `span.mnote` "unconfirmed". `title` = "Permission mode: Plan" or, unconfirmed, "Permission mode: Plan (not confirmed: Claude's footer is covered or not shown yet)".

| Variant | Where | Look |
|---|---|---|
| full | session header | icon + label (+ "unconfirmed") |
| compact | dashboard rows ≥ 860 px (app tier > 1010 px) | icon + label; an unconfirmed tag is hollow and dashed, the word "unconfirmed" goes to `.sr-only` and `title` (keeps the 128 px column) |
| icon-only | dashboard rows ≤ 860 px (app tier ≤ 1010 px) | icon in the 24 px box, edge and fill as above; label in `.sr-only` + `title` (same rule as the status glyph in §3.3) |

**(built amendment 2026-11-13 (0.4.0))** The **New agents** card shows its Permission mode as the same tag (`modeEl`, full variant), not as a sentence: the short word with the mode's icon and colour. The long descriptions ("Auto: a classifier approves actions without asking you", "Manual: ask every time", "Claude Code default (no flag)") stay in the spawn sheet's select and Settings. `default` is a Settings value, not a mode a pane can be in, so it is not in `MODE_META` (a pane reporting it is still unknown); on the card it is the word **Default** with the existing gear icon and the neutral Manual colour (`m-manual`: Claude Code asks every time by default), so it differs from Manual by icon and word and never by colour alone. Manual, Accept edits, Plan, Auto and Don't ask use their own entries unchanged. The tag is confirmed (a setting has no footer to read). Before Settings loads the value is "–".

#### 2.8.6 Confirmed, unconfirmed, unknown

| State | When | Frame | Tag | Words |
|---|---|---|---|---|
| confirmed | the footer shows the mode (`modeConfirmed: true`, `mode` ≠ `unknown`) | solid 3 px `--mc-line` | filled, solid edge | label |
| unconfirmed (held) | `modeConfirmed: false`. The footer is covered (permission prompt, dialog) or unreadable, and `mode` is a held value: the last mode read on this pane, else, for a pane nika started, its launch mode (also before the footer first shows) | dashed 3 px (10 px on, 6 px off) in `--mc-line` | hollow, dashed edge | label + "unconfirmed" |
| unknown | `mode: "unknown"` with `modeConfirmed: true`: the footer is unreadable and nika has neither read a mode on this pane nor launched it | dashed, `--m-unknown-line` | hollow, dashed, grey | "Mode ?" |
| bypass, either | footer contains "bypass", or launched with it (0.4) | hazard stripes, never dashed | filled, solid | "Bypass" (+ "unconfirmed") |

A held value and a launch value look the same: there is no third style. A held value keeps its mode's colour but is always dashed and says "unconfirmed", so it never claims more than nika saw. Unknown never takes a mode colour; it appears only when nika has no reading at all. The usual case is a prompt: while it covers the footer, the window shows the held mode, dashed, not "Mode ?".

#### 2.8.7 Announcements

One polite region per session window (`#mode-live`, `aria-live="polite"`), separate from the global announcer so a mode change is never swallowed by a status message.

- Change: "builder-1: permission mode is now Plan."
- Bypass: "builder-1: permission mode is now Bypass. Claude runs every tool without asking."
- Unconfirmed at open: "builder-1 started in Plan mode, not confirmed yet."
- A switch from nika (§9.3): only the final mode is announced, once, after the mode route answers. The tag follows each capture on the way, silently. Ending where it started: nothing.
- Same mode, confirmed ↔ unconfirmed (a prompt covers the footer, then leaves): nothing; the prompt has its own announcement (§9.5). Becomes unknown, or from unknown back to the same mode: nothing.
- At most one message per capture; flapping between a mode and unknown within 3 s is not announced.

---

## 3. Component inventory

States: D default · H hover · F focus-visible · A active/pressed · X disabled · L loading · E error · 0 empty. "—" means the state does not exist for that component.

### 3.1 Buttons

| Variant | D | H | F | A | X | L |
|---|---|---|---|---|---|---|
| Primary | `--accent` fill, `--on-accent` text, 600 | fill mixed 12 % toward `--text` | 2 px `--focus` ring, 2 px offset | fill `--accent`, translateY(0) | 50 % opacity, `cursor: not-allowed`; when a reason exists use `aria-disabled="true"` + reason toast on click | 12 px spinner + verb-ing label ("Applying…"), `aria-busy="true"`, `disabled` |
| Secondary | `--surface` fill, `--line-strong` border | `--surface-2` | ring | `--surface-3` | as above | as above |
| Ghost / icon | transparent, 28×28 icon, `aria-label` + `title` | `--surface-3` | ring | `--surface-3` | as above | spinner replaces icon |
| Danger | `--danger` text + border | `--danger-soft` | ring | `--danger-soft` | as above | as above |
| Link | `--accent`, underlined, min-height 24 | underline 2 px | ring | — | — | — |

Copy: buttons name the result ("Apply rules", "Spawn agent", "Start orchestrator", "Save"), never "OK/Submit". The toast after an action repeats the verb ("Rules applied", "Spawned builder-3").

Privileged actions when tmux or claude is missing: keep visible, `aria-disabled="true"`, title and click toast give the reason ("Needs tmux."). In the browser tier they are not rendered at all.

### 3.2 Status badge, rules badge, model tag, counts

| Component | D | H | F | E | 0 |
|---|---|---|---|---|---|
| Status (`.st`) | glyph + label (or `sr-only` label in compact rows) | — | — | — | — |
| Status pill (`.pill-st`) | `--st-bg` + `--st-c` text | — | — | — | — |
| Rules badge | glyph + words, pill | if it is a button: `--surface-2` | ring | — | "– No rules" outlined |
| Model tag | `--surface-2`, 12 px 600, `title="Model: sonnet"` | — | — | — | "–" when unknown |
| Counts line | "◆ 2 need you · ○ 3 waiting · ● 4 working" with SR words | — | — | — | hidden when 0 |

### 3.3 Agent row (A)

Grid: status 104 · name ≥120 · model 64 · **(0.4) context 64 (§3.19)** · what (prompt + branch chip) · activity 56 · pane 44 · ⋯ 32. Height ≥ 40.

| State | Look |
|---|---|
| D | `--surface`, 1 px `--line` between rows |
| H | `--surface-2` |
| F | the name link gets the ring (rows are not focusable themselves; name link and ⋯ button are the two tab stops) |
| attn | `--attn-soft` 55 % tint + 3 px inset left bar `--attn` + reason text in `--attn` |
| busy / ended | prompt in `--text-muted`; ended name muted |
| no pane | pane column shows "–"; "Focus in tmux" missing from ⋯ |
| loading | skeleton rows 40 px (status 90, name 160, text flex, time 60) |
| error | whole list at 60 % opacity + banner "Disconnected… reconnecting every 3 s" (stale data stays readable) |
| 0 | "No agents in this project. [Start orchestrator] [Spawn agent]" inside the group |

Container widths: ≤ 860 px (app tier: ≤ 1010 px) hides model and pane columns and shows status as glyph only (the context column stays at 56 px, number only, no bar); ≤ 600 px moves the prompt to a second line.

**(0.4) Context** cell (`div.c-ctx`) right after the model, on both tiers: the meter of §3.19. Ended rows show their last value muted.

**(0.4) Role badge** after the name (`roleTagEl(roleTag(a, pickId))`; markup and words in §3.16). At ≤ 860 px (app tier ≤ 1010 px) the long word is clipped like the mode label (still read by screen readers) and a short one shows.

**(0.5, W9) Label chip**, first child of `.c-what`, before the project chip and the "under <parent>" chip (`labelEl(agentLabelView(a))`; look, words and states in §3.21). A row has one only when a spawned agent's pane carries a kind: the main orchestrator, a sub-orchestrator (its role tag is its label), a user's own session and an ended row show none. Both tiers draw it.

**(0.4) Nesting.** A group whose live agents hang under each other draws one flat `ul.rows` in tree order, each row indented by its place in the tree (§3.17). A group where nothing nests is drawn exactly as before.

**(0.5, W8) Subagent lines.** Under a row that has subagents (§1.2, §9.17): a `details.subs` ("N subagents · M running" with a muted "+K ended") whose lines each hold a state badge (colour, glyph and word: Running, Finished, Stopped), the description, the label chip (§3.21), the model and the time; or, when nothing is running and nothing shown, the one muted line "No subagents running +K ended". In the app tier the description is a link to the subagent's read-only view; on the browser tier it is plain text.

### 3.4 Project group / card

| State | Look |
|---|---|
| D | name (h2, ellipsis at 32ch, link), rules badge, path (muted, ellipsis at 40ch, hidden ≤ 760 px), counts, actions [Start orchestrator] [Spawn agent] |
| H/F | name link underline / ring |
| unregistered repo | "not a nika project" muted + [Add project] instead of the actions |
| limit reached | Spawn shows `aria-disabled` and the limit as its title; a click toasts it (§3.17) |
| **(0.4)** orchestrator | the first button follows `orchState`: **Open orchestrator** (live), **Resume orchestrator** (ended), **Start orchestrator** (none, or gone with its own title). §3.16 |
| **(0.4)** sub-orchestrator | the project page's header adds **Spawn sub-orchestrator** (`i-sub-spawn`, secondary) after Spawn agent; the dashboard group header keeps its two buttons. §3.17 |
| 0 | see agent row 0 |

### 3.5 Form fields

| Field | D | H | F | X | E |
|---|---|---|---|---|---|
| Text / number / select / textarea | 32 px, `--line-strong` border, `--surface` | border `--text-muted` | ring (`:focus-visible` on inputs = always on focus) | `--surface-2`, muted text | 2 px `--danger` border (1 + inset 1), message below: "!" disc + 600 text, `aria-invalid="true"`, `aria-describedby` → message id |
| Radio card | 1 px `--line` box, title + muted description | — | ring on the radio | 50 % | — |
| Radio card checked | `--accent` border + `--accent-soft` | | | | |
| Checkbox / switch | 16 px, `accent-color: --accent`; switch 34×20 | — | ring | 50 % | — |
| Stepper (max agents) | [−] 64 px input [+], 32 px | — | ring | − at 1, + at 8 disabled | message "Choose a whole number from 1 to 8." |

Validation: on blur for format errors, on submit for everything. Submit with errors → error summary banner at the top of the form ("3 fields need a fix before saving.") and focus moves to the first invalid field. Server 400 names the field; show the same message pattern on that field.

Messages (exact copy):
- model: "Use a model id such as claude-sonnet-5-5, or opus, sonnet, haiku, fable."
- RC prefix: "Lowercase letters, digits and dashes, up to 20, starting with a letter or digit. Leave empty to use the project name."
- agent name: "Lowercase letters, digits and dashes, up to 40, starting with a letter or digit."
- max agents: "Choose a whole number from 1 to 8."
- brief: "Write the first message for the agent." (empty), "The brief is over 64 KB." (size)

### 3.6 Dialogs

| Kind | Size | Header | Footer |
|---|---|---|---|
| Modal (rules) | min(980, vw−32) × min(720, vh−32) | title + close (×) | Cancel · primary |
| Side sheet (Settings drawer, 0.4.0, §3.20) | 480 × full height, right edge | "Settings" + project name + close | none |
| Side sheet (spawn) | 480 × full height, right edge | title + project + close | count note · Cancel · Spawn agent (or Spawn sub-orchestrator, §3.17) |
| Confirm (remove project) | 440 wide | title | Cancel · danger action |
| Modal (Choose plugins, 0.3.4) | min(560, vw−32) × min(640, vh−32) | title + close (×) | Cancel · Save plugins (§3.15) |
| Modal (Choose models, 0.4) | min(480, vw−32) | title + close (×) | Cancel · Save models (§3.15) |

States: D (open, scrim `--scrim`), L (primary shows spinner; Esc and Cancel are disabled while a write is in flight; the `cancel` event is prevented), E (inline alert at the top of the body, focus moves to it), success (body replaced by a result list + Done, which gets focus).

### 3.7 Diff viewer

Grid per line: old no (3.5em) · new no (3.5em) · marker (1.5em) · text. Mono 12/1.5. Added lines `--diff-add` + "+" in `--busy` 700; removed `--diff-del` + "−" in `--danger` 700; hunks `--surface-2` muted; the line text stays `--text` (≥ 10.78:1). Horizontal scroll inside the diff, never wrap. The diff `<pre>` is focusable (`tabindex="0"`) so it can be scrolled by keyboard.

| State | Look |
|---|---|
| create | all lines "+", file action badge "create" (busy colours) |
| update | hunks, badge "update" (idle colours) |
| unchanged | no diff body: "Unchanged. Not touched." badge "unchanged" (ended colours). **(built amendment 2026-11-14 (0.4.0))** An entry may carry a server `note` (plain text, shown with `textContent`, only on `unchanged` and `skipped`, for example `CLAUDE.md`: "Gets the rules through @AGENTS.md."); the detail pane then shows it in place of the default line, and the list row still says "unchanged". A `skipped` entry without a note says "Skipped. Not touched." |
| foreign | full replace diff, badge "replace" (attn colours) + confirm checkbox |
| settings.local.json | only the `enabledPlugins` block; header note "N other keys kept (values not shown)" |
| L | 6 skeleton lines |
| E | "Preview failed: <message>. [Retry]" |

### 3.8 Toast and banner

- Toast: bottom centre, max 440 px, `--text` on `--bg` (inverted), 4.2 s, optional one action button; errors use `--danger` + white and `role="alert"`, info uses `role="status"`. Toasts never steal focus. Every toast action also exists elsewhere (e.g. Apply rules in the project view), so a missed toast never blocks a task.
- Banner (page-level): icon + bold first sentence + fix + optional [Retry]. Kinds: danger (tmux missing, disconnected), warn (claude missing), info (browser tier read-only). Not banners: a `tmux` source that only says no server is running is `ok` (no panes, nothing wrong), and registry files nika skipped (unreadable or not in Claude's format) show as one muted line, `p.skip-note.muted` (`--fs-small`, `--text-muted`), at the top of the dashboard, with the same text as `nika status`: "N session files skipped (unreadable or not in Claude's format)" ("1 session file skipped …" for one). It is information, not an error: the list is only short of those sessions.

### 3.9 Terminal mirror

| State | Look / behaviour |
|---|---|
| live | rows rendered from capture; cursor block; header "● Live · 92 × 30" |
| paused | user scrolled up > 8 px from bottom: header dot turns to an amber square + "Paused"; "Jump to live ↓" button bottom-right; new captures are applied but scroll position is kept |
| passthrough | 2 px `--accent` inset outline + accent banner "Typing goes to pane %12. Ctrl+] to stop." |
| input box mirrored (0.5) | with a readable draft and Type into pane off, the rows from Claude's input box down are not drawn (Claude's prompt suggestion is a row of that box, so it is cut with it and the message box shows it as its placeholder); a one-row strip "Input box · mirrored in the message box below" ends the mirror (§9.12) |
| unfocused | cursor becomes a hollow outline |
| pane gone | overlay "Pane %12 is gone. The agent ended or the pane was closed. The transcript is still readable." composer disabled |
| tmux error | overlay `role="alert"` "tmux failed: capture-pane exited 1. Retrying every 2 s. [Retry now]" |
| loading | "Connecting to pane %12…" centred, no skeleton |
| empty | blank rows still render (no message) |

### 3.10 Input composer

Monospace textarea with a "›" prompt, grows 1 → 8 lines (20 px each), then scrolls. Placeholder "Message builder-1…", or Claude's prompt suggestion while it offers one (§9.12).
Its keys are in §4.2; there is no row of key buttons (§3.11). **(built amendment 2026-11-09 (0.3.3))**

Order inside the composer, top to bottom: quick actions and their reason line (§9.4) · model popover (while open) ·
attention note or prompt panel (§9.5) · message box · mode row ("Mode" + switcher + reason line, §9.3) · notes row (argument hint, shell hint, problem line).

| State | Look |
|---|---|
| D | `--line-strong` border |
| F | `--accent` border + 1 px ring (focus-within) |
| multi-line paste | chip "Pasted 14 lines · sends as one paste [Clear]" |
| X | pane gone / tmux error: disabled, placeholder "Pane is gone" |
| rate-limited | line under the box in `--idle`: "Too fast: max 20 keys per second. Your text is kept." (`role="alert"`) |
| echo | not shown: a screen-reader-only (`.sr-only`) polite live region in the notes row, so a screen reader still hears: "Sent 23 characters + Enter to %12", "Sent Esc to %12", "Sent Shift-Tab to %12", one line per arrow run ("Sent 3 × Down to %12", "Sent 5 arrow keys to %12") |
| permission prompt | attention note above: "reviewer-2 asks to run a command. Use ↑ ↓ and Enter to choose, or Esc to refuse." |

Notes row: the argument hint, the shell hint, the draft note (0.5, §9.12) and the problem line, in that order; the row wraps and takes no height while all four are empty. **(built amendment 2026-11-13 (0.4.0, F7); the draft note 2026-11-14 (0.5))**
The hint row with the key tips ("Esc ^C ⇧Tab go to Claude", "⌃⇧Tab moves focus back", "⌘/ all shortcuts") and the visible "Sent … to %12" echo is
gone (owner decision 2026-11-13): the keys are in the Keyboard shortcuts window (§4.6) and in the message box's accessible name (§4.2), and the
echo keeps only its screen-reader job. Nothing else in the row changed. The `.hintline` rules and the composer-width and height
queries that hid the tips went with it.

### 3.11 Key chips (removed in 0.3.3)

**(built amendment 2026-11-09 (0.3.3))** The row of key buttons under the message box is gone (owner decision
2026-11-09). Its keys work from the message box itself (§4.2): Esc, Ctrl+C (as Stop, while Claude works), Shift+Tab,
and ↑ ↓ ← → and Enter when the box is empty. Tab is no longer sent from the box; Type into pane still sends Tab and
every other allow-listed key. The prompt gates the Shift-Tab and Enter chips had stay on those keys (§9.5).

### 3.12 Menus, tabs, skeletons

- Row menu ("⋯"): disclosure button (`aria-expanded`, `aria-controls`) + list of buttons; Esc closes and returns focus; one open at a time; items: Copy resume command, Show report, Open in claude.ai ↗, Focus pane %n in tmux.
- **(0.4)** `menuEl` items may carry `fk` (`data-fk`), `group: true` (`li.grp`: a rule above the item) and `reason` (the item is `aria-disabled="true"` with the reason as its `title`; it stays focusable, a click shows the reason as an error toast and runs nothing). The app tier adds the orchestrator items of §3.16 between "Focus pane" and "End session…", each group set off by a rule.
- Tabs (session narrow layout): `role="tablist"` / `tab` / `aria-selected`; Left/Right move, Home/End jump (spec; mock uses click).
- Skeleton: `--surface-2` → `--surface-3` sweep 1.4 s; flat with reduced motion; `aria-busy="true"` on the container, plus "Loading agents…" `sr-only`.

---

### 3.13 Back button (owner request 2026-11-09)

One look on every screen with a back link (project view, session window): a **ghost button**, not a text link.
`<a class="back" href="…">` with the `i-back` icon and the label (the session window keeps its project name or
"Dashboard" in `#proj`). Rules live in `public/tokens.css` (both pages load it), and both pages drop their `.crumb` rules.

```css
.back { display: inline-flex; align-items: center; gap: 4px; height: 28px; max-width: 28ch; padding: 0 8px 0 4px;
  border-radius: var(--r-sm); color: var(--text-muted); font-weight: 600; text-decoration: none; }
.back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back:hover { background: var(--surface-3); color: var(--text); }
.back:active { background: var(--surface-3); }
.back:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

`title` "Back to <label> (⌘[)" on macOS, "Back to <label> (Alt+←)" on Linux; `aria-keyshortcuts` "Meta+BracketLeft" /
"Alt+ArrowLeft". The session window gains the same shortcut (it had none): ⌘[ / Alt+← follows the button's `href`,
except while passthrough is on (Linux Alt+← then goes to the pane rules: not on the allow-list, not sent; macOS ⌘[ stays
an app shortcut, §4.2).

**(0.3 build, 2026-11-09)** Settings has no back link: the screen never had one, and its header holds only the `h1` and
a one-line note. ⌘[ / Alt+← still goes back to the dashboard from Settings (§4.6 table). So the screens
with a back link are the project view and the session window.

### 3.14 Add to Applications notice (owner request 2026-11-09, ADR 0011)

App tier, macOS, dashboard screen only: a page-level **info banner** (§3.8) at the top of the dashboard's main area,
driven by `GET /api/app/me` `appCopy` (read at load and after each action). One banner at a time:

| `appCopy` | Banner text | Buttons |
|---|---|---|
| `state: missing`, a source, not `dismissed` | **Add nika to Applications** so Spotlight and Launchpad can find it. | **Add to Applications** (primary, small) · Not now (ghost) |
| `state: stale`, `managed` | **nika <available> is installed.** Update the app in Applications to match. | **Update app** (primary, small) · Not now (ghost) |
| anything else | no banner | — |

- "Not now" on Add posts `{ "action": "dismiss" }` (never asked again; `nika app install` still works). "Not now" on Update
  only hides the banner until the next launch (nothing is posted).
- Pressing the primary button: spinner + "Adding…" / "Updating…", `aria-busy`, both buttons aria-disabled.
- 200: the banner leaves; toast (`role="status"`) "nika is in Applications. Open it from Spotlight or Launchpad." (Add) or
  "Updated the app in Applications to <version>." (Update); with `restart: true`: "Updated to <version>. Quit and reopen
  nika to use it."
- Errors stay in the banner as one alert line (`role="alert"`), fixed copy, the buttons re-enabled:
  `foreign-target` "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace. Move it away, then try again." · `no-source` "nika can't find
  its own app to copy. Reinstall it with Homebrew." · `copy-busy` "nika is already copying the app." · `copy-failed`, 5xx,
  network "nika couldn't copy the app to Applications."
- Icon: `i-apps` (a 2×2 grid of rounded squares, 16 px, same stroke as the set). Every string is static copy plus the
  server's version number (rendered with `textContent`).

### 3.15 Project setup card, Choose plugins dialog (0.3.4) and Models (0.4)

Per-project settings live on the project page, not in Settings (ADR 0012). Settings keeps only the defaults for every project.

**Project setup card** (`#proj-setup`, second card of the right column; the aside's `aria-label` is "Project details"):
"Project setup", "Applies to this project only." and "Defaults are in Settings." ("Settings" links to `#settings`), then a
**Plugins** block: `h3` with a count ("3 on"), up to 8 chips in A to Z order, "+N more" when there are more, and "Written into
`.claude/settings.local.json` when you apply rules." A chip for a plugin that is no longer installed has a dashed edge, the
warning icon in `--idle` and "(not installed)". With no plugin chosen: "No plugins chosen. Agents use only what the project
already enables." Below the block, **Choose plugins…** (`button.btn`, `aria-haspopup="dialog"`, never a link).

**Choose plugins dialog** (static `<dialog id="dlg-plugins">`, no `<form>`, so Enter in the filter never saves): header
"Choose plugins for <project>" and ×; a sentence on where ticks are written; an alert slot; a full-width filter; the count
line; one scrolling list (a `<fieldset>` with the screen-reader legend "Installed plugins"; nothing else in the dialog
scrolls); a help line; footer Cancel · **Save plugins**.
- Row (`label.check.plug-row`, min height 32): checkbox · `name` (mono 12, wraps anywhere) with " @market" muted · "on" (ticked
  only, accent, hidden from screen readers). A ticked row has the `--accent-soft` fill. A row for a ticked plugin that is no
  longer installed adds a second line, warning icon + "(not installed)"; its accessible name ends "(not installed)".
- Order is fixed when the dialog opens: ticked plugins A to Z, then the rest. Ticking never moves a row; only the filter
  redraws rows.
- Filter: case-insensitive substring of `name@market`; a hidden row keeps its tick. Count line "<on> on · <n> installed", filtered
  "Showing <k> of <n> · <on> on"; 400 ms after typing it announces "<k> plugins shown" or "No plugin matches".
- Open: focus the filter; the ticks come from `GET /api/app/projects/:key/config`, the list from `GET /api/app/plugins`.
- States: loading (6 skeleton lines, Save disabled, filter usable) · load error (alert, footer Cancel · Retry) · none installed
  or ticked ("No plugins are installed in Claude Code."; filter hidden; footer Close only) · no match ("No plugin matches “<text>”."
  and a Clear filter link-button that focuses the filter) · saving (Save "Saving…", Cancel, ×, filter and boxes disabled, the
  dialog busy so Esc does nothing) · save error (alert, ticks kept, focus on the alert) · saved (toast "Plugins saved for
  <name>. Apply rules to write them." with **Apply rules**).
- Save sends `PUT /api/app/projects/:key/config` `{ "plugins": [ticked, sorted] }` only when the set changed; unchanged closes
  with no request. `[]` means "leave `enabledPlugins` alone". Cancel, Esc and × discard silently.
- Keys: Tab order × → alert → filter → boxes (Space) → Clear filter → Cancel → Save. Esc in a filter with text clears it, else
  closes. Mod+Enter saves. Focus returns to **Choose plugins…**.

**(0.4) Models block and Choose models dialog.** Under the Plugins block the card has a **Models** block (same `h3` shape, with
"<n> set here" when n > 0): a `dl.kv` (`data-fk="setup-models"`) listing only the roles this project sets, in the order
Orchestrator, Reasoner, Builder, Scout; each `dd` shows the catalog label ("Opus 5.5") with the id in its `title`, and a Custom ID
in mono, wrapping anywhere. With none set: "All roles use the defaults from Settings."; before Settings has loaded: "Not loaded
yet." Then "Used when nika starts this project's orchestrator or spawns its agents." and **Choose models…**
(`button.btn`, `aria-haspopup="dialog"`, `data-fk="choose-models"`).

**Choose models dialog** (static `<dialog id="dlg-models" class="dlg-models">`, no `<form>`, width min(480, 100vw−32); only the
body scrolls): header "Models for <project>" (name cut at 32) and ×; "Used when nika starts this project's orchestrator or
spawns its agents. Running sessions keep their model."; an alert slot; four `.field`s (label, `select#md-model-<role>`, a
Custom ID input and its error line); "Defaults are in Settings."; footer `span#md-dirty` · Cancel · (Retry) · **Save models**.
- Each select is `fillRoleOverride`: **Use default (<Settings model's label>)** first, then the catalog groups, then Custom ID.
  A saved id the catalog lacks opens as Custom ID with its field filled. The Custom ID field checks `MODEL_ID` on blur and on
  Save, with the Settings copy (`MODEL_HINT`).
- Open: focus the title while loading, then the Orchestrator select. `loadSettings()`, `loadModels()` and
  `GET /api/app/projects/:key/config` run together.
- Save is off until the draft differs from what was loaded, and off again when changed back; the footer says "No changes yet."
  or "<n> role changed" / "<n> roles changed". Enter in a Custom ID field saves only while Save is on.
- States: loading (4 skeleton lines, Save off) · load error (alert "The model settings could not be loaded. Check that nika is
  still running, then try again."; footer Cancel · Retry) · no catalog (a help line "The model list did not load. Choose Use
  default, or type a model ID."; each select offers Use default and Custom ID) · invalid custom (field error; on Save the alert
  "<n> field(s) need a fix before saving." and focus on the first) · saving (Save "Saving…", Cancel, ×, selects and fields off, dialog
  busy) · save error (alert, draft kept, focus on the alert).
- Save sends `PUT /api/app/projects/:key/config` `{ "models": { "orchestrator", "reasoner", "builder", "scout" } }`, each an id or
  `null` (= default), and the page copy (`state.settings.perProject[key].models`) follows. Toast "Models saved for <name>.
  Sessions nika starts from now on use them."; when the project's rules state is `nika` or `outdated` it adds "Apply rules to
  update the models in rules/orchestration.md." (the rendered file changes only on Apply).
- The spawn sheet's Roles group lists the project's effective models; an overridden role reads "Builder · claude-opus-5-5 (this
  project)". The page computes them with `effectiveRoleModels`, which mirrors the server's `effectiveModels`.
- Keys: Tab order × → alert → each select / Custom ID field → Cancel → Retry → Save. Esc, Cancel and × discard silently. Focus
  returns to **Choose models…**.

**Settings save bar.** The bar (Save · Discard) is hidden until the form differs from what was loaded, and hidden again when
the values are put back. Showing it announces "Unsaved changes. Save or discard them at the bottom." Discard repopulates the
form, focuses the page heading and announces "Changes discarded." While the bar is hidden Enter and Mod+Enter send nothing.

### 3.16 Pick or resume an orchestrator (0.4)

A project remembers one orchestrator by session id (`perProject.<key>.orchestratorSessionId`, app tier only). Start orchestrator saves the session it starts, so the header can **Resume** it after it ends. Any other session of the project can be made the orchestrator (**Set**), and **Stop using** forgets the id (it never ends a session or removes a tag).

**Badge** (`span.tag[title] > span.tag-l + span.tag-s[aria-hidden]`, the same markup in rows and the session header). Never colour alone: each state has its own word.

| Kind | When | Class | Words |
|---|---|---|---|
| main | live, role `orchestrator` | `.tag` | "orchestrator" (short "orch") |
| sub | live, role `sub-orchestrator` (read from the role, never derived from depth; an orphan keeps it) | `.tag.sub` (outlined) | "sub-orchestrator" (short "sub-orch") |
| saved | not live, it is the project's saved orchestrator | `.tag.muted` | "orchestrator"; title "Saved orchestrator. Resume it from the header or this row's menu." |

The browser tier shows main and sub only (they come from tmux tags); it never shows saved, which needs the project's pick.

**Row menu** (app tier, registered projects only): Copy resume command · Show report · Open in claude.ai ↗ · Focus pane · *rule* · Set as orchestrator · Resume as orchestrator · Stop using as orchestrator · *rule* · Spawn agent under <name>… · Spawn sub-orchestrator under <name>… · *rule* · End session…

| Row | Set | Resume | Stop using | Spawn agent under | Spawn sub-orchestrator under |
|---|---|---|---|---|---|
| live main orchestrator, is the pick | – | – | shown | shown | shown |
| live main orchestrator, not the pick (a 0.3 pane) | shown | – | – | shown | shown |
| live sub-orchestrator | – | – | – | shown | – |
| live nika agent | – | – | – | – | – |
| live session, no nika role, in tmux | shown | – | – | – | – |
| live session, no nika role, no pane | shown, off | – | – | – | – |
| ended, is the pick | – | shown | shown | – | – |
| ended, not the pick | shown | shown | – | – | – |

A spawn item needs a live row with a pane. Both spawn items of a row share one reason (R0 first, then the limits of §3.17).

Items are `aria-disabled` with their reason (a click shows it): offline or no tmux / claude (`blockedReason`; Set on an ended session and Stop using need only the server); R1 "<other> is running as this project's orchestrator. End it first, then choose another." (Set and Resume while another orchestrator runs); R2 "This session isn't running in tmux, so nika can't make it the orchestrator. End it, then use Resume as orchestrator." (Set on a live session without a pane).

**Header button** (project header and dashboard group header): **Open orchestrator** (live; link to the session window, title "Open <name>"), **Resume orchestrator** (ended; `i-resume`; title "Resume <name> in tmux"), **Start orchestrator** (none; gone: title "The saved orchestrator is gone. Starts a new one."). The project header's ⋯ menu gains "Stop using <name> as orchestrator" (gone: "Stop using the saved orchestrator") after "Copy folder path" whenever a pick is saved.

**Gone alert** (project page, top of the agents area): `div.alert[data-kind="warn"]` with the warning icon, "The saved orchestrator is gone: its transcript was deleted, so it can't be resumed. Start orchestrator starts a new one." and **Stop using it** (`btn.link`). It is state, not an event, so it has no `role="alert"`. Stop using it moves focus to the page heading.

**Toasts** (names cut at 40 characters; a session with no name is "the saved session"; `Saving…` spinner while a request runs, one request at a time):
- Set, live: "<name> is now the orchestrator for <project>." + **Open**. Set, ended: "<name> is the orchestrator for <project>. Resume it from the header when you need it." + **Resume now**. Replacing a pick adds " (was <old>)" after the project.
- Resume: "Resuming <name> as the orchestrator for <project>…", then the session window opens; when the save worked but the start failed: "<name> is saved as the orchestrator, but it didn't start: <reason> Try Resume orchestrator in the header."
- Stop using: live "<name> is no longer the saved orchestrator. It keeps running until you end it."; ended or gone "<project> has no saved orchestrator now. Start orchestrator starts a new one."
- Start with a gone pick: the server forgets it and starts fresh; "Started a new orchestrator. The saved one was gone." When the server instead opened an orchestrator that was already running (`created: false`): "The saved orchestrator was gone. Opened the one that is running." The project page shows no toast of its own when it opens the window (it would die with the page): the window address carries the fixed token `notice=pick-gone` (new) or `notice=pick-gone-open` (already running), and the window shows the matching text once, for exactly one such token only, and removes the parameter with `history.replaceState`. With no usable link the page stays and toasts the text itself.
- A second Set while one runs: "Another change to this project's orchestrator is still running. Try again." (409 `busy`).
- Refusals: not_found "nika can't find that session any more. Its transcript may have been deleted. Nothing changed."; other_project "That session belongs to another project, so it can't be this project's orchestrator. Nothing changed."; no_pane and orchestrator_running as R2 and R1; agent_session and the rest show the server's message; unreachable "Could not reach the nika server."

Test hooks (`data-fk`): header `resume:<key>`, `start:<key>`, `orch:<key>`; header menu `orch-stop-proj`; alert `orch-gone`, `orch-forget`; row items `orch-set:<scope>:<id>`, `orch-resume:<scope>:<id>`, `orch-stop:<scope>:<id>`, `spawn-under:<scope>:<id>`, `spawn-sub:<scope>:<id>`.

### 3.17 Nesting tree, spawn sheet and limits (0.4)

An orchestrator can have sub-orchestrators, and each parent has agents of its own (three levels at most). The page gets `role`, `parent`, `depth` and `children` on every live agent (contract C3, C6) on both tiers; the tree shows on both, the spawn controls only in the app.

**Tree rows** (project page and dashboard; `treeRows` in `dash-model.js`). One flat `ul.rows` in tree order, so the row grid and the tab order (name link, then ⋯ button, row after row) stay as they are. The page builds the tree itself from `parent` (a session id, or a pane id the server could not resolve): a root is level 1, each parent above adds one, never more than 3. The server's `depth` is not used for placement, so a forged value moves nothing. Siblings: the most urgent status in each subtree first (a subtree with a child that needs you rises), then the most recent activity in the subtree. A loop of parents is cut.

| Part | Markup and look |
|---|---|
| row | `li.row[data-depth][aria-level]`, `id="row-<scope>-<agent id>"`, `hidden` while an ancestor is folded |
| slot | a 24 × 24 box before the name: the collapse button `button.tree-tg` when the row has children, else `span.tree-sp[aria-hidden]` (names stay aligned) |
| toggle | `aria-expanded`, `aria-controls` = the ids of every descendant row, in row order; label "Hide the 3 agents under planner" / "Show the 3 agents under planner, 1 needs you" (singular for 1); chevron `i-chev` turns −90° when folded; `data-fk="tree:<scope>:<id>"` |
| elbow | `span.elbow[aria-hidden]` at level 2 and 3: the margins make the indent, 24 px a level (12 px at ≤ 860 px, app tier ≤ 1010 px); a visually hidden ", under <parent>" follows the name |
| folded | the row shows `span.tree-hid[aria-hidden]` "+N", with the number of hidden agents that need you beside it (the attention diamond and `--attn`) |
| orphan | a parent that is not running: the row is a root, keeps its role tag, and shows `span.tree-orphan` "parent ended" (title "This agent's parent session is no longer running.") |

Folding is local to the page (`state.open`, key `!tree:<scope>:<id>`, the "!" pattern of the Ended sections; rebuilt rows get focus back through `data-fk`). Live rows are never capped (0.4, F1b: a live session behind a button looks like a missing one). The 12-row cap (`ROW_CAP`) applies to the Ended section only: it draws its first 12 rows, then a ghost button "Show N more ended agents" ("Show 1 more ended agent" for one; `data-fk="more:<scope>"`, state id `cap:<scope>`), and its summary "Ended (n)" counts all of them.

Flat lists: Ended, the "Waiting on you" queue and any filter draw rows without tree markup. A row whose parent is listed gets a chip "under <parent>" (cut at 24 characters, full name in the title) after the project chip. An ended row has no parent (the server gives a parent only to live agents), so it gets no chip. A group where nothing nests (no row has children, none is an orphan) is drawn exactly as in 0.3.

**Spawn entry points.**

| Entry | Parent | Role preset | Shown when |
|---|---|---|---|
| header **Spawn agent** | none (you) | agent | always (registered project) |
| header **Spawn sub-orchestrator** (project page only; `aria-label` always "Spawn sub-orchestrator", icon only at ≤ 760 px) | the main orchestrator | sub-orchestrator | always; off without a live main orchestrator ("Start the orchestrator first: sub-orchestrators run under it.") |
| row "Spawn agent under <name>…" | that row's pane | agent | §3.16 matrix |
| row "Spawn sub-orchestrator under <name>…" | that row's pane | sub-orchestrator | §3.16 matrix |

**Disabled reasons and server refusals** (checked in this order, after offline and missing tmux / claude; one text for `aria-disabled` + toast and for the sheet's alert on a 409; the page counts from its snapshot, the server decides):

| Case | Copy |
|---|---|
| parent at its limit (an orchestrator) | "<parent> already runs <r> of <max> agents of its own. Wait for one to finish, or raise “Agents per orchestrator” in Settings." |
| parent at its limit (you) | "You already run <r> of <max> agents spawned from nika in <project>. Wait for one to finish, or raise “Agents per orchestrator” in Settings." |
| project cap min(3 × N, 24) | "<project> already runs <r> of <cap> agents, the most one project can run. Wait for one to finish." |
| 409 `depth` (a sub-orchestrator request) | "<parent> can't start a sub-orchestrator. Only the main orchestrator can: nika allows three levels (orchestrator, sub-orchestrators, their agents). Nothing was started." |
| 404 `not_found` with a parent | "<parent> is no longer running, so nothing was started. Close this and spawn from a session that is running." |

When the project sets its own limit (0.4.0, below) the `parent` tail reads "Wait for one to finish, or raise “Per orchestrator” on this project’s New agents card." instead, because raising the Settings value would change nothing for it; the server's message for the same refusal says the same.

The 409 `limit` copy is chosen by the body's `scope` (`parent` or `project`) and uses its `running` and `max`; a body that does not parse, a 409 `depth` on a plain agent request, a 404 with no parent (or with an `under` pane, which may be the one that is gone) and every other refusal show the server's own message. Sub-orchestrators count toward their parent's limit and the project cap.

**Spawn sheet.** The title and button read "Spawn agent" or "Spawn sub-orchestrator". A `dl.kv.sp-kv` row "Parent" shows "<name> · orchestrator|sub-orchestrator · pane %3", or "None. You start it from nika.". A **Role** fieldset has two radio cards, Agent ("Does one task and reports back.") and Sub-orchestrator ("Plans the work and spawns up to <N> agents of its own. It may run only nika spawn and nika status."). When the parent cannot have a sub-orchestrator (none, or a sub-orchestrator) the radio is `disabled`, its card gets `data-off="true"` (50 % opacity) and `p.help#sp-role-why` (full contrast, the radio's `aria-describedby`) says why: "Sub-orchestrators run under the orchestrator. Use Spawn sub-orchestrator in the header, or the orchestrator's row menu." / "Only the main orchestrator can start sub-orchestrators: nika allows three levels." Switching the role changes the title, the button, the brief help, the name (only while it still holds the last default, `builder-N` or `lead-N`) and the model (only while the select is untouched: Roles › Builder, or › Orchestrator). The remembered model, permission mode and placement are kept per project and role. The footer note counts at open time: "<parent>: 2 of 3 · <project>: 5 of 9 running" (or "Spawned from nika: …"; names cut at 24). The request carries `role` (`agent` or `orchestrator`) and, with a parent, `parent` (its pane); the header's Spawn agent sends no parent. (0.5, W9) An agent's request also carries `kind` when the **Kind** select (`#sp-kind`, after Model; §3.21) holds a word; Automatic and a sub-orchestrator send none. Success toast: "Spawned builder-3 in pane %12", "Spawned builder-3 under planner in pane %12" or "Spawned sub-orchestrator lead-1 under planner in pane %9", with **Open session**. A refusal keeps every field and puts the copy in the sheet's alert, with focus on it.

**Settings and the New agents card.** Settings › Panes and limits: the label "Agents per project at once" is now **Agents per orchestrator**; help: "1 to 8. How many agents each orchestrator can run at once; the agents you spawn from nika share one more such limit. One project runs at most 3 times this number, and never more than 24." The Models section line ends "A project can override them on its page." The project page's **New agents** card lists Permission mode, Pane, **Per orchestrator** "<N> at once", **Spawned from nika** "<r> of <N>" and **This project** "<r> of <cap> running"; the `.limit` note appears at the project cap ("Limit reached: <r> of <cap> agents are running in this project. Spawning is off until one ends.") or when your own bucket is full ("Limit reached: you run <r> of <N> agents spawned from nika. Spawn from an orchestrator's row, or wait for one to end."). Remove project: "nika stops listing this project and forgets its plugin, model, permission mode, pane and agent limit choices and its saved orchestrator. No files change and running agents keep running."

**(built amendment 2026-11-13 (0.4.0)) New agents: this project's mode, pane and limit.** The values of **Permission mode**, **Pane** and **Per orchestrator** are menu buttons (the disclosure menu `menuEl`: one open at a time, Esc closes and returns focus). Each can be the project's own or left on Settings; the project's value wins for that item only, and Settings stays the default for every project.
- *Button.* The current value and a chevron: the mode as its tag (own colour, icon and word, as above), the pane as its words ("Beside", "Under the last agent"), the limit as "<N> at once". While the project has no value of its own a muted "from Settings" follows the button. `aria-label`: "Permission mode for <project>: Auto, from Settings" (", set for this project" when it is the project's own). Before Settings has loaded the rows read "–", "–" and "3 at once" as plain text, with no menu.
- *Menu.* First "Use Settings (<Settings value>)", then, under a rule, every choice: Default, Manual, Accept edits, Plan, Auto, Don't ask (never Bypass); Beside, Under the last agent; "1 at once" to "8 at once". The current choice has a check icon and `aria-current="true"`; every item keeps a 16 px slot for the check so the words line up. Items are words only; the tag is on the button. `data-fk`: the button `agent-<field>` (`permissionMode`, `panePlacement`, `maxAgents`), the items `agent-<field>:settings` and `agent-<field>:<value>`.
- *Picking.* Sends the one-field `PUT /api/app/projects/:key/config` (contract §3; "Use Settings" sends `null`), then draws the card again and toasts "<Item> saved for <project>: <value>. Sessions nika starts from now on use it." or "<Item> for <project> now follows Settings: <value>. …", plus " Apply rules to update rules/orchestration.md." while a rules file nika wrote exists (the file lists these three values). A refusal or a lost connection is an error toast with the server's message ("Could not reach the nika server.") and the old value stays. A second pick of the same item while its save is on the way is ignored.
- *Elsewhere.* "Spawned from nika <r> of <N>", "This project <r> of <cap> running" and the `.limit` note use the project's limit. In the spawn sheet the permission select's first option reads "Use this project's setting: <effective mode>" and the pane choice "<effective pane> (from Settings)" or "(set for this project)". An explicit mode in the sheet or on the CLI still wins.
- *`menuEl`.* Two optional additions, existing callers unchanged: a fourth argument, the button's content in place of the "⋯" icon (class `btn ghost menu-val`), and a per-item `current` flag (once any item has it, every item gets the check slot).

Test hooks (`data-fk`): tree toggle `tree:<scope>:<id>`, header `spawn-sub:<key>`, row items `spawn-under:` and `spawn-sub:` (§3.16), sheet `sp-parent`, `sp-role-agent`, `sp-role-orch`, `sp-kind`; ids `sp-role`, `sp-role-why`, `sp-note`, `limit-note`.

### 3.18 Auto-compact setting (0.4, ADR 0014)

Settings gets a section `#s-compact` ("Auto-compact") after Models, and an index link "Auto-compact" after "Models". It sets when the
sessions nika starts compact their conversation. Default: on, 80 %, 400k.

```
Auto-compact
Compacts a session's conversation before it gets too long.

[ (•)] Auto-compact at  [−][ 80 ][+] % of [400k            v]    [▣ On]
Compacts at about 320k tokens (about 160k on 200k-window models).
On a model with a 200k window, Claude can't compact later than about 83 %, so a higher % acts as about 83 % on those models.
Applies only to sessions nika starts: the orchestrator, a resumed orchestrator and spawned agents, from their next start.
Running sessions and sessions you start yourself keep Claude Code's own setting.
```

**Controls**, in order, in `div.inline.compact-row`: the switch `input#set-compact[role=switch]` (`data-fk=compact-on`, described by
`set-compact-result` and `set-compact-help`); `label[for=set-compact]` "Auto-compact at"; `span.stepper` with `−` (`data-step=-5`,
`data-step-for=set-compact-pct`, aria-label "5 percent less"), `input#set-compact-pct[type=number][min=20][max=95]` (`data-fk=compact-pct`,
aria-label "Auto-compact at, percent of the window", described by `set-compact-result set-compact-cap set-compact-err`) and `+`
("5 percent more"); `span[aria-hidden]` "% of"; `select#set-compact-win` (`data-fk=compact-win`, aria-label "Window the percent applies
to"; 200k, 400k, 1M, "Model's full window"); and the chip `span.onoff-st#set-compact-st[aria-hidden]`.

**Lines under the row.** `p.help#set-compact-result` is the result line (no live region; the inputs point at it);
`p.help#set-compact-cap` and `p.help#set-compact-help` are static; `p.err#set-compact-err` reads "Choose a whole number from 20 to 95."
and shows for a blank, a fraction or an out-of-range number, on blur and on Save (a shown error goes as soon as the number is valid
or the row is switched off).

**Result line** (`compactPreview({ enabled, pct, window })` in `public/ctx.js`; it previews the unsaved form and decides nothing the server
launches with). A window larger than a model's own is cut to it, and a session never compacts above `window - 33000` tokens, so for a
percent P and a window W the amount is `min(floor(W x P / 100), W - 33000)`, rounded down to 1k and written short ("320k", "1M"):

| Window | Copy |
|---|---|
| 200k | "Compacts at about {X200} tokens." |
| 400k | "Compacts at about {X400} tokens (about {X200} on 200k-window models)." |
| 1M | "Compacts at about {X1M} tokens on 1M-window models (about {X200} on 200k-window models)." |
| Model's full window | "Compacts at {P} % of each model's window: about {X1M} tokens on 1M-window models, about {X200} on 200k-window models." |
| off | "Off. Sessions nika starts keep Claude Code's own setting." |
| invalid number | the line is hidden; the error shows |

80 % of 400k reads "about 320k tokens (about 160k on 200k-window models)"; 90 % of 400k reads "about 360k tokens (about 167k on 200k-window
models)", because the 200k window cannot go past 167k. (Correction to the first design, which capped the percent at 83 and so wrote 166k.
The 200k row has no addendum: it is already the 200k number.)

**On and off, by colour, icon and word.** On: accent track, chip `i-compact` + "On" (`--accent` on `--accent-soft`), number, stepper and window
enabled. Off: `--line-strong` track, chip `i-compact-off` + "Off" (`--text-muted`, dashed `--line-strong` edge), number, stepper and window
`disabled` with their values kept, and the result line reads the Off sentence. Switching off while the number is invalid puts the saved
number back and clears the error.

**Save.** `formValue()` gains `compaction: { enabled, pct: Number(value), window }` (`window` a number or `'model'`); the Save bar, Discard and
the summary work as in §3.15. The stepper buttons are generic: `data-step-for` names the number (default `set-max`), the clamp is the
number's own `min` and `max`, and a typed whole number from 20 to 95 works. The result line redraws on every `input` and `change`.

Test hooks (`data-fk`): `compact-on`, `compact-pct`, `compact-dec`, `compact-inc`, `compact-win`; ids `set-compact-result`, `set-compact-cap`,
`set-compact-help`, `set-compact-err`, `set-compact-st`.

### 3.19 Context meter (0.4)

How full a session's context is, on every row of both tiers and in the session header. The server sends `context` (contract C6: `tokens`,
`window`, `compactAt`, `pct`, `compaction`); the page formats it (`ctxView`, `public/ctx.js`; `ctxEl`, `public/dom.js`) and never computes a
window, a per cent or a threshold.

**What the per cent means.** `tokens / window`, where `window` is the one auto-compact uses: Settings' window cut to the model's own when
auto-compact is on, the model's full window when it is off. For a session nika started, the meter therefore shows how close it is to
compacting. Sessions nika did not start (and ended ones) are measured against the same window, but nika's setting does not act on them.

| `lvl` | When | Visible | Bar |
|---|---|---|---|
| `unknown` | no `context`, or no tokens | "–", `--text-muted` | none |
| `nowin` | tokens, but no window or per cent (no model seen yet) | "124k", `--text-muted` | none |
| `ok` | pct < 60 | "41 %" | `--line-strong` |
| `warn` | 60 ≤ pct < 80 | "63 %" in `--idle` 600 | `--idle` |
| `full` | pct ≥ 80 | `i-warn` + "86 %" in `--danger` 700 | `--danger` |

The thresholds are fixed at 60 % and 80 % on both tiers (they do not follow the auto-compact per cent). Per cent: `Math.round(pct)`, a
no-break space, "%"; over 100 shows as is and fills the bar. Tokens: "999", "8.5k", "124k", "1M", "1.2M" (`fmtTokens`, rounded down).
Bar: `span.ctx-bar[data-q="0".."10"][aria-hidden] > i`, `q = min(10, round(pct / 10))`: ten CSS classes, no inline style, no CSSOM write.

**Title** (a mouse aid: the cells take no focus) and **screen-reader text** (an `.sr-only` span; the visible parts are `aria-hidden`):

| `compaction` | Title | Screen-reader text |
|---|---|---|
| `on` | "Context: 312k of 400k tokens (compacts at 320k)" | "Context 78 % used, 312k of 400k tokens, compacts at 320k" |
| `off` | "Context: 312k of 1M tokens (the model's window; auto-compact is off)" | "Context 31 % used, 312k of 1M tokens, auto-compact off" |
| `none` (nika did not start it, or it ended) | "Context: 312k of 400k tokens" | "Context 78 % used, 312k of 400k tokens" |
| `unknown` | "Context: no usage yet" | "Context unknown" |
| `nowin` | "Context: 124k tokens; the window is not known yet" | "Context 124k tokens, window unknown" |

`full` adds ", nearly full" to the screen-reader text. A bad `compactAt` on `on` reads as `none`.

**Rows.** Grids per container width (§9.9): the 64 px column sits after the model; at ≤ 860 px (app tier ≤ 1010 px) it is 56 px with the bar hidden; at ≤ 600 px it stays on
line 1 beside the age. `.c-ctx { display: flex; justify-content: flex-end; }`; `.ctx` stacks the number over the bar. Ended rows: `--text-muted`
number, `--line-strong` bar fill at every level. A stale list (error banner) is at 60 % opacity as a whole.

**Session header.** `span.ctx#sess-ctx` in `.sess-meta` after the model, `hidden` until the first agent poll; each poll fills it again. It lays out
inline: "Context" (muted), "312k / 400k ·" (`.hide-narrow`: gone at ≤ 1000 px), the number, the bar. The title is the row's.

Colour is never alone: the number is always there, `full` also has the warning icon, and the sentence for screen readers carries the level.
Ids and classes: `sess-ctx`, `.c-ctx`, `.ctx`, `.ctx-l`, `.ctx-t`, `.ctx-v`, `.ctx-bar`; tokens in `public/tokens.css`.

### 3.20 Settings drawer (0.4.0)

On a window 1030 px wide or narrower (§6) the project page shows only the agents. Its three cards, **Rules**, **Project setup** and **New agents**,
move into a drawer that the **Settings** button opens (owner decision 2026-11-13; renamed and moved to the title row, owner decision 2026-11-14). Above 1030 px nothing changes: agents plus the 320 px column, and no button.

- **Button.** In the title row, at the far right, right before "Show ended": `< Dashboard  <project>  <rules chip>  [gear Settings]  [ ] Show ended`. It leaves the actions row
  (Start orchestrator, Spawn agent, Spawn sub-orchestrator, ⋯). The gear icon (`#i-gear`) and the word "Settings" (`button.btn.setup-open`, `aria-haspopup="dialog"`,
  `aria-controls="dlg-setup"`, `data-fk="setup:<project key>"`); the ids and the key keep the old "setup" name. The word is plain text, not a `.lbl` span, so no breakpoint hides it:
  the visible word is the accessible name (WCAG 2.5.3) and the button needs no `aria-label` or `title`. It is hidden by CSS above 1030 px and never disabled. It is rendered into
  `#proj-settings`, an empty host (`display: contents`) inside `.bar-end`, the flex group that holds the host and the Show ended box, so the two wrap together: when the row is
  too narrow the group moves under the title as one unit. The "Rules current/outdated" chip stays next to the project name, so a rules warning shows with the drawer closed.
- **Drawer.** `<dialog id="dlg-setup" class="sheet">`, the Spawn sheet's look, keys and animation (§3.6): `showModal()`, the scrim, Esc, the × button and a
  click on the scrim close it. A press that starts inside the drawer and ends on the scrim (dragging a selection out) does not. Header: "Settings" with the project name
  as a muted line (it tells this drawer from the app's Settings page); the body scrolls and the header stays; it opens at the top. Focus moves to the heading on open and back to the Settings button on close
  (found again by its `data-fk` if a render replaced the button). A hash change (the "Settings" link in the Project setup card, or a way back) closes it.
- **One home for the cards.** `setupCards()` stays the only builder. Narrow, the cards live in the drawer body (`#su-body`) and `#proj-setup` is empty and hidden;
  wide, they live in `#proj-setup` and the body is empty; never both, so no id appears twice. A render while the drawer is open rebuilds the cards inside it, keeps it
  open and keeps focus on the control that survives (by `data-fk`). The app polls only while no dialog is open, so the counts in New agents refresh when it closes.
  When the window grows past 1030 px with the drawer open it closes, the cards go back to the column and the project heading takes focus; shrinking moves them into the drawer.
- **Dialogs from the cards.** Preview rules, Choose plugins…, Choose models… and the confirm dialog open on top of the drawer (`openDialog(dlg, { keep })`); Esc closes the top
  one only, and focus returns to the button that opened it inside the drawer. Any other pair of dialogs still closes the first.
- **Menus.** The New agents value menus work inside the drawer. Esc closes an open menu first and the drawer stays. A menu opens above its button when it does not
  fit below and does fit above inside the drawer body; otherwise it opens below and the body scrolls to show all of it, so it is never cut off (measured at 900 × 700 and 900 × 480).
- Browser tier: unchanged (the project page, the button and the drawer are app-only).
- Edge cases: a project that is not registered empties both homes; without `matchMedia` the page counts as wide.

### 3.21 Labels: what kind of agent a row is (0.5, W9)

**(built 2026-11-15 (0.5).)** Owner request (plan calls 21 and W9, 2026-11-13): a row says what kind of agent it is, in one word on a chip. A label is
display only: no flag, prompt, tool list, permission or limit depends on it, and it never reaches claude. Contract: `api-app.md` (the snapshot's
`label`, the spawn's `kind`, the CLI's `--kind`, the `@nika-kind` tag); the threat: `docs/security.md` T57. The logic that has no DOM is in
`public/dash-model.js` (`KINDS`, `KIND_TEXT`, `ROLE_KIND`, `kindFromModel`, `agentLabelView`, `subLabelView`); the chip is `labelEl` in
`public/dom.js`.

**The words** (`KINDS`, in the order the sheet lists them; `KIND_TEXT` is also the wording of the chip's title, the sheet's options and the rules template)

| Kind | Meaning |
|---|---|
| `coder` | writes and changes code |
| `reviewer` | reviews code or designs |
| `tester` | writes and runs tests |
| `designer` | designs and plans |
| `scout` | finds files and facts, read-only |
| `writer` | writes docs and reports |
| `agent` | no particular kind |

A sub-orchestrator is always labelled by its role tag ("sub-orchestrator", §3.16) and takes no kind. An agent spawned without a kind gets one from
the model it was spawned with (Builder's model → `coder`, Reasoner's → `designer`, Scout's → `scout`, any other → `agent`, decided at spawn), and an
agent spawned before 0.5 reads `agent`. Claude's own subagents are labelled from their `agentType` (`api-app.md`, snapshot): a built-in type's kind
(`Explore` → `scout`, `Plan` → `designer`, `general-purpose` → `agent`, …), else the type's own name, cleaned and cut to 24 characters.

**Why one neutral chip (the visible-state rule).** The owner's rule (every state has its own colour, icon and word) is about **states**. A label is
not a state: it is a noun that is fixed for the agent's life, it never asks the user to act and it never changes while the row lives. Colouring
eight labels would spend eight hues that already mean status, mode, fit and subagent state, and a row would carry a coloured thing that is not a
state. So every label uses the **same neutral pill** and the word is the whole message. The pill shape and the neutral fill keep it apart from the
state badges (which always have a hue and a glyph) and from the role tag (square corners, accent). No icon: one shared icon adds nothing, eight
would be decoration.

**Look** (`span.agent-kind[title]`, `public/tokens.css`, loaded by both pages): `display: inline-flex; align-items: center; flex: none;
min-height: 20px; padding: 0 8px; border-radius: 999px; font-size: var(--fs-cap); font-weight: 500; color: var(--text); background:
var(--surface-2); border: 1px solid var(--line); white-space: nowrap; max-width: 24ch; overflow: hidden; text-overflow: ellipsis`. `--text` on
`--surface-2` is a body-text pair in both themes (well above 4.5:1); the border is decoration; no new token. `labelEl(view)` returns `null` for a view
with no text. The word goes in through `textContent`; the `title` carries the meaning for mouse users.

**Where it shows**

| Surface | Tier | Chip |
|---|---|---|
| Dashboard and project-page rows (§3.3) | both | first child of `.c-what`, before the project chip and the "under <parent>" chip. Title "Kind: <kind>, <meaning>". None on the main orchestrator, a sub-orchestrator, a user's own session or an ended row |
| Session window header (§9.2) | app | `#sess-kind` right after `#sess-role`, replaced at every poll, hidden when there is none; shown at every width |
| Subagent lines (§3.3, §9.17), rows and the session list | rows both, list app | where the raw type was: badge, description, **label**, model, time. Title "Claude's <type> subagent", plus ". Kind: <kind>, <meaning>" for a word of the list |
| Read-only subagent view header (§9.17) | app | `#sess-kind`, always shown once the subagent is known (`agent` at worst) |
| Spawn sheet (§3.17) | app | the **Kind** select, below |

Why in `.c-what` and not beside the name: at 1280 px the name column is at its 120 px minimum with the tree elbow, the fold and the role tag
(§3.3, the 0.4 squeeze), and a pill there would squeeze names to one letter again. The chip never shrinks (`flex: none`), so on a narrow row it takes its
width from the prompt text. At ≤ 600 px `.c-what` moves to the second line (the existing grid) and the chip stays first in it; the
`@container cwhat (max-width: 188px)` rule still hides only the branch and the second project chip, never the label. The project page uses the
same `rowEl`, so it gets the chip too.

**Spawn sheet: the Kind field.** A native `<select id="sp-kind" data-fk="sp-kind" aria-describedby="sp-kind-help">` with the visible label "Kind", right
after the Model field (Tab order: Role, Name, Model, **Kind**, Brief, Permission mode, Pane, Cancel, Spawn). Help `p#sp-kind-help`: "Shown as a label on
its row. Automatic picks it from the model's role."

| Option (value) | Text |
|---|---|
| Automatic (`''`) | Settings loaded and the sheet's model is exactly one role's model: "Automatic · coder (Builder's model)", "Automatic · designer (Reasoner's model)", "Automatic · scout (Scout's model)". No single role (a model that is no role's, or two roles with different kinds on one id): "Automatic · agent (no matching role)". Settings not loaded yet: "Automatic (from the model's role)" |
| `coder` … `agent` | "<kind> · <meaning>", one per `KINDS` entry, in that order |

1. Open: the value is this window's last pick for the project's agents (`spawnPrefs`, key `<project key>:agent`) when it is one of the seven words,
   else Automatic.
2. A change of the model select, or typing in the Custom ID field, rewrites the Automatic option's text only; the value stays.
3. Role switched to sub-orchestrator: the select is `disabled`, `#sp-kind-help` reads "A sub-orchestrator always shows sub-orchestrator.", and
   the value is kept; back to agent it is enabled and the help text is back.
4. Submit: `kind` goes into the request only for an agent with a picked word. Automatic sends none, and the server derives the same word from
   the model's role (the page's `kindFromModel` is a copy used only for the preview; a test runs both over one table of cases). The pick is
   remembered for `<project key>:agent` after a 200.
5. While spawning the select is disabled with the rest of the sheet (as `#sp-role`), then enabled again unless the sheet is a sub-orchestrator's.
6. A 400 about `kind` (only a stale page could get one) shows in `#sp-alert` through the existing error path.

The role name in the Automatic text is `ROLE_LABEL` of `models-ui.js`. The native select needs no new shortcut (arrows and type-ahead pick; the
platform's own key opens it).

**Copy (exact)**

| Where | Text |
|---|---|
| Sheet field, help | "Kind"; "Shown as a label on its row. Automatic picks it from the model's role." |
| Sheet help, sub-orchestrator | "A sub-orchestrator always shows sub-orchestrator." |
| Automatic option | "Automatic · <kind> (<Role>'s model)" / "Automatic · agent (no matching role)" / "Automatic (from the model's role)" |
| Kind options | "<kind> · <meaning>" |
| Chip title, agent | "Kind: <kind>, <meaning>" |
| Chip title, subagent | "Claude's <type> subagent" (+ ". Kind: <kind>, <meaning>" for a word of the list) / "Claude's subagent" |
| API 400 | "invalid kind: use coder, reviewer, tester, designer, scout, writer or agent" / "kind is for agents: a sub-orchestrator always shows sub-orchestrator" |
| CLI exit 2 | "--kind must be one of coder, reviewer, tester, designer, scout, writer, agent" / "--kind is for agents: a sub-orchestrator always shows sub-orchestrator" |

**States**

| Surface | No label | Loading | Error |
|---|---|---|---|
| Row | no chip (orchestrator, sub-orchestrator, user's session, ended) | n/a (snapshot) | stale list at 60 % opacity (existing) |
| Session header | `#sess-kind` hidden | hidden until the first poll | keeps the last value |
| Subagent line, subagent view | never empty (`agent` at worst) | n/a | n/a |
| Sheet | Automatic is the default | "Automatic (from the model's role)" until Settings loads | the server's 400 in `#sp-alert` |

**Accessibility.** The chip's word is visible text (no colour carries meaning); its `title` adds the meaning for mouse users, and a screen reader reads
the word in reading order. The sheet's select has a visible label and `aria-describedby` help, and the disabled state has its reason in visible
text. Tokens only, both themes from `tokens.css`; no motion.

**Rules template.** `templates/orchestration.md` tells an orchestrator to pass `--kind <kind>` on every `nika spawn`, lists the seven words, says what
nika picks without one, and says a sub-orchestrator takes no `--kind`. `TEMPLATE_VERSION` is 3, so every registered project's rules read "outdated"
until rules are applied again (this repository's own included).

**Not built.** A label for an ended session, the main orchestrator or a user's own session; a label column in `nika status`, or in the tray; a change of
the guard prompts, `agent.json` or `_run-agent`; a colour or an icon per label, or a filter by label; telling a chosen kind from a derived one.

## 4. Keyboard model

Mod = ⌘ on macOS, Ctrl on Linux. No single-character shortcuts (WCAG 2.1.4), with one exception the owner asked for
(2026-11-09): `?` opens Keyboard shortcuts (§4.6), only outside text entry and with a Settings switch to turn it off.
0.1's "/" to filter is replaced by Mod+F.

### 4.1 Global

| Keys | Action | Notes |
|---|---|---|
| Mod+1 | Dashboard | |
| Mod+, | Settings | |
| Mod+O | Add project (native folder picker) | |
| Mod+F | Focus the agent filter (dashboard) | |
| Mod+K | Command palette | C only; Phase 5 for A |
| ⌘[ (macOS), Alt+← (Linux) | Back | session → project/dashboard |
| Mod+Enter | Submit the open form (Spawn agent, Save settings) | |
| ? · Mod+/ | Keyboard shortcuts (§4.6) | `?` only outside text entry and while "Single-key shortcuts" is on |
| Mod+Shift+H | Show or hide the transcript (session window) | Direction A, **(built amendment 2026-11-09 (0.3.4))**: the key of the **Transcript** toggle (§4.7); wide windows only; direction B's drawer is not built |
| Mod+Q | Quit nika | **(built amendment 2026-11-13 (0.4.0, F2))** macOS: the app menu. Linux: the page, as Ctrl+Q, through `POST /api/app/window` (`quit`); also while "Type into pane" is on |
| Mod+W | Close the window | macOS: the app menu. Linux: the page, as Ctrl+W (`close`); not while "Type into pane" is on, where Ctrl+W goes to Claude |
| Mod+= (Ctrl++ too on Linux) · Mod+- · Mod+0 | Zoom in · zoom out · actual size | macOS: the View menu. Linux: the page (`zoom-in`, `zoom-out`, `zoom-reset`); also while "Type into pane" is on. A held zoom key repeats; a held Ctrl+Q or Ctrl+W acts once |
| Tab / Shift+Tab | Normal order: skip link → sidebar → main → … | |

The window keys above are the only keys the page adds for the OS's default shortcuts. Everything a text field does natively (copy, cut,
paste, select all, undo, redo, on both platforms) is never prevented by nika's key handlers: the message box (`composerKey`), the
dashboard's and the session window's global handlers and the window keys leave Ctrl/Command+C/X/V/A/Z/Y and Ctrl+Shift+Z alone, and Ctrl+C
in the message box is Stop only when nothing is selected. macOS Command keys are never read by the page.

Shortcuts are listed in the UI next to their targets (`<kbd>` in nav, `title`), and in `aria-keyshortcuts`.

### 4.2 Session focus model

Three zones, in tab order: header actions → transcript → terminal mirror → composer (quick actions, prompt panel,
message box, mode switcher). Opening a session focuses the **composer**. **(built amendment 2026-11-09 (0.3.3))**
With the message box focused, Esc, Ctrl+C and Shift+Tab go to Claude, and so do the arrows and Enter when the box is
empty (owner decision 2026-11-09). One pure function holds the rules: `composerKey` in `public/quick-actions.js`.

| Key | In the message box (default) | In passthrough (mirror focused, "Type into pane" on) |
|---|---|---|
| printable text | edits the box | sent to the pane, batched every 120 ms |
| Enter | send text + Enter (empty box: Enter alone); a held Enter sends once; not while a prompt is open (§9.5). **(0.5, W13)** Also while Claude works: Claude queues the message (§9.12) | Enter |
| Shift+Enter | new line | Enter (no distinction in a terminal) |
| Esc | closes the model popover, then the palette; else sends Escape (a held Esc sends once) | Escape |
| Ctrl+C | with a selection: the browser's (copy on Linux); while Claude works: Stop (`/stop` route, §9.4); otherwise nothing is sent and the problem line says why for 3 s | C-c |
| Shift+Tab | sends BTab: Claude's next permission mode (a held key sends once); nothing is sent before the window has read the pane once, or while it is gone or tmux fails (the pane's reason shows for 3 s, such as "Connecting to the pane…"), while a prompt is open (§9.5), or while a mode switch runs ("Wait for the mode switch to finish.") | BTab |
| Tab | moves focus forward (palette option active: inserts it). **(0.5)** In an empty box that shows Claude's suggestion as its placeholder, a bare Tab accepts it instead (§9.12; a held key accepts once). Once it is accepted the box holds text, so Tab moves focus again: the box is not a keyboard trap (WCAG 2.1.2). Ctrl+Shift+Tab always moves back | Tab |
| Ctrl+Shift+Tab | moves focus back, to the Shell toggle | not sent (not on the allow-list) |
| ↑ ↓ ← → | empty box: sent to the pane in batches (a batch holds ≤ 8 keys and goes out at the 8th key or 120 ms after the first, whichever is first; held repeats dropped while 2 batches wait); text in the box: caret; palette: ↑ ↓ choose. **(0.5)** → in an empty box that shows Claude's suggestion accepts it (§9.12) instead of going to the pane as an arrow key | sent as KEY_NAME |
| Home End PgUp PgDn ⌫ Del | edit the box. **(0.5, W3)** The terminal mirror, focused with Type into pane off, scrolls Claude's view with PgUp, PgDn, Home and End instead (below, §9.15) | sent as KEY_NAME |
| Ctrl+U/K/A/E/L/R | box editing | sent as C-u … C-r |
| Ctrl+W | Linux: closes the window (§4.1); macOS: left to the browser | sent as C-w (Close is not a window key here) |
| Ctrl+Shift+C | **(0.4.0)** left to the text field (no engine copies with it there), never Stop; Ctrl+C is Stop only with nothing selected | **(built amendment 2026-11-13 (0.4.0, F2))** copies the text selected in the mirror to the clipboard; sends nothing. "Select text in the terminal first, …" (3 s) when nothing in the mirror is selected |
| Ctrl+Q, Ctrl+=, Ctrl++, Ctrl+-, Ctrl+0 (Linux) | window keys (§4.1) | window keys (§4.1), not sent to the pane and no "Not sent" message |
| Ctrl+] | enter passthrough | **leave** passthrough (the only key nika keeps) |
| ⌘ shortcuts (macOS) | app shortcuts | still app shortcuts (not sent) |
| paste (Mod+V; on Linux also Ctrl+Shift+V) | inserted; multi-line → paste chip | sent as one bracketed paste (≤ 16 KB). Ctrl+V (Linux) and Ctrl+Shift+V are not cancelled: the browser pastes and the mirror's `paste` handler sends it. WebKitGTK maps Ctrl+V to its Paste command and Ctrl+Shift+V to PasteAsPlainText (`Source/WebKit/UIProcess/gtk/KeyBindingTranslator.cpp`, read 2026-11-13); both fire the DOM `paste` event. Checked by reading the source, not yet on a Linux build: on the owner's 0.4.0 Linux checklist. On macOS Ctrl+V is not on the allow-list (Command+V pastes) |
| other keys | — | not sent; echo "Not sent: Alt-x is not on the allow-list" |

**Terminal mirror focused, Type into pane off (0.5, W3, §9.15).** PgUp and PgDn scroll Claude's own view one page, Home and Ctrl+Home go to
its top, End and Ctrl+End back to the live bottom; the mouse wheel and the trackpad over the mirror do the same. The keys act only where
focus already is and focus never moves (WCAG 2.1.1, 2.4.3). Ctrl+PgUp and Ctrl+PgDn stay with the app, and a key with Alt, Meta or Shift is
left alone. The message box keeps its own editing keys, and Type into pane on keeps sending the user's own keys.

The box is never a keyboard trap: Tab leaves forward, Ctrl+Shift+Tab backward. Its accessible name says so: "Message
to builder-1. Enter sends, Shift+Enter adds a line. Escape and Control+C go to Claude; so does Shift+Tab when no question
or prompt is open, and the arrow keys and Enter when the box is empty. Control+Shift+Tab moves focus back." **(0.5, W1 fix round: Shift+Tab
is held back while a permission prompt or a question form is open, §9.5 and §9.16.)**

Leaving passthrough: Ctrl+], the banner's "Stop" button, clicking outside the mirror, or focus leaving the mirror for any reason. Each change is announced ("Passthrough on: every key goes to pane %12. Press Control and ] to leave." / "Passthrough off"). This is a documented, escapable keyboard mode (WCAG 2.1.2).

### 4.3 Esc ladder

Esc closes the **nearest nika layer**; only when nothing is open does it reach the pane.

1. Open row menu → close it, focus its button.
2. Open dialog (rules, spawn, palette, confirm) → cancel it, focus the opener. Not while a write is in flight.
3. B drawer with focus inside → close drawer, focus its toggle.
4. Session screen, composer or passthrough → send Escape to the pane (shown in the echo). In the message box a held Esc sends one Escape. **(built amendment 2026-11-09 (0.3.3))**
5. Anywhere else → nothing. Esc never closes the session window or navigates back.

### 4.4 Dialogs

Native `<dialog>.showModal()`: background is inert, Tab cycles inside, Esc fires `cancel` (the Settings drawer lets Esc close an open menu inside it first, §3.20). Initial focus: the element with `autofocus` (first field in spawn, Done on success), else the dialog's `h2` (`tabindex="-1"`). On close, focus returns to the opener; if the opener is gone (row re-rendered), to the screen's `h1`.

### 4.5 Skip links and landmarks

- First tab stop: "Skip to content" → `#main` (`tabindex="-1"`).
- Session: a second skip link "Skip to message input" → composer.
- Landmarks: `nav` (sidebar, labelled "Main"), `main`, `aside` (project cards), `header` (screen bar), `footer` only in C (status line).

### 4.6 Keyboard shortcuts window (owner request 2026-11-09)

**Open.** `?` (Shift+/ on most layouts: match `e.key === '?'`, no Ctrl, ⌘ or Alt) or Mod+/ (`e.key === '/'` with Mod), or
the **Keyboard shortcuts** button. `?` is ignored when the focus is in an `input`, `textarea`, `select` or
contenteditable element, in the terminal mirror, while passthrough is on, while any dialog is open, or when the setting
"Single-key shortcuts" is off. Mod+/ works everywhere except in passthrough on Linux (Ctrl+] is the only key nika keeps
there; macOS ⌘/ stays an app shortcut, §4.2) and while another dialog is open. Pressing either key again with the window
open does nothing; Esc or Close closes it and focus returns to the opener (§4.4).

**Button.** Ghost icon button, icon `i-kbd` (a keyboard outline, 16 px, same stroke as the set), `aria-label="Keyboard
shortcuts"`, `title` "Keyboard shortcuts (?)" (just "(⌘/)" / "(Ctrl+/)" when the setting is off), `aria-keyshortcuts`
"Shift+Slash Meta+Slash" (Linux "Shift+Slash Control+Slash"). Dashboard: in the sidebar footer on the app tier; the browser tier has no
sidebar, so there it sits in the dashboard bar (0.3 build, 2026-11-09; its `title` names only Mod+/, because `?` is
app-tier only). Session window: in the header bar, at the far right.

**Dialog.** Native `<dialog id="kbd-dlg">`, 560 wide (min(560, vw−32)), max height min(720, vh−32), body scrolls. Header:
`h2` "Keyboard shortcuts" (initial focus, `tabindex="-1"`) and a muted line naming the window ("Dashboard" / "Session
window" / (0.5, W8) "Subagent window"). Body: one section per group, `h3` + `<table>` with a visually hidden `caption` (the group name),
`<th scope="col">` Name · Shortcut · Description; Shortcut cells use `<kbd>` per key joined by "+", alternatives joined by
" or "; mono 12 for keys. Footer: on the app tier a muted line "Single-key shortcuts: On" (or "Off") + link button
"Change in Settings" (dashboard: goes to `#settings` and closes; session window: opens the dashboard's Settings in the same
window), then **Close** (secondary). The browser tier footer has only Close. Content is static copy from one module
(`public/shortcuts.js`), filtered by window, tier and platform; nothing in it comes from the server.

Key labels: macOS ⌘ ⌥ ⇧ ⌃ and the arrows; Linux Ctrl, Alt, Shift and the arrows. Mod = ⌘ / Ctrl. "⌘[ / Alt+←" in the
tables means ⌘[ on macOS and Alt+← on Linux: each platform shows only its own.

**Content.** Exact copy; list only what the window and tier support.

Dashboard (app tier):

| Group | Name | Shortcut | Description |
|---|---|---|---|
| Navigation | Dashboard | Mod+1 | Show all projects and agents |
| | Settings | Mod+, | Open Settings |
| | Add project | Mod+O | Choose a folder to add as a project |
| | Filter agents | Mod+F | Move to the agent filter (dashboard) |
| | Back | ⌘[ / Alt+← | Go back to the dashboard (project view, Settings) |
| | Keyboard shortcuts | ? or Mod+/ | Show this list |
| Dialogs and menus | Run the main action | Mod+Enter | Spawn, save or apply in the open dialog or in Settings |
| | Close | Esc | Close the open menu or dialog |
| Window **(0.4.0, F2)** | Quit nika | Mod+Q | Quit the app (your agents keep running in tmux) |
| | Close window | Mod+W | Close this window |
| | Zoom in | ⌘= / Ctrl+= or Ctrl++ | Make the window content larger |
| | Zoom out | Mod+- | Make the window content smaller |
| | Actual size | Mod+0 | Reset the zoom |

Dashboard (browser tier): Keyboard shortcuts — Mod+/ — Show this list; Close — Esc — Close the open menu. (`?` is app-tier
only: the browser tier cannot store the setting that turns it off.)

Session window:

| Group | Name | Shortcut | Description |
|---|---|---|---|
| Window | Back | ⌘[ / Alt+← | Back to the dashboard |
| | Show or hide transcript | Mod+Shift+H | Give the terminal the full width (wide windows; narrow ones have tabs) |
| | Keyboard shortcuts | ? or Mod+/ | Show this list |
| | Quit nika | Mod+Q | Quit the app (your agents keep running in tmux), also while typing into the pane |
| | Close window | Mod+W | Close this window (while typing into the pane, Ctrl+W goes to Claude) |
| | Zoom in | ⌘= / Ctrl+= or Ctrl++ | Make the window content larger |
| | Zoom out | Mod+- | Make the window content smaller |
| | Actual size | Mod+0 | Reset the zoom |
| Message box | Send | Enter | Send the text, then Enter, to Claude (empty box: Enter only) |
| | New line | Shift+Enter | Start a new line in the message box |
| | Press Esc in Claude | Esc | Stop Claude's turn or close Claude's menu (when nothing in nika is open) |
| | Interrupt | Ctrl+C | Stop Claude's turn, as Stop does (while Claude works and no text is selected) |
| | Next permission mode | Shift+Tab | Press Shift-Tab in Claude (not before the pane is read, nor while Claude asks you something) |
| | Arrow keys in Claude | ↑ ↓ ← → | In an empty box: move through Claude's menus and earlier prompts |
| | Move focus back | Ctrl+Shift+Tab | Leave the message box backward (Shift+Tab goes to Claude) |
| | Commands | / | Open the command list (at the start of an empty box) |
| | Type into the pane | Ctrl+] | Send every key straight to Claude's terminal |
| Typing into the pane | Stop typing into the pane | Ctrl+] | Keys go to the message box again |
| | Copy | ⌘C / Ctrl+Shift+C | Copy the text selected in the terminal (Ctrl+C goes to Claude) |
| | Paste | ⌘V / Ctrl+Shift+V or Ctrl+V | Send the clipboard to Claude as one paste |
| Mode switcher | Move between modes | ← → Home End | Moves focus; does not switch |
| | Switch | Enter or Space | Switch to the focused mode |
| Command list | Move | ↑ ↓ | Move through the commands |
| | Insert | Enter or Tab | Put the command in the message box |
| | Close | Esc | Close the list and keep the text |

**(0.5, W8) Subagent window** (the read-only view of one of Claude's subagents, §9.17; app tier only, the browser tier has no such window): one group, Window, and none of the session window's Message box, Terminal, Mode switcher or Command list groups.

| Group | Name | Shortcut | Description |
|---|---|---|---|
| Window | Back | ⌘[ / Alt+← | Back to the session that runs it |
| | Keyboard shortcuts | ? or Mod+/ | Show this list |
| | Quit nika | Mod+Q | Quit the app (your agents keep running in tmux) |
| | Close window | Mod+W | Close this window |
| | Zoom in | ⌘= / Ctrl+= or Ctrl++ | Make the window content larger |
| | Zoom out | Mod+- | Make the window content smaller |
| | Actual size | Mod+0 | Reset the zoom |

Show or hide transcript (Mod+Shift+H) is not listed there: the view is one column with no split. The muted line under the title reads "Subagent window".

**(built amendment 2026-11-13 (0.4.0, F2))** The Window group gains Quit nika, Close window, Zoom in, Zoom out and Actual size (the dashboard gets the same five as a Window group of its own); Typing into the pane gains Copy and Paste. **(built amendment 2026-11-09 (0.3.3))** Next permission mode, Arrow keys in Claude and Move focus back are new; Interrupt now stops the turn through the Stop route and keeps the selection rule. **(built amendment 2026-11-09 (0.3.4))** Show or hide transcript is new (§4.7).

**Settings.** Settings → Appearance gets a checkbox **Single-key shortcuts** (on by default), help text "Press ? to show
keyboard shortcuts. Turn this off if you use speech input or single-key commands." Stored as `ui.singleKeyShortcuts`
(boolean) through the existing settings route. The session window reads it from `GET /api/app/settings` once at load.

**A11y.** Every row is reachable as table text (no hover-only content); the dialog follows §4.4; the button's `title`
and `aria-keyshortcuts` name both keys; WCAG 2.1.4 is met by the Settings switch and by ignoring `?` in text entry.

### 4.7 Transcript toggle (session window, 0.3.4)

**(built amendment 2026-11-09 (0.3.4))** The session window gets a show/hide control for the Transcript column, so the
terminal can have the full width. It is the first control in the terminal column's head (`.term-head`), before the live dot:

```
[▥ Transcript on]  ● Live · 92×30     [Dark|Light] [Type into pane off ⌃]]
```

`button.btn#hist-toggle`, `aria-pressed`, `aria-controls="sess-hist"`: icon + the word "Transcript" + an `.onoff` chip
(§9.6: colour, icon and word, never colour alone).

| | On (default) | Off |
|---|---|---|
| look | pressed (accent-soft fill, accent edge), `i-hist-on` (frame, divider, three lines on the left), chip "on" | plain, `i-hist-off` (frame, divider), chip "off" |
| layout | the 38 % / 62 % split | `.split.hist-off`: the terminal column takes the full width, the transcript column is not rendered |

- **Wide windows only.** `.split.hist-off` applies at 1001 px and wider (a `min-width` media query) and never with
  `.no-term` (a window with no terminal would show nothing). At 1000 px and below the Terminal / Transcript tabs
  already choose which one shows, so the button is `display: none` there; the saved choice is kept and applies again
  when the window is wider. No-op, button hidden: 1000 px and below, `no-hist` (no session id), `no-term` (no pane).
- **Key.** Mod+Shift+H (⌘⇧H, Ctrl+Shift+H), pure rule `wantsHistToggle(e, { mac, passthrough, dialogOpen })` in
  `public/shortcuts.js`: Mod (the platform's, alone) + Shift + the H key in either case, no Alt, not while a dialog is
  open, not in passthrough on Linux (macOS's ⌘ stays the app's, as for Mod+/). It works in the message box and on any
  control; holding the keys toggles once. `title` "Show or hide the transcript (⌘⇧H)" / "(Ctrl+Shift+H)",
  `aria-keyshortcuts` "Meta+Shift+H" / "Control+Shift+H".
- **Memory.** The choice is `nika.transcript` = `shown` | `hidden` in `localStorage` (a per-viewer convenience, like
  Dark / Light), applied at load; anything else, or storage that throws, means shown. The app's port changes every
  launch, so the choice lasts until nika quits (accepted, owner decision 2026-11-09).
- **Announce and focus.** Polite live region: "Transcript hidden" / "Transcript shown" (not at load). Hiding while focus is
  inside the transcript moves focus to the toggle, so it is never left in a column that is gone.
- **Sheet.** The Keyboard shortcuts window lists it in the session window's **Window** group, after Back: "Show or hide
  transcript" · Mod+Shift+H · "Give the terminal the full width (wide windows; narrow ones have tabs)".

---

## 5. Accessibility

Baseline: WCAG 2.2 AA.

### 5.1 Contrast (computed, WCAG 2.x relative luminance)

All 252 UI pairs and 36 terminal pairs were computed; 0 failures. Status colours clear 4.5:1 on every background, so they are safe as text anywhere.

| Pair | Needs | A light | A dark | B light | B dark | C light | C dark |
|---|---|--:|--:|--:|--:|--:|--:|
| `--text` on `--bg` | 4.5:1 | 16.14 | 14.89 | 15.04 | 15.60 | 14.78 | 14.00 |
| `--text` on `--bg-alt` | 4.5:1 | 14.74 | 13.84 | 13.93 | 14.83 | 15.62 | 13.17 |
| `--text` on `--surface` | 4.5:1 | 17.76 | 13.20 | 17.05 | 13.98 | 17.23 | 12.27 |
| `--text` on `--surface-2` | 4.5:1 | 15.98 | 11.92 | 15.85 | 12.62 | 16.03 | 10.91 |
| `--text` on `--surface-3` | 4.5:1 | 14.31 | 10.35 | 14.13 | 11.02 | 14.35 | 9.33 |
| `--text-muted` on `--bg` | 4.5:1 | 6.23 | 7.68 | 6.50 | 7.87 | 6.21 | 7.19 |
| `--text-muted` on `--bg-alt` | 4.5:1 | 5.69 | 7.14 | 6.02 | 7.48 | 6.56 | 6.76 |
| `--text-muted` on `--surface` | 4.5:1 | 6.85 | 6.81 | 7.37 | 7.05 | 7.23 | 6.30 |
| `--text-muted` on `--surface-2` | 4.5:1 | 6.16 | 6.15 | 6.85 | 6.37 | 6.73 | 5.60 |
| `--accent` on `--surface` | 4.5:1 | 6.44 | 6.71 | 7.06 | 7.69 | 6.04 | 8.92 |
| `--accent` on `--bg` | 4.5:1 | 5.85 | 7.57 | 6.23 | 8.58 | 5.18 | 10.17 |
| `--accent` on `--accent-soft` | 4.5:1 | 5.43 | 5.98 | 5.89 | 6.44 | 5.20 | 7.32 |
| `--accent` on `--bg-alt` (focus ring) | 3:1 | 5.34 | 7.04 | 5.77 | 8.16 | 5.48 | 9.57 |
| `--on-accent` on `--accent` | 4.5:1 | 6.44 | 7.32 | 7.06 | 8.03 | 6.21 | 8.93 |
| `--text` on `--accent-soft` | 4.5:1 | 14.97 | 11.76 | 14.23 | 11.71 | 14.84 | 10.06 |
| `--line-strong` on `--surface` (control edge) | 3:1 | 3.31 | 3.48 | 3.52 | 3.59 | 3.64 | 3.31 |
| `--line-strong` on `--bg` | 3:1 | 3.01 | 3.93 | 3.10 | 4.00 | 3.12 | 3.78 |
| `--bg` on `--text` (toast) | 4.5:1 | 16.14 | 14.89 | 15.04 | 15.60 | 14.78 | 14.00 |
| `--busy` on `--busy-soft` | 4.5:1 | 5.02 | 6.93 | 5.02 | 6.93 | 5.02 | 6.93 |
| `--busy` on `--surface` | 4.5:1 | 5.77 | 8.16 | 5.77 | 8.46 | 5.61 | 8.09 |
| `--busy` on `--bg` | 3:1 | 5.24 | 9.20 | 5.09 | 9.44 | 4.82 | 9.23 |
| `--busy` on `--bg-alt` | 3:1 | 4.79 | 8.56 | 4.71 | 8.98 | 5.09 | 8.68 |
| `--idle` on `--idle-soft` | 4.5:1 | 5.60 | 7.42 | 5.60 | 7.42 | 5.60 | 7.42 |
| `--idle` on `--surface` | 4.5:1 | 6.33 | 8.54 | 6.33 | 8.86 | 6.16 | 8.47 |
| `--idle` on `--bg` | 3:1 | 5.75 | 9.63 | 5.59 | 9.88 | 5.29 | 9.66 |
| `--idle` on `--bg-alt` | 3:1 | 5.25 | 8.96 | 5.17 | 9.40 | 5.59 | 9.09 |
| `--attn` on `--attn-soft` | 4.5:1 | 5.73 | 6.47 | 5.73 | 6.47 | 5.73 | 6.47 |
| `--attn` on `--surface` | 4.5:1 | 6.80 | 6.76 | 6.80 | 7.01 | 6.62 | 6.70 |
| `--attn` on `--bg` | 3:1 | 6.18 | 7.62 | 6.00 | 7.82 | 5.68 | 7.64 |
| `--attn` on `--bg-alt` | 3:1 | 5.65 | 7.09 | 5.56 | 7.44 | 6.00 | 7.19 |
| `--ended` on `--ended-soft` | 4.5:1 | 4.97 | 5.21 | 4.97 | 5.21 | 4.97 | 5.21 |
| `--ended` on `--surface` | 4.5:1 | 5.72 | 6.17 | 5.72 | 6.40 | 5.57 | 6.12 |
| `--ended` on `--bg` | 3:1 | 5.20 | 6.96 | 5.05 | 7.14 | 4.78 | 6.98 |
| `--ended` on `--bg-alt` | 3:1 | 4.75 | 6.47 | 4.68 | 6.79 | 5.05 | 6.57 |
| `--danger` on `--danger-soft` | 4.5:1 | 5.63 | 6.53 | 5.63 | 6.53 | 5.63 | 6.53 |
| `--danger` on `--surface` | 4.5:1 | 6.57 | 6.90 | 6.57 | 7.16 | 6.40 | 6.84 |
| `--danger` on `--bg` | 3:1 | 5.97 | 7.79 | 5.80 | 7.99 | 5.49 | 7.80 |
| `--danger` on `--bg-alt` | 3:1 | 5.46 | 7.24 | 5.37 | 7.60 | 5.80 | 7.34 |
| `--text` on `--diff-add` | 4.5:1 | 15.64 | 11.49 | 15.01 | 11.74 | 15.58 | 10.78 |
| `--text` on `--diff-del` | 4.5:1 | 15.20 | 12.81 | 14.59 | 13.08 | 15.15 | 12.01 |
| `--busy` on `--diff-add` | 4.5:1 | 5.08 | 7.10 | 5.08 | 7.10 | 5.08 | 7.10 |
| `--danger` on `--diff-del` | 4.5:1 | 5.63 | 6.70 | 5.63 | 6.70 | 5.63 | 6.70 |

Direction-specific pairs: C status line `#dce5ef` on `#101924` 13.90 (light) and `#062731` on `#5fd3ea` 8.93 (dark); C attention bar `#fff` on `#b0125c` 6.80, `#2a0716` on `#ff80b5` 7.90; selected segment `--surface` on `--text` 17.23 / 12.27.

Terminal palettes (each colour on its own background):

| Pair | Needs | dark | light |
|---|---|--:|--:|
| `--term-fg` on `--term-bg` | 4.5:1 | 13.16 | 15.26 |
| cursor on `--term-bg` | 3:1 | 16.12 | 15.26 |
| ANSI 1–7, 9–15 on bg | 4.5:1 | 6.80–16.26 | 5.23–9.82 |
| ANSI 8 ("bright black", dim text) | none | 5.38 | 4.63 |
| ANSI 0 ("black") | none | 1.70 | 15.26 |

ANSI 0 on the dark surface is deliberately close to the background: programs use it as "black on black" for invisible padding and as a background colour. ANSI 8 still clears 4.5:1. Program-chosen 256/RGB colours are outside nika's control.

### 5.2 Non-colour cues

- Status: shape + word (see §2.2). Attention rows add a left bar and the reason text.
- Diffs: "+"/"−" markers and line numbers; action badges carry words (create/update/unchanged/replace).
- Errors: "!" disc + bold text + `aria-invalid`; never a red border alone.
- Links inside text are underlined; nav links show `aria-current` with weight + surface change.
- Paused mirror: shape change (dot → square) + the word "Paused".

### 5.3 Focus indicator

`:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }` everywhere; ≥ 5.18:1 against every background in all three directions (needs 3:1). Inside the mirror and the diff (dark/scrolling surfaces) the outline is inset (`outline-offset: -2px`). Focus is never hidden by sticky UI (2.4.11): the settings save bar and toasts are compensated with `scroll-padding-bottom: 64px` on scroll containers; toasts sit above the save bar.

### 5.4 ARIA roles and live regions

| Element | Role / attributes |
|---|---|
| Global announcer | one `div.sr-only[aria-live="polite"]`; text cleared then set after 30 ms |
| Status change announcements | only `→ attn`, `→ idle`, `→ ended`, max one message per 3 s refresh, grouped ("2 agents need you: reviewer-2 in demo-api, designer in web-console") |
| Toasts | `role="status"` (info) / `role="alert"` (error) |
| Banners (tmux missing, offline) | `role="alert"` on first appearance only |
| Terminal mirror | `role="region"`, `aria-label="Live terminal of builder-1, pane %12"`, `tabindex="0"`, **not** a live region; in passthrough `role="application"` with the exit instruction in its label |
| Mirror echo ("Sent … to %12") | polite live region, visually hidden (`.sr-only`), not shown to sighted users since 0.4.0 |
| Transcript | `ol` of entries; each entry has who + time; folded parts are `<details>` / `<summary>` |
| Rows | `ul` > `li`; name is a link; status text present (visually hidden when compact) |
| Counts | glyphs `aria-hidden`, numbers followed by `sr-only` words |
| Dialogs | `aria-labelledby` → h2 |
| Tabs | `tablist` / `tab` / `aria-selected`, panels `tabpanel` |
| Row menus | disclosure pattern (`aria-expanded`, `aria-controls`), not `role="menu"` |
| Loading containers | `aria-busy="true"` |
| Tray (native) | handled by the OS; item text is plain words (no colour, no glyph meaning) |

### 5.5 Screen-reader text for status

Row: "reviewer-2, Needs you: Asking to run a command, model opus, demo-api, 4 minutes ago, pane %14". Session header: "builder-1, Working, demo-api, sonnet, pane %12" (an orchestrator: "planner, orchestrator, Working, demo-api, …"; the badge's long word is always read, the short one is `aria-hidden`). **(0.4)** The context meter adds one sentence after the model, in both: "…, Fable 5.1, Context 78 % used, 312k of 400k tokens, compacts at 320k, pane %3" (§3.19 has the other forms). Tray: "demo-api — 1 needs you, 1 waiting, 2 working".

### 5.5a Tooltips on icon-only controls (0.4.0)

A control that shows an icon or a symbol and no words, always or only below a breakpoint, carries a `title` equal to its accessible name, so a
hover says what it is: the dialogs' × buttons, the steppers' − and +, the project tree's fold button, Copy backup path, the sidebar links and
the Add project button on the 60 px rail, the status glyph on a narrow row (its word is hidden), and the tmux and claude dots on the rail. A
control that already has a different title (a disabled item's reason) keeps it. A button whose words stay at every width, such as the project page's Settings button (§3.20), is not an icon control and needs none. `test/tooltips.test.js` reads every page in `public/` and fails
on an icon or symbol control without a title; the controls that page code builds are asserted in the tests that run that code.

### 5.6 Target size (2.5.8)

All targets ≥ 24×24 px: buttons 28, icon buttons 28×28 (xs 24×24), the Shell toggle 26 high, links `min-height: 24px`, checkboxes 16 px but inside a label row of ≥ 24 px, row menu 28. The only smaller visual elements (status glyphs, branch chips) are not interactive. **(built amendment 2026-11-09 (0.3.3))**

### 5.7 Other 2.2 criteria

- 2.5.7 Dragging: none needed (the session split is fixed; no drag-to-resize in 0.2).
- 3.2.6 Consistent help: environment status lives in the same place on every screen (sidebar footer).
- 3.3.7 Redundant entry: Spawn remembers the last model, permission mode and placement per project.
- 1.4.10 Reflow: the app's minimum window is 720×480; the terminal mirror and diffs are 2-D content and scroll horizontally by design.
- 1.4.12 Text spacing: no fixed heights on text containers except the mirror rows.

---

## 6. Responsive behaviour

Window minimum: **720 × 480** (set `minWidth`/`minHeight` in the Tauri window config). All rules below are by window (container) width.

| Width | Shell | Dashboard rows | Project view | Session |
|---|---|---|---|---|
| ≥ 1280 | sidebar 232 | all 7 columns | agents + 320 px cards column | split 38 % / 62 % |
| 1031–1279 | sidebar 232 | rows container ≤ 1010 (browser tier ≤ 860): model + pane hidden, status glyph only | as above | split, transcript min 300 |
| 1000–1030 | sidebar 232 | as above | agents only; cards in the Settings drawer (§3.20), its button in the title row | split, transcript min 300 |
| 900–999 | sidebar 232 | as above | agents only; cards in the Settings drawer | **tabs**: Terminal (default) / Transcript |
| 760–899 | 60 px icon rail, attention counts as corner badges, names in `title` + SR text | group action labels hidden (icon buttons) | agents only; cards in the Settings drawer (the button keeps its word) | tabs; header labels hidden |
| 720–759 | rail | rows ≤ 600: prompt on a 2nd line; path hidden | agents only; cards in the Settings drawer | tabs |

Session details:
- The composer (quick actions, message box, mode row, notes row) is always visible; the mirror takes the remaining height (min 120 px). **(built amendment 2026-11-09 (0.3.3))**
- Mirror never wraps or scales: a 92-column pane at 12 px mono is ~670 px; wider panes scroll horizontally inside the mirror. Font never below 11 px.
- The transcript tab keeps "Load older" sticky at the top. **(built amendment 2026-11-09 (0.3.3))**
- Above 1000 px the **Transcript** toggle (§4.7) can hide the transcript column and give the terminal the full width; at 1000 px and below the toggle is not shown and the tabs stay. **(built amendment 2026-11-09 (0.3.4))**

Rules dialog ≤ 900 px: the file list becomes a horizontal strip above the diff. Settings ≤ 900 px: the in-page index hides and field pairs stack. **(built amendment 2026-11-09 (0.3.4))** The Choose plugins dialog is min(560, vw−32) × min(640, vh−32) at every width (so it still fits 720 × 480); only its list scrolls, and a long plugin name wraps instead of widening the row.

B: centred column max 760 px; drawer pushes ≥ 1180 px and overlays below. C: lanes stack vertically ≤ 860 px with tiles in an auto-fill grid (min 240 px); the Timeline rail becomes a tab ≤ 1000 px.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Long project name (48 chars, e.g. `infra-scripts-and-deployment-tooling-for-staging`) | ellipsis at 32ch in headings, 28 chars in the tray (`…`), full name in `title`, `aria-label` and the project view `h1` (wraps with `overflow-wrap: anywhere`) |
| Long agent name (≤ 40 by `AGENT_NAME`) | ellipsis in rows and tiles; full in the session header |
| Long branch | chip max 22ch, ellipsis, full in `title` |
| Long prompt | one line with ellipsis in rows; 2 lines (`line-clamp`) in cards/tiles; full in the session header tooltip and the transcript |
| 50+ agents | ended folded per project; live rows never capped, the Ended section draws 12 rows then "Show N more ended agents"; Mod+F filter by name, prompt or branch; sidebar shows only attention counts; announcements grouped; C caps lanes at 6 tiles and turns tails off for tiles beyond the first 12 on screen |
| Very long transcript entry | text > 12 lines clamps with "Show all N lines"; tool output in a `<pre>` (max-height 22em, scroll); entries > 32 KB arrive with `truncated: true` → "This entry is over 32 KB; nika shows the first part only."; history pages of 50 with "Load older" (keeps scroll position) |
| 200-column terminal | rendered at full width with horizontal scroll; header shows "200 × 50"; jump-to-live also scrolls to column 0 |
| Wide characters (CJK, emoji) | rendered as text; column math must count terminal cells (wide = 2), see Risks |
| Missing pane (no tmux, plain terminal session) | no session mirror: the session screen shows the transcript only and a note "This session is not in tmux, so nika can show its transcript but cannot mirror or type into it." |
| Missing branch / model / prompt | branch omitted; model "–"; prompt "(no prompt yet)" muted |
| Unregistered repo with live agents | group/lane shows "not a nika project" + [Add project] |
| Untitled session (no agent name) | shown as "untitled session" in `--text-muted`; still clickable |
| Permission prompt | row and tray become "Needs you"; session shows the prompt panel (§9.5) and the prompt in the mirror; Esc and, from an empty box, ↑ ↓ go to the pane; Enter, Shift+Tab, digits and pastes wait (§9.5); nika never answers on its own. **(built amendment 2026-11-09 (0.3.3))** |
| Spawn at limit | the spawn opener is `aria-disabled` with the limit copy of §3.17 as its title; a 409 limit from the server shows the same text inside the sheet |
| Rules conflict (409 hash) | "These files changed after the preview. Nothing was written. [Reload preview]" |
| Rules refused (409, e.g. symlink) | "nika refused to write: rules/ is a symbolic link. Nothing was changed." |
| Foreign rules file | Apply stays disabled until "Replace rules/orchestration.md (not written by nika). A backup is kept." is checked |
| `.gitignore` | optional file; the checkbox "Add .claude/settings.local.json to .gitignore" is **unchecked by default**; when unchecked the file is listed as "optional, not written" |
| Disconnected server | banner + stale list at 60 % opacity; actions disabled with reason; retry every 3 s |
| Rate limited (429) | composer keeps text; message for 3 s; the message box stays enabled; forwarded arrows are batched (§4.2) |
| Folder picker busy | toast "A folder picker is already open. Finish or cancel it first." |
| Folder picker cancelled | toast "No folder chosen. Nothing was added." |
| Times | "now" (< 1 min), "N min", "N h", "N d"; absolute time in `title` |
| **(0.4)** Saved orchestrator is gone (transcript deleted) | header Start orchestrator + the project-page alert (§3.16); Start forgets the id and starts fresh |
| **(0.4)** Saved orchestrator outside the time window | the header still says Resume (the project list checks the transcript index, not the window); its row is just not listed |
| **(0.4)** Two main orchestrators live (a 0.3 leftover) | Open orchestrator uses the saved one if it runs, else the most recent; Set and Resume are off (R1) |
| **(0.4)** Older server (no `orchestrator` field) | the snapshot decides: Open or Start, never Resume or the saved badge |
| **(0.4)** No usage yet in the transcript tail (a new session, or the last assistant entry is beyond the tail window) | the context meter reads "–" (`unknown`) |
| **(0.4)** A model nika does not know | the server counts it as 200k, so the meter shows a per cent against 200k; `nowin` means only that no model id was seen |
| **(0.4)** Context over 100 % (a window smaller than the context) | the number is shown as is and the bar is full |
| **(0.4)** Auto-compact off, or a session nika did not start | the same meter against the model's window (off) or the setting's window (`none`); the title says which, and says nothing about compacting for `none` |
| **(0.4)** Older server (no `context` field) | every row shows "–" |

---

## 8. Phase 4 implementation notes

### 8.1 CSP and styling

- Keep the current CSP from `src/server.js` for both tiers: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
- No inline `<script>`, no inline `<style>`, no `style="…"` attributes, no `on*=` attributes. The mockups use all of these for convenience; the real files are `index.html` + `app.css` + `app.js` (plus app-tier modules).
- Allowed under `style-src 'self'`: CSSOM property writes (`el.style.color = 'rgb(95 0 0)'`, `el.style.height = '120px'`). Use them only for 256/RGB mirror colours and the composer auto-grow. Never `setAttribute('style', …)` and never `el.style.cssText`.
- Icons: one static SVG sprite in `index.html`; instances via `createElementNS` + `<use href="#i-name">`.
- Container queries are optional in the real app: the mockups use them to simulate window sizes inside one page; the app can use `@media (max-width: …)` with the same breakpoints.

### 8.2 Untrusted strings

- Every agent name, prompt, reason, report, branch, path, plugin id, transcript text, diff line and mirror segment is set with `textContent` (the `h()` helper from `public/app.js`, which the mockups reuse). No `innerHTML`, `insertAdjacentHTML` or `outerHTML` anywhere.
- Mirror segments: one `span` per styled run, classes `.f0–.f15 .b0–.b15 .sb .sd .si .su` from the server's whitelisted SGR fields; nothing from capture becomes a class name or attribute except via those fixed maps.
- Titles and `aria-label`s built from data use `setAttribute` with plain strings (never URLs). The claude.ai link is built from a validated session id and opened by the shell, never as an `<a href>` the webview navigates.

### 8.3 Static vs JS-rendered

| Static in `index.html` | Rendered by JS |
|---|---|
| shell: skip link, sidebar frame, nav, main, empty screen sections with `h1`s, dialogs (`<dialog>` frames with headers and footers), SVG sprite, announcer, toast host | project list + counts, queue, groups, rows, project cards, settings values and plugin list, rules file list + diffs, transcript entries, mirror rows, toasts, banners |

Rendering cadence: dashboard data every 3 s (as 0.1); session mirror capture every 500 ms while the session is visible and the window focused (server caches 250 ms, use `If-None-Match` → 304); pause polling when the window is hidden. Update the mirror per changed row only (compare row text + style), so selection and scroll survive.

### 8.4 Tier detection

On load, `GET /api/app/me`: 200 → app tier (render privileged UI); 404 or network error on `:3335` → browser tier: do **not** render spawn, start, rules, settings, keys, history or mirror; show the info banner "Read-only. Start, input, rules and settings live in the nika app." Privileged routes never exist on `:3335`, so hiding is presentation, not security.

### 8.5 Theme

Follow the OS (`prefers-color-scheme`); no toggle in 0.2. The mirror Light/Dark switch is per viewer in `localStorage` (wrapped in try/catch).

### 8.6 Cost guardrails (if C-style tails are adopted later)

Tails only for tiles in the viewport (IntersectionObserver), max 12 panes, 1 Hz, `-S` never used (visible screen only), paused when the window is hidden.

### 8.7 Mock-only things to drop

The mock bar, `data-world`, the `.stage/.win` frame, `?theme`/`?size` params, simulated toasts ("Simulate cancel/busy"), the fake desktop and browser chrome.

---

## 9. Session controls (0.3)

Product spec: `docs/superpowers/specs/2026-11-08-control-panel-design.md` §6.2–§6.9. Tokens and the mode tag: §2.8. Mockup: `docs/design/variants/session-controls.html`. App tier only; the browser tier on :3335 renders none of this (not disabled: absent). Every string from a pane (prompt labels, question) or from a command file (name, description) is set with `textContent`.

### 9.1 Window frame and message-box edge

The session window carries the current mode in three places at once: a 3 px frame along the top of the window, the header tag, and a 3 px left edge on the message box.

```css
.mode-frame { flex: none; height: 0; }   /* div.mode-frame, aria-hidden, first child of body */
body[data-mode] .mode-frame { height: 3px; background: var(--mc-line); }
body[data-confirmed="false"] .mode-frame, body.m-unknown .mode-frame {
  background: repeating-linear-gradient(90deg, var(--mc-line) 0 10px, transparent 10px 16px); }
body.m-bypass .mode-frame {   /* after the rule above: bypass is never dashed */
  background: repeating-linear-gradient(135deg, var(--m-bypass-line) 0 6px, var(--m-bypass-stripe) 6px 10px); }

/* message-box edge: public/session.css:163 sets box-shadow on focus, which would drop the edge.
   Replace that rule with this pair (the fallback keeps the edge off when body has no mode class). */
.inbox { box-shadow: inset 3px 0 0 var(--mc-line, transparent); }
.inbox:focus-within { border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--mc-line, transparent), 0 0 0 1px var(--accent); }
```

The edge and the focus ring are two shadows in one declaration, so focus adds the ring without removing the mode. Shell on replaces both (§9.6).

`body` gets `data-mode="<api mode>"`, the mode class (`m-plan` …) and `data-confirmed`. No pane, pane gone, or no capture yet: no class, no frame (height 0), no edge, no tag. The frame is decoration (`aria-hidden`); the tag and the live region carry the meaning.

### 9.2 Header

Order: back crumb · `h1` name · **role badge** (`#sess-role`, §3.16; hidden when there is none) · **label chip** (`#sess-kind`, §3.21; hidden when there is none) · status pill · **mode tag** (`#sess-mode`) · model · **context meter** (`#sess-ctx`, §3.19; hidden until the first poll) · pane · branch · spacer · Open in
claude.ai · Keyboard shortcuts. **(built amendment 2026-11-09 (0.3.3))** The mode switcher moved under the message
box (§9.3); the `.bar-end` wrapper is gone and `.bar-tools` holds the two buttons.

- The tag sits right after the status pill so the two read together ("Waiting", "Plan"). It is the mode's word at
  every width, and the only mode shown in the narrow Transcript tab.
- The header wraps (it already has `flex-wrap`).
- The tag is never focusable and never a button; the switcher is the control.

### 9.3 Mode switcher

Segmented toolbar: Manual, Accept edits, Plan, Auto (`MODE_TARGETS`). Don't ask is never a segment. **Bypass is never a segment in 0.3** (product spec §6.3: only for panes nika launched with bypass allowed, which arrives in 0.4; the mode route refuses it as a target). A bypass footer in 0.3 shows only as the current-mode tag, with the switcher in its "Bypass current (0.3)" state below. The two Bypass segment rows below are the 0.4 look.

**(built amendment 2026-11-09 (0.3.3))** Placement: under the message box, in `div.mode-row#mode-row` (§3.10 order): the toolbar (labelled "Permission mode" for screen readers; the visible "Mode" word was removed in 0.4.0, owner 2026-11-13), then `#msw-why`. The row is hidden until the switcher is wired (no pane: no row).

Anatomy: `div.msw[role="toolbar"][aria-label="Permission mode"][aria-describedby="msw-why"]` > `button.<mode cls>[aria-pressed]` (icon + label) ×4 (×5 in 0.4 with Bypass), then `span#msw-why.msw-why` (info icon + reason text) when the switcher can't act. `#msw-why` is not a live region (it flips with every working/waiting change); a result message (below) is announced once through the window's announcer. The switcher is disabled while a `prompt` is open, `mode` is `unknown` or `modeConfirmed` is `false` (`docs/contracts/api-app.md`: the route would answer 409).

| Segment state | Look |
|---|---|
| default | transparent, `--text` label, `--text-muted` icon; hover `--surface-2` |
| pressed (current mode, confirmed) | `--mc-soft` fill, `--mc-line` edge, `--mc` text and icon, 600 |
| held (prompt open or unconfirmed) | `.held`: **not pressed** (`aria-pressed="false"`), 1 px dashed `--mc-line` edge, `--mc` text and icon, no fill, 100 % opacity, `title` "Plan, not confirmed". Same dashed language as the tag; no segment is pressed while the mode is not confirmed. None when the held mode is not a segment (Don't ask, Bypass) |
| Bypass, not pressed (0.4 only) | `--m-bypass` text and icon (red even when idle, so it is never picked by accident) |
| Bypass, pressed (0.4 only) | `--m-bypass` fill, `--m-bypass-on` text |
| switching (target) | 12 px spinner in place of the icon, 1 px dashed `--mc-line` edge, `aria-busy="true"` |
| aria-disabled | 45 % opacity, `cursor: not-allowed`; **the pressed segment and a held one stay at 100 %** so the mode stays readable |
| not in cycle | aria-disabled + label struck through + `title` "Auto isn't in this session's Shift-Tab cycle" |

```css
.msw button.held { border: 1px dashed var(--mc-line); color: var(--mc); opacity: 1; }
.msw button.held .ic { color: inherit; }
.msw-why.err { color: var(--idle); font-weight: 600; }   /* result messages; the icon becomes i-warn */
```

**Why the switcher can't act.** The first reason that applies wins. Before all of them, a window with no mode at all (no tag, no frame) shows the "not connected" rows.

| # | Switcher state | Segments | Reason line (`#msw-why`, exact copy) |
|---|---|---|---|
| — | pane gone | all aria-disabled, none pressed | "The pane is gone." |
| — | tmux error (captures fail, §3.9) | same | "nika couldn't reach tmux." |
| — | no capture yet | same | "Connecting to the pane…" |
| 1 | permission prompt or dialog open (`prompt` ≠ null, or status Needs you) | none pressed; the held mode's segment `.held`; all aria-disabled. nika offers no Shift-Tab here, and Shift+Tab in the message box waits too (§9.5) | "Answer the prompt first." |
| 2 | Claude working | all aria-disabled (pressed stays full) | "Switch when Claude is waiting for you." |
| 3 | mode unconfirmed (`modeConfirmed: false`, no prompt) | none pressed; the held or launch mode's segment `.held`; all aria-disabled | "Waiting for Claude to confirm the mode." |
| 4 | mode unknown | none pressed, all aria-disabled | "nika can't read the mode. Use the terminal." (no chip; as built in 0.3.0) |
| 5 | Don't ask current | none pressed, all aria-disabled | Don't ask tag + "Don't ask is on. Change it in the terminal." |
| — | ready (Claude idle, no prompt, mode confirmed) | all live, current pressed | none |
| — | switching | target busy, others aria-disabled; the pressed segment follows the footer | "Switching… up to 6 Shift-Tab presses." (no live count) |
| — | Bypass current (0.3) | Manual, Accept edits, Plan, Auto live, none pressed (switching away is allowed; only bypass as a target is refused) | the Bypass tag + "Claude runs every tool without asking." in the normal look (not the error look); the switcher no longer sits next to the header tag, so its row names the mode itself |

In every state where the mode is Bypass or Don't ask (modes without a segment), the reason line leads with that mode's tag (`modeEl`; dashed "unconfirmed" while held) instead of the info icon. Colour never travels alone.

Paused and passthrough (§3.9) change nothing: a paused mirror still applies captures, and clicking a segment moves focus out of the mirror, which already leaves passthrough.

**Results of a switch** (`POST /api/app/pane/:id/mode`). Messages replace the reason line in its error look (`.msw-why.err`, warn icon) and stay until the next switch request, until a reason 1–5 applies, or until the pane's mode changes after the response.

| Response | Message (exact copy) | Also |
|---|---|---|
| 200 | none | focus stays on the segment; `#mode-live` says "builder-1: permission mode is now Plan." (§2.8.7) |
| any non-200 after presses, the next capture reads a confirmed mode other than the start mode | "Stopped at Accept edits." | the tag already shows the mode reached; `#mode-live` announces it once. Wins over the rows below |
| 409 `not-in-cycle`, the next capture is back at the start mode | "Auto isn't in this session's Shift-Tab cycle." | that target struck through. Strikes clear when the pane's mode changes; a used-up press budget that stopped elsewhere is the row above, never a strike |
| 409 `not-idle` | "Switch when Claude is waiting for you." | |
| 409 `mode-unknown` | "nika can't read the mode." | |
| 409 `mode-unchanged` | "The mode didn't change; try again or use the terminal." | calm: no alert, no Bypass tag (the footer read fine and did not move; a footer that reads Bypass is `stopped-in-bypass` instead) |
| 409 `busy-switching` | "Another action is running on this session." | |
| 404 | "The session is gone." | the window goes to its pane-gone state (§3.9) |
| 429 | "Too many keys at once; try again." | |
| 5xx, network error | "nika couldn't reach tmux." | |

Behaviour: the header tag follows the footer during the switch (each capture), so the user sees the cycle pass through modes; only the final mode is announced. The response's `presses` is used only for the echo ("Sent 2 × Shift-Tab to %12"), never as a live count. There is no cancel: at most 6 presses, each followed by up to 1.8 s of polling (about 11 s worst case).

Keyboard: one Tab stop (roving `tabindex`: the pressed segment, else the first). ← → move focus and wrap; Home / End jump. **Moving never switches**; Enter or Space switches. Activating the pressed segment or an aria-disabled one does nothing (aria-disabled segments stay focusable so their `title` and `#msw-why` can be read). Focus stays on the segment after a switch. A pointer press on the switcher while the message box has focus leaves focus in the box (`mousedown` default prevented), so typing goes on. **(built amendment 2026-11-09 (0.3.3))**

Segments keep icon + word at every width (the switcher has the composer's width). The row wraps: the reason line first, then the segments. Below 560 px window height the row stays. **(built amendment 2026-11-09 (0.3.3))**

### 9.4 Quick actions

One toolbar (`#qa`, `role="toolbar"`, `aria-label="Session actions"`) at the top of the composer, above the prompt panel and the message box. 28 px buttons, 12 px text, icon + word. End session sits alone at the far right.

| Button | Icon | Sends | Live when | Otherwise (aria-disabled `title`) |
|---|---|---|---|---|
| Stop | `i-stop` (filled while live) | `POST /api/app/pane/:id/stop` with `{}` (contract §3): Esc, and a second Esc in vim insert mode | Claude is working | "Nothing to stop: Claude is waiting" |
| Compact | `i-compact` | `/compact` (command route, contract §3) | Claude is waiting | "Available when Claude is waiting for you" |
| Clear… | `i-clear` | after confirm: `/clear` (command route) | Claude is waiting | same |
| Model: `<model>` ▾ | `i-model`, `i-chev` | opens the model popover; Switch model sends `/model <id>` (command route) | Claude is waiting | same |
| Rewind | `i-rewind` | `/rewind` (command route, contract §3) | Claude is waiting | "Available when Claude is waiting for you" |
| End session… | `i-end` | opens the End dialog (§9.8) | pane eligible and the agent is not `ended` | "No live session on this pane" (an `ended` agent: no request goes out, the route could only answer 409 `not-idle`) |

- **Stop is always in the first slot**, live only while Claude works and aria-disabled while Claude waits, so the row never shifts under the pointer (owner decision 2026-11-09). Live look: `--text` edge, 600, filled square. Ctrl+C in the message box runs the same Stop while Claude works (§4.2). `title`: "Stops this turn (Esc in the pane; twice in vim insert mode). Keeps the work, also stops running subagents". **(Built amendment 2026-11-09, task 14b: Stop posts to its own route instead of the keys route; results below.)**
- Compact, Clear, Model and Rewind are aria-disabled while Claude works (owner decision 2026-11-09), the same idle rule as the mode switch.
- Compact, Clear, Model and Rewind go through the command route (contract §3 `/command`): nika types the command only into Claude's empty input and presses Enter only when the input reads exactly that command, so a draft typed in the terminal is never sent or cleared. Compact `title`: "Types /compact and Enter: summarises the conversation to free context". Clear `title`: "Types /clear and Enter after you confirm". Rewind `title`: "Types /rewind and Enter: opens Claude's rewind menu in the pane". **(Built amendment 2026-11-09, task 14b: Rewind types `/rewind` through the command route instead of Esc Esc. It no longer reads nika's message box, so the old "Empty the message box first" state is gone; the route's own rule (Claude's input must be empty) applies, with the shared failure copy below.)**
- End session uses the Danger button (§3.1) and ends with "…" because it opens a dialog; so does Clear.
- Clear confirm (440 px confirm dialog, §3.6): title "Clear builder-1's conversation?", body "Claude starts a new conversation with empty context.", buttons Cancel (initial focus) · **Clear conversation** (danger).
- Model popover: disclosure (`aria-expanded`, `aria-controls="model-pop"`), not a menu. Content: label "Model for builder-1", the §6.9 `<select>` (Latest / Aliases / Older optgroups, then "Custom ID…" which reveals a text field; Aliases: best, fable, opus, sonnet, haiku, opusplan, opus[1m], sonnet[1m]), a muted line "Types `/model <id>` and Enter.", footer Cancel · **Switch model** (primary). Opening focuses the select; Esc or Cancel closes and returns focus to the Model button; Tab out of the popover closes it. Custom field error: "Use a model id such as claude-sonnet-5-5, or an alias such as opus or sonnet[1m]." A change never fires on `<select>` change (arrow keys on a closed GTK select would send several `/model`s); only Switch model sends.
- After any send, the existing echo says what went out ("Sent /compact + Enter to %12"). Rewind says "Opened Rewind in %12: pick a point in the pane" (the menu is in the pane, not in nika). Stop says "Stopped builder-1's turn".
- Stop failures (**built amendment 2026-11-09, task 14b**), fixed copy in the problem line, never the server's text: 409 `prompt-open`: "Answer the prompt first. Esc = No is in the prompt panel." (**0.5, W1:** "Answer the question above first." while a question or plan form shows, §9.16) · 409 `screen-unclear`: "nika can't tell what Claude is showing, so Stop sent nothing. Press Esc in the terminal." · 409 `not-busy`: "Nothing to stop: Claude is waiting." · 409 `stopping` (another window is already stopping this pane): "Already stopping the turn." · 409 `mode-unknown`: "Claude's input stayed in vim insert mode; press Esc in the terminal." · 429: "Too many keys at once; try again." · 404: "The session is gone." (and the pane-gone state, §3.9) · 5xx, network error: "nika couldn't reach tmux." · anything else: "nika couldn't stop the turn." A command in flight (Compact waiting on the control lock) does not block Stop; only a Stop already in flight ignores a second click.
- Command route failures, in the composer's problem line (`role="alert"`), fixed copy (never the server's text), the button re-enabled: 409 `input-not-empty`: "Claude's input has a draft. Send or clear it in the terminal, then try again." · 409 `input-unreadable`: "nika can't find Claude's input box, so nothing was typed. Close any menu in the terminal (Esc), then try again." (both a warning, **built amendment 2026-11-09 (0.3.4)**: `input-not-empty` is a draft in a box nika found; `input-unreadable` is no box, or one that does not start with a `❯` row, and nothing is typed) · 409 `not-at-prompt`: "Claude's input didn't take the command; nothing was submitted." · 409 `not-idle`: "Compact, Clear, Model and Rewind are ready when Claude waits for you." · 409 `mode-unknown`: "Claude's screen isn't at the prompt; use the terminal." · 409 `busy-switching`: "Another action is running on this session." · 429: "Too many keys at once; try again." · 404: "The session is gone." · 5xx, network error: "nika couldn't reach tmux."

**States.** A disabled row also says why in words: a reason line `p#qa-why.qa-why` (info icon + text, 12 px `--text-muted`, 6 px under the row, referenced by the toolbar's `aria-describedby`), not only the `title`s. One line, the first matching row wins.

| Window state | Stop | Compact · Clear · Model · Rewind | End session… | Reason line (exact copy) |
|---|---|---|---|---|
| pane gone | aria-disabled | aria-disabled | aria-disabled, `title` "The pane is gone" | "The pane is gone." |
| tmux error (§3.9) | aria-disabled | aria-disabled | aria-disabled | "nika couldn't reach tmux." |
| no capture yet | aria-disabled | aria-disabled | aria-disabled | "Connecting to the pane…" |
| Needs you, prompt panel shown (§9.5) | aria-disabled, `title` "Esc = No is in the prompt panel" | aria-disabled | live (the dialog has its prompt-open line, §9.8) | "Answer the prompt first. Esc = No is in the prompt panel." |
| Needs you, question or plan form shown (§9.16, 0.5) | aria-disabled, `title` "Decline is in the question form" | aria-disabled | live (End declines the dialog first) | "Answer the question above first." |
| Needs you, unknown layout (`prompt: null`) | aria-disabled, `title` "Answer the prompt first; Esc in the message box cancels it" **(built amendment 2026-11-09 (0.3.3))** | aria-disabled | live | "Answer the prompt first." |
| Claude working | **live** | aria-disabled | live (Esc first, §9.8) | "Compact, Clear, Model and Rewind are ready when Claude waits for you." |
| Claude waiting | aria-disabled | live | live | none (Stop being off needs no line) |

While a mode switch from this window is in flight, Compact, Clear, Model and Rewind are also aria-disabled, with no extra line (the switcher's "Switching…" line explains it); End stays live and the route answers `busy-switching` (§9.8). Paused and passthrough change nothing (same reason as §9.3).

```css
.qa-why { margin: 6px 0 0; display: flex; align-items: center; gap: 6px; font-size: var(--fs-small); color: var(--text-muted); }
```

Keyboard: one Tab stop, ← → / Home / End, Enter or Space activates.

≤ 760 px: Compact, Clear, Rewind become icon buttons (`aria-label` = the word, `title` as above); Stop, Model and End session keep their words.

### 9.5 Permission-prompt buttons

When the capture has `prompt`, the attention note above the message box becomes a prompt panel (`#prompt-btns`, `role="group"`, `aria-labelledby` → the question).

- Panel: `--attn-row` fill + 3 px `--attn` left edge (as attention rows). Line 1 reuses the 0.2 attention note (`#attn-note`): the "Needs you" status pill + `#attn-text`, cut to the attention reason (`agent.attention`, e.g. "Asking to run a command") in `--attn`, 600 (`.ask-reason`). nika does not parse the prompt's own title line (no "Bash command: …" line). Line 2: the question, 600.
- **Kind tag (0.5, W1).** The panel's header starts with a tag `i-warn` + "Permission" (`.dlg-kind[data-k="perm"]`, `--attn`; `public/session.html`), so a permission prompt and a question form (§9.16, tags "Question" and "Plan approval") never look alike.
- One button per option, full width, in Claude's order: keycap digit (`kbd`, 700) + the label as text, wrapping (labels ≤ 80 chars after `clean()`). Secondary-button look, left-aligned, min height 32. A button posts `{ n, sig }` to `POST /api/app/pane/:id/answer` (`docs/contracts/api-app.md`).
- **An option whose label contains "bypass" (any case) gets no button** (rule 12; the answer route refuses it): it shows as a plain row, same height, dashed `--line-strong` edge, no fill, the digit in a muted keycap, the label as text, and a second line in `--text-muted`: "Answer this one in the terminal". It is not focusable.
- **A prompt that mentions bypass anywhere gets no answer button at all** (built amendment 2026-11-09, task 14b; the answer route refuses every option with 400 when the prompt window - the last 15 non-blank rows, tool-call lines above the question included - mentions bypass, NFKC, letters only). The capture's `prompt.bypass` carries that same test (contract §3), and the page hides every answer button when it is `true`; the page's own checks of the question and the labels stay as a second line. Every option is drawn as the plain row above, with "Answer this one in the terminal"; only the Esc button stays. If the route still answers 400, the problem line says "Answer this prompt in the terminal." and the question is locked like an answered one.
- Last: a dashed-edge button "Esc" + "Cancel, same as No" (sends `Escape` through the keys route).
- Muted hint under the buttons: "Each button presses its number in the pane. Claude answers at once; no Enter."
- On press: all option buttons (and Esc) go aria-disabled while the request runs. After a 200 they stay aria-disabled **until the question changes** (a new `sig`) or the prompt is gone; echo "Sent 2 to %12". The panel leaves when a capture shows no prompt.
- Answer route results, in the problem line (`role="alert"`), exact copy:

| Response | Message | Buttons after |
|---|---|---|
| 200 | none (echo only) | disabled until the question changes |
| 409 `prompt-changed` | "The question changed; check the session." | disabled until the question changes |
| 409 `already-answered` | none | disabled until the question changes (it was answered already, by a double click or in a second window) |
| 409 `no-prompt` | "The question is gone." | re-enabled (the panel leaves with the next capture) |
| 409 `busy-switching` | "Another action is running on this session." | re-enabled |
| 400 (built amendment, task 14b) | "Answer this prompt in the terminal." | disabled until the question changes (the route refuses this prompt; a retry would get the same answer) |
| 429 | "Too many keys at once; try again." | re-enabled |
| 404 | "The session is gone." | re-enabled; the window then goes to its pane-gone state (§3.9), which removes the panel |
| 5xx, network error | "nika couldn't reach tmux." | re-enabled |

Rule: the buttons re-enable after any non-200 except `prompt-changed`, `already-answered` and 400.
- **Send, Shell and the lone Enter wait while a question is open** (built amendment 2026-11-09, task 14b). While a prompt is on screen, or the agent is "Needs you", the message box sends nothing: not a line, a paste, a Shell line or the Enter of an empty box (Enter would confirm the highlighted option). The text stays in the box and the problem line (`role="alert"`) says "Answer the prompt with the buttons above or in the terminal." while the panel shows an answer button, and "Answer the prompt in the terminal, or turn on Type into pane." when it shows none (a layout nika cannot parse), and "Answer this prompt in the terminal." for a prompt the capture marks `bypass` (Type into pane uses the keys route, which refuses Enter, digits and paste there). **(built amendment 2026-11-09 (0.3.3))** Enter and Shift+Tab in the message box send nothing either once nika has seen the prompt, and show the same line (Shift-Tab can pick "allow for this session"). The page knows a prompt only from its last capture (about half a second old: the page reads the pane every 250 ms and the server keeps a capture for 250 ms; older while the window is hidden), so a key pressed in that window can reach a prompt whose window does not mention bypass (security T26); Shift+Tab alone is also held back before the first capture and while the pane is gone or tmux fails, with the pane's reason ("Connecting to the pane…") for 3 s. Esc still goes (the No path), and ↑ ↓ from an empty box move Claude's highlighted option. A keys-route 409 `bypass-prompt` shows "Answer this prompt in the terminal."; a 409 `screen-unclear` (an unreadable footer whose window mentions bypass, such as a dialog nika does not parse) shows "nika can't tell what Claude is showing; use the terminal." Passthrough is the raw terminal path and is unchanged (it too posts to the keys route, so Enter, Shift-Tab, digits and paste there meet the same guard).
- Unknown layout (`prompt: null` while the status is "Needs you"): no buttons; the 0.2 note changes in 0.3 (built amendment, task 14b), because nika now blocks Enter there: "<name> needs you: <reason>. Answer it in the terminal, or turn on Type into pane (⌃] on a Mac, Ctrl+] elsewhere)." The gate now holds for every dialog nika cannot parse, not only bypass ones.
- Option labels can contain folder paths: shown in the app only, never logged.

Keyboard and focus: each button is a Tab stop (they are the main action while Claude asks). The panel appearing never moves focus; the live region says "builder-1 asks: Do you want to proceed? 4 choices above the message box." Ctrl+Shift+Tab from the message box reaches the Shell toggle (Shift+Tab in the box goes to Claude, §4.2); Shift+Tab from the toggle reaches the panel's Esc button, then the options. **(built amendment 2026-11-09 (0.3.3))**

### 9.6 Shell toggle (and the on/off rule)

Every on/off control shows its state in words as well as colour: a small `.onoff` chip ("on" / "off", 11 px 700, 1 px `currentColor` edge, `aria-hidden`) inside the button, next to `aria-pressed`. This applies to Shell and to the existing "Type into pane" toggle.

Shell: a 26 px toggle at the left edge inside the message box: `i-shell` (`$`) + "Shell" + chip.

| | Off | On |
|---|---|---|
| toggle | `--surface`, `--line-strong` edge, `--text-muted`, chip "off" | `--shell` fill, `--on-shell` text, chip "on" |
| message box | mode edge (§9.1), prompt sign "›" | 2 px `--shell` border instead of the mode edge, prompt sign "!" in `--shell` |
| placeholder | "Message builder-1…" | "Shell command for Claude's ! mode…" |
| notes row | — | "Shell on: Enter runs this through Claude's ! mode, then shell turns off." |

Ink is shell's own colour: it is not a mode hue, a status hue or the accent, and it matches the terminal look of the mirror. (Claude's own `!` mode border is pink, which would collide with Needs you.)

Sending in shell mode: `C-u`, then `!` + text, then `Enter` (spec §6.5). Shell turns **off after each successful send** (owner decision 2026-11-09), like Claude's `!` mode, so a following normal message can't run as a command. A failed send keeps Shell on and keeps the text (the 0.2 problem line says why), so a retry still goes as a command. Enter with an empty box does nothing in shell mode (no lone `!` is sent). Live region: "Shell mode on" / "Shell mode off".

The 2 px ink border replaces the 1 px border and the mode edge; the padding drops by 1 px so the text doesn't move. Focus keeps the ink border and adds a 2 px accent ring outside it:

```css
.inbox.shell-on { border: 2px solid var(--shell); padding: 5px 5px 5px 9px; box-shadow: none; }
.inbox.shell-on:focus-within { border-color: var(--shell); box-shadow: 0 0 0 2px var(--accent); }
.inbox.shell-on .prompt { color: var(--shell); }
```

While Shell is on, the command palette never opens (§9.7).

Keyboard: a Tab stop before the textarea; Enter or Space toggles and leaves focus on the toggle; the composer keeps its text.

"Type into pane" keeps its 0.2 behaviour (accent-soft when pressed, accent banner) and gains the chip.

### 9.7 Command palette

A list that opens above the message box (absolute, anchored to the box's left and right edges, opens upward, `--elev-2`, `--line-strong` edge, `--r-md`, max-height 360 px, scrolls).

Opens when the message box starts with `/` and the text after it has no whitespace (`paletteQuery`), or from the **Commands** button (`i-cmd` ghost icon button inside the box, before Send; `aria-label="Commands (/)"`; with an empty box it inserts `/` and opens; with text in the box it is aria-disabled, `title` "Empty the message box to pick a command"). **Never while Shell is on**: a `/` there is shell text, and the Commands button is aria-disabled with `title` "Turn Shell off to pick a command".

Anatomy: header row "**Commands**" + muted "6 match /co" on the left, key hints right (`↑ ↓` choose, `Enter` insert, `Esc` close); then `ul#palette[role="listbox"][aria-label="Commands"]` of `li[role="option"][aria-selected]`:

```text
┌──────────────────────────────────────────────────────────────┐
│▌/compact [instructions]                             Built-in │  name 600 mono, argument hint mono muted, source tag right
│ Summarize the conversation to free context                   │  description, muted, one line, ellipsis (full text in title)
│ /config [key=value]                                 Built-in │
│ Open settings; key=value sets one directly                   │
│ ▭ Opens a dialog in the terminal                             │  only when dialog: true; --idle, 600, i-dialog
└──────────────────────────────────────────────────────────────┘
```

- Source tag: "Built-in", "Personal" (`~/.claude`), "Project", "Plugin demo-tools". 11 px 600, `--surface-2`, `--line` edge, `--text-muted`.
- Active option: `--accent-soft` fill + 3 px `--accent` left edge; its description turns `--text`.
- Order: `rankCommands` (exact name match first, then name prefix, then name substring, then description), ≤ 50.
- **The first option is active on open and after every keystroke that filters**, so Enter always has a target while the list has one.
- Empty: "No command matches /xyz. Enter sends the text as typed." Loading: "Loading commands…". Error: "Couldn't load the command list. Enter sends the text as typed."
- **(built amendment 2026-11-09 (0.3.3))** The notes row (once the hint line) has no "/ commands" tip any more (the Commands button and the Keyboard shortcuts window name it). After insert, it shows the argument hint: "Arguments: [model]" (a textarea placeholder can't show it once there is text).

Keyboard (focus never leaves the textarea): ↑ ↓ move the active option (no wrap); Enter or Tab inserts `/<name> ` and closes; Esc closes and keeps the text (an Esc ladder step before "send Escape to the pane"); typing filters and makes the first option active again; a space closes it. Enter on an exact match inserts it like any other option (`/compact` + Enter gives `/compact `; a second Enter sends). With no match (empty list, loading or error), Enter sends the text as typed. Click inserts.

ARIA: the textarea gets `aria-controls="palette"` and, while an option is active, `aria-activedescendant`. Polite announcement on open and when the count changes (debounced 400 ms): "6 commands. Up and Down to choose, Enter to insert, Escape to close."

### 9.8 End-session dialog

Confirm dialog, 440 px (§3.6), opened from the quick-actions row, the dashboard row menu ("End session…") and, in 0.4, the graph node menu.

| State | Content |
|---|---|
| default | title "End builder-1's session?"; body "Claude exits and the pane closes. Resume later with Copy resume command."; footer Cancel (**initial focus**) · **End session** (danger, filled) |
| default, Claude working | as default + a muted line "Claude is working. nika presses Esc first to end the turn, then ends the session." |
| default, prompt open | as default + a muted line "Claude is asking a question. nika presses Esc first, which answers No." |
| ending | End session shows a spinner + "Ending…", `aria-busy`; Cancel aria-disabled; Esc does nothing (the `cancel` event is prevented); polite line "Waiting for Claude to exit…" |
| ended (`ended: true`) | dialog closes; toast "Session ended" (`role="status"`); the mirror shows the pane-gone overlay; focus goes to the screen `h1` (dashboard: the row's ⋯ button, or the `h1` if the row is gone) |
| failed (`ended: false`) | alert at the top of the body (`role="alert"`, `--danger-soft`, warn icon, 600): **"Claude didn't exit; use Stop or the terminal."**; with `reason: "keys"` (a key send failed, a rate limit say): **"nika couldn't send the keys; try again."**; focus moves to the alert; the footer has only Close |
| refused or error | same alert slot, fixed copy (never the server's text); footer Close. 409 `not-idle`: "Claude didn't stop after Esc; use the terminal." · 409 `mode-unknown`: "Claude's screen isn't at the prompt; use the terminal." · 409 `input-not-empty`: "Claude's input has a draft, so nika didn't type /exit. Send or clear it in the terminal, then try again." · 409 `input-unreadable`: "nika can't find Claude's input box, so it didn't type /exit. Close any menu in the terminal (Esc), then try again." (both drawn as a warning alert, `data-kind="warn"`, **built amendment 2026-11-09 (0.3.4)**; the other refusals stay `danger`) · 409 `not-at-prompt`: "Claude's input didn't take /exit; nothing was submitted." · 409 `busy-switching`: "Another action is running on this session." · 404: "The session is gone." · 5xx, network error: "nika couldn't reach tmux." |

"Copy resume command" lives in the dashboard row menu (§3.12). The session header has no menu in 0.3, so it is not added there; the body names the row-menu item as is.

**(0.3 build, 2026-11-09)** The dialog's **End session** button is `.btn.danger.fill` (danger, filled: `--danger` fill, `--surface` text, §2.8.2), defined once in `public/tokens.css` for both pages. The quick-actions **End session…** button and the Clear dialog's **Clear conversation** stay plain Danger (§3.1).

### 9.9 Dashboard row mode tag

- App tier only: a mode column after status, 128 px. The browser tier keeps the 0.2 grids. App-tier grids, per container width (`public/app.css` container queries):

```css
.row { grid-template-columns: 104px 128px minmax(232px, 1.5fr) 88px 64px minmax(0, 2fr) 56px 44px 32px; }
@container (max-width: 1010px) {   /* app tier; the browser tier switches at 860px. Status glyph, mode icon, name, context, what, age, ⋯ */
  .row { grid-template-columns: 22px 24px minmax(208px, 1.1fr) 56px minmax(0, 2fr) 52px 32px; } }
@container (max-width: 600px) {   /* what drops to line 2 under name */
  .row { column-gap: 6px; grid-template-columns: 22px 24px minmax(0, 1fr) 56px 40px 32px; }
  .row .c-what { grid-column: 3 / -1; grid-row: 2; }
  .row .c-act { grid-row: 1; grid-column: 5; } }
```

**(0.4)** The 64 px column after the model is the context meter (§3.19), on both tiers; in the narrow grids (≤ 860 px, in the app tier ≤ 1010 px) it is 56 px (the bar is hidden and the number stays), wide enough for the warn icon and a 3-digit percent ("⚠ 105 %" is 55 px). The app tier's wide grid needs 864 px (its floors add up to 748, plus 8 gaps of 12 and the 20 px padding), so it hands over to the narrow grid at 1010 px, where the `what` cell is still at least 147 px; with the narrow grid from 861 to 1010 px the rules of the 860 px block apply to the app tier. The browser tier has the same grids without the mode column
(`104px minmax(232px, 1.5fr) 88px 64px minmax(0, 2fr) 56px 44px 32px`, at least 137 px of `what`; ≤ 860 px `22px minmax(208px, 1.1fr) 56px minmax(0, 2fr) 52px 32px`; ≤ 600 px
`22px minmax(0, 1fr) 56px 40px 32px` with a 6 px column gap, age in column 4).

**(0.4 names)** The name column takes room from the `what` column: its floor is 232 px wide and 208 px at ≤ 860 px (app tier ≤ 1010 px), enough for a depth-3 name (`builder-2`) or a depth-2 sub-orchestrator row (`api-lead`) in full. The name cell (`.c-name`) is a size container: the role tag shows its long word ("orchestrator", "sub-orchestrator") only while the cell is at least 270 px wide and swaps to the short word ("orch", "sub-orch") below that, so the tag is whole or narrow, never clipped mid-word; the tag never shrinks, and `.name` keeps a floor of 9ch. The `what` cell (`.c-what`, also a size container) puts the text first. On every row the branch chip shrinks 100 times faster than the text, down to a floor of 10ch, and the branch chip and the "under <parent>" chip are not shown when the cell is 188 px or less. On a row that needs you the text never shrinks (it is cut at 60% of the cell, never below 14ch), and the project chip shrinks 100 times and the "under <parent>" chip 300 times faster than it; on every other row the project chip keeps its size. The project page puts its cards under the list at 1030 px or less (not 1000), so that its rows keep a 198 px name cell in the 600 px grid.

- The compact tag (§2.8.5). Rows without an eligible pane (ended, not in tmux) leave the cell empty. Attention rows keep their tint and left bar; the tag keeps its own fill on top.
- A "Needs you" row shows the held mode (the prompt covers the footer): hollow, dashed, its mode colour, "unconfirmed" in `.sr-only` and `title`. Never "Mode ?" unless nika has no reading at all (§2.8.6).
- ≤ 860 px container (app tier ≤ 1010 px): icon-only tag (24×24), next to the glyph-only status.
- Row SR text (§5.5) gains the mode after the status: "reviewer-2, Needs you: Asking to run a command, Accept edits mode, unconfirmed, model opus, demo-api, 4 minutes ago, pane %14". Confirmed: "Plan mode".
- Row menu: "End session…" for live agents with an eligible pane (opens §9.8).

### 9.10 Focus order and Esc ladder

Session window Tab order: skip links → back crumb → Open in claude.ai → Keyboard shortcuts → [Terminal / Transcript tabs when narrow] → transcript → [Transcript toggle, wide windows] → Dark/Light → Type into pane → [Leave, in passthrough] → mirror → [Jump to live, Retry now, when shown] → quick actions (1 stop) → [model popover while open] → prompt option buttons → prompt Esc → [question form: options, Other, Send answer / Answer / Submit answers / choice buttons, Decline / Reject (Esc), §9.16] → [attachment chips' remove buttons] → shell toggle → message box → [paste Clear] → Commands → Add attachments → Send → mode switcher (1 stop). Opening the session still focuses the message box (§4.2). In the message box Shift+Tab goes to Claude; Ctrl+Shift+Tab moves focus back to the shell toggle. **(built amendment 2026-11-09 (0.3.3))** The **Transcript** toggle (§4.7) sits between the transcript and Dark/Light, and only on wide windows. **(built amendment 2026-11-09 (0.3.4))**

Esc ladder (§4.3) gains two rungs, in this order: model popover or row menu → **palette** → dialog → B drawer → pane.

### 9.11 Responsive summary

| Width | Header | Switcher | Quick actions | Palette |
|---|---|---|---|---|
| ≥ 1000 | one line when it fits | under the message box, icon + word | labels, reason line under the row | full width of the message box |
| 760–999 | wraps | under the message box, icon + word | labels, may wrap; End stays right | same |
| < 760 | as 0.2 (labels of header buttons hidden) | under the message box, icon + word; the row wraps | Compact, Clear, Rewind icon only | same, source tags stay |

**(built amendment 2026-11-09 (0.3.3))**

### 9.12 Draft sync and the input-box cut (0.5, W5 and W6)

**(built 2026-11-14 (0.5).)** The message box and Claude's input box mirror each other, and Claude's prompt suggestion shows as the
message box's placeholder (W4, below). Contract: `api-app.md` (`draft` on the capture, `PUT /api/app/pane/:id/draft`,
`POST /api/app/pane/:id/suggestion`, and since W13 `POST /api/app/pane/:id/submit`); how the screen is read: `claude-tui.md` §10. Always on, no
setting (owner decision 2026-11-14). The logic that has no DOM is `public/draft-sync.js`; the wiring is `public/session.js`. **(built
2026-11-15 (0.5, W13).)** Send works while Claude works, the way the terminal does: the text goes into Claude's input and `Enter` is
pressed, and Claude queues the message and takes it at its next step (owner decision "Send now, like the terminal"; ADR 0019).

**What moves, and when**

| Direction | Rule |
|---|---|
| terminal → message box (a pull) | the screen's draft changed and the user has not typed here for 1.5 s, and nothing unsent is in the box. The caret stays where it was when the text only grew, else it goes to the end. Focus never moves. A pull does not count as an edit |
| message box → terminal (a push) | 250 ms after the last edit, one request in flight at a time, only text that fits (at most 1024 characters, 12 newlines, 13 rows); spaces and tabs at the very end are not pushed. While Claude works, replacing the text in Claude's input clears it with `End` and `C-u` (never `Escape`, which would interrupt the turn) when the cursor sits on the box's last row; with the cursor on an earlier row nothing is sent (the `Cursor` note below) |
| first readable capture of a window | pulls only into an empty box; text already in the box is kept and never wiped (it goes to Claude with the next edit or with Send) |
| typing in an IME composition | no pull and no push until the composition ends |
| both change | the box wins while the user types here; a terminal change that comes first (the push answers 409) wins, the box then shows the screen's text |
| Shell | Claude's `!` mode and the Shell toggle are one thing: a `!` draft turns Shell on with the text after the `!`, and Shell on pushes `!` + text (§9.6) |

**The cut (W6).** The mirror stops above Claude's input box, because the box is in the message box:

| Screen | Mirror rows | Strip |
|---|---|---|
| draft readable (`empty` or `text`), Type into pane off | the rows above the input box's top rule | one row at the bottom of the mirror: icon `i-kbd` and the words "Input box · mirrored in the message box below", muted in the terminal grey (`--a8`) with a dashed top edge, not focusable, `aria-hidden` (the message box carries the content) |
| draft unreadable | every row | none: the user must see `[Pasted text #4]` or the history entry; the paused note says what to do |
| no plain box (a permission prompt, a dialog, an unknown footer) | every row | none |
| Type into pane on | every row | none (the user types into the real box) |
| capture without a `draft` (an older server) | every row | none |

The header keeps the pane's real size ("Live · 120 × 39"). The cursor is not drawn when its row is cut. Auto-scroll and Paused are
unchanged.

**The note under the box.** One note at a time in the notes row (`#draft-note`, a polite `role="status"` region, referenced by
`aria-describedby` of the message box). Each kind has its own colour, icon and word (the visible-state rule of §9.6):

| Kind | Icon | Colour | Words | When |
|---|---|---|---|---|
| paused | `i-pause` | `--idle` on `--idle-soft` | **Sync paused:** Claude's input holds <reason>. Edit or clear it in the terminal. | the screen's draft is unreadable; nothing is pulled or pushed, and nika never writes over it |
| long | `i-info` | `--text` on `--surface-3` | **Not mirrored:** Long text goes to Claude when you send it. | unsent text that does not fit Claude's box, or that the server refused as too long |
| hold | `i-dialog` | `--attn` on `--attn-soft` | **On hold:** A prompt is open or Stop is running. Your text goes into Claude's input when that is over. | the last write was refused with 409 `not-idle` (a permission prompt or dialog is open, or a Stop or End interrupt runs); tried again every 3 s |
| cursor | `i-window` | `--fit-other` on `--fit-other-soft` | **Cursor:** Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or wait: your text goes in when Claude waits. | the last write was refused with 409 `cursor-not-at-end`: Claude is not idle, its cursor is on an earlier row of its box, and only `Escape` could clear that (it would interrupt the turn); tried again every 3 s |
| queued | `i-send` | `--busy` on `--busy-soft` | **Queued:** Claude takes your message at its next step. | both boxes are empty and in sync and Claude's box shows its queued-messages placeholder (`draft.queued`, `api-app.md`): Claude holds a message nika sent while it works. Never together with the suggest note (Claude's queued placeholder is no suggestion) |
| suggest | `i-kbd` | `--accent` on `--accent-soft` | **Suggestion:** Tab or → accepts what Claude suggests. | the message box and Claude's input box are in sync, both empty, and Claude's box shows a prompt suggestion (below) |

The reasons: `pasted` "a pasted block nika can't read back"; `tall` "a draft longer than 14 rows"; `trailing` "text that ends in
spaces"; `history` "a prompt-history entry"; `layout` "text nika can't read back exactly" (a row shape nika does not know, or a wrap that could be read two ways: a word cut at the box width looks the same as two long words with a space between them, and nika does not guess). While paused the message box stays
editable and Send obeys the table below. The arrow keys of an empty box still go to the pane (0.3.3): `Up` in the terminal
recalls history, which pauses the sync and says why.

The page decides "fits" with a twin of the server's envelope check (at most 1024 characters, 12 newlines, 13 estimated rows at the
pane's width, no control character but newline and tab; `public/draft-sync.js` `fits`, asserted equal to `src/draft.js` by
`test/draft-sync.test.js`), so a text the page pushes is never refused by the server as too long.

**Claude's prompt suggestion (W4).** After a turn Claude can draw a suggestion for the next prompt as dim text in its empty input box
(`claude-tui.md` §10.10). The message box shows it and takes it with one key.

- *Placeholder.* While the message box is empty, Shell is off and the screen's draft is a readable, empty prompt box with a
  `suggestion` (`suggestionFor` in `public/draft-sync.js`), the box's placeholder is that suggestion instead of "Message <name>…".
  Shell on, text in the box (one space counts), a paused draft or no plain box on screen: "Message <name>…" (Shell: "Shell command
  for Claude's ! mode…"). A disabled box keeps its own placeholder.
- *Look.* The box gets the class `suggest`: `.inbox.suggest textarea::placeholder` is `--accent`, italic, opacity 1, so the
  suggestion reads as Claude's text and not as the muted "Message …" hint; and the note kind `suggest` (table above) says in words and
  an icon what accepts it. Colour is never the only cue. Contrast: the table of §5.1 already holds both pairs, `--accent` on
  `--surface` (6.04:1 at the lowest) and `--accent` on `--accent-soft` (5.20:1 at the lowest), both above 4.5:1 in every theme.
- *Accept.* A bare Tab or → in the empty box while a suggestion shows (`composerKey` returns `accept`; Ctrl, Shift, Alt and Meta
  variants keep their meaning, and a palette option that is active still takes Tab first). A held key accepts once. The page calls
  `POST /api/app/pane/:id/suggestion { text }` with the suggestion it shows, in the keys chain, so arrows typed just before go
  first; nika sends no Tab of its own and posts nothing when its own copy is already stale. On 200 the box takes Claude's text with the
  caret at its end (a box the user typed into meanwhile keeps its text: nika wins while the user types here), the problem line clears
  and the echo says "Accepted Claude's suggestion: <text>". The note is a polite `role="status"` region, so a screen reader hears
  "Suggestion: Tab or → accepts what Claude suggests." each time a suggestion appears.
- *Without a suggestion* Tab keeps moving focus and → keeps going to the pane as an arrow key (empty box) or moving the caret (text).
- *Send* with an empty message box that shows a suggestion is still `Enter` alone (table below). What Claude submits then is not
  verified (`claude-tui.md` §10.11).
- *Failed accept.* The line is fixed copy chosen by the status and the code, never the server's text, in the problem slot:

| Answer | Line |
|---|---|
| 409 `draft-mismatch` | "Claude's input did not take the suggestion. nika shows what it holds now." |
| 409 `draft-changed`, or the page's own copy already stale | "Claude's suggestion changed. Nothing was sent." |
| 409 `draft-unreadable` | the paused line above ("Claude's input holds <reason>. Send or clear it in the terminal.") |
| 409 `not-idle` | "Claude is busy or a prompt is open, so nika can't accept the suggestion now. Nothing was sent." |
| 409 `input-unreadable`, `mode-unknown` | "nika can't read Claude's input box right now (a menu may be open). Nothing was sent." |
| 409 `busy-switching` | "Another action is running on this session. Try again in a moment." |
| 400 | "nika can't accept this suggestion." |
| 404 | "The session is gone." |
| 429 | "Too many keys at once; try again." |
| no answer | "nika did not answer." |
| anything else | "nika couldn't accept the suggestion." |

A refusal that carries a `draft` is adopted like any other 409 of the sync (the terminal wins); the suggestion then follows the screen.

**Send** (after the permission-prompt gate of §9.5; the text is the message box's, Shell adds its `!`). Claude working does not gate Send:
Claude queues the message. Every Send ends in one `Enter` through `POST /api/app/pane/:id/submit` (W13), never the keys route: the server
presses it only on a fresh screen that shows neither a permission prompt nor a dialog and, with `base` (the `sig` of Claude's input the page
last saw or just wrote), only while Claude's input still reads that. What "Enter" means in the table is that guarded Enter:

| Message box | Claude's input box | What Send does |
|---|---|---|
| any | readable, same text | `Enter` alone |
| empty | anything | `Enter` alone (Shell on with an empty box does nothing, §9.6) |
| text that fits | readable, different | copies the text into Claude's input first (`PUT …/draft`), then `Enter` against the `sig` of that write; a copy that fails sends no `Enter` and shows its line, and the text stays |
| text that does not fit | readable and empty (prompt mode) | as before 0.5: one paste, then `Enter` |
| text that does not fit | readable with other text | refused: "Claude's input already holds text; it would be sent together with yours. Clear it in the terminal or shorten your message." |
| text | unreadable | refused: "Claude's input holds <reason>. Send or clear it in the terminal." |
| text | no plain box, footer known | as before 0.5 (the paste or Shell path through the keys route, which types the text), then the guarded `Enter` with no `base` |
| text, Shell text, or an empty box | no plain box and the footer unknown (a menu, Claude's agent list, the shells pill) **(0.5, F1)** | refused before any key: "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." (for an empty box the line ends at "Nothing was sent.") The legacy road would type the text before the submit route could refuse, and a typed key there leaves the pill or runs as a message (`claude-tui.md` §1). Shell on with an empty box still does nothing (§9.6) |
| any, attachments in the tray | readable | the text is copied as above, then `POST /api/app/pane/:id/attach-send` pastes the files and presses its own `Enter` (§9.14) |

nika never clears Claude's draft to make room for a long message (owner decision 2026-11-14). The problem lines of a failed copy are
fixed copy chosen by the status and code, never the server's text, in the `role="alert"` slot, with the text kept:

| Answer | Line |
|---|---|
| 409 `draft-changed`, `screen-changed`, `draft-mismatch` | "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent." |
| 409 `draft-unreadable` | the paused line above, with "Send or clear it in the terminal." |
| 409 `not-idle` | "A prompt is open in Claude or Stop is running, so nika can't change its input now. Nothing was sent. Your text is kept." |
| 409 `cursor-not-at-end` | "Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or send when Claude waits. Nothing was sent. Your text is kept." |
| 409 `clear-stopped` | "Claude's input did not clear in time. Nothing was sent. Your text is kept; send again." |
| 409 `input-unreadable`, `mode-unknown` | "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." |
| 409 `busy-switching` | "Another action is running on this session. Try again in a moment. Your text is kept." |
| 400 | "This text can't be copied into Claude's input as it is. Your text is kept." |
| 404 | "The session is gone." |
| 429 | "Too many keys at once; try again. Your text is kept." |
| no answer | "nika did not answer. Your text is kept." |
| anything else | "nika couldn't copy your text into Claude's input. Your text is kept." |

A background push that fails says its line once (a warning for 6 s): "nika did not answer. Your text is kept." or "nika couldn't
copy your text into Claude's input. It is kept here."; after three failures it stops until the next edit. The Send echo for a copied
message reads "Sent 23 characters + Enter to %12" ("Sent a shell command (23 characters) + Enter to %12" with Shell on).

**When the Enter does not go (W13).** The lines are fixed copy chosen by the status and the code of the `submit` answer, in the
`role="alert"` slot, with the text kept:

| Answer | Line |
|---|---|
| 409 `prompt-open` | "A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept." |
| 409 `bypass-prompt` | "Answer this prompt in the terminal." |
| 409 `not-idle` | "Stop is running, so nika did not press Enter. Send again in a moment. Your text is kept." |
| 409 `draft-changed` | "Claude's input changed before Enter. nika shows what it holds now. Nothing was sent." |
| 409 `screen-unclear` | "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept." |
| 409 `suggestion-shown` | "Claude's input is empty and shows a suggestion, so nika did not press Enter. Nothing was sent." |
| 409 `input-unreadable`, `mode-unknown` | "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." |
| 409 `busy-switching` | "Another action is running on this session. Try again in a moment. Your text is kept." |
| 200 with `taken: false` | "nika pressed Enter, but Claude's input still shows your text (a menu may have taken the Enter). Check the terminal. Your text is kept." |
| 404 | "The session is gone." |
| 429 | "Too many keys at once; try again. Your text is kept." |
| no answer | "nika did not answer, so it is not known whether Enter was pressed. Check Claude's input in the terminal. Your text is kept." |
| anything else | "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept." |

A 200 with `taken: true` or `null` clears the message box (a `null` pulls back from the screen anything still in Claude's input; nothing is
lost). The echo of a message that Claude queued while it works reads "Queued for Claude: 23 characters + Enter" (a screen reader hears
it; the visible cue is the `Queued` note). While Claude holds a queued message, the Stop button's title reads "Stop ends Claude's current
step. Your queued message then goes to Claude at once." (`public/quick-actions.js`, only while `draft.queued`).

### 9.13 Fit: the mirror fills the panel (0.5, W7)

**(built 2026-11-14 (0.5).)** The session window measures its terminal panel in cells and asks the server to make the mirrored
pane that size. Contract: `api-app.md` (`PUT` and `DELETE /api/app/pane/:id/fit`); the lease and what is safe: ADR 0017 and
`docs/security.md` T52. Always on, no setting (owner decision 2026-11-14). The logic that has no DOM is `public/fit-ui.js`; the
wiring is `public/session.js`. App tier only. The window can change the user's tmux window, so it says so: the chip below, which since F1 is a button that opens a panel with the reason and, where it helps, Fit again.

| What the user sees | When |
|---|---|
| the pane has the panel's size: the mirror shows it with no scrolling and no scaling | `fitted`: nika sized the tmux window to the panel (a window with several panes is also zoomed on this pane) |
| the pane is zoomed in its tmux window and keeps its own size; the text is drawn smaller | `zoomed`: the panel is smaller than a window with several panes, and resizing would squeeze them |
| the pane keeps the size the user's terminal gives the tmux window (nika resizes nothing); the text is drawn smaller when the pane is larger than the panel | `terminal` (0.5, F4): a terminal shows the tmux window; a window with several panes is also zoomed on this pane |
| the pane keeps its real size (text scaled when it is larger than the panel) | `blocked` or `other`: nika changed nothing |

The tmux window is given back when this window closes, 15 s after the page goes quiet, or on the first change the user makes in
tmux (unzoom, move, split, kill, resize; nika sees it within one second, and the restore follows within tens of milliseconds). After
such a change nika does not fit again until the session window is opened again or the user presses Fit again in the chip's panel.
A split or an exit of nika's own agent pane (a pane tagged `agent` or `sub-orchestrator`) is not a change of the user's (0.5, F2): nika
gives the window back and fits it again within about a second, and the chip stays as it was ("When nika's own agents come and go", below).
A terminal that starts or stops showing the window, or resizes it, is not a change of the user's either (0.5, F4): while a terminal shows the
window the chip reads "Fit · your terminal's size" and nika resizes nothing, and it sizes the window to the panel again only after no terminal
has shown it for 30 seconds ("When a terminal shows the window", below).

**Measuring the panel** (`panelSize`)

| Part | Rule |
|---|---|
| probe | `#fit-probe` inside `.term`: 100 zeros in the unscaled terminal font (`var(--fs-term)/1.35 var(--mono)`, `white-space: pre`), `aria-hidden`, hidden and off to the left. One cell is the probe's width / 100 wide and its height tall |
| box | the `.term` client box minus its padding: 12 px left and right, 10 px top and bottom (`PAD_X` 24, `PAD_Y` 20) |
| size | `cols = floor((width − 24) / cellW)` clamped to 40–400, `rows = floor((height − 20) / cellH)` clamped to 10–200. Nothing is asked while a number is missing or not positive (a hidden tab keeps the last good size). The cut strip of §9.12 is not subtracted |
| when | a `ResizeObserver` on `.term` (the app's zoom changes the box too) and `document.fonts.ready`; the request follows 250 ms after the last change; an unchanged size is not asked for |

**Text scale** (`scaleFor`). `scale = min(1, panelCols / paneCols, panelRows / paneRows)` from the capture's size, clamped to
`SCALE_MIN` 0.4 below and **never above 1** (owner decision, Q2: a pane smaller than the panel stays at its real size; the app's own
zoom, Cmd or Ctrl + and −, makes text larger). It is `--fit-scale` on `.term`, set with `style.setProperty` (the CSP allows no
style attribute). `.term-rows` uses `font-size: calc(var(--fs-term) * var(--fit-scale, 1))`; `ch` and the row height are em-based, so
the pane's grid stays exact. Below 0.4 the text stops shrinking and the terminal scrolls, as before. The header keeps the pane's
real size ("Live · 120 × 39", §9.12).

**The chip.** `#fit-chip`, a button inside `#fit-wrap` since F1 (the panel below), sits in the terminal header after "Live · C × R". It follows the rule of §9.6: colour, icon and words,
never colour alone. It is hidden (its wrapper is) until the first 200 answer, and again after the window gives the lease back or a 403. The header
wraps (`flex-wrap`) when the chip does not fit, so the window never scrolls sideways. A state change is announced once (polite,
`announce()`) as "Fit: <words>. <title>".

| `state` | Icon | Text / fill / edge | Words | `title` (hover) |
|---|---|---|---|---|
| `fitted` | `i-fit` | `--accent` / `--accent-soft` / `--accent-line` | Fit · fills the panel | nika sized the tmux window to this panel and puts it back when this window closes |
| `zoomed` | `i-zoom` | `--idle` / `--idle-soft` / `--idle-line` | Fit · zoomed, text scaled | Other panes in this tmux window would be squeezed, so nika zoomed the pane and scaled the text |
| `blocked` | `i-off` | `--text-muted` / none / dashed `--line-strong` | Fit · off | the reason below; "nika is not fitting this tmux window" for a reason the page does not know |
| `other` | `i-window` | `--fit-other` / `--fit-other-soft` / `--fit-other-line` | Fit · another window | Another nika window shows a pane of this tmux window |
| `terminal` (0.5, F4) | `i-term` | `--fit-term` / `--fit-term-soft` / `--fit-term-line` | Fit · your terminal's size | A terminal shows this tmux window, so nika leaves its size to the terminal and scales the text to this panel (two titles, below) |

The words of the `blocked` chip are always "Fit · off"; the reason is its `title`, picked from a fixed table (the page never shows
a string of the server):

| `reason` | `title` |
|---|---|
| `user-zoom` | You zoomed another pane in this window; nika leaves it |
| `size-option` | This tmux window has a window-size setting nika does not change |
| `foreign-tag` | Another program marks this tmux window |
| `changed` | The tmux window changed while nika was fitting it, so nika put it back |
| `user-change` | You changed this tmux window, so nika put it back |

The `terminal` chip has two titles (0.5, F4), chosen by `chipView` from the answer's `panes` and `userZoom` (read as data, never shown): with
one pane, or when the pane is the one the user zoomed, "A terminal shows this tmux window, so nika leaves its size to the terminal and scales
the text to this panel" (chip key `terminal:`); with an integer `panes` above 1 and a `userZoom` that is not `true`, nika zoomed the pane, and
the title is "A terminal shows this tmux window, so nika only zoomed this pane, leaves the size to the terminal and scales the text to this
panel" (key `terminal:zoom`). A `reason` on `terminal` is ignored (the server sends `null`), and the zoom sentence is not in the reason table
above, so a server reason can never select it.

Each state has its own colour (owner decision, Q5), so `other` has its own cerulean pair of tokens in `tokens.css`, used by this chip
only (light `#0f68a2` on `#ddf2ff`, edge `#3786c3`; dark `#4abce9` on `#0e2a36`, edge `#1c8cb4`): text on its fill 5.17:1 (light)
and 6.89:1 (dark), edge at least 3.5:1, and an OKLab distance of at least 0.05 to every status and mode hue (asserted by
`test/session-ui.test.js`). `blocked` keeps the muted grey on a dashed edge, so the five chips differ in icon, words, edge and hue.

`terminal` (0.5, F4) has its own plum triple in `tokens.css`, used by this chip only: `--fit-term`, `--fit-term-soft` and `--fit-term-line` (light
`#8b3f6b` on `#f8e8f1`, edge `#b96a98`; dark `#d9a6c8` on `#35222f`, edge `#a8789b`, the same in both dark blocks). Measured with the formulas of
the `--fit-other` test: text on its fill 5.89:1 (light) and 7.20:1 (dark); the text over its fill and `--surface`, `--bg`, `--surface-2`,
`--surface-3` and `--attn-row` at least 5.60:1 (light) and 6.02:1 (dark); the edge over `--bg`, `--surface` and `--surface-2` at least 3.39:1
(light) and 3.95:1 (dark); the nearest other chip, status or mode colour in OKLab is `--attn` at 0.085 (light) and `--m-dontask` at 0.062 (dark),
above the 0.05 floor. The icon (`i-term`, a frame with a prompt, unlike `i-hist-off`) and the words carry the state, so colour is never the only
cue. `test/session-ui.test.js` asserts the tokens, the contrast and the distances.

**The panel (0.5, F1; owner request 2026-11-15).** The chip is a button, and in every state (fitted and zoomed too): the reason was a `title` and one
announcement, which a keyboard or touch user never reads, so it now has a place to be read, and where `open: true` can help the panel offers the way
back. Markup: `span#fit-wrap.fit-wrap` (hidden while there is no chip, so the panel can never show without it) holding `button#fit-chip.fit`
(`type="button"`, `aria-expanded`, `aria-controls="fit-pop"`, `aria-label` = the state's label such as "Fit: off"; inside: the icon, the words, and a
chevron `i-chev` that turns 180° while the panel is open) and `div#fit-pop.pop.fit-pop` (`role="group"`, `aria-labelledby="fit-pop-h"`): the heading
`p#fit-pop-h` (the label), `p#fit-pop-why` (the state's `title`, the reason sentence), `p#fit-pop-hint` (the hint, and a `code` line where there
is one), `p#fit-pop-note` (the note, below), and a footer with `button#fit-pop-close` "Close" and `button#fit-again.btn.primary`
(`aria-describedby="fit-pop-why"`, so it is read with its reason). `fitPanelView(view, ui)` in `public/fit-ui.js` is pure; the hint, the code and
the action are looked up by the chip's key, never by a word of the server.

| Chip key | Hint | Code (text only) | Action |
|---|---|---|---|
| `fitted` | none | none | none |
| `zoomed` | "To fill the panel without scaled text, make this window larger or hide the transcript (Ctrl+Shift+H)." | none | none |
| `blocked` / `user-change` | "Fit again turns the fit on once more. After a change of your own nika stays off until you ask." (reworded in F4: Fit again over a window a terminal shows lands on `terminal`, so it no longer promises a size) | none | **Fit again** |
| `blocked` / `changed` | "Fit again tries once more." | none | **Fit again** |
| `blocked`, no or unknown reason | none | none | **Fit again** |
| `blocked` / `user-zoom` | "Unzoom it in tmux (prefix, then z) and nika fits the window by itself." | none | none |
| `blocked` / `size-option` | none | none | none |
| `blocked` / `foreign-tag` | "If no other nika runs, clear the mark in that tmux window, then nika fits it by itself:" | `tmux set-option -wu @nika-fit` | none |
| `other` | "The other nika window stops fitting it." | none | **Fit here** |
| `terminal` (key `terminal:`) | "When no terminal has shown this tmux window for 30 seconds, nika sizes it to this panel by itself. Switch your terminal to another window or detach it to get there." | none | none |
| `terminal` with several panes that nika zoomed (key `terminal:zoom`) | "Your terminal shows this pane zoomed too, until this session window closes. When no terminal has shown the tmux window for 30 seconds, nika sizes it to this panel by itself." | none | none |

No action for `user-zoom`, `size-option` and `foreign-tag`: `open: true` changes nothing there (the server refuses again), so a button would only
fail; `user-zoom` and `foreign-tag` recover on the next heartbeat once the user acts in tmux. "Fit here" says that this window takes the tmux window
over from the other nika window, which "Fit again" would not. `terminal` has no action either (0.5, F4): `open: true` cannot override the terminal
rule, a request would land on `terminal` again. The 30 seconds in its two hints are typed text; they are the server's `GROW_MS`, and `PANEL` in
`public/fit-ui.js` changes with it.

Words: the button's name and the panel's heading are the state's label ("Fit: fills the panel", "Fit: zoomed, text scaled", "Fit: off", "Fit: another
window", "Fit: your terminal's size"); the actions read "Fit again", "Fit here" and, while a request is on its way, "Fitting…" (the button gets `aria-disabled="true"`, not
`disabled`, so focus stays on it); the footer's other button is "Close"; the note reads "nika could not fit the window just now. It tries again
within 5 seconds." (with the `i-warn` icon, in the `--idle` colour; there is no `--warn` token).

| When | What happens |
|---|---|
| click, Enter or Space on the chip while closed | the panel is drawn and placed (absolute under the chip, so opening never changes the terminal box and never fires a fit request; `placeMenuX` keeps it inside the window, right-aligned to the chip by default, `data-x="start"` left-aligned); focus goes to Fit again when it is shown, else to Close |
| click on the chip while open, Esc (inside the panel or on the chip; it never reaches the page's handlers), or Close | closes; focus goes to the chip |
| Tab out of the chip and the panel, or a pointer down outside the panel and the chip | closes; focus stays where it went |
| the window is resized | closes; focus goes to the chip if it was inside the panel |
| a new chip state while open | the panel is drawn again in place (announced once by the chip as before); focus stays, unless the focused action has just gone: then Close |
| the chip hides (a 403, the window given back, the pane gone) | closes; focus goes to the transcript button if it was inside |
| Fit again (click, Enter or Space; ignored while `aria-disabled`) | the page's next request is `open: true`; the button reads "Fitting…" |
| the answer is 200 with `fitted`, `zoomed` or `terminal` | the panel closes; focus on the chip; the chip announces its state |
| 200 with `blocked` or `other` and a new key | the panel stays, drawn again; the chip announces its state |
| 200 with the same key as before | the panel stays; "Fit is still off. <title>" is announced |
| any other status, or no answer | the note shows, the button is enabled again; the planner asks `open: true` again at the next beat; the note is announced |
| 403 | everything stops; the chip hides and focus goes to the transcript button |

**Keyboard and accessibility.** Tab order: transcript button, the chip, then, with the panel open, Close and the action (DOM order), then the colour
buttons. No new shortcut. The button is at least 24 px high (2.5.8); the focus ring is the page-wide `:focus-visible` rule. Both themes use the same
tokens as the chip; the primary action is the existing `.btn.primary`. At ≤ 760 px the header wraps as before (the chevron adds 14 px) and the panel
stays on screen. States: no chip before the first 200 answer (no button, no panel); fitted, zoomed and terminal open an information-only panel; a blocked state
with an action shows heading, why, hint, Close and the action; pending shows "Fitting…"; a failed ask shows the note under the hint.

**When the page asks** (`createFitPlanner`; one request at a time, the newest size wins)

| Event | Request |
|---|---|
| the first capture answers (the pane is live) | `PUT { open: true }`, repeated until one is answered 200; every later request is `open: false`, also after `blocked / user-change` and `blocked / changed`, until the user asks (next row) |
| the user presses Fit again or Fit here (F1) | `PUT { open: true }` at once: a waiting heartbeat is cleared and the beat re-armed, and a request in flight finishes first, then this one goes out. A refused or lost ask is tried again by the next beat, again with `open: true`; later requests are `open: false` once one is answered 200. Not before the first capture, not after the pane is gone or a 403, and not while an ask is pending |
| the panel changes size | `PUT { open: false }` 250 ms after the last change |
| every 5 s | `PUT { open: false }` with the current size (the beat: the server lets a lease lapse after 15 s without one) |
| the window is shown again (`visibilitychange`) | one `PUT` at once: timers may have been suspended and the lease may have lapsed |
| the window closes or leaves the page (`pagehide`) | one `DELETE` with `keepalive: true` |
| the capture answers 404 (the pane is gone) | one `DELETE`; the beats stop. If the pane comes back, the lease is asked for again with `open: false` |
| the page returns from the back/forward cache (`pageshow`, `persisted`) | it measures again and sends `PUT { open: true }` |
| 403 | everything stops for good and the chip is hidden |
| 404, 409, 429, 502, 503, any other status, no answer | nothing now; the next beat asks again |

**With the rest of the window.** A resize re-wraps Claude's input box, so the server changes the tmux window under the pane's control
lock: a draft push that meets a fit step gets 409 `busy-switching` and the draft sync pushes again about 300 ms later (§9.12). The
next capture after a resize carries the new size, rows and `draft.box`, so the cut strip follows. Spawning an agent from the app's sheet
into a tmux window that is fitted gives the window back first, and the page fits it again, with the new pane count, on its next beat. An
agent that the orchestrator starts with `nika spawn` splits into the fitted window on its own (another process, no release first), and
since F2 the watch fits the window again within about a second.

**When nika's own agents come and go (0.5, F2; owner decisions 2026-11-15).** An orchestrator starts agents and its agents end, all in the
window that is fitted, so a fit that turned itself off at the first split would be off most of the time. The server therefore tells nika's
own panes from the user's by the pane tag `@nika-role` that the spawn sets (`agent` or `sub-orchestrator`; anything else, the orchestrator's
`orchestrator` included, counts as the user's). What the user sees:

| Event (window fitted for the orchestrator's pane) | Before F2 | Now |
|---|---|---|
| The orchestrator runs `nika spawn …` (CLI; split beside it) | restored, chip "Fit · off", off until the session window reopens | restored and fitted again within about a second; chip unchanged (or "zoomed" on the next beat, when the panel is smaller than the window with the new pane) |
| Spawn from the app's sheet into that window | released before the split, fitted again on the next beat | same (unchanged) |
| An agent's claude ends and its pane closes | off (pane count changed) | fitted again |
| A sub-orchestrator's agents split beside it (its own session window) | off | fitted again |
| The user splits, unzooms, switches pane, resizes, closes a pane of their own | off | off (unchanged; Fit again in the panel) |
| The user closes an agent's pane by hand | off | fitted again (counted as nika's; a residual, `docs/security.md` m) |
| The user splits in the same second as a nika spawn | off | off (the user's pane has no agent tag) |

A new pane that has no tag yet gets one watch tick (about a second) to be tagged, because the spawn tags it right after the split; if it is
still untagged then, it was the user's. Nothing about this shows on the page except the window being fitted again: no new chip, word or
announcement, and a user who turned the fit off (any change of their own) is not fitted again behind their back.

**When a terminal shows the window (0.5, F4; owner ruling 2026-11-16).** A terminal attached to the tmux window that the session window mirrors
used to get the window resized to the panel, with dots around it. Now nika does not resize a window that a terminal shows: any terminal client of
that window counts (a plain terminal, control mode, `ignore-size`, read-only; `docs/security.md` T52). It zooms the pane when the window has
several panes, keeps the lease, and the page scales the text as it does for `zoomed`. One chip, "Fit · your terminal's size", covers one pane and
several; its title says "only zoomed this pane" when nika zoomed the pane. What the user sees:

| Situation | Before F4 | Now |
|---|---|---|
| One pane (the orchestrator), the user's terminal shows it, the panel is 112 × 21 | the window is resized to 112 × 21 (`window-size manual`), dots in the terminal | nothing is resized (the tag only); chip "Fit · your terminal's size"; the mirror shows the terminal-sized pane scaled (a 200 × 50 pane in 112 × 21 draws at 0.42×; below 0.4× the text stops shrinking and the panel scrolls) |
| Several panes, a terminal shows the window | zoomed and resized; dots | zoomed only (the terminal shows the pane zoomed too); chip `terminal`, title "only zoomed this pane" |
| No terminal shows the window | fitted or zoomed | the same |
| The terminal switches to a window nika resized | dots until the session window closes | dots for up to about a second, then the window takes the terminal's size; the chip reads `terminal` on the next beat (within 5 s) |
| The terminal resizes while it shows the window | a user change for a zoom-only lease: the fit is off | nothing: the window follows the terminal, the chip stays `terminal` |
| The terminal leaves (switches window, detaches) | | `terminal` for 30 s more, then "Fit · fills the panel" (or "Fit · zoomed, text scaled") |
| The terminal comes back within 30 s | | still `terminal`; the 30 s start over the next time it leaves |
| The user unzooms in their terminal | off (a user change) | off (a user change, unchanged); Fit again lands on `terminal` |
| The session window closes while the terminal shows the window | the window was resized back (a frame of dots) | the terminal gets the window back unzoomed; nothing is resized back |

Shrink at once, grow after 30 s: a window does at most one grow and one shrink per 30 s. A size nika set is still a user change when someone else
changes it (no terminal can resize a `manual` window).

Not built: a settings switch, a per-project option, anything on the browser tier, a fit that re-asserts after the user changed the
window, taking over a pane the user zoomed, a countdown of the 30 s on the page, a setting for that delay, a fit that overrides the terminal rule.

### 9.14 Attachments (0.5, W2)

**(built 2026-11-14 (0.5); the file chooser 2026-11-15.)** The message box takes images, PDFs and text files. They go with the next
Send, and nothing reaches Claude before it. Contract: `api-app.md` (`POST …/attachments`, `DELETE …/attachments/:id`,
`POST …/attachments/pick`, `POST …/attach-send`); how Claude shows them: `claude-tui.md` §11; ADR 0016. The logic that has no DOM is
`public/attach.js`; the wiring is `public/session.js` (`sendComposer`). App tier only. Always on; the one setting is how long nika
keeps its copies (Settings, section "Attachments", "Keep attachments for N days", 1 to 30, default 7).

**Ways in**

| Way | Rule |
|---|---|
| **Add attachments** (the paperclip, right of Commands) | The page opens no file input of its own: the webview's freezes the app on macOS. It asks the server, which asks the desktop shell for its native dialog. While the dialog is open the button is busy (dashed `--busy` edge, a spinner in place of the clip, the name "Choosing files…", and the line "Choose files in the system dialog…" beside the tray: colour, icon and words). The page asks again every 300 ms; the picked files come back already stored, as ready chips (or failed ones with the reason). The room asked for is 6 minus the chips; a full tray says "Up to 6 attachments per message." and asks nothing |
| paste in the message box | files on the clipboard (a screenshot, a copied file) are added and the paste is cancelled; text alone pastes as before |
| drop on the message box | the box gets a dashed `--accent` edge and the words "Drop to attach"; a drop anywhere else is cancelled, so the window never opens the file; with a Send out or input off there is no drop look and the drop effect is "none" |

Per message: 6 files, 8 MB each. A bigger file becomes a failed chip ("Too big · max 8 MB") and is never read or uploaded. Over six:
"Up to 6 attachments per message." (warning, 4 s). While a Send is out or input is off: "Wait until the attachments have gone, then add
more." (warning, 4 s). Uploads go one at a time; a 429 is tried once more after 1 s.

**The chip** (`li.att`, text by `textContent` only): icon, name (ellipsis at 200 px, the full name in `title`), meta, remove button (24 × 24,
"Remove <name>"). Colour never travels alone.

| State | Icon | Meta | Look | Announced (polite) |
|---|---|---|---|---|
| uploading | spinner | "Uploading…" | `--surface-2` fill, `--line` edge, `aria-busy` | — |
| ready | `i-image`, `i-file` (PDF) or `i-text` | the size: "820 B", "14 KB", "1.2 MB" | `--surface-2` fill, `--line` edge | "Attached <name>, <size>." |
| failed | `i-warn` in `--danger` | the reason (below) | `--danger-line` edge, no fill | "<name> can't be attached: <reason>." |
| Gone (after a send said the file is no longer on disk) | `i-warn` | "Gone" | as failed | — |
| any, while a Send is out | as before | as before | the tray is `aria-busy`, the remove buttons `aria-disabled` | — |

Removing: the × on a ready chip deletes the file at once; on an uploading chip it marks the file to be deleted when the upload answers;
a failed chip just goes. Focus moves to the next chip's remove button, else the previous one, else the message box. Announced "Removed
<name>." Closing the window deletes the files of ready chips (`pagehide`, `keepalive`).

**Why a file failed** (fixed copy picked by status and code; the server's words never show):

| Cause | Chip says | Problem line (alert slot, 8 s) |
|---|---|---|
| over 8 MB (page check or 413) | "Too big · max 8 MB" | — |
| not PNG, JPEG, GIF, WebP, PDF or UTF-8 text (415) | "Not supported" | "<name>: use PNG, JPEG, GIF, WebP, PDF or UTF-8 text." |
| empty (400) | "Empty file" | — |
| 409 `no-project` | "Try again" | "nika can't tell this session's project yet. Try again in a moment." |
| 409 `path-unusable` | "Can't store" | "nika's attachments folder has a path Claude can't take (a space or a special character). Set XDG_STATE_HOME to a plain path." |
| 409 `folder-unsafe` | "Can't store" | "nika's attachments folder isn't safe to write to (a link, or another owner). Nothing was saved." |
| 507 `storage-full` | "Storage full" | "nika's attachment storage is full (256 MB). Older attachments go after a day or two; try again later." |
| 507 `disk-full` | "Disk full" | "The disk is full. Nothing was saved." |
| a picked file nika may not read (a link, a folder, another owner's file) | "Can't read" | "<name>: nika can't read this file (a link, a folder, or a file with another owner)." |
| 429 after the retry, a server error, no answer | "Upload failed" | — |
| 404 | "Upload failed" | "The session is gone." |

The chooser has three lines of its own: "A file chooser is already open. Finish or cancel it first." (429, warning 4 s), "The file chooser
closed. Nothing was added." and "nika couldn't open the file chooser. Nothing was added.".

**Send.** Enter or the Send button with ready chips sends the text and the files together; an empty message box with ready chips sends the
files alone. Before anything goes, and with the text and chips kept, Send is refused with a line in the alert slot when: Shell is on ("Turn
Shell off to send attachments: a ! command can't carry them."), a chip still uploads ("Wait until the attachments have finished
uploading."), a chip failed ("Remove the attachments that failed, then send."), the text does not fit draft sync ("This message is too
long to go with attachments. Send the text first, then the attachments."), or Claude's input cannot be read ("nika can't read Claude's
input box right now (a menu may be open). Nothing was sent. Your text is kept." or, for an unreadable draft, "Claude's input holds
something nika can't read back. Send or clear it in the terminal, then try again."). Otherwise: the text is copied into Claude's input
first (the draft write of §9.12; a copy that fails sends nothing), then `attach-send` pastes the paths and presses `Enter`. The draft
sync holds still until the send is over. Sending works while Claude works: Claude queues the message with its files (W13).

On 200 the message box and the chips clear, and the echo reads "Sent 2 attachments and your message to %7" ("Sent 1 attachment to %7"
with no text). After a send that held a PDF or text file the page shows one notice per page load: "Claude may ask to read the attached
file: it is in nika's attachments folder, outside the project. Answer in the prompt panel." ("files … they are" for several). Claude's
Read prompt then shows in the prompt panel (§9.5); nika never answers it.

When a send does not go, the text and chips stay and the line is fixed copy picked by the code:

| Code | Line |
|---|---|
| `not-idle` | "A prompt is open in Claude or Stop is running. Nothing was sent; your text and attachments are kept." |
| `mode-unknown`, `input-unreadable` | "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." |
| `draft-unreadable` | "Claude's input holds something nika can't read back. Send or clear it in the terminal, then try again." |
| `draft-changed` | "Claude's input changed while nika was getting ready. Nothing was sent; try again." |
| `shell-mode` | "Claude's input is in ! mode. Press Backspace in the terminal to leave it, then send again." |
| `cursor-not-at-end`, `vim-normal` | "Claude's input is in vim normal mode or its cursor isn't at the end. Press i (or End) in the terminal, then send again." |
| `screen-changed` with nothing pasted | "Claude's screen changed, so nothing was sent." |
| `busy-switching` | "Another action is running on this session. Try again in a moment." |
| `path-unusable` | the folder line above |
| `attachment-gone` | "<name> is no longer on disk. Remove it and add it again." and that chip turns "Gone" |
| 429 | "Too many keys at once; try again." |
| 404 | "The session is gone." |
| no answer | "nika did not answer, so it is not known whether anything was sent. Check Claude's input in the terminal. Your text and attachments are kept here." |
| anything else | "nika couldn't send the attachments. Nothing was sent; your text and attachments are kept." |

When some files were already pasted (`pasted` above 0) the line says so, because nika never clears Claude's input: "nika put 1 of 2
attachments into Claude's input, then stopped without pressing Enter: <reason>. Send or clear Claude's input in the terminal (Esc twice),
then send again. Your text and attachments are kept here." The reason is "Claude's screen changed (a prompt, a menu or a search may be
open; Esc closes a search)" for `screen-changed`, "Claude didn't take <name>" for `not-taken`, "a prompt opened or Stop ran" for
`not-idle`, "too many keys at once" for a 429 and "nika could not finish" for anything else.

**Keyboard and screen readers.** Tab order: prompt buttons, the chips' remove buttons, Shell, the message box, [paste Clear], Commands,
**Add attachments**, Send. Paste (Cmd or Ctrl+V) is the keyboard road for an image on the clipboard, the button for files. The drop zone is
pointer-only and `aria-hidden`; everything it does is reachable by the button. The button's description (`#att-help`, screen-reader
only): "Images (PNG, JPEG, GIF, WebP), PDF or text files: up to 6 per message, 8 MB each. You can also paste or drop them on the message
box." Targets: the button 28 px (as Commands), the remove buttons 24 × 24 px (WCAG 2.5.8).

**Not built:** thumbnails or previews, a Retry button on a failed chip (remove it and add the file again), attachments with Shell on or
for text that does not fit draft sync, SVG, HEIC, TIFF and archives, attachments on the browser tier.

### 9.15 Scrolling Claude's view (0.5, W3)

**(built 2026-11-14 (0.5).)** The wheel, the trackpad and the page keys over the terminal mirror move Claude's own full-screen view, so
the user can read older output without the terminal. Contract: `api-app.md` (`POST /api/app/pane/:id/scroll`, `alt` and `scrolled` on the
capture); how the screen is read: `claude-tui.md` §12; ADR 0018. The logic that has no DOM is `public/scroll.js`; the wiring is
`public/session.js`. Always on, no setting.

**Where input is taken**

| Input | Over or focus | Goes to |
|---|---|---|
| wheel or trackpad, vertical | the pointer over the mirror (focus stays where it is) | native first, then Claude (below) |
| wheel with Ctrl or Meta (pinch zoom, app gestures) | anywhere | the browser or app, untouched |
| wheel, horizontal or with Shift | the mirror | native: the mirror's sideways overflow |
| wheel | the transcript column, the message box, anything else | native, untouched |
| PgUp, PgDn, Home, End, Ctrl+Home, Ctrl+End (no Alt, Meta or Shift; Ctrl+PgUp and Ctrl+PgDn belong to the app) | the mirror focused, Type into pane off | native first, then Claude |
| the same keys | the message box | the box's own editing (§4.2) |
| the same keys | Type into pane on | the keys route, raw, as the user's own keys |

**Native first, then Claude.** The mirror's own overflow scrolls before Claude's view does (the browser's nested-scroll rule): up is native
while the mirror is not at its top, down while it is not at its bottom; then the request goes to Claude. With the W7 fit the pane fills the
panel, so this is rarely in play. The page calls `preventDefault()` only when Claude takes the input (no overscroll bounce).

**What a request is.** `public/scroll.js` turns wheel travel into whole Claude pages: a page is half of Claude's transcript area (the row of
the input box's top rule divided by two, at least 4 rows); the first page goes at half a page of travel, so the average is one page per
page of travel; a change of direction drops the rest; at most 8 pages in a request and never a backlog (trackpad momentum cannot run
away). One request in flight, at least 100 ms apart. PgUp and PgDn are one page; Home and Ctrl+Home are `{ to: 'top' }`, End and Ctrl+End
`{ to: 'bottom' }`. A request that does not answer in 10 s is cut off and counts as lost. The page does not ask when it can tell the
server would refuse (its twin of the gate, on the last capture): then it shows the line below, and when the pane is not in its full-screen
view or not read yet, nothing at all.

**The corner of the mirror.** One note element (`#paused-note`), bottom left, with its own colour, icon and words, plus the existing
**Jump to live** button (bottom right):

| nika's mirror (its own overflow) | Claude's view | Note | Jump to live |
|---|---|---|---|
| at the bottom | at the bottom | none | hidden |
| scrolled up (Paused) | at the bottom | `i-pause`, "Paused while you scroll", `--idle` on `--idle-soft` | shown: native bottom |
| at the bottom | scrolled up | `i-up`, "Scrolled up in Claude's view", `--accent` on `--accent-soft` | shown: native bottom, then `{ to: 'bottom' }` |
| scrolled up | scrolled up | the "Scrolled up" note (it says more) | shown: both |

Claude's view counts as scrolled when the capture's `scrolled` is true (Claude's own pill is on screen); after a request the route's
answer sets it at once. Jump to live returns the mirror to the bottom and column 0, sends `{ to: 'bottom' }` when Claude is scrolled, and
moves focus to the message box. The End key in the mirror, once the mirror itself is at its bottom, sends `{ to: 'bottom' }` and resets the
column without moving focus. The header stays "Live · C × R" when only Claude is scrolled:
the mirror is still the live screen. Claude's pill row stays in the mirror (an honest copy of the screen). Contrast: both note pairs are in §5.1.

**Announcements** (polite, only on a change of `scrolled`): "Scrolled up in Claude's view. Jump to live returns to the bottom." and "Back
at the live bottom."

**When it does not go.** A refusal drops the queue (never keys behind a refusal) and shows one fixed line, at most once per 3 s, in the
problem slot (warning, 3 s). The server's words never show:

| Answer or page gate | Line |
|---|---|
| `prompt-open` | "A prompt is open, so nika doesn't send scroll keys. Answer it first, or scroll in the terminal." |
| `screen-unclear` | "A dialog or menu is open in Claude, so nika doesn't send scroll keys. Close it first, or scroll in the terminal." |
| `menu-open` | "Claude's / menu may be open, so nika doesn't send scroll keys. Finish or clear the command first." |
| `no-view` | "Claude isn't in its full-screen view here, so there is nothing for nika to scroll. The transcript shows the whole conversation." |
| `busy-switching` | "Another action is running on this session. Scroll again in a moment." |
| 429, 404, 403 | none (the next request goes after the window; the gone-pane and lost-connection overlays speak) |
| no answer | "nika did not answer." |
| anything else | "nika couldn't scroll Claude's view." |

A scroll is allowed while Claude works (a scroll key never interrupts a turn), with a draft in Claude's box, in vim modes, and over
an unreadable draft. W5 draft sync, the W6 cut, the W7 fit, Send and Stop are unchanged while Claude is scrolled up; Claude returns to the
bottom by itself when a message is submitted.

**Keyboard and screen readers.** The mirror is a focusable region (`tabindex="0"`) whose keys are listed in `aria-keyshortcuts`
("PageUp PageDown Home End") and in the Keyboard shortcuts window (two session rows). Focus never moves on a wheel; keys act only where
focus already is (WCAG 2.1.1, 2.4.3). Jump to live stays in the Tab order after the mirror (§9.10). No new tokens or components: the note
reuses `.paused-note`, the button is the existing `.jump`.

**Not built:** a scrollback route (tmux holds no history for Claude), mouse reports, tmux copy mode, line-by-line scrolling, an automatic
return to the bottom before or after Send, scroll keys in prompts or dialogs, a message-box shortcut, a setting, anything on the browser
tier.

### 9.16 Question dialogs and plan approvals (0.5, W1)

**(built 2026-11-15 (0.5).)** When Claude asks the user a question (one to eight questions in tabs, then a review) or asks to approve a
plan, the window draws a form above the message box and the user answers there. Contract: `api-app.md` (the capture's `dialog` field and
`POST /api/app/pane/:id/dialog`); how Claude draws these dialogs and which keys answer them: `claude-tui.md` §13; the decision: ADR 0015;
the threat: `security.md` T37. The logic that has no DOM is `public/dialog-form.js` (tested alone); the wiring is `public/session.js`
(`cleanDialog` in `noteScreen`, `DF.render` after `renderPrompt`, `DF.live()` in the send gate). App tier only: no route and no `dialog`
field on :3335.

The form reads **exactly or not at all**. A dialog nika cannot read (a cut-off or too-wide screen, a wrapped label, an unknown shape, a
feedback survey) keeps the old banner ("<name> needs you: <reason>. Answer it in the terminal, or turn on Type into pane."), and the gates
still count it as a prompt. The form shows **one step at a time** (the current question, the review, or the plan's choices) and follows
Claude's own tabs; it never moves between them. After an answer the next question appears with a new `sig`.

**Placement.** `div.ask.dlg#dialog-form` (`role="group"`, `aria-labelledby` the question or, for a plan, the kind tag) sits in
`#composer-box` after the permission panel (`#prompt-btns`). It reuses `.ask` (`--attn-row` fill, 3 px `--attn` left edge) and takes at most
`min(45vh, 420px)`, scrolling inside itself, so the mirror keeps its height. A shown form stays while every capture has a dialog (it
leaves on `dialog: null` or a pane that is not `ok`); a `ready` step with another `sig` rebuilds it, and the same `sig` keeps the
nodes, so typed text and focus survive the 250 ms captures. The attention note and the form never show together.

| Part | What it is |
|---|---|
| Header `.ask-h` | state chip (below) · kind tag (`i-dialog` "Question", or `i-m-plan` "Plan approval" in `--m-plan`) · the attention reason (`.ask-reason`) |
| Tabs `ol.dlg-tabs` (`aria-label="Questions"`, shown for two or more tabs) | one item per tab of Claude's strip, **not buttons**: the header, `i-check` when answered or an empty ring, `.sr-only` "answered" / "not answered", `aria-current="step"` on the current one; plus "Review". Under a 560 px composer (container query) the list is replaced by the line "Question 2 of 4 · Tools" (or "Review") |
| Question | `fieldset > legend.ask-q` (600, `tabindex="-1"`) |
| Option rows `label.ch` | a radio (single-select) or a checkbox (multi-select) · `kbd` with Claude's number · the label · the description (`--fs-small`, `--text-muted`). A description over 180 characters is clamped to 3 lines with a **More** / **Less** link (`aria-expanded`). Checked: `--accent-soft` fill, `--accent` edge. A multi-select box starts as Claude shows it |
| Other | `label.ch` "Other" with a text field (`maxlength="300"`, placeholder "Type your answer", `aria-label` "Other answer"); typing selects it. A counter "n/300" from 250 characters. A first digit shows the warn line "Start with a word: Claude can read a first digit as an option." and Send then moves the focus back to the field instead of sending. Where the capture says `other: false` (a multi-select question that is not on the last tab) the row is a `.pbtn-off` line "Other answers: use the terminal" |
| Buttons (question) | **Send answer** (`.btn.primary`) when the answer ends the dialog (`final`: one tab, single-select), else **Answer**; **Decline** (`.btn.ghost`, `title` "Presses Esc in the pane: Claude stops and waits for you"). Enter in the Other field is the primary button, never a newline (Shift+Enter and an IME's Enter excepted). The primary is aria-disabled until the choice is valid (one pick, or a typed answer; a multi-select needs at least one pick or text) |
| Review | heading "Review your answers"; when Claude shows it, a warn row (`i-warn`, `--idle`) "You have not answered all questions"; `dl.dlg-review` with the question (`dt`) and the answer (`dd`) as Claude shows them; **Submit answers** (primary) and **Decline** |
| Plan | the note "Read the plan in the terminal view." (`i-window`; the plan text is never shown or sent to the page); one `button.pbtn` per choice (`kbd` and Claude's label, verbatim) that answers on click, Enter or Space; the text option ("Tell Claude what to change") is a `.pbtn-off` row "<label>: use the terminal"; **Reject (Esc)** (`.pbtn.esc`, the Decline) |

**States.** Every state has its own colour, icon and word.

| State | When | Chip: colour, icon, word | Controls |
|---|---|---|---|
| reading | `unreadable`, no form shown yet, under 2 s (`READING_MS`) | `--ended` on `--ended-soft` · `i-clock` · "Reading" | none; the note "Reading Claude's question…" |
| unreadable | the same, after 2 s | no form: the banner (above) takes over | |
| ready | `ready`, `bypass: false` | the existing "Needs you" pill (`--attn`) | live |
| terminal only | `ready`, `bypass: true` | `--text-muted`, dashed edge, no fill · `i-off` · "Terminal only" | read-only (the options are shown, not offered); only Decline (Reject) is live; the note "This mentions bypass, so nika leaves it to you: answer it in the terminal." |
| answering | a request is in flight | `--accent` on `--accent-soft` · spinner · "Answering" | everything aria-disabled; the pressed button has `aria-busy` |
| answered | 200 (or 409 `already-answered`) | `--busy` on `--busy-soft` · `i-check` · "Answered" ("Submitted" and "Declined" in their cases) | locked until a new `sig` or `dialog: null` |
| failed | any other answer | `--danger` on `--danger-soft` · `i-warn` · "Not answered" | per the table below |
| kept, unreadable | a form is shown and the next capture is `unreadable` | the chip keeps its state; the note "nika can't read Claude's dialog right now. Wait a moment, or answer in the terminal." | Send aria-disabled; the next readable capture takes the note away |

**Route outcomes.** The problem line (`role="alert"`) shows fixed copy chosen by the status and the `error` code only, never the server's
text. With `sent > 0` the line gains " nika had pressed <n> key(s) in the pane before it stopped.". After a 200 the echo says "Sent 3 keys to
%12" and the polite region says "Answered.", "Submitted builder-1's answers.", "Sent your choice to builder-1." or "Declined.".

| Response | Message | Form after |
|---|---|---|
| 409 `no-dialog` | "The question is gone." | re-enabled |
| 409 `dialog-changed` | "The question changed; check the session." | locked until a new `sig` |
| 409 `dialog-touched` | "This question was changed in the terminal. Finish it there." | locked |
| 409 `dialog-focus` | "Claude's selection was moved in the terminal. Finish it there." | locked |
| 409 `text-mode` | "nika can't type your answer: Claude's text field isn't ready for typing. Type it in the terminal." | locked |
| 409 `text-mismatch` | "Your answer didn't arrive exactly as typed, so nika stopped before sending it. Fix it in the terminal." | locked |
| 409 `not-taken` | "Claude didn't take the key. Check the session, then try again." | re-enabled |
| 409 `already-answered` | none (answered in a second window) | locked, chip "Answered" |
| 409 `busy-switching` | "Another action is running on this session." | re-enabled |
| 409 `not-idle` | "nika is stopping Claude's turn; try again in a moment." | re-enabled |
| 400 `terminal-only` | "Answer this in the terminal." | locked |
| 400 `invalid`, any other 409 or status | "nika couldn't send this answer. Check it and try again." | re-enabled |
| 429 | "Too many keys at once; try again." | re-enabled |
| 404 | "The session is gone." | the pane-gone state (§3.9) |
| 5xx, network error | "nika couldn't reach tmux." | re-enabled |

**Rulings (2026-11-15).** (1) **The form stays locked after 409 `dialog-touched` and `dialog-focus`**: the user changed the dialog in the
terminal, so the line sends them there to finish it; a new `sig` or `dialog: null` unlocks the form. (2) **Escape in the message box is a
passthrough**, as in the terminal and as for a permission prompt (Stop's `title` for a prompt of unknown layout says "Esc in the message box cancels it"): it
declines the dialog without the form's `sig` check (security T37, residual p). The form itself has no Esc handler and presses no key of its
own; Decline and Reject are the explicit ways, and digits are not shortcuts.

**Other controls while a form shows** (the capture has a dialog, readable or not):

- **Send, Shell and the lone Enter** wait, like for a permission prompt (§9.5): "Answer the prompt with the buttons above or in the terminal."
  while a readable form is live, "Answer the prompt in the terminal, or turn on Type into pane." for a bypass step or a dialog nika cannot
  read (the keys route then refuses Enter, digits and paste with "Answer this prompt in the terminal."). The text stays in the box.
- **Stop** is aria-disabled with the `title` "Decline is in the question form" and the reason line "Answer the question above first."; a 409
  `prompt-open` that arrives while a form shows says the same line (a permission prompt keeps "Answer the prompt first. Esc = No is in the
  prompt panel."). Compact, Clear, Model and Rewind stay aria-disabled with that line; End session declines the dialog first, as it answers
  a permission prompt with Esc (§9.8).
- **The message box's accessible name** (the composer label) is now "Message to builder-1. Enter sends, Shift+Enter adds a line. Escape and
  Control+C go to Claude; so does Shift+Tab when no question or prompt is open, and the arrow keys and Enter when the box is empty.
  Control+Shift+Tab moves focus back." (§4.2). The mode switch, commands, draft writes and suggestion accepts refuse while a dialog is on
  screen (`api-app.md`).

**Keyboard, focus and announcements.** Tab order: quick actions → permission panel (if shown) → the form (one stop per radio group,
each checkbox, Other, the primary button, Decline; the tabs list is not focusable) → the Shell toggle → the message box (§9.10). Arrow keys
and Space are native. The form appearing never moves focus. When the form rebuilds for the next tab or the review while focus was inside it,
focus goes to the new legend (or the review heading, or the plan note); when the form leaves with focus inside it, focus goes to the message
box. Announcements (polite, once per step): "builder-1 asks: Which checks should I run? Question 1 of 4, above the message box." · on each
later tab "Question 2 of 4: <question>" · "Review your answers: 4 answers, above the message box." · "builder-1 asks you to approve a plan.
Read it in the terminal view; choices above the message box." A step that mentions bypass says the terminal-only note instead of "above the
message box". The `.dlg[data-inert]` look (60 % opacity, `not-allowed`) shows whenever the form cannot take an answer; option rows are at
least 32 px high and More / Less is 24 px (WCAG 2.5.8).

**Not built:** "Chat about this"; the plan's text option and the plan text; moving between Claude's tabs; free text in a multi-select
question on a tab that is not the last; a keyboard shortcut for an option; a Settings switch; anything on the browser tier.

### 9.17 Subagents: rows, the session list and the read-only view (0.5, W8; the W11 line)

Owner request (2026-11-15): "Show Claude's subagents and open them, from the dashboard and from the parent session." These are **Claude's own
subagents**, the children of its `Agent` tool that run inside the parent session; they are not the agents nika spawns (§3.17). Routes and fields:
`docs/contracts/api-app.md` (`subagents` in the snapshot, the subagent history route, `subagent` on a history entry); Claude's files:
`docs/contracts/claude-tui.md` §14; the threat: `docs/security.md` T56.

**Where they appear.**

| Surface | Tier | What |
|---|---|---|
| Dashboard and project-page rows (§3.3) | both | the folded list under a row; the description is a link in the app tier and plain text in the browser tier |
| Session window, top of the Transcript column | app | the session's own folded list, with its own "Show ended" box |
| Read-only subagent view (the session window with `agent=<id>`) | app | the subagent's transcript, no pane, no input |
| The parent's transcript | app | "Open subagent transcript" under the `Agent` call that started it |

Decisions (owner, 2026-11-15, as recommended): a subagent opens in the same session window, read-only, and Back goes up to the parent session; the
session window lists them folded at the top of the Transcript column (anything above the terminal would resize Claude's pane under the fit, §9.13,
every time a subagent started, and Claude already draws its running subagents under the footer in the mirror); that list has its own remembered box
(§1.2); the dashboard's lines stay folded by default, the summary says how many run.

**The state badge** (`subStateEl` in `public/dom.js`; rules in `public/tokens.css`, shared by both pages). Colour, glyph and word, never colour alone;
the glyph is `aria-hidden`, the word is text, the badge has a `title`. Only the status tokens `.st` already uses, light and dark, no new colour.

| State | Word and title | Token | Glyph |
|---|---|---|---|
| `running` | Running · "Running inside its session" | `--busy` on `--busy-soft` | filled 10 px dot with a turning arc (`st-spin`; the arc stops under reduced motion) |
| `finished` | Finished · "Finished its task" | `--ended` on `--ended-soft` | a check |
| `stopped` | Stopped · "Did not finish: its session is no longer running" | `--idle` on `--idle-soft` | a hollow 8 px square |

`.sst.pill` (padding 2 px 10 px 2 px 8 px, radius 999 px, the soft fill) is the session header's form. A state outside these three gives no badge: the
line is drawn without one, and the read-only view hides its pill. The role tag `subagent` (`.tag.sa`: `--surface-2`, `--text`, a 1 px dashed
`--accent-line` border; title "Claude's own subagent. It runs inside its parent session.") is used only by the read-only view's header. One line
(`li.sub[data-ss]`, `subagentItemEl`) holds the badge, the description (a link, `a.sub-desc.sub-link`, title "Open its transcript (read-only)", at least
24 px high; "(no description)" when empty), the label chip (`span.agent-kind`, §3.21; the raw type is in its title), the model label and a time (rows only); it wraps, so at ≤ 600 px the badge
and description come first and the rest below.

**Rows** (`subagentsEl` in `public/app.js`; `subagentView` and `subagentHref` in `public/dash-model.js`).

1. `subagentView(subs, showEnded)`: no array or no object in it → nothing is drawn. `shown` is every entry with the view's "Show ended" on, else the
   `running` ones, in the server's order (running first, then newest). Summary: "1 subagent · 1 running", "3 subagents" (none running), or "No
   subagents running" (nothing shown). The hint "+K ended" follows the summary, muted, while K entries are hidden.
2. Nothing shown (all ended, box off): one muted, non-interactive line `p.subs.subs-none`, "No subagents running +K ended" (the W11 line). It replaces the
   0.4 rule that drew nothing.
3. Otherwise `details.subs` (open state kept per row, `subs:<session id>`), summary = summary + hint, and a `ul` labelled "Subagents of <name>" with a
   line per shown subagent, each with its time (`timeEl`).
4. App tier: the description links to `session.html?session=<parent uuid>&agent=<id>[&project=<key>]` (`subagentHref`, only for a UUID and a
   `SUBAGENT_ID`; the project key only when the row's group is a registered project). Browser tier: plain text. The link's focus key is
   `sub:<scope>:<session id>:<agent id>`, so a redraw keeps focus on it. A click on the link or the disclosure does not open the row.

**Session list** (`renderSubs` in `public/session.js`, `details#sess-subs` in `session.html`).

1. Place: between the Transcript head and its scrolling list, in the same column (a narrow window: inside the Transcript tab). Hidden while the
   session has no subagents, before the first poll, in the read-only view and in a window with no transcript.
2. Closed by default. The page never opens or closes it; the reader's state survives every redraw (only the summary and the list children are replaced).
3. Summary: the same words as the rows. Body: the "Show ended" box (`label.subs-ended`, 24 px high; remembered as `nika.showEndedSession`, on only for the
   stored string `true`, storage that throws means off; a change is stored and drawn at once), then the list: the same lines as the rows, with **no time**
   (it would change at every poll), each description a link by `subagentHref`. With everything ended and the box off, the summary reads "No subagents
   running +K ended" and the body shows the box and an empty list; ticking it lists them.
4. Redraw only when what it shows changes (the session id and name, the box, the summary, the hint and each shown line's id, state, description, type,
   label and model label). Focus stays on the same link across a redraw (`data-fk` `sub:<agent id>`).
5. Style: a strip with a 1 px bottom border, a summary 32 px high (muted, `--text` on hover), the list at most 40 vh and scrolling.

**The read-only view** (`session.html?session=<uuid>&agent=<id>[&project=<key>]`, built only by `subagentHref`).

1. Boot. In the browser tier the page keeps its message ("The session window is part of the nika app. …"). An `agent` that is not a subagent id → "This
   link has no valid subagent id. Open the subagent again from its session." (a pane in the address is not looked at). A valid `agent` with no valid
   `session` → "This link has no valid session id. Open the subagent again from its session." Otherwise the `pane` parameter is **ignored**, with no
   notice. The page adds `sub-view` to the body, hides the tabs and "Skip to message input", shows the Transcript alone (`no-term`), and shows the notice
   "Read-only. A subagent runs inside its parent session: nika shows its transcript, with no pane to mirror and no input."
2. Wired: the transcript (history, Load older, Jump to latest), the page keys, the window keys (Quit, Close, zoom), the shortcuts window, Settings, the
   agent poll and the history poll. **Not wired:** the terminal, the message box, attachments, the mode switcher, the quick actions, the fit, the
   question form, the transcript toggle and the subagent list. The page makes no `/api/app/pane/*` request in this mode (a test asserts it).
3. Data. The agent poll reads `/api/agents?since=all` and finds the **parent** by session id; the subagent is the parent's `subagents` entry with the
   address's id. The transcript is `GET /api/app/session/<S>/subagents/<A>/history?limit=50[&before=n]`, newest page first, like the session window.
4. Header, from the subagent's entry:

| Part | Value |
|---|---|
| `h1` and the window title | the description, else the type, else "Subagent " and the first 8 characters of the id; the title is "<that> · nika"; before the first poll "Subagent" |
| Role tag | `subagent` |
| State pill | `subStateEl(state, { pill: true })`; hidden until a poll lists the subagent with a known state |
| Label chip (`#sess-kind`, after the role tag; shown at every width), model label | the entry's `label` (never empty: `agent` at worst; chip title "Claude's <type> subagent. Kind: <kind>, <meaning>", or without the Kind part for a name that is no kind) and `modelLabel` (hidden when empty) |
| Context meter, pane, branch, Claude link | never shown |
| Back | `session.html?session=<parent uuid>` plus `&pane=<parent pane>` only while the parent is live, plus `&project=<key>` when the address had one; its label is the parent's name ("untitled session" when it has none). Before the first poll it is the dashboard, or the project when the address had one |

5. **Polling (ruling 2026-11-15).** The state decides what the page does: `running` is busy, `finished` is idle, `stopped` is ended. The history
   poll (every 5 s once loaded, 3 s until then) keeps running while the parent session is live, **also after `finished`**, because Claude removes
   `finished` from the meta again when a subagent wakes up (for example when its background shell ends; `claude-tui.md` §14). It stops only on
   `stopped` (the parent session is gone). When the state changes to `finished` or `stopped` the page reads the live edge once more and announces
   "<title> finished" or "<title> stopped"; a change back to running announces "<title> is running again" and reads nothing extra. The first answer
   announces nothing. A subagent the parent does not list, or a state nobody knows, hides the pill and keeps polling; a snapshot that no longer lists
   the parent changes nothing (the header keeps its last values).
6. Transcript. The same code as the session window, with three differences: the user's text reads **Parent** (not "You"; tool results stay "Tool",
   Claude's text "Claude"), the start marker reads "Start of the subagent's transcript", and no entry carries a subagent link (no nesting).
7. Shortcuts: the `subagent` window of §4.6 (Back, Keyboard shortcuts and the five window keys); "Change in Settings" opens Settings in the same window,
   as in the session window.

**The link in the parent's transcript.** A `tool_use` entry with a valid `subagent` id gets, after its fold, the link `a.hx-sub` "Open subagent
transcript" (accent colour, underlined, at least 24 px high, small text) to `subagentHref({ session, agent, project })`. When the polled subagent list knows
the id and gives it a description, the link's `aria-label` is "Open the transcript of subagent <description>"; otherwise it has none, and the fold's
summary above it already names the call. **Late link:** a call can reach the page one poll before Claude writes the subagent's meta, so the server has not
linked it yet; when a later read of the live edge carries the id for an entry that is already shown without it, the link is appended to that entry once. No
link appears in the read-only view, for a bad id, or for an entry that is not a tool call.

**States.**

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Row line | no subagents: nothing; all ended and hidden: "No subagents running +K ended" | n/a (snapshot) | stale list at 60 % opacity (§3.3) |
| Session list | hidden with no subagents; all ended: summary and box | hidden until the first poll | keeps the last list; the poll retries every 3 s |
| Subagent view, transcript | "No messages in this transcript yet." | the first fetch draws nothing | 404: "No transcript for this subagent yet. nika keeps looking." (and keeps polling); another failure: the server's message, else "The transcript could not be read. nika keeps trying." |
| Subagent view, header | "Subagent" and no pill | "Subagent" until the first poll | keeps its last values |
| Load older | "Older entries could not be loaded." (toast) | "Loading…" on the button | n/a |

**Keyboard and accessibility.** Tab reaches a row's summary, then, when it is open, each subagent link; Enter follows it; the session list adds the box
between the summary and the links. In the read-only view: Back with ⌘[ / Alt+←, `?` or Mod+/ for the shortcuts, the window keys, arrows in the transcript
region (`#hist-scroll`, `tabindex` 0), "Load older entries" and "Jump to latest" as buttons. No single-key shortcut is added. Every badge's word is text;
links have a name (the description, or "(no description)"); lists carry `aria-label="Subagents of <name>"`; the notice is `role="status"` and state changes
go through the page's polite announcer; targets are at least 24 px; the running arc stops under reduced motion. Tokens only, so both themes come from
`tokens.css`. At ≤ 760 px the view hides nothing of its header: the label chip stays (at most 24 characters; the `h1` truncates first), and it is one column at every width.

**Security.** Every string is set with `textContent`; a link is built only from ids checked against `UUID` and `SUBAGENT_ID`; the CSP is unchanged (no
inline anything). Subagent text is data: instruction-like text in a transcript is shown, never acted on (T56).

**Not built.** Subagent lines in `nika status`; links or subagent text on the browser tier; a list or links inside a subagent's own view (nested
subagents); relabelling the parent's `<task-notification>` entries (they still read "You"); live progress beyond the 3 s poll; screenshots (regenerated at the end of
the release).

### 8.8 WebView support

Used features: `<dialog>`, `:focus-visible`, `color-mix()`, `:has()` (B only), container queries (mockups). Tauri uses WKWebView on macOS and WebKitGTK on Linux; `color-mix()` and `:has()` need WebKitGTK ≥ 2.42 (Safari 16.2 level). Provide fallbacks or set a minimum (see Open questions).

---

## Appendix A. Open questions (contract and product)

1. `settings.local.json` preview: a whole-file unified diff can show values of `env`, `permissions`, `hooks` and other keys (context lines, or every line if the file is re-serialised). Proposal: the preview shows only the `enabledPlugins` block plus "N other keys kept (values not shown)". Needs a contract field (e.g. `otherKeys: n`) and the server to send only that block.
2. History entries have no stable id; refresh after "Load older" can duplicate entries at the page boundary. Add an entry offset or id.
3. `/api/agents` groups are keyed by root path, not `PROJECT_KEY`; the app needs `projectKey` per group (or a documented `root === project.dir` match) to link groups to project routes without paths.
4. Agent role (orchestrator vs nika-spawned vs other) and the attention reason ("Asking to run a command" / "Asking you a question") are not in the contract; the design uses both.
5. No route lists local rules templates for the Settings select, and no CLI to import one.
6. Spawn with `panePlacement: under-last` and no `under`: which pane is "last" (most recent nika-started pane in that session)? The UI shows "Under %22 (builder-ui)" and needs the server to tell it.
7. `manual` and `default` behave the same in Claude Code; keep both in the UI (explicit flag vs none) or show one?
8. Theme: follow the OS only, or add a `theme` config key?
9. Tray `status` has project counts but no agent names; "reviewer-2 needs you" in the tray needs names (≤ 3) in the status message.
10. Should Tauri's zoom shortcuts (Mod+= / Mod+−) be enabled? The layout supports 200 % at 1440×900.
11. Minimum Linux WebKitGTK version (see §8.8).

## Appendix B. Mockup coverage

| Screen | States in every variant |
|---|---|
| 1 Dashboard | normal, many (54 workers), loading, empty-projects, empty-agents, error-tmux, error-claude, offline |
| 2 Project view | rules outdated, nika + limit reached, foreign, none |
| 2b Spawn | form, errors, limit, starting |
| 3 Apply rules | preview, foreign, applying, success, conflict, refused (B adds a confirm step) |
| 4 Settings | default, errors |
| 5 Session | live, paused, passthrough, permission, pane-gone, rate-limited, tmux-error (B adds history-open) |
| 6 Tray | menu, attention, add-project (with cancel and busy simulations) |
| 7 Browser tier | read-only board/list |
| C only | command palette (open, query) |

The three variants are frozen: they show the 0.2 design (the 0.3 session controls have their own mockup, `variants/session-controls.html`),
and only their text was touched afterwards ("Agents per orchestrator" in the Settings field and the limit alert). What came after them has no
mockup. It is specified in the sections named here and shown built in `docs/screenshots/`:

| Built after the mockups | Specified in | Screenshot |
|---|---|---|
| Project setup card, Choose plugins dialog (0.3.4) and the Models block and dialog (0.4) | §3.15 | `project-*.png` (the card; the dialogs are not photographed) |
| Pick or resume an orchestrator, the orchestrator badge (0.4) | §3.16 | `project-*.png` |
| Nesting tree, Spawn sub-orchestrator sheet, limits and the New agents card (0.4) | §3.17 | `dashboard-*.png`, `project-*.png`, `spawn-*.png` |
| Auto-compact row in Settings (0.4) | §3.18 | `settings-*.png` |
| Context column and meter (0.4) | §3.19 | `dashboard-*.png`, `project-*.png`, `session-*.png` |
