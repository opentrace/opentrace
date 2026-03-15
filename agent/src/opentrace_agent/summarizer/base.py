"""Summarizer protocol and configuration."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, Sequence


NodeKind = Literal["function", "class", "file", "directory"]

PROMPT_TEMPLATES: dict[NodeKind, str] = {
    "function": "Summarize what this function does in one sentence:\n\n",
    "class": "Summarize what this class does in one sentence:\n\n",
    "file": "Summarize what this source file does in one sentence:\n\n",
    "directory": "Describe the purpose of this directory in one sentence based on its contents:\n\n",
}


@dataclass
class SummarizerConfig:
    """Configuration for the summarization system."""

    enabled: bool = True
    model: str = "Xenova/flan-t5-small"
    max_input_length: int = 480
    batch_size: int = 8
    cache_dir: str | None = None


class Summarizer(Protocol):
    """Interface for code summarization backends."""

    async def init(self) -> None:
        """Load the model into memory."""
        ...

    async def summarize(self, source: str, kind: NodeKind) -> str:
        """Generate a one-sentence summary for a code snippet."""
        ...

    async def summarize_batch(
        self,
        items: Sequence[tuple[str, NodeKind]],
    ) -> list[str]:
        """Summarize multiple items. Default loops over summarize()."""
        ...

    async def dispose(self) -> None:
        """Release model resources."""
        ...
