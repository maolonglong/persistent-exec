import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [artifacts, platformPackage] = process.argv.slice(2);
if (!artifacts || !platformPackage?.startsWith("persistent-exec-bin-")) {
  throw new Error("usage: node scripts/smoke-packages.mjs <artifacts> <host-platform-package>");
}
const tarballs = [
  platformPackage,
  "persistent-exec-node",
  "persistent-exec-bun",
  "chensl-pi-unified-exec",
].map((name) => {
  const matches = readdirSync(artifacts).filter(
    (file) => file.startsWith(`${name}-`) && file.endsWith(".tgz"),
  );
  assert.equal(matches.length, 1, `expected one tarball for ${name}`);
  return resolve(artifacts, matches[0]);
});
const directory = mkdtempSync(join(tmpdir(), "persistent-exec-package-smoke-"));
const env = { ...process.env };
delete env.PERSISTENT_EXEC_LIBRARY_PATH;
delete env.NODE_PATH;
function run(command, args) {
  execFileSync(command, args, { cwd: directory, env, stdio: "inherit", timeout: 180_000 });
}
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Peer packages belong to the pi host; this check exercises the installed runtime packages.
  run("npm", ["install", "--legacy-peer-deps", "--no-audit", "--no-fund", ...tarballs]);
  const extensionDirectory = join(directory, "node_modules", "@chensl", "pi-unified-exec");
  const manifest = JSON.parse(readFileSync(join(extensionDirectory, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.length > 0);
  for (const entry of manifest.pi.extensions)
    assert.ok(existsSync(join(extensionDirectory, entry)), `missing pi entry: ${entry}`);
  writeFileSync(
    join(directory, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
const { PersistentExecRuntime } = await import(process.argv[2]);
const runtime = PersistentExecRuntime.create();
try {
  const session = runtime.spawn({ cmd: "echo packed-runtime-ok", workdir: process.cwd() });
  let output = "";
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = runtime.poll(session);
    output += result.output;
    if (result.exit_code !== null) {
      assert.equal(result.exit_code, 0);
      assert.equal(output.trim(), "packed-runtime-ok");
      break;
    }
    assert.ok(Date.now() < deadline, "packed runtime did not exit");
    await setTimeout(10);
  }
} finally {
  runtime.destroy();
}
console.log(process.argv[2] + ": isolated tarball smoke passed");
`,
  );
  run(process.execPath, ["smoke.mjs", "persistent-exec-node"]);
  run("bun", ["smoke.mjs", "persistent-exec-bun"]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
