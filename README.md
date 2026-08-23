# persistent-exec

Codex-style persistent command execution for pi.

The pi extension replaces the active `bash` tool with `exec_command` and `write_stdin`. A Rust runtime owns PTY/pipe processes, incremental output, and session cleanup through Unix process groups or Windows Job Objects; thin Node.js and Bun FFI adapters expose it to the extension. Commands run through `$SHELL` on Unix and Windows PowerShell on Windows.

## Development

```bash
make fmt
make lint
make test
```

## License

Apache-2.0. See `NOTICE` for extracted Codex process-management code attribution.
