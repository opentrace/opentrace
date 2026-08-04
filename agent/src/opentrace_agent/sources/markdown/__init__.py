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

"""Markdown source ingestion: URL/file → annotated markdown + the corpus store.

The LLM entity/edge extraction that used to live here (``extractor.py`` and
``prompts.py``) was removed on 2026-08-04 — see the wiki CLAUDE.md.
"""

from .clients import (
    BACKENDS,
    AnthropicClient,
    BackendConfig,
    OpenAICompatClient,
    actionable_no_backend_message,
    create_client,
    detect_backend,
    detect_client,
    estimate_cost,
)
from .fetchers import UnsupportedSourceError, resolve
from .loader import AnnotatedMarkdown, convert, detect_source_type
from .source_io import (
    CORPUS_SUBDIR,
    copy_corpus_between_scopes,
    corpus_dir,
    corpus_dir_for_scope,
    load_source_markdown,
    relative_corpus_path,
    write_corpus_markdown,
    write_corpus_markdown_to,
    write_source_markdown,
)

__all__ = [
    "AnnotatedMarkdown",
    "AnthropicClient",
    "BACKENDS",
    "BackendConfig",
    "CORPUS_SUBDIR",
    "OpenAICompatClient",
    "UnsupportedSourceError",
    "actionable_no_backend_message",
    "convert",
    "copy_corpus_between_scopes",
    "corpus_dir",
    "corpus_dir_for_scope",
    "create_client",
    "detect_backend",
    "detect_client",
    "detect_source_type",
    "estimate_cost",
    "load_source_markdown",
    "relative_corpus_path",
    "resolve",
    "write_corpus_markdown",
    "write_corpus_markdown_to",
    "write_source_markdown",
]
