# persistent-exec-pty

This crate starts child processes with either a pseudo-terminal (PTY) or regular pipes. Both modes return the same process handle, so callers can choose whether a command needs a terminal without changing the rest of their process-management code.

## Public API

- `spawn_pty_process(program, args, cwd, env, arg0, size)` → `SpawnedProcess`
- `spawn_pipe_process(program, args, cwd, env, arg0)` → `SpawnedProcess`
- `spawn_pipe_process_no_stdin(program, args, cwd, env, arg0)` → `SpawnedProcess`
- `combine_output_receivers(stdout_rx, stderr_rx)` → `broadcast::Receiver<Vec<u8>>`
- `conpty_supported()` → `bool` (Windows only; always true elsewhere)
- `TerminalSize { rows, cols }` selects PTY dimensions in character cells.
- `ProcessHandle` exposes:
  - `writer_sender()` → `mpsc::Sender<Vec<u8>>` (stdin)
  - `resize(TerminalSize)`
  - `close_stdin()`
  - `has_exited()`, `exit_code()`, `terminate()`
- `SpawnedProcess` bundles `session`, `stdout_rx`, `stderr_rx`, and `exit_rx` (oneshot exit code).

## Usage examples

```rust
use std::collections::HashMap;
use std::path::Path;
use persistent_exec_pty::combine_output_receivers;
use persistent_exec_pty::spawn_pty_process;
use persistent_exec_pty::TerminalSize;

# tokio_test::block_on(async {
let env_map: HashMap<String, String> = std::env::vars().collect();
let spawned = spawn_pty_process(
    "bash",
    &["-lc".into(), "echo hello".into()],
    Path::new("."),
    &env_map,
    &None,
    TerminalSize::default(),
).await?;

let writer = spawned.session.writer_sender();
writer.send(b"exit\n".to_vec()).await?;

// Collect output until the process exits.
let mut output_rx = combine_output_receivers(spawned.stdout_rx, spawned.stderr_rx);
let mut collected = Vec::new();
while let Ok(chunk) = output_rx.try_recv() {
    collected.extend_from_slice(&chunk);
}
let exit_code = spawned.exit_rx.await.unwrap_or(-1);
# let _ = (collected, exit_code);
# anyhow::Ok(())
# });
```

Use `spawn_pipe_process` when the child does not need a terminal. Use `spawn_pipe_process_no_stdin` when it should see EOF immediately instead of receiving input.

## Tests

Run the crate's tests from the repository root:

```bash
cargo test -p persistent-exec-pty
```
