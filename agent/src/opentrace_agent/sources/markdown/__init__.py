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

"""URL/file fetching plus the on-disk corpus store.

Doc plumbing only — this package runs no LLM of its own. The single LLM call
over a document lives in ``wiki/ingest/doc_extraction.py``, and the provider
registry it uses is ``sources/_llm_common.py``. Conversion to markdown lives in
``wiki/ingest/normalize.py``.
"""

from .fetchers import UnsupportedSourceError, resolve
from .source_io import (
    CORPUS_SUBDIR,
    copy_corpus_between_scopes,
    corpus_dir,
    corpus_dir_for_scope,
    relative_corpus_path,
    write_corpus_markdown_to,
)

__all__ = [
    "CORPUS_SUBDIR",
    "UnsupportedSourceError",
    "copy_corpus_between_scopes",
    "corpus_dir",
    "corpus_dir_for_scope",
    "relative_corpus_path",
    "resolve",
    "write_corpus_markdown_to",
]
