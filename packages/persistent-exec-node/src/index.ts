import {
  DataType,
  isNullPointer,
  load,
  open,
  restorePointer,
  type JsExternal,
  wrapPointer,
} from "ffi-rs";
import { findBinary } from "./binary.js";

const LIBRARY_KEY = "persistent_exec_ffi";
const API_VERSION = 1;
let loaded = false;

export interface SpawnOptions {
  cmd: string;
  workdir: string;
  tty?: boolean;
}

export interface NativePollResult {
  output: string;
  omitted_bytes: number;
  exit_code: number | null;
}

export class PersistentExecError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "PersistentExecError";
  }
}

interface RawResult {
  success: number;
  error_code: number;
  error: JsExternal;
  handle: JsExternal;
  data: JsExternal;
  int_value: number;
}

interface CallResult {
  handle: JsExternal;
  data: string | null;
  intValue: number;
}

const RESULT_STRUCT = {
  success: DataType.U8,
  error_code: DataType.U32,
  error: DataType.External,
  handle: DataType.External,
  data: DataType.External,
  int_value: DataType.I64,
};

function ensureLoaded(): void {
  if (loaded) return;
  open({ library: LIBRARY_KEY, path: findBinary() });
  loaded = true;
}

function readCString(pointer: JsExternal): string | null {
  if (isNullPointer(pointer)) return null;
  const [value] = restorePointer({
    retType: [DataType.String],
    paramsValue: wrapPointer([pointer]),
  });
  return value as string;
}

function call(functionName: string, handle?: JsExternal, request?: object): CallResult {
  ensureLoaded();
  const paramsType = handle ? [DataType.External, DataType.String] : [];
  const paramsValue = handle ? [handle, JSON.stringify({ version: API_VERSION, ...request })] : [];
  const pointer = load({
    library: LIBRARY_KEY,
    funcName: functionName,
    retType: DataType.External,
    paramsType,
    paramsValue,
    freeResultMemory: false,
  }) as JsExternal;
  if (isNullPointer(pointer)) throw new Error(`${functionName} returned a null result`);

  const [result] = restorePointer({
    retType: [RESULT_STRUCT],
    paramsValue: wrapPointer([pointer]),
  }) as unknown as [RawResult];
  const error = readCString(result.error);
  const data = readCString(result.data);
  load({
    library: LIBRARY_KEY,
    funcName: "persistent_exec_free_result",
    retType: DataType.Void,
    paramsType: [DataType.External],
    paramsValue: [pointer],
  });

  if (!result.success) {
    throw new PersistentExecError(result.error_code, error ?? "unknown native error");
  }
  return {
    handle: result.handle,
    data,
    intValue: Number(result.int_value),
  };
}

export class PersistentExecRuntime {
  private handle: JsExternal | null;

  private constructor(handle: JsExternal) {
    this.handle = handle;
  }

  static create(): PersistentExecRuntime {
    const result = call("persistent_exec_create");
    if (isNullPointer(result.handle)) throw new Error("native runtime handle is null");
    return new PersistentExecRuntime(result.handle);
  }

  spawn(options: SpawnOptions): number {
    const result = call("persistent_exec_spawn", this.ensureAlive(), options);
    return result.intValue;
  }

  write(sessionId: number, chars = ""): void {
    call("persistent_exec_write", this.ensureAlive(), {
      session_id: sessionId,
      chars,
    });
  }

  poll(sessionId: number): NativePollResult {
    const result = call("persistent_exec_poll", this.ensureAlive(), {
      session_id: sessionId,
    });
    const data = result.data;
    if (!data) throw new Error("native poll returned no data");
    return JSON.parse(data) as NativePollResult;
  }

  terminate(sessionId: number): void {
    call("persistent_exec_terminate", this.ensureAlive(), {
      session_id: sessionId,
    });
  }

  destroy(): void {
    if (!this.handle) return;
    ensureLoaded();
    load({
      library: LIBRARY_KEY,
      funcName: "persistent_exec_destroy",
      retType: DataType.Void,
      paramsType: [DataType.External],
      paramsValue: [this.handle],
    });
    this.handle = null;
  }

  private ensureAlive(): JsExternal {
    if (!this.handle) throw new Error("persistent-exec runtime has been destroyed");
    return this.handle;
  }
}
