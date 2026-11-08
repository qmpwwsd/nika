# ADR 0003 — Shell ↔ server: JSON lines over stdio

Date 2026-11-08 · Status accepted

## Context
The shell needs the port, a status feed for the tray and a way to run the native folder picker. Rust must not need an
HTTP client, and the server must not need IPC.

## Decision
One newline-delimited JSON channel on the child's stdin/stdout, `proto` 1: `hello` → `ready`, `status` every 3 s,
`pick-folder` ↔ `folder`, `error`. Lines over 64 KB and unknown types are ignored. Shapes are fixed in
`docs/contracts/api-app.md` §5.

## Alternatives
- Rust polling `/api/agents` over HTTP: needs `reqwest` (a large crate) and the secret in Rust memory. Rejected.
- Tauri events from the page: would need a Tauri capability on the remote origin. Rejected (ADR 0002).

## Consequences
Protocol parser tested in both `cargo test` and `node --test`. Stdout of the server is reserved for the protocol;
diagnostics go to stderr.
