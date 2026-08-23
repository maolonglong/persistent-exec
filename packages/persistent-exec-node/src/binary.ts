import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "persistent-exec-bin-darwin-arm64",
  "darwin-x64": "persistent-exec-bin-darwin-x64",
  "linux-arm64-gnu": "persistent-exec-bin-linux-arm64-gnu",
  "linux-arm64-musl": "persistent-exec-bin-linux-arm64-musl",
  "linux-x64-gnu": "persistent-exec-bin-linux-x64-gnu",
  "linux-x64-musl": "persistent-exec-bin-linux-x64-musl",
  "win32-arm64": "persistent-exec-bin-win32-arm64",
  "win32-x64": "persistent-exec-bin-win32-x64",
};

function platformKey(): string {
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  let output = "";
  try {
    output = execSync("ldd --version 2>&1", { encoding: "utf8", timeout: 5_000 });
  } catch (error) {
    const result = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }
  const libc = output.toLowerCase().includes("musl") ? "musl" : "gnu";
  return `${process.platform}-${process.arch}-${libc}`;
}

function libraryFilename(): string {
  if (process.platform === "win32") return "persistent_exec_ffi.dll";
  if (process.platform === "darwin") return "libpersistent_exec_ffi.dylib";
  return "libpersistent_exec_ffi.so";
}

export function findBinary(): string {
  const override = process.env.PERSISTENT_EXEC_LIBRARY_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`Native library not found: ${override}`);
    return override;
  }

  const packageName = PLATFORM_PACKAGES[platformKey()];
  if (packageName) {
    try {
      const manifest = require.resolve(`${packageName}/package.json`);
      const candidate = join(dirname(manifest), libraryFilename());
      if (existsSync(candidate)) return candidate;
    } catch {
      // Fall through to development builds.
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  for (const profile of ["debug", "release"]) {
    const candidate = resolve(here, `../../../target/${profile}/${libraryFilename()}`);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "persistent-exec native library not found; build persistent-exec-ffi or install the platform package",
  );
}
