import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateTail } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
const OUTPUT_PREVIEW_LINES = 5;
const INPUT_PREVIEW_CHARS = 80;

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

interface RenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

type ToolTheme = {
  bold(text: string): string;
  fg(
    color:
      | "toolTitle"
      | "accent"
      | "toolOutput"
      | "warning"
      | "success"
      | "error"
      | "muted"
      | "dim",
    text: string,
  ): string;
};

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
          "Wait before returning output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls default to 5000 ms and may wait up to 300000 ms.",
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
  const sessionInteractions = new Map<number, Promise<void>>();

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
      onUpdate?.({
        content: [],
        details: { session_id: sessionId, output: "" },
      });
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
    renderCall(args, theme, context) {
      startRenderTimer(context.state as RenderState, context.executionStarted);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", args.cmd || "...")}`,
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      updateRenderTimer(context.state as RenderState, options.isPartial, context.isError, context);
      const component =
        (context.lastComponent as ToolResultRenderComponent | undefined) ??
        new ToolResultRenderComponent();
      component.update(result, options, context.state as RenderState, theme, context.isError);
      return component;
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
      return withSessionLock(sessionInteractions, params.session_id, signal, async () => {
        const activeRuntime = requireRuntime(runtime);
        const chars = params.chars ?? "";
        if (chars !== "") activeRuntime.write(params.session_id, chars);

        const maxYield = chars === "" ? MAX_POLL_YIELD_MS : MAX_WRITE_YIELD_MS;
        const defaultYield = chars === "" ? DEFAULT_POLL_YIELD_MS : DEFAULT_WRITE_YIELD_MS;
        const yieldMs = Math.min(params.yield_time_ms ?? defaultYield, maxYield);
        const startedAt = performance.now();
        onUpdate?.({
          content: [],
          details: { session_id: params.session_id, output: "" },
        });
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
      });
    },
    renderCall(args, theme, context) {
      const state = context.state as RenderState;
      startRenderTimer(state, context.executionStarted);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const label = args.chars
        ? `Wrote to session ${args.session_id}`
        : `${state.endedAt === undefined ? "Waiting" : "Waited"} for session ${args.session_id}`;
      const input = args.chars ? ` · ${previewInput(args.chars)}` : "";
      text.setText(
        `${theme.fg("toolTitle", theme.bold(args.chars ? "↳" : "•"))} ${theme.fg("dim", `${label}${input}`)}`,
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      updateRenderTimer(context.state as RenderState, options.isPartial, context.isError, context);
      const component =
        (context.lastComponent as ToolResultRenderComponent | undefined) ??
        new ToolResultRenderComponent();
      component.update(result, options, context.state as RenderState, theme, context.isError);
      return component;
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
    sessionInteractions.clear();
  });
}

function requireRuntime(runtime: RuntimeApi | null): RuntimeApi {
  if (!runtime) throw new Error("persistent-exec runtime is not initialized");
  return runtime;
}

async function withSessionLock<T>(
  locks: Map<number, Promise<void>>,
  sessionId: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  locks.set(sessionId, current);

  try {
    await awaitWithAbort(previous, signal);
    return await operation();
  } finally {
    release?.();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  }
}

function awaitWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolveWait, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("command wait aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveWait();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

function startRenderTimer(state: RenderState, executionStarted: boolean): void {
  if (executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

function updateRenderTimer(
  state: RenderState,
  isPartial: boolean,
  isError: boolean,
  context: { invalidate(): void },
): void {
  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1_000);
  }
  if (!isPartial || isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
}

function previewInput(input: string): string {
  const escaped = JSON.stringify(input);
  if ([...escaped].length <= INPUT_PREVIEW_CHARS) return escaped;
  return `${[...escaped].slice(0, INPUT_PREVIEW_CHARS - 4).join("")}..."`;
}

function splitOutputNotice(output: string): { output: string; notice?: string } {
  const match = output.match(/\n\n\[Output truncated from approximately (\d+) tokens\.\]$/);
  if (!match || match.index === undefined) return { output };
  return {
    output: output.slice(0, match.index),
    notice: `Output truncated from approximately ${match[1]} tokens`,
  };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item): item is { type: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

class ToolResultRenderComponent extends Container {
  update(
    result: { content: Array<{ type: string; text?: string }>; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    state: RenderState,
    theme: ToolTheme,
    isError: boolean,
  ): void {
    this.clear();
    const details = result.details as Partial<ToolOutput> | undefined;
    const rawOutput = details?.output ?? (isError ? textContent(result) : "");
    const rendered = splitOutputNotice(rawOutput);
    const output = rendered.output.trimEnd();

    if (output) {
      const styledOutput = output
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");
      if (options.expanded) {
        this.addChild(new Text(`\n${styledOutput}`, 0, 0));
      } else {
        this.addChild({
          render(width: number) {
            const visualLines = new Text(styledOutput, 0, 0).render(width);
            const preview = visualLines.slice(-OUTPUT_PREVIEW_LINES);
            const skipped = visualLines.length - preview.length;
            if (skipped <= 0) return ["", ...preview];
            const hint =
              theme.fg("muted", `... (${skipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return ["", truncateToWidth(hint, width, "..."), ...preview];
          },
          invalidate() {},
        });
      }
    } else if (!options.isPartial && !isError) {
      this.addChild(new Text(`\n${theme.fg("muted", "(no output)")}`, 0, 0));
    }

    if (rendered.notice) {
      this.addChild(new Text(`\n${theme.fg("warning", `[${rendered.notice}]`)}`, 0, 0));
    }

    this.addChild(
      new Text(`\n${formatRenderStatus(details, options.isPartial, state, theme, isError)}`, 0, 0),
    );
  }
}

function formatRenderStatus(
  details: Partial<ToolOutput> | undefined,
  isPartial: boolean,
  state: RenderState,
  theme: ToolTheme,
  isError: boolean,
): string {
  const renderedElapsedSeconds =
    state.startedAt === undefined
      ? undefined
      : ((state.endedAt ?? Date.now()) - state.startedAt) / 1_000;
  const elapsedSeconds = renderedElapsedSeconds ?? details?.wall_time_seconds ?? 0;
  const duration = `${elapsedSeconds.toFixed(1)}s`;
  const countableOutput = details?.output ? splitOutputNotice(details.output).output.trimEnd() : "";
  const lines = countableOutput ? countableOutput.split("\n").length : 0;
  const lineCount = `${lines} ${lines === 1 ? "line" : "lines"}`;

  if (isPartial) {
    const session = details?.session_id === undefined ? "" : ` · session ${details.session_id}`;
    return `${theme.fg("warning", "Running")}${theme.fg("dim", `${session} · elapsed ${duration}`)}`;
  }
  if (isError || !details) {
    return `${theme.fg("error", "Failed")}${theme.fg("dim", ` · took ${duration}`)}`;
  }
  if (details.exit_code === undefined) {
    return `${theme.fg("success", `Session ${details.session_id} running`)}${theme.fg("dim", ` · ${lineCount} · waited ${duration}`)}`;
  }
  const color = details.exit_code === 0 ? "success" : "error";
  return `${theme.fg(color, `Exit ${details.exit_code}`)}${theme.fg("dim", ` · ${lineCount} · took ${duration}`)}`;
}
