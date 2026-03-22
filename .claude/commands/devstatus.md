---
name: devstatus
description: |
  Report the current session state: branch, changes, PR status, and a summary.
  Use when: "what's the status", "where are we", "session status", "what have we done"
allowed-tools: Bash, Read, Glob
---

Report the current session state by gathering and presenting the following information.

## Instructions

### 1. Branch and commit info

```bash
git branch --show-current
git log --oneline -5
git log --oneline main..HEAD  # commits ahead of main
```

### 2. Working tree changes

```bash
git status --short
git diff --stat  # unstaged changes summary
git diff --cached --stat  # staged changes summary
```

### 3. Files changed vs main

```bash
git diff --stat main..HEAD  # all files changed on this branch
```

If on main with no branch changes, note that.

### 4. Check for a PR

```bash
gh pr view --json number,url,title,state,reviews,statusCheckRollup,mergeable 2>/dev/null
```

If a PR exists, report:
- PR number, title, and URL
- State (open/merged/closed)
- Review status (approved/changes requested/pending)
- CI check status (passing/failing/pending)
- Whether it's mergeable

If no PR exists, say so.

### 5. Summary

Write a concise summary of the session covering:
- What branch we're on and how it relates to main
- A short description of the changes (read commit messages, not the full diff)
- Current state: clean/dirty working tree, PR status, CI status
- What the likely next step is (e.g. "ready to merge", "needs review", "has uncommitted changes", "needs a PR")

## Output format

Present as a clean status report:

```
## Session Status

**Branch**: feature-branch (5 commits ahead of main)
**Working tree**: clean | N files modified
**PR**: #123 — "Title" (open, approved, CI passing) — URL

### Changes
- commit message 1
- commit message 2
- ...

### Next steps
- [what to do next]
```
