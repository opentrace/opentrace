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

"""Registry for managing available sources."""

from __future__ import annotations

import logging

from opentrace_agent.sources.base import Source

logger = logging.getLogger(__name__)


class SourceRegistry:
    """Central registry mapping source_type -> Source instance."""

    def __init__(self) -> None:
        self._sources: dict[str, Source] = {}

    def register(self, source: Source) -> None:
        self._sources[source.source_type] = source
        logger.debug("Registered source '%s'", source.source_type)

    def get(self, source_type: str) -> Source | None:
        return self._sources.get(source_type)

    @property
    def all_sources(self) -> dict[str, Source]:
        return dict(self._sources)
