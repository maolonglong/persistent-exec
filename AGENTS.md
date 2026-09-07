# Project guidance

## Architecture

- Keep `persistent-exec-core` transport-neutral. Put C ABI concerns in `persistent-exec-ffi`, runtime-specific loading in the Node/Bun packages, and pi lifecycle/tool behavior in `pi-persistent-exec`.
- Preserve the versioned C ABI and opaque runtime handle. Do not expose Rust layouts across FFI.
- Keep one native runtime per pi session and terminate it on session replacement, extension reload, and shutdown.
- Keep native output and session counts bounded. Partial output must be bounded as well as final output, and truncation metadata must include bytes omitted by the Rust runtime.
- Unix cleanup owns process groups; Windows cleanup owns Job Objects. Do not claim that Unix processes which deliberately create a new session remain contained.
- Keep each pi tool's `promptSnippet` to a one-line capability summary. Put the observable call/result contract in `description` and parameter descriptions.
- Keep `exec_command` and `write_stdin` function descriptions and supported-parameter schemas verbatim-aligned with Codex; do not expose Codex parameters whose behavior this project does not implement.
- Add `promptGuidelines` only for non-obvious behavior that the schema and descriptions cannot express. Do not instruct the model about tools removed from the active set.

## Cross-platform process behavior

- Support Linux, macOS, and Windows for process lifecycle changes. Keep pipe and PTY behavior aligned unless an OS API requires a documented difference.
- After Windows-specific Rust changes, run:
  `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc`
  and the equivalent targeted Clippy command.
- Preserve the upstream license headers in the copied ConPTY sources under `crates/persistent-exec-pty/src/win/`.

## Verification

- Run `make fmt`, `make lint`, and `make test` after code changes.
- Build `persistent-exec-ffi` before Node/Bun runtime tests; the SDKs load the local native library during development.
- For release changes, run `make build-release`, inspect `npm pack` contents, and verify an isolated tarball install. Native packages must contain the dynamic library, `LICENSE`, and `NOTICE`.

## Commit messages

- Use Conventional Commits for every commit: `<type>(<scope>): <summary>`, followed by a blank line, a required body, then optional trailers after another blank line. Use imperative, lowercase English summaries without a trailing period; keep them under 72 characters when practical.
- Use only `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, or `revert`. Use a scope when it narrows ownership: `core`, `ffi`, `pty`, `node`, `bun`, `pi`, `release`, `deps`, `docs`, `ci`, or `repo`.
- Every body must explain why the change is needed, the observable behavior or invariant it establishes, and relevant trade-offs or compatibility impact. State the verification performed when it is not obvious from the commit type. Do not merely restate the diff, invent motivation, or claim checks that did not run.
- Keep commits atomic: one independently reviewable behavioral or maintenance change per commit. Split unrelated formatting, refactors, dependency updates, and feature work.
- Use trailers for metadata: `Fixes: #123`, `Refs: #123`, and `BREAKING CHANGE: <impact and migration>`. Breaking changes require both `!` in the header and a `BREAKING CHANGE` trailer with migration guidance.
- Example:

  ```text
  fix(pty): terminate foreground jobs on session shutdown

  Detached foreground jobs could outlive a replaced pi session and retain
  its terminal resources. Terminate the owning process group during shutdown
  so the session lifecycle remains bounded on Unix and Windows.

  Verified with make test.
  ```

## Packaging

- Keep platform package names synchronized across Node/Bun `optionalDependencies`, both `binary.ts` lookup maps, `scripts/stage-native.mjs`, and the release workflow matrix.
- Publish npm packages in dependency order: platform binary packages first, Node/Bun wrappers second, and `pi-persistent-exec` last.
- Keep package versions synchronized while wrappers use exact versions for native and runtime dependencies.

## Changelog and releases

- `packages/pi-persistent-exec/CHANGELOG.md` is the source of truth for user-facing release notes. Keep one top-level `## [Unreleased]` section and add user-visible changes only; order categories as Breaking Changes, Added, Changed, Fixed, and Removed.
- Treat released changelog sections as immutable. Before a release, audit changes since the prior `v*` tag and add missing user-visible entries under `[Unreleased]`; do not rewrite historical notes to conceal a shipped defect.
- Release only from a clean local `main` with `npm run release:patch` or `npm run release:minor`. Do not manually update release versions, create release tags, or bypass `scripts/release.mjs`: it synchronizes all package/Rust versions, validates the changelog, runs verification, tags the release commit, then commits a fresh `[Unreleased]` section for the next cycle.
- A pushed `v*` tag is a real npm publish action. The release workflow builds and validates all artifacts, creates a draft GitHub Release from the tagged changelog, publishes npm packages, then makes that GitHub Release public only after publishing succeeds.
- For a partially failed release, rerun the failed job or dispatch the release workflow with the original `release_tag`, its `source_ref`, and `publish: true`. Existing tarballs are integrity-checked and skipped; never create another tag or rebuild an already-partially-published version.
- There is no unrelease path. Do not delete a public GitHub Release, retag, unpublish npm versions, or move dist-tags as routine recovery. Publish a corrective version instead. The workflow only deletes draft releases after a failed npm publish.
