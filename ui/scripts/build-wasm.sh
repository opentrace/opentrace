#!/usr/bin/env bash
# Build tree-sitter WASM grammar files for all supported languages.
#
# Usage:
#   npm run build:wasm           (from ui/)
#   bash scripts/build-wasm.sh   (from ui/)
#
# Requires tree-sitter-cli (installed as devDependency).
# Output: ui/public/tree-sitter-*.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(dirname "$SCRIPT_DIR")"
PUBLIC_DIR="$UI_DIR/public"
NODE_MODULES="$UI_DIR/node_modules"

cd "$UI_DIR"

echo "Building tree-sitter WASM grammars..."
echo "Output directory: $PUBLIC_DIR"

# Grammars with standard layout: node_modules/tree-sitter-<name>/
# Format: "npm-package-suffix:output-suffix"
# (npm package is tree-sitter-<npm-suffix>, output is tree-sitter-<output-suffix>.wasm)
STANDARD_GRAMMARS=(
  "python:python"
  "go:go"
  "c:c"
  "cpp:cpp"
  "c-sharp:c_sharp"
  "java:java"
  "kotlin:kotlin"
  "ruby:ruby"
  "rust:rust"
  "swift:swift"
  "bash:bash"
  "json:json"
  "toml:toml"
)

# Build standard grammars
for entry in "${STANDARD_GRAMMARS[@]}"; do
  IFS=':' read -r pkg_suffix out_suffix <<< "$entry"
  pkg_dir="$NODE_MODULES/tree-sitter-$pkg_suffix"
  if [ ! -d "$pkg_dir" ]; then
    echo "  SKIP tree-sitter-$pkg_suffix (not installed)"
    continue
  fi
  echo "  Building tree-sitter-$out_suffix..."
  npx tree-sitter build --wasm -o "$PUBLIC_DIR/tree-sitter-$out_suffix.wasm" "$pkg_dir"
done

# TypeScript / TSX have subdirectory layout
TS_PKG="$NODE_MODULES/tree-sitter-typescript"
if [ -d "$TS_PKG" ]; then
  echo "  Building tree-sitter-typescript..."
  npx tree-sitter build --wasm -o "$PUBLIC_DIR/tree-sitter-typescript.wasm" "$TS_PKG/typescript"

  echo "  Building tree-sitter-tsx..."
  npx tree-sitter build --wasm -o "$PUBLIC_DIR/tree-sitter-tsx.wasm" "$TS_PKG/tsx"
else
  echo "  SKIP tree-sitter-typescript (not installed)"
fi

echo ""
echo "Done. WASM files in $PUBLIC_DIR:"
ls -lh "$PUBLIC_DIR"/tree-sitter-*.wasm
