---
name: pr
description: |
  Run all checks (fmt, lint, license, tests), commit, push, and create a PR.
  Use when: "create a pr", "open a pr", "push and pr", "ship it"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

Prepare, validate, and create a pull request. Run all checks before pushing.

## Arguments
$ARGUMENTS

## Instructions

### 1. Check current state

```bash
git branch --show-current
git status --short
git diff --stat main..HEAD
```

If on main, ask the user for a branch name. If there are no changes vs main, stop.

### 2. Run formatting

```bash
make fmt
```

If any files were reformatted, stage and commit them:
```
style: apply formatting

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

### 3. Run lint

```bash
make lint
```

If lint fails, fix the issues, then re-run until clean. Commit fixes if needed.

### 4. Run license check

```bash
make license-fix
```

If any files were updated with license headers, stage and commit:
```
chore: add license headers

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

### 5. Run tests

```bash
make test
```

If tests fail, investigate and fix. Do NOT skip failing tests.

### 6. Push

```bash
git push -u origin HEAD
```

### 7. Create the PR

Analyze ALL commits on the branch (not just the latest) to write the PR:

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```

Create the PR:
```bash
gh pr create --title "<short title>" --body "$(cat <<'PREOF'
## Summary
<1-3 bullet points covering all changes>

## Test plan
<bulleted checklist>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

If a PR already exists for this branch, update it instead:
```bash
gh pr edit <number> --title "..." --body "..."
```

### 8. Report

Print the PR URL and a one-line summary.

### Guidelines

- Keep PR titles under 70 characters
- Run checks in order: fmt → lint → license → tests → push → PR
- If any check fails and you can't fix it, stop and explain — don't push broken code
- Don't commit unrelated changes (`.env`, `node_modules`, etc.)
- If the user provided arguments, use them as the PR title or description hint
