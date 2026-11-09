# ADR 0013 — Nested orchestration via tmux tags, depth ≤ 3

Date 2026-11-09 · Status accepted (nika 0.4)

## Context
Through 0.3 an agent nika started had one parent in practice: the project's orchestrator, or "you" when it came from the
CLI or the page. 0.4 lets a main orchestrator start sub-orchestrators, and a sub-orchestrator start agents of its own, so
a big job can be split without one orchestrator holding every brief. Three things have to be decided:

- **Who is the parent, and how deep is the child?** The answer drives the limits, the deny list a pane gets and the tree
  the dashboard draws. Anything the child's process can write (argv, env, a file in the reports dir) can be forged by any
  agent of the project, so a forged parent could lift a cap or turn an agent into something with more reach.
- **Where do the limits count?** 0.3 had one number, `limits.maxAgents`, for the whole project. With nesting, one busy
  sub-orchestrator must not starve the others, and the project as a whole still needs a ceiling.
- **How does a sub-orchestrator differ from an agent?** It spawns, so it needs nika's `spawn` and `status` commands. Nothing
  else of the CLI.

## Decision
- **Roles.** `@nika-role` takes a third value, `sub-orchestrator`. `orchestrator` stays the main one (depth 1) and is what every
  "the main orchestrator" check tests, so a sub-orchestrator is never taken for it (`findOrchestratorPane`, the
  `orchestrator_running` check, Start, the adopt route). The spawn request keeps one word for this: `role: 'orchestrator'`
  means "start a sub-orchestrator", and nika tags the pane `sub-orchestrator`.
- **Tags are the only record of parent and depth.** nika sets, with `tmux set-option -p` and fixed argv: `@nika-role`,
  `@nika-agent <key>/<name>`, `@nika-depth 1|2|3` and `@nika-parent <%n>`. Every value is a constant, a validated name or a
  pane id, so no `#` can reach a format-expanded argument. From 0.4 an orchestrator pane nika starts, resumes or adopts also
  gets `@nika-agent <key>/orchestrator` and `@nika-depth 1`. A 0.3 orchestrator pane (role `orchestrator`, no
  `@nika-agent`) still counts as the project's main orchestrator, but only in the project's own session and in the window
  `orchestrator`, the place `findOrchestratorPane` already finds it; it is never retagged.
- **The parent is named, the depth is computed.** The page sends an optional `parent: '%n'`; the CLI takes `$TMUX_PANE` when
  it is a pane id (there is no `--parent` flag). Both go through one resolution from one fresh `tmux list-panes -a` with a
  fixed format: the main orchestrator of this project as parent gives depth 2 (role `agent` or `sub-orchestrator`), a
  sub-orchestrator of this project at depth 2 gives depth 3 (role `agent` only), no usable parent gives depth 1 (role `agent`
  only). "You" means only: no parent named, a pane with no `@nika-role` at all (a shell, the page's header), or, for the CLI,
  a `$TMUX_PANE` that is absent, not a pane id, or not listed. **Every other pane that carries a nika role is 409 `depth`**: an
  agent, anything of another project, a tag that does not parse or agree, an unknown role value. (An earlier draft treated those
  as "you", which let an honestly tagged sub-orchestrator of project A spawn into project B at depth 1 with `--project`.) A page request naming a pane that is not in the listing is 404 `not_found`; for the CLI a stale
  `$TMUX_PANE` is "you". The name `orchestrator` is reserved, so an agent's tag can never take the main orchestrator's form.
  The depth is never read from the request, argv, env or a file; the parent's
  `@nika-depth` is only a consistency check.
- **Limits.** `N = limits.maxAgents` (1–8), now read as "agents per orchestrator". The live set is the panes in any tmux
  session with role `agent` or `sub-orchestrator` and an `@nika-agent` tag for this project, plus the panes this process
  started. The per-project cap is `min(3 × N, 24)`; the per-parent cap is `N` live entries with the same `@nika-parent` (for
  "no parent": those with none). The project check runs first. A refusal is 409 `limit` with `{ scope, running, max }`. A
  sub-orchestrator and an agent share the name space for the duplicate check. The checks and the split run inside the
  existing per-project queue; they do not span the CLI and the app server (see consequences).
- **Launch.** `.agent.json` carries `role`, `parent` and `depth` beside the 0.3 keys, and `_run-agent` asserts the exact key
  set and re-checks every value (exit 3). A sub-orchestrator gets its own guard prompt (`templates/guard-orchestrator.txt`)
  and a `--disallowedTools` list that keeps the agents' entries except `Bash(nika:*)`, which becomes `Bash(nika)` plus
  `Bash(nika <sub>:*)` for every CLI command other than `spawn` and `status`. The list is generated from the CLI's command
  table, so a command added later is denied to sub-orchestrators until someone allows it. Like the agents' list, it is
  advisory (project rules, constraint 12).
- **Read side.** `src/collect/tmux.js` reads the three tags beside the role and parses each strictly (a bad value is absent).
  `src/model.js` gives every live agent `parent` (the parent's session id when the pane maps to a known session, else the
  pane id), `depth` (1–3, from the place in the parent chain, not from the agent's own tag, so a forged `@nika-depth` changes
  nothing on screen) and `children`. A cycle or a self-parent is cut, and the agent becomes a root. Ended agents carry
  no parent or depth and `children: []`. The browser tier gets the same fields: they are tags nika itself wrote.
- `TEMPLATE_VERSION` goes to 2: the rules template gains a "Sub-orchestrators" section and a reworded limit line.

## Alternatives considered
- **The parent from argv, env or a file** (a `--parent` flag, an env var, a field in a report file). Every one of those is
  written by the process that is being limited. An agent could name any pane as its parent, or none, to dodge a cap or to
  climb a level. Rejected; tmux's own record plus a fresh listing is the one place nika already trusts for "which panes are
  nika's" (T12).
- **One role value with the depth alone** (`orchestrator` at depth 2 is a sub-orchestrator). Every existing check that means
  "the main orchestrator" tests the role; with one value a mis-set depth would turn a sub-orchestrator into the main one
  (a second main orchestrator, a pick that adopts the wrong pane). A separate role makes the safe reading the default.
  Rejected.
- **A cross-process lock for the caps.** The CLI and the app server are separate processes; a lock file would be one more
  agent-writable file, and the cap is a guard against honest overload, not a security boundary. Rejected; the race is
  recorded in T36.
- **Deeper nesting.** Three levels cover "orchestrator, a lead per area, their workers". A fourth multiplies the number of
  panes a person has to follow. Rejected until there is a use for it.

## Consequences
- A sub-orchestrator can start agents but not read, end or reconfigure anything else through the CLI, within the advisory
  limits of a deny list (constraint 12). The page can start sub-orchestrators too (`role` and `parent` on
  `POST /api/app/spawn`).
- Anything that can run `tmux set-option` can write these tags, and `$TMUX_PANE` is an ordinary env var. nika does not
  pretend otherwise: a forged tag can move an agent to another parent or out of the tree, and the project cap still holds
  because it counts the whole live set. The residuals are written down in `docs/security.md` (T36 and residual risk).
- The CLI process and the app server can each pass the check for the last free slot at the same moment, so a cap can be
  exceeded by one pane.
- A project's `limits.maxAgents` no longer bounds the project: it bounds each orchestrator, and the project as a whole at
  `min(3 × N, 24)`. A user who had set 8 can now see up to 24 agents.
