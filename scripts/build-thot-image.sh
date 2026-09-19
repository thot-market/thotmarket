#!/usr/bin/env bash
# Build the THOT CVM image, reusing the installed dcap-qvl. Never compiles Rust.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
qvl_binary="${TV_DCAP_QVL:-$(command -v dcap-qvl)}"
test -x "$qvl_binary"
build_context="$(mktemp -d /tmp/thot-verifier.XXXXXX)"
source_context="$(mktemp -d /tmp/thot-source.XXXXXX)"
trap 'rm -rf "$build_context" "$source_context"' EXIT
source_revision="$(git -C "$repo_dir" rev-parse HEAD)"
git -C "$repo_dir" archive "$source_revision" | tar -x -C "$source_context"
cp "$qvl_binary" "$build_context/dcap-qvl"
sha256sum "$build_context/dcap-qvl"
docker build --build-arg "THOT_SOURCE_REVISION=$source_revision" --build-context "verifier=$build_context" -t "${THOT_IMAGE:-thot-demo:dev}" "$source_context"
