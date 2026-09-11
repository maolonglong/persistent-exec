import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [releaseType, mode, ...extra] = process.argv.slice(2);
if (!["patch", "minor"].includes(releaseType) || (mode && mode !== "--check") || extra.length) {
  throw new Error("usage: node scripts/release.mjs <patch|minor> [--check]");
}

const packagePaths = [
  "package.json",
  "packages/persistent-exec-bin-darwin-arm64/package.json",
  "packages/persistent-exec-bin-darwin-x64/package.json",
  "packages/persistent-exec-bin-linux-arm64-gnu/package.json",
  "packages/persistent-exec-bin-linux-arm64-musl/package.json",
  "packages/persistent-exec-bin-linux-x64-gnu/package.json",
  "packages/persistent-exec-bin-linux-x64-musl/package.json",
  "packages/persistent-exec-bin-win32-arm64/package.json",
  "packages/persistent-exec-bin-win32-x64/package.json",
  "packages/persistent-exec-node/package.json",
  "packages/persistent-exec-bun/package.json",
  "packages/pi-unified-exec/package.json",
];
const changelogPath = "packages/pi-unified-exec/CHANGELOG.md";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function nextVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`unsupported current version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return releaseType === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

if (output("git", ["status", "--porcelain"])) {
  throw new Error("release requires a clean worktree");
}
if (output("git", ["branch", "--show-current"]) !== "main") {
  throw new Error("release must run from main");
}

const manifests = new Map(
  packagePaths.map((path) => [path, JSON.parse(readFileSync(path, "utf8"))]),
);
const currentVersion = manifests.get("packages/pi-unified-exec/package.json").version;
if (![...manifests.values()].every((manifest) => manifest.version === currentVersion)) {
  throw new Error("all package manifests must have the same version before release");
}
const version = nextVersion(currentVersion);
const changelog = readFileSync(changelogPath, "utf8");
if (
  [...changelog.matchAll(/^## \[Unreleased\][ \t]*$/gm)].length !== 1 ||
  !/^# Changelog\n\n## \[Unreleased\]/.test(changelog)
) {
  throw new Error("changelog must start with # Changelog and exactly one [Unreleased] section");
}
const unreleased = /^## \[Unreleased\][ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased || !/^- \S.*$/m.test(unreleased[1])) {
  throw new Error(
    "add at least one entry under @chensl/pi-unified-exec's [Unreleased] heading before release",
  );
}
if (releaseType === "patch" && /^### Breaking Changes[ \t]*$/m.test(unreleased[1])) {
  throw new Error("breaking changes require a minor release during 0.x development");
}

if (
  output("git", ["tag", "--list", `v${version}`]) ||
  output("git", ["ls-remote", "--tags", "origin", `refs/tags/v${version}`])
) {
  throw new Error(
    `release tag v${version} already exists; inspect the existing release instead of rerunning`,
  );
}
run("git", ["fetch", "--no-tags", "origin", "main"]);
if (
  output("git", ["merge-base", "HEAD", "FETCH_HEAD"]) !== output("git", ["rev-parse", "FETCH_HEAD"])
) {
  throw new Error("local main is behind or diverged from origin/main");
}
if (mode === "--check") {
  console.log(
    `Release preflight passed for v${version}; no worktree changes, commits, tags, or pushes performed.`,
  );
  process.exit(0);
}

for (const [path, manifest] of manifests) {
  manifest.version = version;
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith("persistent-exec-")) manifest[section][name] = version;
    }
  }
  writeJson(path, manifest);
}

const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
lockfile.version = version;
lockfile.packages[""].version = version;
for (const path of [
  "packages/persistent-exec-node",
  "packages/persistent-exec-bun",
  "packages/pi-unified-exec",
]) {
  const manifest = manifests.get(`${path}/package.json`);
  lockfile.packages[path].version = version;
  for (const section of ["dependencies", "optionalDependencies"]) {
    if (manifest[section]) lockfile.packages[path][section] = manifest[section];
  }
}
writeJson("package-lock.json", lockfile);

const cargoToml = readFileSync("Cargo.toml", "utf8").replace(
  `version = "${currentVersion}"`,
  `version = "${version}"`,
);
if (cargoToml.includes(`version = "${currentVersion}"`))
  throw new Error("failed to update Cargo.toml version");
writeFileSync("Cargo.toml", cargoToml);
let cargoLock = readFileSync("Cargo.lock", "utf8");
for (const crate of ["persistent-exec-core", "persistent-exec-ffi", "persistent-exec-pty"]) {
  const pattern = new RegExp(`(name = "${crate}"\\nversion = ")${currentVersion}(")`);
  if (!pattern.test(cargoLock)) throw new Error(`failed to update ${crate} in Cargo.lock`);
  cargoLock = cargoLock.replace(pattern, `$1${version}$2`);
}
writeFileSync("Cargo.lock", cargoLock);

const date = new Date().toISOString().slice(0, 10);
writeFileSync(changelogPath, changelog.replace("## [Unreleased]", `## [${version}] - ${date}`));

run("make", ["fmt"]);
run("make", ["lint"]);
run("make", ["test"]);
run("make", ["build-release"]);
run("git", ["add", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "packages"]);
run("git", [
  "commit",
  "-m",
  `chore(release): prepare v${version}`,
  "-m",
  `Synchronize package and Rust workspace versions for v${version}. Freeze the current changelog entry before the tag triggers publication.`,
]);
run("git", ["tag", "-a", `v${version}`, "-m", `pi-unified-exec v${version}`]);

const releasedChangelog = readFileSync(changelogPath, "utf8");
writeFileSync(
  changelogPath,
  releasedChangelog.replace("# Changelog\n", "# Changelog\n\n## [Unreleased]\n"),
);
run("git", ["add", changelogPath]);
run("git", [
  "commit",
  "-m",
  "chore(release): start next development cycle",
  "-m",
  "Restore the Unreleased changelog section on main after tagging the release. Keep upcoming user-visible changes separate from the released notes.",
]);
run("git", ["push", "--atomic", "origin", "main", `v${version}`]);
