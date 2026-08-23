.PHONY: fmt lint test test-node test-bun test-pi build-release

fmt:
	cargo fmt --all
	npx oxfmt packages

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	npm run build
	npm run typecheck

test:
	cargo test --workspace
	cargo build -p persistent-exec-ffi
	npm test

test-node:
	npm test --workspace persistent-exec-node

test-bun:
	bun test packages/persistent-exec-bun/test

test-pi:
	bun test packages/pi-persistent-exec/test

build-release:
	cargo build --release -p persistent-exec-ffi
	npm run build
