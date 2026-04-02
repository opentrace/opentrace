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

# PR number — cached per branch, refreshed every 5 minutes
pr_number=""
if [ -n "$branch" ] && [ -n "$cwd" ] && command -v gh &>/dev/null; then
  cache_dir="/tmp/statusline-pr-cache"
  mkdir -p "$cache_dir" 2>/dev/null
  cache_key=$(echo "$cwd:$branch" | (md5sum 2>/dev/null || md5 2>/dev/null || echo "default") | cut -d' ' -f1)
  cache_file="$cache_dir/$cache_key"
  now=$(date +%s)
  if [ -f "$cache_file" ]; then
    cache_age=$(( now - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null || echo 0) ))
    if [ "$cache_age" -lt 300 ]; then
      pr_number=$(cat "$cache_file")
      pr_cached=1
    fi
  fi
  if [ -z "$pr_cached" ]; then
    pr_number=$(cd "$cwd" && GIT_OPTIONAL_LOCKS=0 gh pr view "$branch" --json number -q '.number' 2>/dev/null || echo "")
    echo "$pr_number" > "$cache_file" 2>/dev/null
  fi
fi

# Dev server port — find a vite process whose cwd is under this project
dev_port=""
if [ -n "$cwd" ] && [ -d "$cwd" ] && command -v ss &>/dev/null; then
  while IFS= read -r line; do
    port=$(echo "$line" | grep -oP ':\K517[0-9](?=\s)')
    pid=$(echo "$line" | grep -oP 'pid=\K[0-9]+')
    if [ -n "$port" ] && [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      proc_cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
      if [ -n "$proc_cwd" ] && [[ "$proc_cwd" == "$cwd"/* || "$proc_cwd" == "$cwd" ]] \
         && [[ "$proc_cwd" != "$cwd/.claude/worktrees/"* ]]; then
        dev_port="$port"
        break
      fi
    fi
  done < <(ss -tlnp 2>/dev/null | grep '517[0-9]')
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
if [ -n "$pr_number" ]; then
  out="$out | PR #$pr_number"
fi
if [ -n "$dev_port" ]; then
  out="$out | :$dev_port"
fi

printf "%s" "$out"
