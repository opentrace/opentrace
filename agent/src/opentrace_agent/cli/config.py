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

"""Project configuration management for OpenTrace.

Manages the ``.opentrace/config.yaml`` file that stores per-project settings
such as the organisation ID or slug.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

CONFIG_NAME = "config.yaml"


def find_config(opentrace_dir: Path | None) -> Path | None:
    """Return the path to an existing config.yaml inside *opentrace_dir*.

    If *opentrace_dir* is ``None`` the function returns ``None``.
    """
    if opentrace_dir is None:
        return None
    candidate = opentrace_dir / CONFIG_NAME
    if candidate.exists():
        return candidate
    return None


def load_config(path: Path) -> dict[str, Any]:
    """Load and return the YAML config at *path*.

    Returns an empty dict when the file is empty or missing.
    """
    if not path.exists():
        return {}
    text = path.read_text()
    if not text.strip():
        return {}
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def save_config(path: Path, data: dict[str, Any]) -> None:
    """Write *data* as YAML to *path*, creating parent directories if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.dump(data, default_flow_style=False, sort_keys=False))
