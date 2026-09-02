#!/bin/sh
# Copyright 2026 OpenTrace Contributors
# Licensed under the Apache License, Version 2.0 — see LICENSE
#
# Regression guard: fail if the built bundle contains anything that only
# works under Bun. Catches Bun.spawn / Bun.which / `bun:` protocol
# imports / the `// @bun` header — any of these will silently break the
# plugin in OpenCode Desktop, which loads plugins via a Node-based
# Electron utility process. See plugins/opencode/src/util/process.ts
# for the cross-runtime helpers that replace the Bun-only APIs.
set -eu

dist="${1:-dist/index.js}"

if [ ! -f "$dist" ]; then
  echo "check-dist-portable: $dist not found — run 'bun run build' first." >&2
  exit 2
fi

fail=0

# `// @bun` header — bun bundler stamps this when --target bun is used.
if head -1 "$dist" | grep -q '^// @bun'; then
  echo "check-dist-portable: FAIL — dist starts with '// @bun'. Use --target node." >&2
  fail=1
fi

# `bun:` protocol imports (bun:test, bun:sqlite, etc.) — Node ESM loader
# rejects these outright on the desktop sidecar.
if grep -nE '"bun:[a-z]+' "$dist" >&2; then
  echo "check-dist-portable: FAIL — dist contains bun: protocol imports (see above)." >&2
  fail=1
fi

# Direct Bun.* runtime calls — these throw ReferenceError under Node.
# Scoped to the known-problem APIs so we don't false-positive on the
# string "Bun" in comments / docstrings.
if grep -nE '\bBun\.(spawn|spawnSync|which|file|\$|env|argv|build|serve)\b' "$dist" >&2; then
  echo "check-dist-portable: FAIL — dist references Bun runtime APIs (see above)." >&2
  fail=1
fi

if [ $fail -ne 0 ]; then
  echo "check-dist-portable: bundle is not portable to Node. Fix the offending source and rebuild." >&2
  exit 1
fi

echo "check-dist-portable: ok — bundle is portable to both Bun and Node."
