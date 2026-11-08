# ADR 0009 — Packaging: Homebrew from source (macOS), `.deb` + AppImage via CI (Linux)

Date 2026-11-08 · Status accepted

## Context
nika is installed with `brew install qmpwwsd/tap/nika` today. 0.2 adds a Rust shell, and the owner has no Apple
Developer signing identity and wants Linux support.

## Decision
macOS: the tap formula builds the Tauri app from source (`depends_on "rust" => :build`, ad-hoc signing `-`), installs
the CLI and the `.app` bundle (id `io.github.qmpwwsd.nika`, name `nika`); `nika` opens the app with
`open -b io.github.qmpwwsd.nika`. Linux: GitHub Actions `release-linux.yml` (`workflow_dispatch`, draft release)
builds `.deb` and AppImage on `ubuntu-22.04`; runtime needs AppIndicator, documented. Every publish (tag, release,
tap PR) is a separate owner approval.

## Alternatives
- Notarized binaries: needs a paid identity. Deferred.
- Cask with prebuilt bundle: unsigned downloads are blocked by Gatekeeper. Rejected for now.
- Snap/Flatpak: sandboxing breaks tmux access. Rejected.

## Consequences
Build from source takes minutes on first install. CI runs `npm test`, `cargo test`, `cargo audit` on macOS and Ubuntu.

## Update 2026-11-08 (owner decision)
After 0.2.0, pushing a tag `vX.Y.Z` runs `release-linux.yml`, which builds the Linux packages and creates the draft
release itself (notes from the tag's CHANGELOG section; the tag must match every version file). Manual dispatch stays a
test build with artifacts only. Publishing the draft and updating the tap stay manual, each with the owner's approval.
Only the `draft-release` job has write access, and it runs no repository code. Steps: `docs/packaging.md`, Release
procedure.
