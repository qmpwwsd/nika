# ADR 0004 — Two tiers: read-only browser dashboard, privileged app

Date 2026-11-08 · Status accepted

## Context
0.1 users run `nika serve` as a brew/systemd service on :3335 and open it in a browser; any local process can read it.
0.2 adds actions that must not be exposed that way.

## Decision
The same code base serves two tiers. Browser tier (`nika serve`): 0.1 routes only, `/api/app/*` not mounted (404).
App tier (`nika serve --app`, child of the shell): all routes. The UI shows privileged controls only when
`/api/app/me` answers.

## Alternatives
- Drop the browser tier: breaks 0.1 installs and the no-GUI Linux use case. Rejected.
- Expose privileged routes on :3335 behind a token in the page: any local reader of the page gets the token. Rejected.

## Consequences
Every privileged route has a (−) test on a non-app server. README documents what each tier can do.
