import { copyFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [target, packageName] = process.argv.slice(2);
if (!target || !packageName) {
  throw new Error("usage: node scripts/stage-native.mjs <rust-target> <platform-package>");
}

const filename = target.includes("windows")
  ? "persistent_exec_ffi.dll"
  : target.includes("apple")
    ? "libpersistent_exec_ffi.dylib"
    : "libpersistent_exec_ffi.so";
const targetSource = resolve("target", target, "release", filename);
const hostSource = resolve("target", "release", filename);
const source = existsSync(targetSource) ? targetSource : hostSource;
if (!existsSync(source)) throw new Error(`native library not found: ${targetSource}`);
const packageDirectory = resolve("packages", packageName);
const destination = join(packageDirectory, basename(filename));
copyFileSync(source, destination);
copyFileSync(resolve("LICENSE"), join(packageDirectory, "LICENSE"));
copyFileSync(resolve("NOTICE"), join(packageDirectory, "NOTICE"));
console.log(`${source} -> ${destination}`);
