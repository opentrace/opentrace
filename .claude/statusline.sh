#!/usr/bin/env bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "unknown"')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')

if [ -n "$ctx_size" ]; then
  ctx_size_fmt=$(awk -v n="$ctx_size" 'BEGIN { if (n >= 1000000) printf "%.0fM", n/1000000; else if (n >= 1000) printf "%.0fK", n/1000; else printf "%d", n }')
else
  ctx_size_fmt="?"
fi

# Worktree name from JSON input
worktree_name=$(echo "$input" | jq -r '.worktree.name // empty')

# Git branch — use cwd from JSON so git runs in the right directory
branch=""
worktree_label=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null \
           || GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-parse --short HEAD 2>/dev/null \
           || echo "")
  gitdir=$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" rev-parse --git-dir 2>/dev/null)
  if [ -n "$gitdir" ] && [ -f "$gitdir/commondir" ]; then
    if [ -n "$worktree_name" ]; then
      worktree_label=" [worktree: $worktree_name]"
    else
      worktree_label=" [worktree]"
    fi
  fi
fi

out="$model | ctx: $ctx_size_fmt"
if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  out="$out | ${used_int}% used"
fi
if [ -n "$branch" ]; then
  out="$out | $branch$worktree_label"
elif [ -n "$worktree_label" ]; then
  out="$out |$worktree_label"
fi

printf "%s" "$out"
