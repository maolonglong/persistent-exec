import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const releaseScript = resolve("scripts/release.mjs");
const validNotes = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Preserve command output.\n";

function fixture(t, notes = validNotes) {
  const directory = mkdtempSync(join(tmpdir(), "persistent-exec-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "checkout");
  mkdirSync(cwd);
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  copyFileSync("package.json", join(cwd, "package.json"));
  for (const name of readdirSync("packages")) {
    mkdirSync(join(cwd, "packages", name), { recursive: true });
    copyFileSync(
      join("packages", name, "package.json"),
      join(cwd, "packages", name, "package.json"),
    );
  }
  writeFileSync(join(cwd, "packages/pi-unified-exec/CHANGELOG.md"), notes);
  git("add", ".");
  git("commit", "-m", "fixture");
  const remote = join(directory, "remote.git");
  git("clone", "--bare", cwd, remote);
  git("remote", "add", "origin", remote);
  return {
    cwd,
    git,
    remoteGit: (...args) => git("--git-dir", remote, ...args),
    check: (type = "patch") =>
      spawnSync(process.execPath, [releaseScript, type, "--check"], { cwd, encoding: "utf8" }),
  };
}

test("preflight allows unpublished local commits without changing files or refs", (t) => {
  const { git, remoteGit, check } = fixture(t);
  git("commit", "--allow-empty", "-m", "local preparation");
  const head = git("rev-parse", "HEAD");
  const remoteHead = remoteGit("rev-parse", "main");
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release preflight passed/);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(remoteGit("rev-parse", "main"), remoteHead);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("tag", "--list"), "");
});

for (const [label, notes, error] of [
  [
    "heading-only notes",
    "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [0.1.0] - 2026-01-01\n\n- Old fix.\n",
    /add at least one entry/,
  ],
  ["duplicate Unreleased", `${validNotes}\n## [Unreleased]\n\n- Another fix.\n`, /exactly one/],
  [
    "breaking patch",
    validNotes.replace("### Fixed", "### Breaking Changes"),
    /breaking changes require a minor/,
  ],
]) {
  test(`preflight rejects ${label} before changing files`, (t) => {
    const { git, check } = fixture(t, notes);
    const head = git("rev-parse", "HEAD");
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("rev-parse", "HEAD"), head);
  });
}

test("preflight accepts breaking changes for a minor release", (t) => {
  const { check } = fixture(t, validNotes.replace("### Fixed", "### Breaking Changes"));
  const result = check("minor");
  assert.equal(result.status, 0, result.stderr);
});

for (const location of ["local", "remote"]) {
  test(`preflight rejects an existing ${location} target tag`, (t) => {
    const { git, remoteGit, check } = fixture(t);
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const [major, minor, patch] = version.split(".").map(Number);
    (location === "local" ? git : remoteGit)("tag", `v${major}.${minor}.${patch + 1}`);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release tag .* already exists/);
  });
}

for (const diverged of [false, true]) {
  test(`preflight rejects ${diverged ? "diverged" : "behind"} main`, (t) => {
    const { git, remoteGit, check } = fixture(t);
    const base = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-m", "remote change");
    git("push", "origin", "main");
    git("reset", "--hard", base);
    if (diverged) git("commit", "--allow-empty", "-m", "different local change");
    const remoteHead = remoteGit("rev-parse", "main");
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /behind or diverged/);
    assert.equal(remoteGit("rev-parse", "main"), remoteHead);
  });
}
