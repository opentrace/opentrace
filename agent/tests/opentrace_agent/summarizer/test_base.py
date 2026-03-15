"""Tests for the summarizer abstraction layer."""

from __future__ import annotations

from opentrace_agent.summarizer.base import (
    PROMPT_TEMPLATES,
    SummarizerConfig,
)


class TestSummarizerConfig:
    def test_defaults(self):
        cfg = SummarizerConfig()
        assert cfg.enabled is True
        assert cfg.model == "Xenova/flan-t5-small"
        assert cfg.max_input_length == 480
        assert cfg.batch_size == 8
        assert cfg.cache_dir is None

    def test_custom_values(self):
        cfg = SummarizerConfig(
            enabled=True,
            model="custom/model",
            max_input_length=256,
            batch_size=4,
            cache_dir="/tmp/cache",
        )
        assert cfg.enabled is True
        assert cfg.model == "custom/model"
        assert cfg.max_input_length == 256
        assert cfg.batch_size == 4
        assert cfg.cache_dir == "/tmp/cache"


class TestPromptTemplates:
    def test_all_kinds_have_templates(self):
        for kind in ("function", "class", "file", "directory"):
            assert kind in PROMPT_TEMPLATES
            assert "one sentence" in PROMPT_TEMPLATES[kind]

    def test_function_template(self):
        assert PROMPT_TEMPLATES["function"].startswith("Summarize what this function")

    def test_class_template(self):
        assert PROMPT_TEMPLATES["class"].startswith("Summarize what this class")

    def test_file_template(self):
        assert PROMPT_TEMPLATES["file"].startswith("Summarize what this source file")

    def test_directory_template(self):
        assert PROMPT_TEMPLATES["directory"].startswith("Describe the purpose")
