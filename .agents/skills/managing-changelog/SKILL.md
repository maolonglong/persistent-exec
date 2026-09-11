---
name: managing-changelog
description: Audits user-visible changes against pi-unified-exec's changelog and optionally updates Unreleased. Use when preparing a release, reviewing changelog completeness, or identifying changes that need release notes.
---

# Managing the changelog

Audit release notes from the commit history before a release. This skill updates release notes only; it never changes versions, creates tags, publishes packages, or edits released changelog sections.

## Workflow

1. Read the `Changelog and releases` section in the repository `AGENTS.md`. For review or research requests, report findings without editing. For update or release requests, edit only `[Unreleased]`.
2. Inspect `git status --short`. If the repository is shallow, run `git fetch --unshallow origin` before auditing history. Fetch tags with `git fetch origin --tags`, then find the highest stable release version reachable from HEAD and record the audited HEAD:

   ```bash
   git tag --merged HEAD --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
   git rev-parse HEAD
   git log --reverse --format='%H%n%s%n%b%n---' <tag>..HEAD
   ```

   If no stable release tag is reachable, ask for the intended baseline instead of guessing. If fetching fails, disclose that the baseline may be stale. Account separately for relevant staged and unstaged changes; do not present a committed-history audit as covering them.
3. Read `packages/pi-unified-exec/CHANGELOG.md` and inspect its `[Unreleased]` section before changing it.
4. For each commit since the tag, inspect its changed files and diff. Map observable changes across `core`, `ffi`, `pty`, `node`, `bun`, and `pi` to the user-facing `@chensl/pi-unified-exec` changelog.
5. Skip release housekeeping, changelog-only changes, and internal-only refactors with no user-visible behavior. Do not skip bug fixes merely because their implementation is in a lower-level crate or wrapper.
6. Check existing entries against the final behavior, including later fixes and reverts. Remove duplicate or superseded claims, correct inaccuracies, and add missing entries when editing is authorized. Use this category order when present:

   ```text
   ### Breaking Changes
   ### Added
   ### Changed
   ### Fixed
   ### Removed
   ```

   Use concise user-facing language. Explain observable behavior, constraints, and compatibility impact; do not copy commit subjects or implementation details. Add attribution only when a verified external PR number and author are available. Never invent attribution.
7. Preserve every released `## [X.Y.Z] - YYYY-MM-DD` section byte-for-byte. If a published note is incorrect, report it and prepare a corrective future entry rather than rewriting history.
8. Re-read `[Unreleased]` and, if edited, run `git diff --check` and verify that released sections are unchanged. Report the baseline tag, audited HEAD, coverage of uncommitted changes, entries proposed or changed, skipped groups with reasons, and compatibility or attribution ambiguities. If code changes after the audit, review the additional changes before release; do not reuse a stale audit.

## Decision rules

- A change belongs in the changelog when a pi extension user, Node/Bun consumer, or native-runtime integrator can observe a new capability, changed result, compatibility change, security effect, reliability fix, or performance characteristic.
- Group tightly related commits into one user-facing entry. Keep independent behavior changes as separate bullets.
- A breaking API or lifecycle change must use `### Breaking Changes` and state the migration path.
- Do not add empty categories or filler entries merely to account for every commit.
