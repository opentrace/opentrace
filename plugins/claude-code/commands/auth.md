Set up a git personal access token (PAT) so OpenTrace can clone and index **private** repositories.

## Arguments
$ARGUMENTS

## Instructions

1. **Check whether a token is already available.** A PAT is only needed for private repos; public repos index without one. Look for an already-resolvable token:
   ```bash
   uvx opentraceai auth git --status 2>/dev/null
   ```
   Also note that `OPENTRACE_GIT_TOKEN`, `GITHUB_TOKEN`, or `GITLAB_TOKEN` in the environment are used automatically. If a token is already stored or exported, tell the user they're set and stop here (unless they explicitly want to replace it).

2. **Onboard a new token.** PAT entry is interactive and the token is a secret, so it must **not** be typed through the chat. Ask the user to run this themselves in the terminal (the `!` prefix runs it in this session with hidden input):
   ```
   ! uvx opentraceai auth git --host github.com
   ```
   For GitLab or a self-hosted host, pass the appropriate `--host` (e.g. `--host gitlab.com`). The command validates the token against the provider before storing it, encrypts it at rest in `~/.opentrace/git_tokens.json` with a machine-bound key, and never echoes it back.

3. **Confirm.** After they run it, re-run `uvx opentraceai auth git --status` to confirm the host now appears. Let them know private repos on that host can now be indexed with `/index <git-url>` or the `repo_index` tool.

## Notes
- `uvx opentraceai auth git --clear` removes all stored git PATs.
- Never ask the user to paste a PAT into the chat, and never put a token in a tool argument — the CLI resolves the stored token automatically during indexing.
