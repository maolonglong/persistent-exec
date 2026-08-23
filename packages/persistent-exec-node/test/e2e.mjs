import assert from "node:assert/strict";
import { PersistentExecRuntime } from "../dist/index.js";

const runtime = PersistentExecRuntime.create();
try {
  const sessionId = runtime.spawn({
    cmd: "node -e \"process.stdout.write('node-sdk')\"",
    workdir: process.cwd(),
  });

  let output = "";
  let exitCode = null;
  const deadline = Date.now() + 5000;
  while (exitCode === null) {
    const poll = runtime.poll(sessionId);
    output += poll.output;
    exitCode = poll.exit_code;
    if (exitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(Date.now() < deadline, "command did not exit in time");
  }

  assert.deepEqual({ output, exitCode }, { output: "node-sdk", exitCode: 0 });

  const utf8SessionId = runtime.spawn({
    cmd: "node -e \"process.stdout.write('ready');process.stdout.write(Buffer.from([0xe2,0x82]));setTimeout(()=>process.stdout.write(Buffer.from([0xac])),500)\"",
    workdir: process.cwd(),
  });
  let utf8Output = "";
  let utf8ExitCode = null;
  const utf8Deadline = Date.now() + 5000;
  while (!utf8Output) {
    const poll = runtime.poll(utf8SessionId);
    utf8Output += poll.output;
    utf8ExitCode = poll.exit_code;
    assert.ok(Date.now() < utf8Deadline, "split UTF-8 prefix did not arrive in time");
    if (!utf8Output) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual({ utf8Output, utf8ExitCode }, { utf8Output: "ready", utf8ExitCode: null });

  while (utf8ExitCode === null) {
    const poll = runtime.poll(utf8SessionId);
    utf8Output += poll.output;
    utf8ExitCode = poll.exit_code;
    assert.ok(Date.now() < utf8Deadline, "split UTF-8 command did not exit in time");
    if (utf8ExitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual({ utf8Output, utf8ExitCode }, { utf8Output: "ready€", utf8ExitCode: 0 });
} finally {
  runtime.destroy();
}
