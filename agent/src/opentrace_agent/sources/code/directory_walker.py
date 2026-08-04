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

"""Directory tree walker that produces flat GraphNode/GraphRelationship lists."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from opentrace_agent.pipeline.types import (
    FileEntry,
    GraphNode,
    GraphRelationship,
)

logger = logging.getLogger(__name__)

EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "vendor",
        "dist",
        "build",
        ".idea",
        ".vscode",
        ".mypy_cache",
        ".ruff_cache",
        ".pytest_cache",
        ".tox",
        ".eggs",
        "egg-info",
        ".claude",
        ".opentrace",
    }
)

# File extensions we create FileNodes for
INCLUDED_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".go",
        ".rs",
        ".java",
        ".kt",
        ".rb",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".swift",
        ".yaml",
        ".yml",
        ".json",
        ".toml",
        ".md",
        ".proto",
        ".graphql",
        ".sql",
        ".sh",
        ".bash",
        ".dockerfile",
        ".tf",
        ".hcl",
    }
)

EXTENSION_LANGUAGE_MAP: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".proto": "protobuf",
    ".graphql": "graphql",
    ".sql": "sql",
}

# File extensions surfaced as docs when ``walk_docs=True``. These are the
# formats markitdown knows how to convert to markdown — used by the wiki
# doc-ingestion pass to feed bodies to the LLM. Kept in lockstep
# with ``sources/markdown/loader.py::_EXT_TO_TYPE``.
DOC_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".pdf",
        ".docx",
        ".doc",
        ".pptx",
        ".ppt",
        ".xlsx",
        ".xls",
        ".csv",
        ".epub",
        ".html",
        ".htm",
        ".rst",
        # Plain-text passthrough (no markitdown conversion). ``.md`` is
        # intentionally included even though it's also in INCLUDED_EXTENSIONS;
        # walk_docs surfaces it as a doc entry too so doc ingestion can
        # operate on doc-style markdown without losing the existing File node.
        ".md",
        ".markdown",
        ".txt",
        # Image/audio/video — markitdown handles OCR + transcription.
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".mp3",
        ".wav",
        ".m4a",
        ".mp4",
        ".mov",
        ".webm",
        ".mkv",
    }
)


@dataclass
class DocFileEntry:
    """A doc file discovered when ``walk_docs=True``.

    Separate from :class:`FileEntry` because docs don't have a stable
    ``file_id`` at scan time — the Source node id is derived from the
    markitdown'd body content, computed in the doc-ingestion pass.
    """

    abs_path: str
    path: str  # repo-relative
    extension: str


@dataclass
class WalkResult:
    """Flat output from DirectoryWalker — no tree, just lists."""

    nodes: list[GraphNode] = field(default_factory=list)
    relationships: list[GraphRelationship] = field(default_factory=list)
    file_entries: list[FileEntry] = field(default_factory=list)
    doc_file_entries: list[DocFileEntry] = field(default_factory=list)
    path_to_file_id: dict[str, str] = field(default_factory=dict)
    known_paths: set[str] = field(default_factory=set)
    manifest_files: list[tuple[str, str]] = field(default_factory=list)


class DirectoryWalker:
    """Walks a directory tree and produces flat graph nodes and relationships."""

    def walk(
        self,
        root_path: Path,
        repo_id: str,
        repo_name: str,
        url: Optional[str] = None,
        default_branch: Optional[str] = None,
        walk_docs: bool = False,
    ) -> WalkResult:
        """Walk *root_path* and return flat graph nodes/relationships.

        Args:
            root_path: Absolute path to the cloned repository root.
            repo_id: Unique identifier for the repository (e.g. ``"owner/repo"``).
            repo_name: Human-readable repository name.
            url: Repository URL.
            default_branch: Branch that was cloned.
            walk_docs: When True, also surface non-code doc files
                (PDF/DOCX/MD/TXT/RST/HTML/...) into ``WalkResult.doc_file_entries``
                so the wiki doc-ingestion pass can route them through
                markitdown + the LLM. Off by default to keep the cheap
                ``opentraceai index`` path unchanged.

        Returns:
            A ``WalkResult`` with flat lists of nodes, relationships,
            and file metadata for downstream pipeline stages.
        """
        result = WalkResult()

        # Repository node
        repo_props: dict[str, object] = {}
        if url:
            repo_props["url"] = url
        if default_branch:
            repo_props["defaultBranch"] = default_branch
        result.nodes.append(GraphNode(id=repo_id, type="Repository", name=repo_name, properties=repo_props))

        # Track which directories have been created
        created_dirs: set[str] = set()
        file_count = 0
        dir_count = 0

        for dirpath_str, dirnames, filenames in os.walk(root_path):
            # Mutating dirnames is how os.walk skips a subtree without recursing into it.
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS and not d.endswith(".egg-info")]
            dirnames.sort()

            dirpath = Path(dirpath_str)
            rel_dir = dirpath.relative_to(root_path)
            rel_dir_str = str(rel_dir) if str(rel_dir) != "." else ""

            # Create DirectoryNode + DEFINES relationship for non-root dirs
            if rel_dir_str and rel_dir_str not in created_dirs:
                dir_id = f"{repo_id}/{rel_dir_str}"
                result.nodes.append(
                    GraphNode(
                        id=dir_id,
                        type="Directory",
                        name=dirpath.name,
                        properties={"path": rel_dir_str},
                    )
                )

                # Link to parent (repo or parent dir)
                parent_rel = str(rel_dir.parent) if str(rel_dir.parent) != "." else ""
                parent_id = f"{repo_id}/{parent_rel}" if parent_rel else repo_id
                result.relationships.append(
                    GraphRelationship(
                        id=f"{parent_id}->DEFINES->{dir_id}",
                        type="DEFINES",
                        source_id=parent_id,
                        target_id=dir_id,
                    )
                )

                created_dirs.add(rel_dir_str)
                dir_count += 1

            # Determine parent for files in this directory
            parent_id = f"{repo_id}/{rel_dir_str}" if rel_dir_str else repo_id

            # Process files
            for filename in sorted(filenames):
                ext = _get_extension(filename)

                # Doc-file surfacing — independent of the code path. Files
                # only-in-DOC_EXTENSIONS (e.g. .pdf) get a DocFileEntry but
                # NOT a File node. Files in both sets (e.g. .md) get a File
                # node *and* a DocFileEntry, so the doc-ingestion pass
                # can produce a Source mirror alongside the structural File.
                if walk_docs and ext in DOC_EXTENSIONS:
                    rel_doc = str(rel_dir / filename) if rel_dir_str else filename
                    abs_doc = str(dirpath / filename)
                    result.doc_file_entries.append(DocFileEntry(abs_path=abs_doc, path=rel_doc, extension=ext))

                if ext not in INCLUDED_EXTENSIONS:
                    continue

                rel_file = str(rel_dir / filename) if rel_dir_str else filename
                abs_file = str(dirpath / filename)
                file_id = f"{repo_id}/{rel_file}"
                language = EXTENSION_LANGUAGE_MAP.get(ext)

                file_props: dict[str, object] = {
                    "path": rel_file,
                    "extension": ext,
                }
                if language:
                    file_props["language"] = language

                result.nodes.append(GraphNode(id=file_id, type="File", name=filename, properties=file_props))
                result.relationships.append(
                    GraphRelationship(
                        id=f"{parent_id}->DEFINES->{file_id}",
                        type="DEFINES",
                        source_id=parent_id,
                        target_id=file_id,
                    )
                )

                # Collect metadata for downstream stages
                result.path_to_file_id[rel_file] = file_id
                result.known_paths.add(rel_file)

                from opentrace_agent.sources.code.manifest_parser import is_manifest_file

                if is_manifest_file(rel_file):
                    result.manifest_files.append((rel_file, abs_file))

                from opentrace_agent.sources.code.extractors import PARSEABLE_EXTENSIONS

                if ext in PARSEABLE_EXTENSIONS:
                    result.file_entries.append(
                        FileEntry(
                            file_id=file_id,
                            abs_path=abs_file,
                            path=rel_file,
                            extension=ext,
                            language=language,
                        )
                    )

                file_count += 1

        logger.info(
            "Walked %s: %d directories, %d files",
            repo_id,
            dir_count,
            file_count,
        )
        return result


def _get_extension(filename: str) -> str:
    """Return the lowercase file extension, handling special names."""
    lower = filename.lower()
    if lower == "dockerfile" or lower.startswith("dockerfile."):
        return ".dockerfile"
    _, ext = os.path.splitext(lower)
    return ext
