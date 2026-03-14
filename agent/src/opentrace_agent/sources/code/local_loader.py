"""Local code loader — indexes a local directory without cloning."""

from __future__ import annotations

import logging
from pathlib import Path

from opentrace_agent.models.base import TreeWithOrigin
from opentrace_agent.sources.code.directory_walker import DirectoryWalker
from opentrace_agent.sources.code.extractors import (
    GoExtractor,
    PythonExtractor,
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher
from opentrace_agent.sources.code.utils import count_nodes

logger = logging.getLogger(__name__)

_DEFAULT_EXTRACTORS = [PythonExtractor(), TypeScriptExtractor(), GoExtractor()]


class LocalCodeLoader:
    """Indexes a local directory and returns a TreeWithOrigin.

    Unlike GitHubCodeLoader, this reads files directly from the filesystem
    without cloning. Intended for CLI use, not the Source/Loader registry.
    """

    def __init__(
        self,
        walker: DirectoryWalker | None = None,
        attacher: SymbolAttacher | None = None,
    ) -> None:
        self._walker = walker or DirectoryWalker()
        self._attacher = attacher or SymbolAttacher(_DEFAULT_EXTRACTORS)

    def load(self, path: Path, repo_id: str | None = None) -> TreeWithOrigin:
        """Index the directory at *path* and return a tree with counters.

        Args:
            path: Absolute path to the directory to index.
            repo_id: Unique identifier for the repo node. Defaults to the
                directory name.

        Returns:
            A ``TreeWithOrigin`` with the root ``RepoNode`` and counters.
        """
        path = path.resolve()
        if repo_id is None:
            repo_id = path.name

        # 1. Walk directory tree
        repo_node = self._walker.walk(
            root_path=path,
            repo_id=repo_id,
            repo_name=path.name,
        )

        # 2. Attach symbols (extract + resolve calls)
        symbol_counts = self._attacher.attach(repo_node)

        # 3. Count directories and files
        dir_count, file_count = count_nodes(repo_node)

        counters = {
            "repos": 1,
            "directories": dir_count,
            "files": file_count,
            **symbol_counts,
        }

        logger.info("Indexed local path '%s': %s", path, counters)
        return TreeWithOrigin(root=repo_node, origin="code", counters=counters)
