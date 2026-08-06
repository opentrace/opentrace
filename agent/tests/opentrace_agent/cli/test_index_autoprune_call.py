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

"""``index --wiki``'s autoprune call site.

``tests/opentrace_agent/pipeline/test_autoprune.py`` covers ``autoprune_after_index``
itself, and ``test_vault_ingest.py`` covers the ``vault ingest`` caller end to
end. ``_run_autoprune_after_index`` — the ``index --wiki`` caller — had neither,
so a wrong kwarg or a renamed report field would have surfaced only at runtime
against a real repo. It does the doc re-walk itself, which is the part no other
test exercises.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("real_ladybug")

from opentrace_agent.cli.main import _run_autoprune_after_index  # noqa: E402
from opentrace_agent.pipeline.autoprune import compute_walked_shas  # noqa: E402
from opentrace_agent.store import GraphStore  # noqa: E402
from opentrace_agent.wiki.ingest.graph_writer import vault_node_id  # noqa: E402

VAULT = "v"


def _add_doc(store: GraphStore, vault_id: str, path: Path) -> str:
    """Register *path* in the graph exactly as the wiki writer would."""
    sha = compute_walked_shas([path]).pop()
    node_id = f"corpus::{sha}"
    store.add_node(
        node_id,
        "KnowledgeDoc",
        path.name,
        properties={
            "sha256": sha,
            "filename": path.name,
            "corpus_path": f"corpus/{sha}.md",
        },
    )
    store.add_relationship(
        f"{vault_id}->CONTAINS->{node_id}",
        "CONTAINS",
        vault_id,
        node_id,
        properties={"vault": VAULT},
    )
    return node_id


@pytest.fixture()
def indexed(tmp_path):
    """A doc tree on disk, mirrored into a graph — the state a re-index starts from."""
    docs = tmp_path / "docs"
    docs.mkdir()
    kept = docs / "kept.md"
    removed = docs / "removed.md"
    kept.write_text("# Kept\n")
    removed.write_text("# Removed\n")

    db_path = str(tmp_path / "index.db")
    store = GraphStore(db_path)
    vault_id = vault_node_id(VAULT)
    store.add_node(vault_id, "KnowledgeVault", VAULT, properties={"vault": VAULT, "scope": "local"})
    ids = {
        "kept": _add_doc(store, vault_id, kept),
        "removed": _add_doc(store, vault_id, removed),
    }

    yield {"store": store, "db_path": db_path, "docs": docs, "removed": removed, "ids": ids}
    store.close()


class TestRunAutopruneAfterIndex:
    def test_doc_deleted_from_disk_is_pruned(self, indexed):
        """The whole point: the re-walk must notice the file is gone."""
        indexed["removed"].unlink()

        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )

        assert indexed["store"].get_node(indexed["ids"]["removed"]) is None
        assert indexed["store"].get_node(indexed["ids"]["kept"]) is not None

    def test_untouched_tree_prunes_nothing(self, indexed):
        """A re-index with no deletions must not eat the corpus."""
        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )

        assert indexed["store"].get_node(indexed["ids"]["kept"]) is not None
        assert indexed["store"].get_node(indexed["ids"]["removed"]) is not None

    def test_single_file_source_path_walks_that_file(self, indexed):
        """`source_path` may be one file, and then it is the entire walked set.

        Everything else in the vault is therefore an orphan — the branch that
        would silently prune nothing if the `is_file()` arm stopped matching.
        """
        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"] / "kept.md",
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )

        assert indexed["store"].get_node(indexed["ids"]["kept"]) is not None
        assert indexed["store"].get_node(indexed["ids"]["removed"]) is None

    def test_reports_deletions_on_stdout(self, indexed, capsys):
        indexed["removed"].unlink()

        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )

        assert "Autoprune: -1 documents" in capsys.readouterr().out

    def test_quiet_when_nothing_pruned(self, indexed, capsys):
        """A no-op prune stays silent unless asked; verbose says so explicitly."""
        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )
        assert capsys.readouterr().out == ""

        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=True,
        )
        assert "no orphans found" in capsys.readouterr().out

    def test_non_doc_files_are_not_part_of_the_walked_set(self, indexed):
        """Code beside the docs must not count as a surviving document."""
        (indexed["docs"] / "script.py").write_text("x = 1\n")
        indexed["removed"].unlink()

        _run_autoprune_after_index(
            graph_store=indexed["store"],
            source_path=indexed["docs"],
            vault_name=VAULT,
            db_path=indexed["db_path"],
            verbose=False,
        )

        assert indexed["store"].get_node(indexed["ids"]["removed"]) is None
        assert indexed["store"].get_node(indexed["ids"]["kept"]) is not None
