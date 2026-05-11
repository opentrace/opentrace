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

"""Git repository cloning with token-based authentication."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import git

logger = logging.getLogger(__name__)


def _inject_token(repo_url: str, token: str) -> str:
    """Inject an OAuth2 token into an HTTPS git URL.

    Transforms ``https://github.com/owner/repo`` into
    ``https://oauth2:<token>@github.com/owner/repo``.
    """
    parsed = urlparse(repo_url)
    if parsed.scheme not in ("https", "http"):
        raise ValueError(f"Token auth requires HTTPS URL, got: {repo_url}")
    netloc_with_token = f"oauth2:{token}@{parsed.hostname}"
    if parsed.port:
        netloc_with_token += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc_with_token))


def _clean_env() -> dict[str, str]:
    """Build a minimal environment for git operations.

    Strips GIT_* variables and disables interactive prompts to prevent
    hanging on credential requests.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = ""
    return env


class GitCloner:
    """Clones git repositories to temporary directories."""

    def clone(
        self,
        repo_url: str,
        ref: str | None = None,
        token: str | None = None,
        dest: Path | None = None,
    ) -> Path:
        """Clone a repository and return the path to the clone.

        Args:
            repo_url: HTTPS URL of the repository.
            ref: Branch or tag to check out. If ``None``, uses the repo's default branch.
            token: Personal access token for authentication. Optional.
            dest: Destination directory. A temp directory is created if omitted.

        Returns:
            Path to the cloned repository root.
        """
        url = _inject_token(repo_url, token) if token else repo_url
        clone_dest = dest or Path(tempfile.mkdtemp(prefix="ot-clone-"))

        logger.info("Cloning %s (ref=%s) → %s", repo_url, ref or "default", clone_dest)

        kwargs: dict[str, object] = {
            "depth": 1,
            "env": _clean_env(),
        }
        if ref:
            kwargs["branch"] = ref

        git.Repo.clone_from(url, str(clone_dest), **kwargs)

        logger.info("Clone complete: %s", clone_dest)
        return clone_dest
