# pi-persistent-exec

Codex-style persistent command execution for pi.

```bash
pi install npm:pi-persistent-exec
```

No configuration is required. The extension removes the built-in `bash` tool from the active tool set and enables:

- `exec_command` — run commands with optional PTY support and return a session ID when still running.
- `write_stdin` — poll incremental output or write characters to a running session.

Every pi session owns an independent native runtime. Starting a new session, reloading extensions, or exiting pi terminates its Unix process groups or Windows Job Objects. On Unix, a process that deliberately detaches into a new session can escape process-group cleanup.

The extension runs with the same system permissions as pi. It does not add sandboxing or approval prompts.
