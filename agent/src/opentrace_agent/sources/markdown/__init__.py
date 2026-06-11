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

"""Markdown source ingestion: URL/file → annotated markdown."""

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
from .extractor import (
    VALID_LLM_ENTITY_TYPES,
    ExtractionStats,
    LLMClient,
    ProposedHyperedge,
    entity_node_type,
    extract_entities,
    propose_hyperedges,
    propose_semantic_edges,
)
from .fetchers import UnsupportedSourceError, resolve
from .loader import AnnotatedMarkdown, convert, detect_source_type
from .prompts import (
    ALLOWED_CONFIDENCE_SCORES,
    ENTITY_PROMPT,
    HYPEREDGE_PROMPT,
    SEMANTIC_EDGE_PROMPT,
    VALID_CONFIDENCE_TIERS,
    make_entity_id,
    round_confidence,
)
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
    "ALLOWED_CONFIDENCE_SCORES",
    "AnnotatedMarkdown",
    "AnthropicClient",
    "BACKENDS",
    "BackendConfig",
    "CORPUS_SUBDIR",
    "ENTITY_PROMPT",
    "ExtractionStats",
    "HYPEREDGE_PROMPT",
    "LLMClient",
    "OpenAICompatClient",
    "ProposedHyperedge",
    "SEMANTIC_EDGE_PROMPT",
    "UnsupportedSourceError",
    "VALID_CONFIDENCE_TIERS",
    "VALID_LLM_ENTITY_TYPES",
    "actionable_no_backend_message",
    "convert",
    "copy_corpus_between_scopes",
    "corpus_dir",
    "corpus_dir_for_scope",
    "create_client",
    "detect_backend",
    "detect_client",
    "detect_source_type",
    "entity_node_type",
    "estimate_cost",
    "extract_entities",
    "load_source_markdown",
    "make_entity_id",
    "propose_hyperedges",
    "propose_semantic_edges",
    "relative_corpus_path",
    "resolve",
    "round_confidence",
    "write_corpus_markdown",
    "write_corpus_markdown_to",
    "write_source_markdown",
]
