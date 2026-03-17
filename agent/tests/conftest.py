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

"""Shared test fixtures."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from opentrace_agent.config import AgentConfig
from opentrace_agent.container import AppContainer
from opentrace_agent.graph.mcp_client import MCPToolError


class MockMCPClient:
    """Simple mock that returns success for any tool call via __getattr__."""

    def __init__(self, side_effect=None):
        self._side_effect = side_effect

    def __getattr__(self, name: str) -> AsyncMock:
        if name.startswith("_"):
            raise AttributeError(name)
        return AsyncMock(side_effect=self._side_effect, return_value='{"status": "ok"}')


class ErrorMCPClient:
    """Mock that raises MCPToolError on every tool call."""

    def __getattr__(self, name: str) -> AsyncMock:
        if name.startswith("_"):
            raise AttributeError(name)
        return AsyncMock(side_effect=MCPToolError(name, "something broke"))


@pytest.fixture
def mock_mcp() -> MockMCPClient:
    return MockMCPClient()


@pytest.fixture
def error_mcp() -> ErrorMCPClient:
    return ErrorMCPClient()


@pytest.fixture
def app_container() -> AppContainer:
    """Provide a fresh AppContainer; resets overrides after the test."""
    container = AppContainer(config=AgentConfig())
    yield container  # type: ignore[misc]
    container.reset_override()
