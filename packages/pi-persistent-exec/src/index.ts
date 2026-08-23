import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSdk, type RuntimeApi } from "./sdk";

const EXEC_TOOL = "exec_command";
const STDIN_TOOL = "write_stdin";
const POLL_INTERVAL_MS = 25;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_WRITE_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 300_000;
const DEFAULT_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 12_500;

interface ToolOutput {
  wall_time_seconds: number;
  output: string;
  exit_code?: number;
  session_id?: number;
  original_token_count?: number;
}

interface WaitResult {
  output: string;
  exitCode: number | null;
  originalBytes: number;
  truncated: boolean;
}

const execParameters = Type.Object(
  {
    cmd: Type.String({ description: "Shell command to execute." }),
    workdir: Type.Optional(
      Type.String({ description: "Working directory. Defaults to the current project directory." }),
    ),
    tty: Type.Optional(
      Type.Boolean({ description: "Allocate a PTY for interactive commands. Defaults to false." }),
    ),
    yield_time_ms: Type.Optional(
      Type.Integer({
        minimum: 250,
        maximum: 30_000,
        description: "Maximum time to wait before returning a running session. Defaults to 10000.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_OUTPUT_TOKENS,
        description: "Approximate output token budget for this response. Defaults to 10000.",
      }),
    ),
  },
  { additionalProperties: false },
);

