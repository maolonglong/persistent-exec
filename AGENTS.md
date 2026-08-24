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

## Packaging

- Keep platform package names synchronized across Node/Bun `optionalDependencies`, both `binary.ts` lookup maps, `scripts/stage-native.mjs`, and the release workflow matrix.
- Publish npm packages in dependency order: platform binary packages first, Node/Bun wrappers second, and `pi-persistent-exec` last.
- Treat a pushed `v*` tag as a real npm publish action. Use `workflow_dispatch` to build and inspect release artifacts without publishing.
- If npm publishing partially fails, rerun only the failed `publish` job from that workflow run so it reuses the original artifacts; never rebuild an already-partially-published tag.
- Keep package versions synchronized while wrappers use exact versions for native and runtime dependencies.
