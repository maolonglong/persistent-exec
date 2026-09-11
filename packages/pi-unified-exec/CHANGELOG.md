# Changelog

## [0.1.6] - 2026-09-11

### Fixed

- Sanitize terminal control sequences in tool output and call previews before TUI rendering, without changing raw tool results.

## [0.1.5] - 2026-09-08

### Breaking Changes

- The pi extension is now published as `@chensl/pi-unified-exec` instead of `pi-persistent-exec`. Existing users must remove the old package and install the new scoped package.

### Added

- A reproducible release workflow that validates packages before publishing and creates GitHub Releases from this changelog.
