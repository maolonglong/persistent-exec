import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OutputBuffer } from "./output";
import { loadSdk, type RuntimeApi } from "./sdk";

const EXEC_TOOL = "exec_command";
const STDIN_TOOL = "write_stdin";
const POLL_INTERVAL_MS = 25;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MIN_YIELD_MS = 250;
const MIN_WINDOWS_EXEC_YIELD_MS = 10_000;
const MIN_POLL_YIELD_MS = 5_000;
const MAX_WRITE_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 300_000;
const DEFAULT_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 12_500;
const CALL_PREVIEW_LINES = 3;
const OUTPUT_PREVIEW_LINES = 5;
const INPUT_PREVIEW_CHARS = 80;

interface ToolOutput {
  wall_time_seconds: number;
  output: string;
  exit_code?: number;
  session_id?: number;
  original_token_count?: number;
  cancelled?: boolean;
}

interface WaitResult {
  output: string;
  exitCode: number | null;
  originalBytes: number;
  truncated: boolean;
  cancelled?: boolean;
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
      Type.String({ description: "Working directory for the command. Defaults to the turn cwd." }),
    ),
    tty: Type.Optional(
      Type.Boolean({
        description: "True allocates a PTY for the command; false or omitted uses plain pipes.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          process.platform === "win32"
            ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
            : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

const stdinParameters = Type.Object(
  {
    session_id: Type.Number({
      description: "Identifier of the running unified exec session.",
    }),
    chars: Type.Optional(
      Type.String({
        description: "Bytes to write to stdin. Defaults to empty, which polls without writing.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
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
      process.platform === "win32"
        ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n${windowsShellGuidance()}`
        : "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    promptSnippet: "Execute shell commands with persistent sessions and optional PTY interaction",
    parameters: execParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const activeRuntime = requireRuntime(runtime);
      const yieldMs = clampExecYield(
        optionalUnsignedInteger(params.yield_time_ms, "yield_time_ms") ?? DEFAULT_EXEC_YIELD_MS,
      );
      const maxOutputTokens =
        optionalUnsignedInteger(params.max_output_tokens, "max_output_tokens") ??
        DEFAULT_OUTPUT_TOKENS;
      signal?.throwIfAborted();
      const sessionId = activeRuntime.spawn({
        cmd: params.cmd,
        workdir: resolve(ctx.cwd, params.workdir ?? "."),
        tty: params.tty ?? false,
      });
      return withSessionLock(sessionInteractions, sessionId, undefined, async () => {
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
            yieldMs,
            maxOutputTokens,
            signal,
            (output) => {
              onUpdate?.({
                content: [{ type: "text", text: output }],
                details: { session_id: sessionId, output },
              });
            },
            true,
          );
        } catch (error) {
          activeRuntime.terminate(sessionId);
          await drainTerminatedSession(activeRuntime, sessionId);
          throw error;
        }

        return toolResult(waited, sessionId, startedAt);
      });
    },
    renderCall(args, theme, context) {
      startRenderTimer(context.state as RenderState, context.executionStarted);
      const component =
        (context.lastComponent as ToolCallRenderComponent | undefined) ??
        new ToolCallRenderComponent(theme);
      component.update(args.cmd || "...", theme, context.expanded);
      return component;
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
    description: "Writes characters to an existing unified exec session and returns recent output.",
    promptSnippet: "Write to or poll a running exec_command session",
    parameters: stdinParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const sessionId = positiveInteger(params.session_id, "session_id");
      const chars = params.chars ?? "";
      const defaultYield = chars === "" ? DEFAULT_POLL_YIELD_MS : DEFAULT_WRITE_YIELD_MS;
      const requestedYield =
        optionalUnsignedInteger(params.yield_time_ms, "yield_time_ms") ?? defaultYield;
      const yieldMs = clampWriteYield(requestedYield, chars === "");
      const maxOutputTokens =
        optionalUnsignedInteger(params.max_output_tokens, "max_output_tokens") ??
        DEFAULT_OUTPUT_TOKENS;
      return withSessionLock(sessionInteractions, sessionId, signal, async () => {
        const activeRuntime = requireRuntime(runtime);
        signal?.throwIfAborted();
        if (chars !== "") activeRuntime.write(sessionId, chars);

        const startedAt = performance.now();
        onUpdate?.({
          content: [],
          details: { session_id: sessionId, output: "" },
        });
        const waited = await waitForSession(
          activeRuntime,
          sessionId,
          yieldMs,
          maxOutputTokens,
          signal,
          (output) => {
            onUpdate?.({
              content: [{ type: "text", text: output }],
              details: { session_id: sessionId, output },
            });
          },
        );

        return toolResult(waited, sessionId, startedAt);
      });
    },
    renderCall(args, theme, context) {
      const state = context.state as RenderState;
      startRenderTimer(state, context.executionStarted);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const label = args.chars
        ? `Wrote to session ${args.session_id}`
        : `${context.isPartial ? "Waiting" : "Waited"} for session ${args.session_id}`;
      const input = args.chars ? ` · ${previewInput(args.chars)}` : "";
      text.setText(
        `${theme.fg("toolTitle", theme.bold(args.chars ? "↳" : "•"))} ${theme.fg("dim", sanitizeDisplayText(`${label}${input}`))}`,
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

  pi.on("tool_result", async (event) => {
    if (event.toolName !== EXEC_TOOL && event.toolName !== STDIN_TOOL) return;
    const details = event.details as Partial<ToolOutput> | undefined;
    if (details?.cancelled || (details?.exit_code !== undefined && details.exit_code !== 0)) {
      return { isError: true };
    }
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

function windowsShellGuidance(): string {
  return `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;
}

function optionalUnsignedInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function clampExecYield(yieldMs: number): number {
  const minimum = process.platform === "win32" ? MIN_WINDOWS_EXEC_YIELD_MS : MIN_YIELD_MS;
  return Math.min(Math.max(yieldMs, minimum), MAX_WRITE_YIELD_MS);
}

function clampWriteYield(yieldMs: number, emptyPoll: boolean): number {
  const minimum = emptyPoll ? MIN_POLL_YIELD_MS : MIN_YIELD_MS;
  const maximum = emptyPoll ? MAX_POLL_YIELD_MS : MAX_WRITE_YIELD_MS;
  return Math.min(Math.max(yieldMs, minimum), maximum);
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
    // A cancelled waiter must not remove a still-active predecessor's lock.
    void current.then(() => {
      if (locks.get(sessionId) === current) locks.delete(sessionId);
    });
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
  terminateOnAbort = false,
): Promise<WaitResult> {
  const deadline = performance.now() + yieldMs;
  const maxBytes = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS) * 4;
  const output = new OutputBuffer(maxBytes);
  const snapshot = (): WaitResult => ({
    output: output.output,
    originalBytes: output.originalBytes,
    truncated: output.truncated,
    exitCode: null,
  });
  try {
    while (true) {
      signal?.throwIfAborted();
      const poll = runtime.poll(sessionId);
      output.append(poll);
      if (poll.output || poll.omitted_bytes > 0) {
        onOutput(formatOutput(output.output, output.originalBytes, output.truncated));
      }
      if (poll.exit_code !== null) return { ...snapshot(), exitCode: poll.exit_code };

      const remaining = deadline - performance.now();
      if (remaining <= 0) return snapshot();
      await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), signal);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    let exitCode: number | null = null;
    if (terminateOnAbort) {
      runtime.terminate(sessionId);
      exitCode = await drainTerminatedSession(runtime, sessionId, output);
    }
    return { ...snapshot(), exitCode, cancelled: true };
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
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

async function drainTerminatedSession(
  runtime: RuntimeApi,
  sessionId: number,
  output?: OutputBuffer,
): Promise<number | null> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      const poll = runtime.poll(sessionId);
      output?.append(poll);
      if (poll.exit_code !== null) return poll.exit_code;
    } catch {
      return null;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  return null;
}

function toolResult(waited: WaitResult, sessionId: number, startedAt: number) {
  const originalTokenCount = waited.truncated ? Math.ceil(waited.originalBytes / 4) : undefined;
  const details: ToolOutput = {
    wall_time_seconds: Math.round(((performance.now() - startedAt) / 1_000) * 1_000) / 1_000,
    output: formatOutput(waited.output, waited.originalBytes, waited.truncated),
    ...(waited.exitCode === null ? { session_id: sessionId } : { exit_code: waited.exitCode }),
    ...(originalTokenCount === undefined ? {} : { original_token_count: originalTokenCount }),
    ...(waited.cancelled ? { cancelled: true } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function formatOutput(output: string, originalBytes: number, truncated: boolean): string {
  if (!truncated) return output;
  const originalTokenCount = Math.ceil(originalBytes / 4);
  // ponytail: no disk spool; add bounded retention only if recovering omitted output becomes necessary.
  return `${output}\n\n[Output truncated from approximately ${originalTokenCount} tokens. Omitted output is not retained.]`;
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

function sanitizeDisplayText(text: string): string {
  // Strip sequences before controls so escape payloads do not become visible text.
  // Remove leftover introducers too: partial output can end inside a sequence.
  return stripVTControlCharacters(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufff9-\ufffb]/g,
    "",
  );
}

function previewInput(input: string): string {
  const escaped = JSON.stringify(input);
  if ([...escaped].length <= INPUT_PREVIEW_CHARS) return escaped;
  return `${[...escaped].slice(0, INPUT_PREVIEW_CHARS - 4).join("")}..."`;
}

function splitOutputNotice(output: string): { output: string; notice?: string } {
  const match = output.match(
    /\n\n\[(Output truncated from approximately \d+ tokens\.(?: Omitted output is not retained\.)?)\]$/,
  );
  if (!match || match.index === undefined) return { output };
  return {
    output: output.slice(0, match.index),
    notice: match[1],
  };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item): item is { type: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

class ToolCallRenderComponent {
  private readonly text = new Text("", 0, 0);
  private theme: ToolTheme;
  private expanded = false;

  constructor(theme: ToolTheme) {
    this.theme = theme;
  }

  update(command: string, theme: ToolTheme, expanded: boolean): void {
    this.theme = theme;
    this.expanded = expanded;
    this.text.setText(
      `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", sanitizeDisplayText(command))}`,
    );
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    if (this.expanded || lines.length <= CALL_PREVIEW_LINES) return lines;
    const skipped = lines.length - CALL_PREVIEW_LINES;
    const notice = this.theme.fg("muted", `… +${skipped} ${skipped === 1 ? "line" : "lines"}`);
    return [...lines.slice(0, CALL_PREVIEW_LINES), truncateToWidth(notice, width, "...")];
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

class ToolResultRenderComponent extends Container {
  private cachedOutput: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedSkipped: number | undefined;

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
    const output = sanitizeDisplayText(rendered.output).trimEnd();

    if (output) {
      const styledOutput = output
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");
      if (options.expanded) {
        this.addChild(new Text(`\n${styledOutput}`, 0, 0));
      } else {
        this.addChild({
          render: (width: number) => {
            if (this.cachedOutput !== styledOutput || this.cachedWidth !== width) {
              const preview = truncateToVisualLines(styledOutput, OUTPUT_PREVIEW_LINES, width);
              this.cachedOutput = styledOutput;
              this.cachedWidth = width;
              this.cachedLines = preview.visualLines;
              this.cachedSkipped = preview.skippedCount;
            }
            if (!this.cachedSkipped) return ["", ...(this.cachedLines ?? [])];
            const hint =
              theme.fg("muted", `... (${this.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return ["", truncateToWidth(hint, width, "..."), ...(this.cachedLines ?? [])];
          },
          invalidate: () => {
            this.cachedOutput = undefined;
            this.cachedWidth = undefined;
            this.cachedLines = undefined;
            this.cachedSkipped = undefined;
          },
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
  if (details?.cancelled) {
    const session = details.session_id === undefined ? "" : ` · session ${details.session_id}`;
    return `${theme.fg("warning", "Cancelled")}${theme.fg("dim", `${session} · waited ${duration}`)}`;
  }
  if (!details || (isError && details.exit_code === undefined)) {
    return `${theme.fg("error", "Failed")}${theme.fg("dim", ` · took ${duration}`)}`;
  }
  if (details.exit_code === undefined) {
    return `${theme.fg("success", `Session ${details.session_id} running`)}${theme.fg("dim", ` · ${lineCount} · waited ${duration}`)}`;
  }
  const color = details.exit_code === 0 ? "success" : "error";
  return `${theme.fg(color, `Exit ${details.exit_code}`)}${theme.fg("dim", ` · ${lineCount} · took ${duration}`)}`;
}
