import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

function withChangelog(contents, callback) {
  const directory = mkdtempSync(
    join(tmpdir(), "persistent-exec-release-notes-"),
  );
  const changelogPath = join(directory, "CHANGELOG.md");
  writeFileSync(changelogPath, contents);
  try {
    callback(changelogPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("extracts one released changelog section as GitHub Release notes", () => {
  withChangelog(
    `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Next fix.\n\n## [1.2.3] - 2026-09-07\n\n### Added\n\n- New feature.\n\n## [1.2.2] - 2026-09-01\n\n- Previous release.\n`,
    (changelogPath) => {
      const notes = execFileSync(
        "node",
        ["scripts/release-notes.mjs", "1.2.3", changelogPath],
        {
          encoding: "utf8",
        },
      );
      assert.equal(
        notes,
        "## persistent-exec v1.2.3\n\n### Added\n\n- New feature.\n",
      );
    },
  );
});

test("rejects release notes without a matching changelog section", () => {
  withChangelog("# Changelog\n\n## [Unreleased]\n", (changelogPath) => {
    assert.throws(
      () =>
        execFileSync(
          "node",
          ["scripts/release-notes.mjs", "1.2.3", changelogPath],
          {
            stdio: "pipe",
          },
        ),
      /missing pi-persistent-exec changelog entry/,
    );
  });
});
