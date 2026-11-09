# ADR 0011 — Copy the app into ~/Applications

Date 2026-11-09 · Status accepted (owner decision 2026-11-09)

## Context
The Homebrew formula builds `nika.app` from source and leaves it in the keg (`/opt/homebrew/opt/nika/nika.app`).
Spotlight does not index that folder (checked: `mdfind` by bundle id finds nothing), and Launchpad and the Applications
folder do not list it, so the owner cannot open nika by name. A formula cannot write into Applications itself.

## Decision
nika copies its own app bundle into `~/Applications/nika.app` (a real folder, so Spotlight, Launchpad and the Dock show
it with its icon): on `nika app install`, or when the app, opened from the Homebrew folder, asks once "Add nika to
Applications?". nika refreshes a copy it made when a launch command (`nika`, `nika open`, `nika app`) runs after
`brew upgrade`, and the app offers "Update app" when the Homebrew copy is newer. Rules: contract §6 "App copy".

## Alternatives
- Homebrew cask with a prebuilt app in `/Applications`: macOS blocks unsigned downloaded apps; it needs an Apple
  Developer ID (yearly cost) for signing and notarization, or every user clears the quarantine flag. Rejected for now.
- A symlink in Applications: always current, but Spotlight does not index symlinked apps. Rejected.
- `/Applications`: shared by all users and may need an admin password. Rejected; `~/Applications` needs neither.

## Consequences
A second place nika writes (rule 11): one fixed path, only nika's own bundle, built in a temp sibling and swapped in, never
over something that is not nika. The copy can lag the keg until a launch command or the app's Update button runs; the
formula's caveats say so. With two copies, `nika` launches the managed one by path, not by bundle id.
