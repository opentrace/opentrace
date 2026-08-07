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

"""``index`` with a single URL/file input.

That path skips the DirectoryWalker entirely and hands one ``SourceInput`` to
the wiki pipeline, so the options that configure a directory walk have nowhere
to go. They used to be accepted and dropped on the floor.
"""

import pytest
from click.testing import CliRunner

from opentrace_agent.cli.main import app

LLM_ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "OLLAMA_BASE_URL",
    "OT_LOCAL_LLM_URL",
    "OT_LLM_PROVIDER",
)


@pytest.fixture
def doc(tmp_path):
    """A single markdown file — the ``file`` input kind."""
    p = tmp_path / "note.md"
    p.write_text("# Note\n\nBody.\n")
    return p


@pytest.fixture
def no_llm_backend(monkeypatch):
    """Strip provider keys so a run that reaches the preflight fails loudly.

    Every assertion below is about argument validation, which must reject the
    invocation *before* the preflight. Leaving a real key in the developer's
    shell would let a bad invocation proceed to a live LLM call.
    """
    for var in LLM_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


class TestDirectoryOnlyOptionsRejected:
    """Options that only configure a directory walk must be refused, not ignored."""

    @pytest.mark.parametrize(
        ("args", "flag"),
        [
            (["--repo-id", "custom"], "--repo-id"),
            (["--batch-size", "50"], "--batch-size"),
            (["--no-prune"], "--no-prune"),
            (["--wiki-exclude-design-history"], "--wiki-exclude-design-history"),
        ],
    )
    def test_single_file_rejects_option(self, doc, no_llm_backend, args, flag):
        result = CliRunner().invoke(app, ["index", str(doc), "--wiki", *args])

        assert result.exit_code != 0
        assert flag in result.output
        assert "only valid when indexing a directory" in result.output

    def test_explicit_batch_size_matching_the_default_is_still_rejected(self, doc, no_llm_backend):
        """200 is the default, so a value comparison would miss this.

        Detection keys on click's parameter source, not on the value — the user
        typed it, so silently ignoring it is the same bug regardless of which
        number they chose.
        """
        result = CliRunner().invoke(app, ["index", str(doc), "--wiki", "--batch-size", "200"])

        assert result.exit_code != 0
        assert "--batch-size" in result.output

    def test_all_offenders_are_reported_together(self, doc, no_llm_backend):
        """One run should not require four round trips to discover four problems."""
        result = CliRunner().invoke(
            app,
            ["index", str(doc), "--wiki", "--no-prune", "--repo-id", "x", "--wiki-exclude-design-history"],
        )

        assert result.exit_code != 0
        assert "--no-prune" in result.output
        assert "--repo-id" in result.output
        assert "--wiki-exclude-design-history" in result.output

    def test_defaults_alone_are_not_rejected(self, doc, no_llm_backend):
        """Passing none of them must fall through to the normal preflight."""
        result = CliRunner().invoke(app, ["index", str(doc), "--wiki"])

        assert result.exit_code != 0
        assert "only valid when indexing a directory" not in result.output
        assert "No LLM backend configured" in result.output

    def test_directory_input_still_accepts_them(self, tmp_path, no_llm_backend):
        """The guard is scoped to single-source input; a real walk still takes them."""
        (tmp_path / "mod.py").write_text("def f():\n    return 1\n")

        result = CliRunner().invoke(
            app,
            ["index", str(tmp_path), "--repo-id", "custom", "--batch-size", "50", "--no-prune"],
        )

        assert "only valid when indexing a directory" not in result.output


class TestValidationPrecedesEnvironment:
    def test_bad_invocation_reports_itself_before_demanding_a_key(self, doc, no_llm_backend):
        """A malformed command must not first send the user to buy an API key.

        The preflight used to run first, so ``--no-prune`` against a single file
        reported "No LLM backend configured" — pointing at the environment for a
        run that the arguments had already doomed.
        """
        result = CliRunner().invoke(app, ["index", str(doc), "--wiki", "--no-prune"])

        assert result.exit_code != 0
        assert "only valid when indexing a directory" in result.output
        assert "No LLM backend configured" not in result.output
