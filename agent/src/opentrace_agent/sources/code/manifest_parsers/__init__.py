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

"""Manifest parsers subpackage — re-exports all public symbols."""

from opentrace_agent.sources.code.manifest_parsers.cargo_parser import (  # noqa: F401
    parse_cargo_toml,
)
from opentrace_agent.sources.code.manifest_parsers.dispatcher import (  # noqa: F401
    _LOCK_NAMES,
    _MANIFEST_NAMES,
    is_manifest_file,
    parse_manifest,
    parse_manifest_result,
)
from opentrace_agent.sources.code.manifest_parsers.go_parser import (  # noqa: F401
    extract_go_module_path,
    parse_go_mod,
)
from opentrace_agent.sources.code.manifest_parsers.npm_parser import (  # noqa: F401
    parse_package_json,
)
from opentrace_agent.sources.code.manifest_parsers.pip_parser import (  # noqa: F401
    normalize_py_name,
    parse_requirements_txt,
)
from opentrace_agent.sources.code.manifest_parsers.pyproject_parser import (  # noqa: F401
    parse_pyproject_toml,
)
from opentrace_agent.sources.code.manifest_parsers.types import (  # noqa: F401
    ManifestParseResult,
    ParsedDependency,
)
