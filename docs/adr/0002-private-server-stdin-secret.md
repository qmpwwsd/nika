# ADR 0002 — Private server, secret over stdin, init script

Date 2026-11-08 · Status accepted

## Context
Privileged actions (keystrokes into panes, spawning agents, writing project files) must not be reachable by a browser
tab, another local process or a prompt-injected agent. The :3335 service is readable by anything on the machine.

## Decision
The shell starts `node bin/nika serve --app`, which listens on `127.0.0.1:0` and only mounts `/api/app/*` there. A
256-bit secret travels **only** over the child's stdin (`hello` message) and back into the page through a Tauri
`initialization_script` that defines a non-enumerable `window.__NIKA_APP__` when `location.origin` is the server's.
`public/api.js` copies it into a module constant, deletes the global and sends it as `X-Nika-App`. The server also checks
`Origin` / `Sec-Fetch-Site` and requires JSON for writes. The webview has no Tauri capability for that origin.

## Alternatives
- Secret in the URL or a cookie: lands in history, logs or is sent by any same-origin tab. Rejected.
- Tauri IPC commands instead of HTTP: duplicates the server, exposes `__TAURI__` to transcript-derived content. Rejected.
- Unix socket: WKWebView cannot load from one. Rejected.

## Consequences
Random port per launch; the browser tier (:3335) stays read-only and never learns the secret (T1, T2). Node refuses a
TTY stdin for `--app`; closing stdin ends the server.