const stdinParameters = Type.Object(
  {
    session_id: Type.Integer({ minimum: 1, description: "Running session identifier." }),
    chars: Type.Optional(
      Type.String({
        description:
          "Characters to write. Empty or omitted polls without writing. Use \\u0003 for Ctrl-C.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Integer({
        minimum: 250,
        maximum: MAX_POLL_YIELD_MS,
        description:
          "Maximum time to wait for output or exit. Defaults to 250 after a write and 5000 when polling.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_OUTPUT_TOKENS,
        description: "Approximate output token budget for this response. Defaults to 10000.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default function persistentExecExtension(pi: ExtensionAPI): void {
  let runtime: RuntimeApi | null = null;

  pi.registerTool({
    name: EXEC_TOOL,
    label: "exec",
    description:
      "Execute a shell command in workdir. Returns exit_code when complete or session_id when still running. Output keeps the tail within max_output_tokens and reports original_token_count when truncated.",
    promptSnippet: "Execute shell commands with persistent sessions and optional PTY interaction",
    parameters: execParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const activeRuntime = requireRuntime(runtime);
      const sessionId = activeRuntime.spawn({
        cmd: params.cmd,
        workdir: resolve(ctx.cwd, params.workdir ?? "."),
        tty: params.tty ?? false,
      });
      const startedAt = performance.now();
      let waited: WaitResult;
      try {
        waited = await waitForSession(
          activeRuntime,
          sessionId,
          params.yield_time_ms ?? DEFAULT_EXEC_YIELD_MS,
          params.max_output_tokens ?? DEFAULT_OUTPUT_TOKENS,
          signal,
          (output) => {
            onUpdate?.({
              content: [{ type: "text", text: output }],
              details: { session_id: sessionId, output },
            });
          },
        );
      } catch (error) {
        activeRuntime.terminate(sessionId);
        await drainTerminatedSession(activeRuntime, sessionId);
        throw error;
      }

      return toolResult(waited, sessionId, startedAt);
    },
    renderCall(args, theme) {
      const command = args.cmd.length > 100 ? `${args.cmd.slice(0, 97)}...` : args.cmd;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      return renderToolResult(result.details as Partial<ToolOutput> | undefined, isPartial, theme);
    },
  });

  pi.registerTool({
    name: STDIN_TOOL,
    label: "stdin",
    description:
      "Write characters to a running exec_command session, or omit chars to poll it. Returns exit_code when complete or session_id while still running. Output uses the same bounded tail as exec_command.",
    promptSnippet: "Write to or poll a running exec_command session",
    parameters: stdinParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const activeRuntime = requireRuntime(runtime);
      const chars = params.chars ?? "";
      if (chars !== "") activeRuntime.write(params.session_id, chars);

      const maxYield = chars === "" ? MAX_POLL_YIELD_MS : MAX_WRITE_YIELD_MS;
      const defaultYield = chars === "" ? DEFAULT_POLL_YIELD_MS : DEFAULT_WRITE_YIELD_MS;
      const yieldMs = Math.min(params.yield_time_ms ?? defaultYield, maxYield);
      const startedAt = performance.now();
      const waited = await waitForSession(
        activeRuntime,
        params.session_id,
        yieldMs,
        params.max_output_tokens ?? DEFAULT_OUTPUT_TOKENS,
        signal,
        (output) => {
          onUpdate?.({
            content: [{ type: "text", text: output }],
            details: { session_id: params.session_id, output },
          });
        },
      );

      return toolResult(waited, params.session_id, startedAt);
    },
    renderCall(args, theme) {
      const action = args.chars ? `write ${JSON.stringify(args.chars)}` : "poll";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("stdin"))} ${theme.fg("dim", `${args.session_id}: ${action}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      return renderToolResult(result.details as Partial<ToolOutput> | undefined, isPartial, theme);
    },
  });

  pi.on("session_start", async () => {
    const sdk = await loadSdk();
    runtime = sdk.PersistentExecRuntime.create();
    const active = pi
      .getActiveTools()
      .filter((name) => name !== "bash" && name !== EXEC_TOOL && name !== STDIN_TOOL);
    pi.setActiveTools([...active, EXEC_TOOL, STDIN_TOOL]);
  });

  pi.on("session_shutdown", async () => {
    runtime?.destroy();
    runtime = null;
  });
}

function requireRuntime(runtime: RuntimeApi | null): RuntimeApi {
  if (!runtime) throw new Error("persistent-exec runtime is not initialized");
  return runtime;
}

async function waitForSession(
  runtime: RuntimeApi,
  sessionId: number,
  yieldMs: number,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
  onOutput: (output: string) => void,
): Promise<WaitResult> {
  const deadline = performance.now() + yieldMs;
  const maxBytes = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS) * 4;
  let output = "";
  let originalBytes = 0;
  let truncated = false;
  while (true) {
    signal?.throwIfAborted();
    const poll = runtime.poll(sessionId);
    if (poll.output || poll.omitted_bytes > 0) {
      originalBytes += Buffer.byteLength(poll.output, "utf8") + poll.omitted_bytes;
      const next = truncateTail(output + poll.output, { maxBytes, maxLines: 2_000 });
      output = next.content;
      truncated ||= next.truncated || poll.omitted_bytes > 0;
      onOutput(formatOutput(output, originalBytes, truncated));
    }
    const result = { output, originalBytes, truncated };
    if (poll.exit_code !== null) return { ...result, exitCode: poll.exit_code };

    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ...result, exitCode: null };
    await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("command wait aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function drainTerminatedSession(runtime: RuntimeApi, sessionId: number): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      if (runtime.poll(sessionId).exit_code !== null) return;
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

function toolResult(waited: WaitResult, sessionId: number, startedAt: number) {
  const originalTokenCount = waited.truncated ? Math.ceil(waited.originalBytes / 4) : undefined;
  const details: ToolOutput = {
    wall_time_seconds: Math.round(((performance.now() - startedAt) / 1_000) * 1_000) / 1_000,
    output: formatOutput(waited.output, waited.originalBytes, waited.truncated),
    ...(waited.exitCode === null ? { session_id: sessionId } : { exit_code: waited.exitCode }),
    ...(originalTokenCount === undefined ? {} : { original_token_count: originalTokenCount }),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function formatOutput(output: string, originalBytes: number, truncated: boolean): string {
  if (!truncated) return output;
  const originalTokenCount = Math.ceil(originalBytes / 4);
  return `${output}\n\n[Output truncated from approximately ${originalTokenCount} tokens.]`;
}

function renderToolResult(
  details: Partial<ToolOutput> | undefined,
  isPartial: boolean,
  theme: { fg(color: "warning" | "success" | "dim" | "error", text: string): string },
): Text {
  if (isPartial) return new Text(theme.fg("warning", "running"), 0, 0);
  if (!details) return new Text(theme.fg("error", "no result"), 0, 0);

  const state =
    details.exit_code === undefined ? `session ${details.session_id}` : `exit ${details.exit_code}`;
  const lines = details.output?.split("\n").filter(Boolean).length ?? 0;
  return new Text(
    `${theme.fg(details.exit_code === 0 || details.exit_code === undefined ? "success" : "error", state)}${theme.fg("dim", ` · ${lines} lines · ${details.wall_time_seconds ?? 0}s`)}`,
    0,
    0,
  );
}
