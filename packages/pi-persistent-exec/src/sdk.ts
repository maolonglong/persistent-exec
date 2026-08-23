import type {
  NativePollResult,
  PersistentExecRuntime as NodeRuntime,
  SpawnOptions,
} from "persistent-exec-node";

export interface RuntimeApi {
  spawn(options: SpawnOptions): number;
  write(sessionId: number, chars?: string): void;
  poll(sessionId: number): NativePollResult;
  terminate(sessionId: number): void;
  destroy(): void;
}

type RuntimeConstructor = {
  create(): RuntimeApi;
};

let sdkPromise: Promise<{ PersistentExecRuntime: RuntimeConstructor }> | null = null;

function detectRuntime(): "bun" | "node" {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return "bun";
  if (process.versions?.bun) return "bun";
  return "node";
}

export function loadSdk(): Promise<{ PersistentExecRuntime: RuntimeConstructor }> {
  if (sdkPromise) return sdkPromise;

  const globalState = globalThis as Record<string, unknown>;
  const cached = globalState.__persistentExecSdkPromise;
  if (cached) {
    sdkPromise = cached as Promise<{ PersistentExecRuntime: RuntimeConstructor }>;
    return sdkPromise;
  }

  const packageName = detectRuntime() === "bun" ? "persistent-exec-bun" : "persistent-exec-node";
  sdkPromise = import(packageName) as Promise<{
    PersistentExecRuntime: typeof NodeRuntime;
  }>;
  globalState.__persistentExecSdkPromise = sdkPromise;
  return sdkPromise;
}
