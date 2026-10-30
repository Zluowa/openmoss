# Rebuilding the bundled Linux bwrap executable

This directory accompanies Moss distributions containing the standalone Codex `bwrap` executable. The executable is a separate process from Moss/Electron.
It combines the Rust wrapper, the vendored bubblewrap 0.11.2 C sources, and libcap 2.75. This document records the engineering source and relinking path; it is not legal advice.

## Content-addressed source

- `sources/codex-rust-v0.149.0-alpha.4.3-source.tar.gz` is the complete tree at OpenAI Codex commit `e8f485bdf82a4cb9283e3e5305011b7b9d360b38` (SHA-256 `cddf2da29fb67523b9147fe1f9f2d1fa49606c8009dfd09754369cdaf09c4f05`).
- `sources/libcap-2.75.tar.xz` is the exact libcap source archive used by the upstream build tooling (SHA-256 `de4e7e064c9ba451d5234dd46e897d7c71c96a9ebf9a0c445bc04f4742d83632`).
- Bubblewrap license and source are under `codex-rs/vendor/bubblewrap`.
- The Rust/C linkage and wrapper are under `codex-rs/bwrap`.
- The pinned libcap build and target environment are defined by `.github/scripts/install-musl-build-tools.sh`; the release sequence is in `.github/workflows/rust-release.yml`.

## Distribution identity

The release target is the public npm distribution `@openai/codex@0.149.0-alpha.4.3`, not a byte copy of an installed ChatGPT build. The public macOS arm64 npm payload's installed `codex` executable has SHA-256 `1acc7d06740f7bff0863f727eb592c2191a2cc3f63341b41800c54e901981c2d` and reports `codex-cli 0.149.0-alpha.4.3`.

The installed ChatGPT app executable SHA-256 `dd304ffe232fa9e782ed3e5358776d270e394c2fb85cab846f989823f0843313` is retained only as a frozen behavior reference. These distribution hashes are intentionally distinct; private installed bytes are never copied into this repository or used as the public release payload.

## Rebuild and relink

Use an Ubuntu 24.04 x86_64 builder with Rust 1.95.0 and Zig 0.14.0. Extract the Codex archive, verify both source hashes above, install the target declared by the included `rust-toolchain.toml`, then run from the extracted Codex root:

```sh
export TARGET=x86_64-unknown-linux-musl
export GITHUB_ENV="$PWD/rebuild.env"
export RUNNER_TEMP="${RUNNER_TEMP:-/tmp}/codex-bwrap-rebuild"
bash .github/scripts/install-musl-build-tools.sh
set -a
. "$GITHUB_ENV"
set +a
cd codex-rs
cargo build --locked --target "$TARGET" --release --bin bwrap
strip --strip-debug --strip-unneeded "target/$TARGET/release/bwrap"
sha256sum "target/$TARGET/release/bwrap"
```

The install script fetches libcap only after checking the same SHA-256 pinned above. For an offline rebuild, serve the bundled `libcap-2.75.tar.xz` at that script's `libcap_download_url`, without changing its checksum. Modify the vendored bubblewrap source or Rust wrapper before the Cargo step to produce and relink a modified standalone executable.
