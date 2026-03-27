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

"""Parser for package.json (npm/yarn/pnpm) manifest files."""

from __future__ import annotations

import json

from opentrace_agent.sources.code.manifest_parsers.types import ParsedDependency

_NPM_SECTIONS = {
    "dependencies": "runtime",
    "devDependencies": "dev",
    "peerDependencies": "peer",
    "optionalDependencies": "optional",
}


def parse_package_json(content: str, source: str) -> list[ParsedDependency]:
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return []
    deps: list[ParsedDependency] = []
    for section, dep_type in _NPM_SECTIONS.items():
        section_data = data.get(section)
        if not isinstance(section_data, dict):
            continue
        for name, version in section_data.items():
            deps.append(
                ParsedDependency(
                    name=name,
                    version=str(version),
                    registry="npm",
                    source=source,
                    dependency_type=dep_type,
                )
            )
    return deps
