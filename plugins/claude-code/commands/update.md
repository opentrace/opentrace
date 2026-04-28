---
name: update
description: |
  Check for and install updates to the OpenTrace CLI (opentraceai).
  Use when: "update opentraceai", "update cli", "check for updates", "upgrade opentraceai", "new version"
allowed-tools: Bash
---

Check for updates to the OpenTrace CLI (`opentraceai`) and optionally install them.

## Arguments
$ARGUMENTS

## Instructions

1. **Get the installed version**:
   ```bash
   uvx opentraceai --version 2>/dev/null
   ```

2. **Get the latest version from PyPI**:
   ```bash
   curl -sS https://pypi.org/pypi/opentraceai/json | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])"
   ```

3. **Compare versions**:
   - If the installed version matches the latest, tell the user they're up to date.
   - If a newer version is available, show both versions and ask the user if they'd like to upgrade.

4. **Upgrade** (if the user confirms, or if they passed `--yes` or `yes` as an argument):
   ```bash
   uv tool upgrade opentraceai
   ```
   If `opentraceai` is not installed as a uv tool (i.e. the user relies on `uvx`), the cache will refresh automatically on next `uvx` run. In that case, clear the uvx cache to force a fresh install:
   ```bash
   uv cache clean opentraceai
   ```

5. **Verify**: Run `uvx opentraceai --version` to confirm the new version is active.
