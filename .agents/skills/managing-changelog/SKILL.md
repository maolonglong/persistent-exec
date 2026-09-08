---
name: managing-changelog
description: Audits commits since the previous release tag and updates persistent-exec's Unreleased changelog. Use when preparing a release, reviewing changelog completeness, or asked what user-visible changes need release notes.
---

# Managing the changelog

Audit release notes from the commit history before a release. This skill updates release notes only; it never changes versions, creates tags, publishes packages, or edits released changelog sections.

## Workflow

1. Read the `Changelog and releases` section in the repository `AGENTS.md`.
2. Find the latest reachable release tag and list commits in chronological order:

   ```bash
   git tag --merged HEAD --sort=-v:refname | head -1
   git log --reverse --format='%H%n%s%n%b%n---' <tag>..HEAD
   ```

   If no release tag is reachable, stop and ask for the intended baseline instead of guessing.
3. Read `packages/pi-unified-exec/CHANGELOG.md` and inspect its `[Unreleased]` section before changing it.
4. For each commit since the tag, inspect its changed files and diff. Map observable changes across `core`, `ffi`, `pty`, `node`, `bun`, and `pi` to the user-facing `@chensl/pi-unified-exec` changelog.
5. Skip release housekeeping, changelog-only changes, and internal-only refactors with no user-visible behavior. Do not skip bug fixes merely because their implementation is in a lower-level crate or wrapper.
6. Add missing entries under `[Unreleased]` using this category order when present:

   ```text
   ### Breaking Changes
   ### Added
   ### Changed
   ### Fixed
   ### Removed
   ```

   Use concise user-facing language. Explain observable behavior, constraints, and compatibility impact; do not copy commit subjects or implementation details. Add attribution only when a verified external PR number and author are available. Never invent attribution.
7. Preserve every released `## [X.Y.Z] - YYYY-MM-DD` section byte-for-byte. If a published note is incorrect, report it and prepare a corrective future entry rather than rewriting history.
8. Re-read the changed `[Unreleased]` section, run `git diff --check`, and report: baseline tag, commits considered, entries added or changed, skipped commits with reasons, and any ambiguity requiring maintainer input.

## Decision rules

- A change belongs in the changelog when a pi extension user, Node/Bun consumer, or native-runtime integrator can observe a new capability, changed result, compatibility change, security effect, reliability fix, or performance characteristic.
- Group tightly related commits into one user-facing entry. Keep independent behavior changes as separate bullets.
- A breaking API or lifecycle change must use `### Breaking Changes` and state the migration path.
- Do not add empty categories or filler entries merely to account for every commit.
