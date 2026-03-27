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

"""Parser for Cargo.toml (Rust) manifest files."""

from __future__ import annotations

import re

from opentrace_agent.sources.code.manifest_parsers.types import ParsedDependency


def parse_cargo_toml(content: str, source: str) -> list[ParsedDependency]:
    deps: list[ParsedDependency] = []
    section: str | None = None

    for line in content.splitlines():
        stripped = line.strip()

        if stripped.startswith("["):
            section = stripped.strip("[]").strip()
            continue

        if section in ("dependencies", "dev-dependencies", "build-dependencies"):
            dep_type = {
                "dependencies": "runtime",
                "dev-dependencies": "dev",
                "build-dependencies": "dev",
            }[section]
            if "=" in stripped and not stripped.startswith("#"):
                name, _, value = stripped.partition("=")
                name = name.strip()
                value = value.strip().strip('"')
                # Handle inline table: foo = { version = "1.0", features = [...] }
                if value.startswith("{"):
                    vm = re.search(r'version\s*=\s*"([^"]*)"', value)
                    version = vm.group(1) if vm else "*"
                else:
                    version = value
                deps.append(
                    ParsedDependency(
                        name=name,
                        version=version,
                        registry="crates",
                        source=source,
                        dependency_type=dep_type,
                    )
                )

    return deps
