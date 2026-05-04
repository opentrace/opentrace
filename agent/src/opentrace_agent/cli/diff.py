# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""``opentraceai diff`` — impact analysis for every uncommitted change.

Lists code files changed in the working tree (or the index, with
``--staged``) and runs the impact analyzer against each one. The aim is a
single command a developer can run before pushing to see the union of
blast radii without manually invoking ``opentraceai impact <file>`` per
edited file.
"""

from __future__ import annotations

import os
import subprocess

from opentrace_agent.cli.impact import run_impact

# Code extensions we run impact analysis on. Kept as a local set so this
# module doesn't pull in the indexer's pipeline-side ``INCLUDED_EXTENSIONS``.
_CODE_EXTENSIONS = frozenset(
    {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".go",
        ".rs",
        ".java",
        ".kt",
        ".rb",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".swift",
    }
)


def _git_changed_files(repo_root: str, *, staged_only: bool) -> list[str]:
    """Return repo-relative paths of code files changed in the working tree.

    Defaults to *all* tracked changes (staged + unstaged), since that's
    what a developer wants to review before pushing. Pass *staged_only*
    to limit to the index. Untracked files are excluded — they have no
    committed baseline to diff against.
    """
    cmd = ["git", "diff", "--name-only"]
    cmd.append("--cached" if staged_only else "HEAD")
    try:
        result = subprocess.run(
            cmd,
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []
    if result.returncode != 0:
        return []

    paths: list[str] = []
    for line in result.stdout.splitlines():
        path = line.strip()
        if not path:
            continue
        if os.path.splitext(path)[1].lower() in _CODE_EXTENSIONS:
            paths.append(path)
    return paths


def run_diff(
    repo_root: str,
    db_path: str | None,
    *,
    staged_only: bool = False,
) -> None:
    """Entry point for the diff subcommand.

    Discovers files changed in the working tree (or the index when
    *staged_only*) and runs ``run_impact`` for each one in turn. No-ops
    silently when there is no graph or no changes — same fail-closed
    posture as the underlying ``impact`` command.
    """
    if not db_path:
        return

    files = _git_changed_files(repo_root, staged_only=staged_only)
    if not files:
        return

    print(f"[OpenTrace] Impact of {len(files)} changed file(s):\n")
    for path in files:
        # Header lets successive impact blocks be read in series.
        print(f"=== {path} ===")
        run_impact(path, db_path)
        print()