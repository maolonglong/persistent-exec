import { expect, test } from "bun:test";
import { PersistentExecRuntime } from "../src/index";

test("runs and polls a command", async () => {
  const runtime = PersistentExecRuntime.create();
  try {
    const sessionId = runtime.spawn({
      cmd: "bun -e \"process.stdout.write('bun-sdk')\"",
      workdir: process.cwd(),
    });

    let output = "";
    let originalBytes = 0;
    let exitCode: number | null = null;
    const deadline = Date.now() + 5_000;
    while (exitCode === null) {
      const poll = runtime.poll(sessionId);
      output += poll.output;
      originalBytes += poll.original_bytes;
      exitCode = poll.exit_code;
      if (exitCode === null) await Bun.sleep(10);
      expect(Date.now()).toBeLessThan(deadline);
    }

    expect({ output, exitCode }).toEqual({ output: "bun-sdk", exitCode: 0 });
    expect(originalBytes).toBe(Buffer.byteLength(output));
  } finally {
    runtime.destroy();
  }
});
