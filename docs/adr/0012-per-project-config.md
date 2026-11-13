# ADR 0012 — Per-project config lives under `perProject` and is saved by its own route

Date 2026-11-09 · Status accepted (nika 0.3.4)

## Context
Through 0.3.3 the plugins to turn on for a project were stored in `config.json` as `plugins.perProject: { <key>: [names] }`
and edited in Settings. Two problems came with that:

- The choice belongs to one project, but it was edited on a different screen. "Choose plugins…" on the project page jumped
  to Settings, and the long list overlapped the fields around it.
- Saving Settings sent the whole `plugins.perProject` map. A Settings page opened before a project's choice changed would
  overwrite that choice with its stale copy (a whole-map race between pages). 0.4 adds more per-project values (models, the
  orchestrator session), so the same race would grow.

## Decision
- `config.json` gets a top-level `perProject: { <PROJECT_KEY>: { plugins?: string[] } }`. Unknown inner keys are dropped with
  a warning (0.4 adds its own: see the addendum below). The old `plugins` group is gone from the schema.
- A project's entry is read with `GET /api/app/projects/:key/config` and written with `PUT` on the same path. The store
  function `updateProjectConfig` changes only that project's entry, inside the store's one serial queue, so nothing else in
  the file can be overwritten by a stale page.
- `PUT /api/app/settings` refuses `perProject` (and the old `plugins` group is an unknown key). Settings holds only the
  defaults for every project, and its form never carries per-project values.
- The route accepts a plugin name that is installed now or already saved for that project, so a plugin that was removed from
  Claude Code can still be unticked. Any other name is 400.
- A config written by 0.3.3 or older is migrated on load, silently: `plugins.perProject[key]` becomes
  `perProject[key].plugins`. When both shapes exist `perProject` wins. The old group is never written back.
- `removeProject` deletes the project's `perProject` entry.

**0.4 addendum — per-project models.** A project may override the model of each of the four roles (orchestrator, reasoner,
builder, scout) under `perProject[key].models`, a partial map that stores only the roles it sets. They use this same route:
`PUT …/config` takes exactly one of `{ plugins }` or `{ models }`, so the plugins dialog and the models dialog cannot overwrite
each other, and `GET …/config` returns both. The effective model of a role is the project's id where set, else Settings';
`effectiveModels` in `src/store.js` is the one place that decides it, for the orchestrator's `--model`, the rendered Roles table
and (mirrored in `public/models-ui.js`) the spawn sheet.

## Alternatives considered
- **Keep the map in Settings and fix only the layout.** Leaves the race and the jump to another screen. Rejected.
- **A whole-map `PUT /api/app/per-project`.** Fixes the screen but keeps the race between two project pages. Rejected.
- **A field per value under `PUT /api/app/projects/:key`.** More routes for no gain; one route with a validated patch grows
  to 0.4's values without a new route.
- **Store the choice in the project's own `.claude/settings.local.json` only.** nika writes that file only after a preview
  and confirmation (ADR 0006), so a choice made earlier would have nowhere to live until then.

## Consequences
- Settings can never overwrite a project's choice, and a project page can never overwrite the defaults.
- `rules.js` reads `perProject[key].plugins`; no entry still means `enabledPlugins` is left as it is.
- `config.json` is still read and written only by nika, through `src/store.js` and `src/fwrite.js`; the browser tier serves none
  of the per-project config (it is reachable only on the app tier). `rules/project-rules.md` rule 4 names "project list and
  per-project config".
- An empty list means "no entry" everywhere: `loadConfig` drops an empty `plugins` list (and an entry left empty) without a
  warning, whether it came from a hand-edited file, from 0.3.3's `plugins.perProject[key] = []` or from a save; the route and
  the dialog store no list for `[]`. So applying rules leaves the file's plugins as they are, as the card and dialog say.
- Going back to 0.3.3 with a 0.3.4 file: 0.3.3 drops the unknown `perProject` key with a warning and has no plugin selection,
  and its next save writes the file without it, so the choices are lost. Choose them again after upgrading.
