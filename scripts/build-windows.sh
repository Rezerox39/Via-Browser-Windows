#!/usr/bin/env bash
# Cross-compile a Windows x64 build + NSIS installer from Linux using cargo-xwin.
set -euo pipefail
cd "$(dirname "$0")/.."

export CC_x86_64_pc_windows_msvc=clang
export CFLAGS_x86_64_pc_windows_msvc="-m64"
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=lld-link

rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin || true

npm install
npx tauri build --runner xwin-runner --target x86_64-pc-windows-msvc --bundles nsis
