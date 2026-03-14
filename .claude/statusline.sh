#!/usr/bin/env bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "unknown"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')

if [ -n "$ctx_size" ]; then
  ctx_size_fmt=$(awk -v n="$ctx_size" 'BEGIN { if (n >= 1000000) printf "%.0fM", n/1000000; else if (n >= 1000) printf "%.0fK", n/1000; else printf "%d", n }')
else
  ctx_size_fmt="?"
fi

# Git branch
branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo "")

# Worktree detection
worktree=""
if [ -f "$(git rev-parse --git-dir 2>/dev/null)/commondir" ]; then
  worktree=" [worktree]"
fi

out="$model | ctx: $ctx_size_fmt"
if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  out="$out | ${used_int}% used"
fi
if [ -n "$branch" ]; then
  out="$out | $branch$worktree"
fi

printf "%s" "$out"
