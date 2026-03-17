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

"""Agent configuration — reads the shared config.yaml used by the Go API.

Agent-specific settings live under the ``agent:`` key in the YAML file.
Environment variables with the ``OT_`` prefix override YAML values.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic_settings import BaseSettings

logger = logging.getLogger(__name__)


class AgentConfig(BaseSettings):
    """Configuration for the OpenTrace agent.

    Populated from the ``agent:`` section of config.yaml, then overlaid
    with environment variables using the ``OT_`` prefix.
    Example: OT_OPENTRACE_MCP_URL=https://mcp.example.com/sse
    """

    model_config = {"env_prefix": "OT_"}

    port: int = 50051
    """gRPC server port."""

    log_level: str = "INFO"
    """Logging level (DEBUG, INFO, WARNING, ERROR)."""

    opentrace_mcp_url: str = ""
    """URL of the OpenTrace MCP server (SSE or streamable HTTP endpoint)."""

    opentrace_api_key: str = ""
    """API key for authenticating with the MCP server."""

    sources_config_path: str = ""
    """Path to the YAML file defining source/loader configurations."""

    summarization_enabled: bool = True
    """Enable ML-based node summarization (requires summarization extras)."""

    summarizer_model: str = "Xenova/flan-t5-small"
    """Hugging Face model ID for the summarizer."""

    summarizer_max_input_length: int = 480
    """Maximum input tokens for the summarizer model."""

    summarizer_batch_size: int = 8
    """Number of items to summarize per batch."""

    summarizer_cache_dir: str = ""
    """Custom cache directory for model weights. Empty uses HF default."""


def load_config(config_path: str) -> AgentConfig:
    """Load configuration from the shared YAML file.

    Reads the ``agent:`` section from *config_path*, then lets
    pydantic-settings overlay any ``OT_``-prefixed env vars on top.

    If *config_path* is empty or the file doesn't exist, returns
    defaults (still respecting env vars).
    """
    agent_data: dict[str, Any] = {}

    if config_path:
        import yaml

        try:
            with open(config_path) as f:
                data = yaml.safe_load(f)
            if isinstance(data, dict):
                agent_data = data.get("agent", {})
                if not isinstance(agent_data, dict):
                    agent_data = {}
        except FileNotFoundError:
            logger.warning("Config file not found: %s, using defaults", config_path)

    return AgentConfig(**agent_data)


def load_sources_config(path: str) -> dict[str, Any]:
    """Load source configuration from a YAML file.

    Returns an empty dict if the path is empty or the file doesn't exist.
    """
    if not path:
        return {}

    import yaml

    try:
        with open(path) as f:
            data = yaml.safe_load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
