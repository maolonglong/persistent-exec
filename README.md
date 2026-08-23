# persistent-exec

Persistent shell sessions for [pi](https://github.com/badlogic/pi-mono).

The `pi-persistent-exec` extension replaces pi's built-in `bash` tool with two tools:

- `exec_command` starts a command and returns its result. If the command is still running, it returns a session ID instead.
- `write_stdin` sends input to a running session or checks it for more output.

This lets pi run interactive commands and keep long-running processes alive between tool calls. Commands use `$SHELL` on Unix and PowerShell on Windows.

## Installation

```bash
pi install npm:pi-persistent-exec
```

The extension works without additional configuration.

## Process cleanup

Each pi session gets its own native runtime. Starting a new session, reloading extensions, or exiting pi terminates the processes started by the old runtime. Cleanup uses process groups on Unix and Job Objects on Windows.

A Unix process can escape cleanup if it deliberately starts a new session. The extension runs with the same permissions as pi and does not add a sandbox or approval prompts.

## Development

Run the formatter, linter, and test suite from the repository root:

```bash
make fmt
make lint
make test
```

## License

Apache-2.0. See `NOTICE` for attribution for the process-management code adapted from Codex.
