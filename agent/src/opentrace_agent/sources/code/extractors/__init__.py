"""Tree-sitter based symbol extractors for source code analysis."""

from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    ExtractionResult,
    SymbolExtractor,
)
from opentrace_agent.sources.code.extractors.go_extractor import GoExtractor
from opentrace_agent.sources.code.extractors.python_extractor import PythonExtractor
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor,
)

__all__ = [
    "CallRef",
    "CodeSymbol",
    "ExtractionResult",
    "GoExtractor",
    "PythonExtractor",
    "SymbolExtractor",
    "TypeScriptExtractor",
]
