# Project guidance

## Architecture

- Keep `persistent-exec-core` transport-neutral. Put C ABI concerns in `persistent-exec-ffi`, runtime-specific loading in the Node/Bun packages, and pi lifecycle/tool behavior in `pi-persistent-exec`.
- Preserve the versioned C ABI and opaque runtime handle. Do not expose Rust layouts across FFI.
- Keep one native runtime per pi session and terminate it on session replacement, extension reload, and shutdown.
- Keep native output and session counts bounded. Partial output must be bounded as well as final output, and truncation metadata must include bytes omitted by the Rust runtime.
- Unix cleanup owns process groups; Windows cleanup owns Job Objects. Do not claim that Unix processes which deliberately create a new session remain contained.

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
- Keep package versions synchronized while wrappers use exact versions for native and runtime dependencies.
