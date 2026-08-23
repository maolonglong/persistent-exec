# pi-persistent-exec

Persistent shell sessions for [pi](https://github.com/badlogic/pi-mono).

```bash
pi install npm:pi-persistent-exec
```

The extension replaces pi's built-in `bash` tool with:

- `exec_command`, which starts a command and returns its result or a session ID if it is still running
- `write_stdin`, which sends input to a running session or checks it for more output

Commands use `$SHELL` on Unix and PowerShell on Windows. No additional configuration is needed.

Each pi session gets its own native runtime. Starting a new session, reloading extensions, or exiting pi terminates the processes started by the old runtime. Cleanup uses process groups on Unix and Job Objects on Windows. A Unix process can escape cleanup if it deliberately starts a new session.

The extension runs with the same permissions as pi. It does not add a sandbox or approval prompts.
