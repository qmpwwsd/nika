# ADR 0001 — Desktop shell: Tauri v2

Date 2026-11-08 · Status accepted

## Context
0.2 needs a tray icon, a window, a folder picker and "start at login" on macOS and Linux. nika's logic is Node with
zero npm dependencies and must stay that way.

## Decision
A thin Tauri v2 shell (`app/src-tauri`) supervises the Node server and hosts one webview pointed at it. Rust crates are
the only approved dependencies (owner, 2026-11-08): `tauri` (tray-icon, image-png), `tauri-build`,
`tauri-plugin-single-instance`, `tauri-plugin-dialog`, `tauri-plugin-autostart`, `serde`, `serde_json`; versions pinned,
`Cargo.lock` committed, `cargo audit` in CI. A new crate is a new approval.

## Alternatives
- Electron: bundles Chromium and Node, 150+ MB, npm dependency tree. Rejected.
- Menu-bar-only Swift app: macOS only. Rejected (Linux required).
- Browser dashboard only: no tray, no folder picker, no privileged tier isolation. Kept as the read-only tier.

## Consequences
Rust toolchain needed to build (`rustup`); formula `depends_on "rust" => :build`. The webview has no Tauri capability
for the server origin, so the page never sees `window.__TAURI__` (ADR 0002).
