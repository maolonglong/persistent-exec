---
name: releasing
description: Prepares, publishes, and recovers pi-unified-exec releases using the repository scripts and original CI artifacts. Use for release readiness checks, version releases, or failed publication recovery.
---

# Releasing

Coordinate release decisions and verification; leave version changes, release commits, tags, and publishing to the existing scripts and workflow.

## Prepare

1. Read the release and packaging rules in `AGENTS.md`, `scripts/release.mjs`, and `.github/workflows/release.yml`. Determine whether the request authorizes preparation only, publication, or recovery. Never treat a request to optimize or verify the release process as permission to release.
2. Load `managing-changelog` and audit the intended release contents. Record the baseline tag and audited HEAD. Review any later code changes before continuing. Review requests remain read-only; release preparation may update `[Unreleased]`.
3. Choose patch or minor according to `AGENTS.md`; state the proposed version and any migration requirements. Inspect local changes rather than discarding them. Commit only the intended preparation changes using the repository commit policy before running the clean-worktree preflight.
4. On the intended clean local `main`, run `npm run release:patch -- --check` (or `release:minor`). This fetches remote state and checks the branch, versions, changelog, and target tag without changing worktree files, creating commits/tags, or pushing. It does not run builds or tests. If main is behind or diverged, resolve that deliberately and re-audit; do not reset away work.
5. Run the affected checks required by `AGENTS.md`. Verify packed artifacts outside the repository so the SDK cannot fall back to `target/debug` or `target/release`. On a Linux x64 GNU host, the local packaging check is:

   ```bash
   make build-release
   node scripts/stage-native.mjs x86_64-unknown-linux-gnu persistent-exec-bin-linux-x64-gnu
   artifacts=$(mktemp -d)
   npm pack ./packages/persistent-exec-bin-linux-x64-gnu --pack-destination "$artifacts"
   npm pack ./packages/persistent-exec-node --pack-destination "$artifacts"
   npm pack ./packages/persistent-exec-bun --pack-destination "$artifacts"
   npm pack ./packages/pi-unified-exec --pack-destination "$artifacts"
   node scripts/smoke-packages.mjs "$artifacts" persistent-exec-bin-linux-x64-gnu
   rm -r "$artifacts"
   ```

   Inspect pack contents for the native library, `LICENSE`, and `NOTICE`. Clean up the temporary artifact directory even on failure. The smoke check runs the installed Node/Bun runtime APIs and checks pi entrypoint files; it does not launch a real pi host. Release CI repeats the smoke check against the actual Linux x64 GNU release tarballs before publication. Other platforms retain their build and normal CI coverage, not equivalent packed-runtime smoke coverage.
6. For preparation-only requests, stop with the audit, proposed version, verification results, and blockers. Do not invoke the publishing command.

## Publish

1. Obtain explicit authorization for npm publication before invoking `npm run release:patch` or `npm run release:minor` without `-- --check`. Both commands push main and the release tag automatically. If already authorized for this release, do not ask again.
2. Run the selected command once. It updates versions and notes, runs formatting/lint/tests/release build, creates the release commit/tag and next-cycle commit, then pushes main and the tag atomically.
3. Inspect the tag's release workflow. Success means artifact validation and the isolated smoke check passed, all npm packages published or matched existing integrity, and the GitHub Release became public. Verify exact npm versions and the public release notes before reporting completion. Do not infer publication from a local tag or a successful push alone.

## Recover by observed state

Inspect the worktree, local and remote refs, original workflow jobs/artifacts, and npm package versions before taking action. Do not rerun the version-bumping command blindly.

- **Failure before release commit/tag:** preserve the script's partial changes and diagnose the failed step. Report the exact state; do not manually complete the remaining release steps or reset unrelated work. If restoring the known pre-release state is necessary, obtain approval for that restoration first.
- **Local release commit/tag exists, push failed:** verify the tag target, next-cycle commit, and remote refs. Under the existing release authorization, retry the atomic push of those same refs only when they are the intended release. Do not create a new tag or rerun the bump.
- **CI failed after the tag was pushed:** prefer rerunning only failed jobs of the original run. Once any npm package exists, never rerun successful build jobs or rebuild the tag. The publisher skips existing versions only when their tarball integrity matches.
- **Recovery needs updated workflow code:** with publication authorization, dispatch `.github/workflows/release.yml` using the original `release_tag`, the deliberately chosen recovery `source_ref`, the original `artifact_run_id`, and `publish: true`. Inspect those inputs before dispatch; omitting the artifact run would rebuild packages. If original artifacts are unavailable or integrity differs, stop rather than substituting new bytes for an existing version.
- **Only final GitHub publication failed:** rerun that failed job; do not republish npm or recreate a public release.
- **Published package is defective:** use a corrective version. Never delete a public release, retag, unpublish, or move dist-tags as recovery.

Report the release URL, workflow result, npm verification, and any remaining blocker. Preparation, push, npm publication, and public GitHub Release are distinct outcomes.
