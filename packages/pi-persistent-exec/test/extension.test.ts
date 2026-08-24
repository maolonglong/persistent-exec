import { expect, test } from "bun:test";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import persistentExecExtension from "../src/index";

initTheme("dark");

interface RenderContext {
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  lastComponent?: Component;
  invalidate(): void;
  executionStarted: boolean;
  isError: boolean;
}

interface TestTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

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
  renderCall?(args: Record<string, any>, theme: TestTheme, context: RenderContext): Component;
  renderResult?(
    result: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
    options: { expanded: boolean; isPartial: boolean },
    theme: TestTheme,
    context: RenderContext,
  ): Component;
}

const plainTheme: TestTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function renderContext(
  args: Record<string, unknown>,
  state: Record<string, unknown> = {},
): RenderContext {
  return {
    args,
    state,
    invalidate() {},
    executionStarted: true,
    isError: false,
  };
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

test("renders a compact output tail and full expanded output", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderResult) throw new Error("exec renderer was not registered");
  const result = {
    content: [{ type: "text", text: "ignored" }],
    details: {
      output: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
      exit_code: 0,
      wall_time_seconds: 1.25,
    },
  };
  const context = renderContext({ cmd: "printf output" });

  const collapsed = exec.renderResult(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    context,
  );
  const collapsedText = collapsed.render(80).join("\n");
  expect(collapsedText).toContain("3 earlier lines");
  expect(collapsedText).not.toContain("line 1");
  expect(collapsedText).toContain("line 8");
  expect(collapsedText).toContain("Exit 0 · 8 lines · took 1.3s");

  context.lastComponent = collapsed;
  const expanded = exec.renderResult(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    context,
  );
  expect(expanded.render(80).join("\n")).toContain("line 1");
});

test("renders live and persistent session states", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderCall || !exec.renderResult)
    throw new Error("exec renderers were not registered");
  const state: Record<string, unknown> = {};
  const callContext = renderContext({ cmd: "sleep 30" }, state);
  exec.renderCall({ cmd: "sleep 30" }, plainTheme, callContext);
  const resultContext = renderContext({ cmd: "sleep 30" }, state);

  const partial = exec.renderResult(
    {
      content: [],
      details: { output: "ready", session_id: 42 },
    },
    { expanded: false, isPartial: true },
    plainTheme,
    resultContext,
  );
  expect(partial.render(80).join("\n")).toContain("Running · session 42 · elapsed");

  resultContext.lastComponent = partial;
  state.startedAt = 1_000;
  state.endedAt = 6_000;
  const waiting = exec.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: { output: "ready", session_id: 42, wall_time_seconds: 0.25 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    resultContext,
  );
  expect(waiting.render(80).join("\n")).toContain("Session 42 running · 1 line · waited 5.0s");
  expect(state.interval).toBeUndefined();
});

test("renders semantic stdin actions with bounded escaped input", () => {
  const stdin = createHarness().tools.get("write_stdin");
  if (!stdin?.renderCall || !stdin.renderResult)
    throw new Error("stdin renderers were not registered");
  const chars = `${"x".repeat(100)}\n`;
  const writeContext = renderContext({ session_id: 7, chars });
  const write = stdin.renderCall({ session_id: 7, chars }, plainTheme, writeContext);
  const writeText = write.render(200).join("\n");
  expect(writeText).toContain('Wrote to session 7 · "xxx');
  expect(writeText.trimEnd()).toEndWith('..."');
  expect(writeText).not.toContain("\n");

  const state: Record<string, unknown> = {};
  const pollContext = renderContext({ session_id: 7 }, state);
  const poll = stdin.renderCall({ session_id: 7 }, plainTheme, pollContext);
  expect(poll.render(80).join("\n")).toContain("Waiting for session 7");
  stdin.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: { output: "", exit_code: 0, wall_time_seconds: 0.5 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    renderContext({ session_id: 7 }, state),
  );
  pollContext.lastComponent = poll;
  const waited = stdin.renderCall({ session_id: 7 }, plainTheme, pollContext);
  expect(waited.render(80).join("\n")).toContain("Waited for session 7");
});

test("renders failures and truncation metadata", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderResult) throw new Error("exec renderer was not registered");
  const component = exec.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        output: "tail\n\n[Output truncated from approximately 1234 tokens.]",
        exit_code: 2,
        wall_time_seconds: 0.25,
        original_token_count: 1234,
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    renderContext({ cmd: "false" }),
  );
  const rendered = component.render(100).join("\n");
  expect(rendered.match(/Output truncated/g)).toHaveLength(1);
  expect(rendered).toContain("Exit 2 · 1 line · took 0.3s");
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

test("serializes concurrent interactions for one session", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  const exec = harness.tools.get("exec_command");
  const stdin = harness.tools.get("write_stdin");
  if (!exec || !stdin) throw new Error("persistent tools were not registered");

  const script =
    'let buffer="",firstAt=0;process.stdout.write("ready");process.stdin.on("data",data=>{buffer+=data;while(buffer.includes("\\n")){const newline=buffer.indexOf("\\n");buffer=buffer.slice(newline+1);if(firstAt===0){firstAt=Date.now();process.stdout.write("first\\n")}else{process.stdout.write("delay:"+(Date.now()-firstAt)+"\\n");process.exit(0)}}})';
  const encodedScript = Buffer.from(script).toString("base64");
  const command = `node -e "eval(Buffer.from('${encodedScript}','base64').toString())"`;
  const first = await exec.execute(
    "call-start",
    { cmd: command, yield_time_ms: 250 },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const sessionId = Number(first.details.session_id);

  const [firstWrite, secondWrite] = await Promise.all([
    stdin.execute(
      "call-first-write",
      { session_id: sessionId, chars: "one\n", yield_time_ms: 500 },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
    stdin.execute(
      "call-second-write",
      { session_id: sessionId, chars: "two\n", yield_time_ms: 1_000 },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
  ]);

  expect(firstWrite.details.output).toContain("first");
  const delay = Number(String(secondWrite.details.output).match(/delay:(\d+)/)?.[1]);
  expect(delay).toBeGreaterThanOrEqual(350);
  expect(secondWrite.details.exit_code).toBe(0);
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
