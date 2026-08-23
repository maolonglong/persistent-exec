import { CString, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { findBinary } from "./binary";

const API_VERSION = 1;
const RESULT_SUCCESS = 0;
const RESULT_ERROR_CODE = 4;
const RESULT_ERROR = 8;
const RESULT_HANDLE = 16;
const RESULT_DATA = 24;
const RESULT_INT_VALUE = 32;

const symbols = {
  persistent_exec_create: { args: [], returns: FFIType.ptr },
  persistent_exec_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  persistent_exec_spawn: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.ptr,
  },
  persistent_exec_write: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.ptr,
  },
  persistent_exec_poll: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.ptr,
  },
  persistent_exec_terminate: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.ptr,
  },
  persistent_exec_free_result: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type Library = ReturnType<typeof dlopen<typeof symbols>>;
let library: Library | null = null;

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

interface CallResult {
  handle: number;
  data: string | null;
  intValue: number;
}

function loadLibrary(): Library {
  if (!library) library = dlopen(findBinary(), symbols);
  return library;
}

function encodeString(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

function readCString(pointer: number): string | null {
  if (pointer === 0) return null;
  return new CString(pointer as unknown as Pointer).toString();
}

function call(
  name:
    | "persistent_exec_create"
    | "persistent_exec_spawn"
    | "persistent_exec_write"
    | "persistent_exec_poll"
    | "persistent_exec_terminate",
  handle?: Pointer,
  request?: object,
): CallResult {
  const lib = loadLibrary();
  const resultPointer =
    name === "persistent_exec_create"
      ? lib.symbols.persistent_exec_create()
      : lib.symbols[name](
          handle ?? null,
          ptr(encodeString(JSON.stringify({ version: API_VERSION, ...request }))),
        );
  if (resultPointer === null) throw new Error(`${name} returned a null result`);

  const success = read.u8(resultPointer, RESULT_SUCCESS) !== 0;
  const errorCode = read.u32(resultPointer, RESULT_ERROR_CODE);
  const error = readCString(read.ptr(resultPointer, RESULT_ERROR));
  const nativeHandle = read.ptr(resultPointer, RESULT_HANDLE);
  const data = readCString(read.ptr(resultPointer, RESULT_DATA));
  const intValue = Number(read.i64(resultPointer, RESULT_INT_VALUE));
  lib.symbols.persistent_exec_free_result(resultPointer);

  if (!success) throw new PersistentExecError(errorCode, error ?? "unknown native error");
  return { handle: nativeHandle, data, intValue };
}

export class PersistentExecRuntime {
  private handle: Pointer | null;

  private constructor(handle: Pointer) {
    this.handle = handle;
  }

  static create(): PersistentExecRuntime {
    const result = call("persistent_exec_create");
    if (result.handle === 0) throw new Error("native runtime handle is null");
    return new PersistentExecRuntime(result.handle as unknown as Pointer);
  }

  spawn(options: SpawnOptions): number {
    return call("persistent_exec_spawn", this.ensureAlive(), options).intValue;
  }

  write(sessionId: number, chars = ""): void {
    call("persistent_exec_write", this.ensureAlive(), {
      session_id: sessionId,
      chars,
    });
  }

  poll(sessionId: number): NativePollResult {
    const data = call("persistent_exec_poll", this.ensureAlive(), {
      session_id: sessionId,
    }).data;
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
    loadLibrary().symbols.persistent_exec_destroy(this.handle);
    this.handle = null;
  }

  private ensureAlive(): Pointer {
    if (!this.handle) throw new Error("persistent-exec runtime has been destroyed");
    return this.handle;
  }
}
