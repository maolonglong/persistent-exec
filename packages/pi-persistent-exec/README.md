# pi-persistent-exec

Persistent shell sessions for [pi](https://github.com/badlogic/pi-mono).

```bash
pi install npm:pi-persistent-exec
```

The extension replaces pi's built-in `bash` tool with:

- `exec_command`, which starts a command and returns its result or a session ID if it is still running
- `write_stdin`, which sends input to a running session or checks it for more output

Commands use `$SHELL` on Unix and PowerShell on Windows. No additional configuration is needed.

Starting a new session, reloading extensions, or exiting pi terminates processes started by the extension. It runs with the same permissions as pi and does not add a sandbox or approval prompts.
