import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const platformPackages = [
  { name: "persistent-exec-bin-darwin-arm64", required: "libpersistent_exec_ffi.dylib" },
  { name: "persistent-exec-bin-darwin-x64", required: "libpersistent_exec_ffi.dylib" },
  { name: "persistent-exec-bin-linux-arm64-gnu", required: "libpersistent_exec_ffi.so" },
  { name: "persistent-exec-bin-linux-arm64-musl", required: "libpersistent_exec_ffi.so" },
  { name: "persistent-exec-bin-linux-x64-gnu", required: "libpersistent_exec_ffi.so" },
  { name: "persistent-exec-bin-linux-x64-musl", required: "libpersistent_exec_ffi.so" },
  { name: "persistent-exec-bin-win32-arm64", required: "persistent_exec_ffi.dll" },
  { name: "persistent-exec-bin-win32-x64", required: "persistent_exec_ffi.dll" },
];
const packages = [
  ...platformPackages,
  { name: "persistent-exec-node", required: "dist/index.js" },
  { name: "persistent-exec-bun", required: "dist/index.js" },
  { name: "pi-persistent-exec", required: "src/index.ts" },
];

const [artifactDirectory, releaseTag] = process.argv.slice(2);
if (!artifactDirectory || !releaseTag) {
  throw new Error("usage: node scripts/publish-packages.mjs <artifacts> <vX.Y.Z>");
}
const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`invalid release version: ${releaseTag}`);
}
const prerelease = version.split("-", 2)[1];
const prereleaseTag = prerelease?.split(".", 1)[0];
const npmTag =
  prereleaseTag && prereleaseTag !== "latest" && /^[A-Za-z][0-9A-Za-z-]*$/.test(prereleaseTag)
    ? prereleaseTag
    : prerelease
      ? "next"
      : "latest";

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout;
}

const candidates = packages.map(({ name, required }) => {
  const filename = `${name}-${version}.tgz`;
  const tarball = resolve(artifactDirectory, filename);
  if (!existsSync(tarball)) throw new Error(`missing release artifact: ${filename}`);

  const entries = new Set(commandOutput("tar", ["-tzf", tarball]).split("\n").filter(Boolean));
  for (const path of ["package/LICENSE", "package/NOTICE", `package/${required}`]) {
    if (!entries.has(path)) throw new Error(`${filename} is missing ${path}`);
  }
  const manifest = JSON.parse(commandOutput("tar", ["-xOzf", tarball, "package/package.json"]));
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(
      `${filename} contains ${manifest.name}@${manifest.version}, expected ${name}@${version}`,
    );
  }
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  return { name, tarball, integrity, manifest };
});

const candidatesByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
function requireExactDependencies(packageName, section, expectedNames) {
  const manifest = candidatesByName.get(packageName)?.manifest;
  const dependencies = manifest?.[section] ?? {};
  const actualNames = Object.keys(dependencies)
    .filter((name) => name.startsWith("persistent-exec-"))
    .sort();
  const sortedExpectedNames = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(sortedExpectedNames)) {
    throw new Error(
      `${packageName} ${section} contains [${actualNames.join(", ")}], expected [${sortedExpectedNames.join(", ")}]`,
    );
  }
  for (const dependencyName of expectedNames) {
    if (dependencies[dependencyName] !== version) {
      throw new Error(
        `${packageName} requires ${dependencyName}@${dependencies[dependencyName] ?? "missing"}; expected ${version}`,
      );
    }
  }
}

const platformPackageNames = platformPackages.map(({ name }) => name);
requireExactDependencies("persistent-exec-node", "optionalDependencies", platformPackageNames);
requireExactDependencies("persistent-exec-bun", "optionalDependencies", platformPackageNames);
requireExactDependencies("pi-persistent-exec", "dependencies", [
  "persistent-exec-node",
  "persistent-exec-bun",
]);

console.log(
  `Validated ${candidates.length} release artifacts for ${version} (npm dist-tag: ${npmTag}).`,
);
if (process.env.PUBLISH_DRY_RUN === "1") {
  for (const { name } of candidates) console.log(`Would publish ${name}@${version}`);
  process.exit(0);
}

for (const { name, tarball, integrity } of candidates) {
  const specifier = `${name}@${version}`;
  const lookup = spawnSync("npm", ["view", specifier, "dist.integrity", "--json"], {
    encoding: "utf8",
  });
  if (lookup.status === 0) {
    const publishedIntegrity = JSON.parse(lookup.stdout);
    if (publishedIntegrity !== integrity) {
      throw new Error(
        `${specifier} already exists with different package contents. Rerun only the failed publish job from the original workflow run so it reuses that run's artifacts; do not rebuild the tag.`,
      );
    }
    console.log(`${specifier} is already published with matching integrity; skipping.`);
    continue;
  }
  const lookupError = `${lookup.stdout}${lookup.stderr}`;
  if (!lookupError.includes("E404")) {
    throw new Error(`failed to check ${specifier}:\n${lookupError}`);
  }

  const published = spawnSync(
    "npm",
    ["publish", tarball, "--access", "public", "--provenance", "--tag", npmTag],
    { stdio: "inherit" },
  );
  if (published.status !== 0) throw new Error(`failed to publish ${specifier}`);
}
