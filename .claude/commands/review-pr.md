---
name: review-pr
description: |
  Fetch PR review comments, fix the issues, reply to threads, and push.
  Pass a PR number as argument, or omit to use the current branch's PR.

  Use this command when:
  - "check pr comments", "fix pr feedback", "address review comments"
  - "resolve pr comments", "review-pr", "handle pr comments"
  - After pushing code that has been reviewed
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

Fix all review comments on a pull request, then reply to and resolve each thread.

## Arguments
$ARGUMENTS

## Instructions

### 1. Find the PR

If a PR number was given, use it. Otherwise detect from the current branch:

```
gh pr view --json number,url,headRefName
```

### 2. Fetch review comments

```
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

Parse the JSON to extract:
- `id` — comment ID (for replying)
- `path` — file path
- `line` / `original_line` — line number
- `body` — the review comment text
- `diff_hunk` — surrounding diff context
- `in_reply_to_id` — if set, this is a reply (skip it, handle the root comment only)

Group comments by thread (root `id`). Skip threads that already have a reply from this repo's maintainers indicating the issue is resolved.

### 3. For each unresolved comment

1. **Read** the file at the mentioned path and line
2. **Understand** what the reviewer is asking for
3. **Fix** the issue using Edit (or Write if needed)
4. **Verify** the fix doesn't break anything (run relevant tests if applicable)

### 4. Commit and push

Stage all changed files and create a single commit:
```
fix: address PR review comments

- [one line per fix]

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to the branch.

### 5. Reply and resolve

For each comment thread you fixed, reply with a brief message explaining what was done and referencing the commit SHA:
```
gh api repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies -f body="Fixed in {sha} — {brief description}"
```

### Guidelines

- Fix what was asked — don't refactor surrounding code
- If a comment is a question rather than a change request, reply with an answer instead of making a code change
- If a comment suggests something you disagree with or can't implement, reply explaining why rather than silently skipping it
- Run tests after making changes if the affected code has tests
- Group all fixes into a single commit
