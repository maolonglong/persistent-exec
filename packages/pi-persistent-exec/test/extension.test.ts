import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import persistentExecExtension from "../src/index";

interface RegisteredTool {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: string; text: string }> }) => void) | undefined,
    context: { cwd: string },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  let activeTools = ["read", "bash", "write"];
  const pi = {
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: unknown[]) => Promise<void>) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
  };

  persistentExecExtension(pi as unknown as ExtensionAPI);
  return {
    tools,
    handlers,
    activeTools: () => activeTools,
  };
}

test("exposes concise agent-facing tool metadata", () => {
  const { tools } = createHarness();
  const exec = tools.get("exec_command");
  const stdin = tools.get("write_stdin");
  if (!exec || !stdin) throw new Error("persistent tools were not registered");

  expect({
    exec: {
      description: exec.description,
      promptSnippet: exec.promptSnippet,
      promptGuidelines: exec.promptGuidelines,
    },
    stdin: {
      description: stdin.description,
      promptSnippet: stdin.promptSnippet,
      promptGuidelines: stdin.promptGuidelines,
    },
  }).toEqual({
    exec: {
      description:
        "Execute a shell command in workdir. Returns exit_code when complete or session_id when still running. Output keeps the tail within max_output_tokens and reports original_token_count when truncated.",
      promptSnippet: "Execute shell commands with persistent sessions and optional PTY interaction",
      promptGuidelines: undefined,
    },
    stdin: {
      description:
        "Write characters to a running exec_command session, or omit chars to poll it. Returns exit_code when complete or session_id while still running. Output uses the same bounded tail as exec_command.",
      promptSnippet: "Write to or poll a running exec_command session",
      promptGuidelines: undefined,
    },
  });
});

test("removes bash and runs a persistent stdin session", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();

  expect(harness.activeTools()).toEqual(["read", "write", "exec_command", "write_stdin"]);

  const exec = harness.tools.get("exec_command");
  const stdin = harness.tools.get("write_stdin");
  if (!exec || !stdin) throw new Error("persistent tools were not registered");

  const first = await exec.execute(
    "call-1",
    {
      cmd: "node -e \"process.stdout.write('ready');process.stdin.once('data',d=>{process.stdout.write('received:'+d.toString().trim());process.stdin.destroy()})\"",
      yield_time_ms: 250,
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  expect(first.details.output).toBe("ready");
  expect(typeof first.details.session_id).toBe("number");

  const second = await stdin.execute(
    "call-2",
    {
      session_id: first.details.session_id,
      chars: "hello\n",
      yield_time_ms: 1_000,
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  expect(second.details).toMatchObject({
    output: "received:hello",
    exit_code: 0,
  });

  await harness.handlers.get("session_shutdown")?.();
});

test("bounds final and partial output while preserving original size", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  const exec = harness.tools.get("exec_command");
  if (!exec) throw new Error("exec_command was not registered");
  let maxUpdateBytes = 0;

  const result = await exec.execute(
    "call-large",
    {
      cmd: "node -e \"process.stdout.write('x'.repeat(2000000))\"",
      yield_time_ms: 5_000,
      max_output_tokens: 10,
    },
    undefined,
    (update) => {
      maxUpdateBytes = Math.max(
        maxUpdateBytes,
        Buffer.byteLength(update.content[0]?.text ?? "", "utf8"),
      );
    },
    { cwd: process.cwd() },
  );

  expect(maxUpdateBytes).toBeLessThan(200);
  expect(Buffer.byteLength(String(result.details.output), "utf8")).toBeLessThan(200);
  expect(Number(result.details.original_token_count)).toBeGreaterThan(400_000);
  await harness.handlers.get("session_shutdown")?.();
});
