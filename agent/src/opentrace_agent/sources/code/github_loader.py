"""GitHub code loader — clones repos and indexes code structure with tree-sitter."""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any

from opentrace_agent.models.base import TreeWithOrigin
from opentrace_agent.sources.base import Loader
from opentrace_agent.sources.code.directory_walker import DirectoryWalker
from opentrace_agent.sources.code.extractors import (
    GoExtractor,
    PythonExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.git_cloner import GitCloner
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher
from opentrace_agent.sources.code.utils import count_nodes

logger = logging.getLogger(__name__)

# Default extractors used when none are provided
_DEFAULT_EXTRACTORS = [PythonExtractor(), TypeScriptExtractor(), GoExtractor()]


class GitHubCodeLoader(Loader):
    """Loads code structure from GitHub repositories via git clone + tree-sitter."""

    def __init__(
        self,
        cloner: GitCloner | None = None,
        walker: DirectoryWalker | None = None,
        attacher: SymbolAttacher | None = None,
    ) -> None:
        self._cloner = cloner or GitCloner()
        self._walker = walker or DirectoryWalker()
        self._attacher = attacher or SymbolAttacher(_DEFAULT_EXTRACTORS)

    @property
    def provider_name(self) -> str:
        return "github"

    async def load(self, config: dict[str, Any]) -> list[TreeWithOrigin]:
        repos = config.get("repos", [])
        if not repos:
            logger.warning("No repos configured for GitHub code loader")
            return []

        trees: list[TreeWithOrigin] = []
        for repo_spec in repos:
            try:
                tree = self._process_repo(repo_spec)
                trees.append(tree)
            except Exception:
                owner = repo_spec.get("owner", "?")
                name = repo_spec.get("name", "?")
                logger.exception("Failed to process repo %s/%s", owner, name)

        return trees

    def _process_repo(self, repo_spec: dict[str, Any]) -> TreeWithOrigin:
        owner = repo_spec.get("owner", "unknown")
        repo_name = repo_spec.get("name", "unknown")
        branch = repo_spec.get("branch", "main")
        token = repo_spec.get("token")
        full_name = f"{owner}/{repo_name}"
        repo_url = f"https://github.com/{full_name}"

        tmp_dir = Path(tempfile.mkdtemp(prefix="ot-loader-"))
        try:
            # 1. Clone
            clone_path = self._cloner.clone(
                repo_url=repo_url,
                ref=branch,
                token=token,
                dest=tmp_dir,
            )

            # 2. Walk directory tree
            repo_node = self._walker.walk(
                root_path=clone_path,
                repo_id=full_name,
                repo_name=repo_name,
                url=repo_url,
                default_branch=branch,
            )

            # 3. Attach symbols
            symbol_counts = self._attacher.attach(repo_node)

            # 4. Count directories and files from the tree
            dir_count, file_count = count_nodes(repo_node)

            counters = {
                "repos": 1,
                "directories": dir_count,
                "files": file_count,
                **symbol_counts,
            }

            logger.info("Indexed repo '%s': %s", full_name, counters)
            return TreeWithOrigin(root=repo_node, origin="code", counters=counters)
        finally:
            # 5. Cleanup
            shutil.rmtree(tmp_dir, ignore_errors=True)
