#!/usr/bin/env bash
# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# OpenTrace status line fragment for Claude Code.
#
# Reads the Claude Code statusline JSON on stdin and emits a single line
# describing the OpenTrace graph state for the current workspace:
#
#   otrc: idx 2h ago | 12.4k nodes
#   otrc: idx ⚠ stale (3) | 12.4k nodes
#   otrc: no index
#
# Opt in by referencing this script from your settings.json:
#
#   {
#     "statusLine": {
#       "command": "/path/to/plugins/claude-code/statusline.sh"
#     }
#   }
#
# Fails silent: any read/parse error prints nothing rather than breaking
# the user's status line.

set -u

# Read stdin (the Claude Code statusline JSON). We only need the cwd.
input="$(cat 2>/dev/null || true)"
cwd=""
if [ -n "$input" ] && command -v python3 >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('workspace', {}).get('current_dir') or data.get('cwd') or '', end='')
except Exception:
    pass
" 2>/dev/null)"
fi
[ -z "$cwd" ] && cwd="$PWD"

# Walk up to find .opentrace/index.db, stopping at git root or depth 10.
db=""
cur="$cwd"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$cur/.opentrace/index.db" ]; then
    db="$cur/.opentrace/index.db"
    break
  fi
  if [ -e "$cur/.git" ]; then
    break
  fi
  parent="$(dirname "$cur")"
  [ "$parent" = "$cur" ] && break
  cur="$parent"
done

if [ -z "$db" ]; then
  printf 'otrc: no index'
  exit 0
fi

# Age of the index, formatted as "Xs/m/h/d ago".
now="$(date +%s)"
# GNU coreutils uses `-c %Y`; BSD/macOS uses `-f %m`. Try GNU first — on Linux
# `stat -f` means --file-system and prints non-numeric text, which would make
# the arithmetic below abort under `set -u`. Clamp to digits as a backstop.
db_mtime="$(stat -c %Y "$db" 2>/dev/null || stat -f %m "$db" 2>/dev/null || echo 0)"
case "$db_mtime" in
  ''|*[!0-9]*) db_mtime=0 ;;
esac
delta=$(( now - db_mtime ))
if [ "$delta" -lt 60 ]; then
  age="${delta}s ago"
elif [ "$delta" -lt 3600 ]; then
  age="$(( delta / 60 ))m ago"
elif [ "$delta" -lt 86400 ]; then
  age="$(( delta / 3600 ))h ago"
else
  age="$(( delta / 86400 ))d ago"
fi

# Count stale files for this workspace from the hook cache.
uid="$(id -u 2>/dev/null || echo shared)"
cache_dir="${TMPDIR:-/tmp}/opentrace-claude-hooks-${uid}"
staleness="$cache_dir/staleness.json"
stale_count=0
if [ -f "$staleness" ] && command -v python3 >/dev/null 2>&1; then
  stale_count="$(WORKSPACE="$(cd "$cur" 2>/dev/null && pwd -P)" DB_MTIME="$db_mtime" python3 -c "
import json, os, sys
try:
    data = json.load(open('$staleness'))
except Exception:
    print(0); sys.exit(0)
workspace = os.environ.get('WORKSPACE', '')
try:
    db_mtime = float(os.environ.get('DB_MTIME', '0'))
except ValueError:
    db_mtime = 0.0
count = 0
for entry in data.values():
    if not isinstance(entry, dict):
        continue
    if entry.get('workspace') != workspace:
        continue
    try:
        if float(entry.get('mtime', 0)) > db_mtime and os.path.exists(entry.get('path', '')):
            count += 1
    except (TypeError, ValueError):
        continue
print(count)
" 2>/dev/null || echo 0)"
fi

# Node count from cached `opentraceai stats` (best-effort; skip on failure).
nodes_fragment=""
if command -v opentraceai >/dev/null 2>&1; then
  stats="$(opentraceai stats 2>/dev/null | head -1 || true)"
elif command -v uvx >/dev/null 2>&1; then
  stats="$(uvx opentraceai stats 2>/dev/null | head -1 || true)"
else
  stats=""
fi
if [ -n "$stats" ]; then
  # Try to extract a "nodes=N" or "N nodes" fragment cheaply.
  n="$(printf '%s' "$stats" | grep -Eo '[0-9]+[ ]*nodes?' | head -1 | awk '{print $1}')"
  if [ -n "$n" ] && [ "$n" -ge 1000 ]; then
    nodes_fragment=" | $(( n / 1000 )).$(( (n % 1000) / 100 ))k nodes"
  elif [ -n "$n" ]; then
    nodes_fragment=" | ${n} nodes"
  fi
fi

if [ "$stale_count" -gt 0 ]; then
  printf 'otrc: idx ⚠ stale (%s)%s' "$stale_count" "$nodes_fragment"
else
  printf 'otrc: idx %s%s' "$age" "$nodes_fragment"
fi
