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

"""Abstract base classes for the Source/Loader two-layer abstraction.

Source = category (e.g., code, issues). Has registered Loaders.
Loader = provider implementation (e.g., GitHubCodeLoader). Produces trees.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

from opentrace_agent.models.base import TreeWithOrigin

logger = logging.getLogger(__name__)


class Loader(ABC):
    """A provider-specific data loader that produces tree structures.

    Each Loader knows how to fetch data from one provider (GitHub, GitLab,
    Linear, etc.) and transform it into a list of TreeWithOrigin.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Identifier for this loader's provider (e.g., 'github', 'gitlab', 'linear')."""
        ...

    @abstractmethod
    async def load(self, config: dict[str, Any]) -> list[TreeWithOrigin]:
        """Load data from the provider and return tree structures.

        Args:
            config: Provider-specific configuration (API keys, repos, etc.)

        Returns:
            List of trees with their origin identifiers.
        """
        ...


class Source(ABC):
    """A category of data (e.g., code, issues) with registered loaders.

    A Source aggregates results from multiple Loaders that each know how
    to fetch this category of data from a specific provider.
    """

    def __init__(self) -> None:
        self._loaders: list[Loader] = []

    @property
    @abstractmethod
    def source_type(self) -> str:
        """Category identifier (e.g., 'code', 'issue')."""
        ...

    def register_loader(self, loader: Loader) -> None:
        """Register a loader for this source category."""
        self._loaders.append(loader)
        logger.debug(
            "Registered loader '%s' for source '%s'",
            loader.provider_name,
            self.source_type,
        )

    @property
    def loaders(self) -> list[Loader]:
        return list(self._loaders)

    async def collect(self, config: dict[str, Any]) -> list[TreeWithOrigin]:
        """Run all registered loaders and aggregate their trees.

        Args:
            config: Full sources config. Each loader receives the subset
                    keyed by its provider_name.

        Returns:
            Aggregated list of trees from all loaders.
        """
        all_trees: list[TreeWithOrigin] = []
        for loader in self._loaders:
            loader_config = config.get(loader.provider_name, {})
            if not loader_config:
                logger.debug(
                    "No config for loader '%s' in source '%s', skipping",
                    loader.provider_name,
                    self.source_type,
                )
                continue
            logger.info(
                "Running loader '%s' for source '%s'",
                loader.provider_name,
                self.source_type,
            )
            trees = await loader.load(loader_config)
            all_trees.extend(trees)
            logger.info(
                "Loader '%s' produced %d tree(s)",
                loader.provider_name,
                len(trees),
            )
        return all_trees
