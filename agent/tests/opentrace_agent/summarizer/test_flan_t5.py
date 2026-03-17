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

"""Tests for FlanT5Summarizer (without actual model loading)."""

from __future__ import annotations

import pytest

from opentrace_agent.summarizer.base import SummarizerConfig
from opentrace_agent.summarizer.flan_t5 import FlanT5Summarizer


class TestFlanT5Summarizer:
    def test_init_without_calling_init_raises(self):
        cfg = SummarizerConfig(enabled=True)
        summarizer = FlanT5Summarizer(cfg)
        with pytest.raises(RuntimeError, match="not initialized"):
            import asyncio

            asyncio.run(summarizer.summarize("code", "function"))

    @pytest.mark.anyio
    async def test_summarize_raises_without_init(self):
        cfg = SummarizerConfig(enabled=True)
        summarizer = FlanT5Summarizer(cfg)
        with pytest.raises(RuntimeError, match="not initialized"):
            await summarizer.summarize("def foo(): pass", "function")

    @pytest.mark.anyio
    async def test_dispose_clears_model(self):
        cfg = SummarizerConfig(enabled=True)
        summarizer = FlanT5Summarizer(cfg)
        # Manually set internals to verify dispose clears them
        summarizer._model = object()  # type: ignore[assignment]
        summarizer._tokenizer = object()  # type: ignore[assignment]
        await summarizer.dispose()
        assert summarizer._model is None
        assert summarizer._tokenizer is None

    @pytest.mark.anyio
    async def test_summarize_batch_raises_without_init(self):
        """Batch summarization should raise RuntimeError without init()."""
        cfg = SummarizerConfig(enabled=True)
        summarizer = FlanT5Summarizer(cfg)
        with pytest.raises(RuntimeError, match="not initialized"):
            await summarizer.summarize_batch(
                [
                    ("def foo(): pass", "function"),
                    ("class Bar: pass", "class"),
                ]
            )

    @pytest.mark.anyio
    async def test_summarize_batch_empty_input(self):
        """Batch summarization with empty input should return empty list."""
        cfg = SummarizerConfig(enabled=True)
        summarizer = FlanT5Summarizer(cfg)
        results = await summarizer.summarize_batch([])
        assert results == []
