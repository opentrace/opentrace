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

"""Tree-sitter based symbol extractors for source code analysis."""

from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    DerivationRef,
    ExtractionResult,
    SymbolExtractor,
    VariableSymbol,
)
from opentrace_agent.sources.code.extractors.go_extractor import GoExtractor
from opentrace_agent.sources.code.extractors.python_extractor import PythonExtractor
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor,
)

_DEFAULT_EXTRACTORS: list[SymbolExtractor] = [
    PythonExtractor(),
    TypeScriptExtractor(),
    GoExtractor(),
]

PARSEABLE_EXTENSIONS: frozenset[str] = frozenset().union(*(frozenset(ext.extensions) for ext in _DEFAULT_EXTRACTORS))

__all__ = [
    "CallRef",
    "CodeSymbol",
    "DerivationRef",
    "ExtractionResult",
    "PARSEABLE_EXTENSIONS",
    "PythonExtractor",
    "SymbolExtractor",
    "TypeScriptExtractor",
    "VariableSymbol",
]
