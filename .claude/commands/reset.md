---
name: reset
description: Hard reset to origin/main and clear the chat context.
allowed-tools: Bash
---

Reset the current worktree to match origin/main and clear conversation context.

## Instructions

### 1. Fetch latest and hard reset

```bash
git fetch origin main
git checkout main
git reset --hard origin/main
git clean -fd
```

### 2. Clear context

After the reset completes, run `/clear` to wipe the conversation context.
