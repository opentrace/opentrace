"""Flan-T5 summarizer using ONNX Runtime via Hugging Face Optimum."""

from __future__ import annotations

import logging
from typing import Sequence

from opentrace_agent.summarizer.base import (
    PROMPT_TEMPLATES,
    NodeKind,
    SummarizerConfig,
)

logger = logging.getLogger(__name__)


class FlanT5Summarizer:
    """Summarizer backed by ``Xenova/flan-t5-small`` (ONNX).

    Requires the ``summarization`` optional dependency group::

        uv pip install opentrace-agent[summarization]

    which installs ``optimum[onnxruntime]`` and ``transformers``.
    """

    def __init__(self, config: SummarizerConfig) -> None:
        self._config = config
        self._model = None
        self._tokenizer = None

    async def init(self) -> None:
        """Load the ONNX model and tokenizer."""
        try:
            from optimum.onnxruntime import ORTModelForSeq2SeqLM
            from transformers import AutoTokenizer
        except ImportError as exc:
            raise ImportError(
                "Summarization requires the 'summarization' extras. "
                "Install with: uv pip install opentrace-agent[summarization]"
            ) from exc

        logger.info("Loading summarizer model: %s", self._config.model)
        self._tokenizer = AutoTokenizer.from_pretrained(self._config.model)
        self._model = ORTModelForSeq2SeqLM.from_pretrained(self._config.model)
        logger.info("Summarizer model loaded")

    async def summarize(self, source: str, kind: NodeKind) -> str:
        """Generate a one-sentence summary for a code snippet."""
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("Summarizer not initialized — call init() first")

        prompt = self._build_prompt(source, kind)

        inputs = self._tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=self._config.max_input_length,
        )
        outputs = self._model.generate(**inputs, max_new_tokens=64)
        return self._tokenizer.decode(outputs[0], skip_special_tokens=True).strip()

    def _build_prompt(self, source: str, kind: NodeKind) -> str:
        max_chars = self._config.max_input_length * 4
        truncated = source[:max_chars] if len(source) > max_chars else source
        return PROMPT_TEMPLATES[kind] + truncated

    async def summarize_batch(
        self,
        items: Sequence[tuple[str, NodeKind]],
    ) -> list[str]:
        """Summarize a batch of items using batched tokenization and generation.

        Pads inputs to equal length and runs a single ``model.generate()``
        call per batch, which is significantly faster than sequential calls.
        """
        if not items:
            return []

        if self._model is None or self._tokenizer is None:
            raise RuntimeError("Summarizer not initialized — call init() first")

        prompts = [self._build_prompt(source, kind) for source, kind in items]

        try:
            inputs = self._tokenizer(
                prompts,
                return_tensors="pt",
                truncation=True,
                max_length=self._config.max_input_length,
                padding=True,
            )
            outputs = self._model.generate(**inputs, max_new_tokens=64)
            results = self._tokenizer.batch_decode(outputs, skip_special_tokens=True)
            return [r.strip() for r in results]
        except Exception:
            # Fall back to sequential on batch failure
            logger.warning(
                "Batch summarization failed, falling back to sequential", exc_info=True
            )
            results: list[str] = []
            for source, kind in items:
                try:
                    summary = await self.summarize(source, kind)
                    results.append(summary)
                except Exception:
                    logger.warning("Failed to summarize item, skipping", exc_info=True)
                    results.append("")
            return results

    async def dispose(self) -> None:
        """Release model resources."""
        self._model = None
        self._tokenizer = None
