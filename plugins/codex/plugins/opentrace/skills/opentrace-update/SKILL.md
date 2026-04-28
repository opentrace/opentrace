---
name: opentrace-update
description: |
  Check for and optionally install updates to the OpenTrace CLI
  (opentraceai). Use this BEFORE manually running `pip` / `uv` update
  commands: it queries PyPI for the canonical latest version, compares
  against installed, and runs the right upgrade command for how the user
  installed it. Trigger phrases: "update opentraceai", "update opentrace
  cli", "check for opentrace updates", "upgrade opentraceai", "new
  opentrace version".
---

Check for updates to the OpenTrace CLI (`opentraceai`) and optionally install
them.

1. **Get the installed version**:
   ```bash
   uvx opentraceai --version 2>/dev/null
   ```

2. **Get the latest version from PyPI**:
   ```bash
   curl -sS https://pypi.org/pypi/opentraceai/json | \
     python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])"
   ```

3. **Compare**:
   - If installed matches latest, tell the user they're up to date.
   - If a newer version is available, show both and ask whether to upgrade.

4. **Upgrade** (if the user confirms, or if they already said "yes"/"upgrade"):
   ```bash
   uv tool upgrade opentraceai
   ```
   If `opentraceai` was installed ad-hoc via `uvx`, `uv tool upgrade` won't
   find it — clear the uvx cache instead to force a fresh pull on next run:
   ```bash
   uv cache clean opentraceai
   ```

5. **Verify**: Run `uvx opentraceai --version` to confirm the new version is
   active.