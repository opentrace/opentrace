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

"""Template-based code summarizer — generates semantic summaries from identifier
names and structural metadata, with no ML inference.

Ported from the UI's ``templateSummarizer.ts`` to produce identical output.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from opentrace_agent.sources.code.summarizer_data import (
    CLASS_SUFFIX_MAP,
    DIR_PATTERNS,
    FILE_PATTERNS,
    VERB_MAP,
    _KEYWORD_PATTERNS,
)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class SymbolMetadata:
    """Structured metadata for template-based summarization."""

    name: str
    kind: str  # "function" | "class" | "file" | "directory"
    signature: str | None = None
    language: str | None = None
    line_count: int | None = None
    child_names: list[str] | None = None
    file_name: str | None = None
    receiver_type: str | None = None
    source: str | None = None
    docs: str | None = None



# ---------------------------------------------------------------------------
# Identifier splitter
# ---------------------------------------------------------------------------


def split_identifier(name: str) -> list[str]:
    """Split an identifier into words, handling camelCase, PascalCase, snake_case,
    SCREAMING_SNAKE_CASE, and acronyms."""
    cleaned = name.strip("_$")
    if not cleaned:
        return [name]

    parts = re.split(r"[_\-]+", cleaned)
    parts = [p for p in parts if p]

    words: list[str] = []
    for part in parts:
        sub = re.sub(r"([a-z])([A-Z])", r"\1\0\2", part)
        sub = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1\0\2", sub)
        sub = re.sub(r"([a-zA-Z])(\d)", r"\1\0\2", sub)
        sub = re.sub(r"(\d)([a-zA-Z])", r"\1\0\2", sub)
        sub_words = [w for w in sub.split("\0") if w]
        words.extend(sub_words)

    return words if words else [name]


def _words_to_phrase(words: list[str]) -> str:
    """Convert word list to a readable phrase."""
    result = []
    for w in words:
        if len(w) <= 4 and w == w.upper() and re.fullmatch(r"[A-Z]+", w):
            result.append(w)
        else:
            result.append(w.lower())
    return " ".join(result)


# ---------------------------------------------------------------------------
# Keyword extraction
# ---------------------------------------------------------------------------


def extract_keywords(source: str) -> list[str]:
    """Scan source code for domain indicators and return deduplicated keywords (max 4)."""
    if not source:
        return []
    found: list[str] = []
    for kp in _KEYWORD_PATTERNS:
        if len(found) >= 4:
            break
        for pat in kp["patterns"]:  # type: ignore[union-attr]
            if pat.search(source):  # type: ignore[union-attr]
                found.append(kp["domain"])  # type: ignore[arg-type]
                break
    return found


def _format_keywords(keywords: list[str]) -> str:
    return f" [{', '.join(keywords)}]" if keywords else ""


# ---------------------------------------------------------------------------
# Function summarizer
# ---------------------------------------------------------------------------

_CONSTRUCTOR_NAMES = frozenset({"__init__", "constructor", "init", "initialize", "New"})

_NON_DESCRIPTIVE = frozenset({
    "foo", "bar", "baz", "tmp", "temp", "x", "y", "z", "fn", "cb", "f", "g",
})


def _is_non_descriptive(name: str) -> bool:
    if len(name) <= 2:
        return True
    return name.lower() in _NON_DESCRIPTIVE


def summarize_function(
    name: str,
    signature: str | None = None,
    language: str | None = None,
    line_count: int | None = None,
    receiver_type: str | None = None,
    source: str | None = None,
) -> str:
    if name in _CONSTRUCTOR_NAMES:
        subject = receiver_type or "instance"
        return f"Initializes {subject}"

    lower_name = name.lower()
    if lower_name.startswith("test_") or lower_name.startswith("test"):
        words = split_identifier(name)
        test_words = words[1:] if words[0].lower() == "test" else words
        if test_words:
            return f"Tests {_words_to_phrase(test_words)}"
        return f"Tests {name}"

    if _is_non_descriptive(name):
        return f"Function {name}"

    words = split_identifier(name)
    if not words:
        return f"Function {name}"

    first_word = words[0].lower()
    rest_words = words[1:]

    verb = VERB_MAP.get(first_word)
    if verb:
        obj = f" {_words_to_phrase(rest_words)}" if rest_words else ""
        if receiver_type:
            lower_verb = verb.lower()
            result = f"{receiver_type} method that {lower_verb}{obj}"
        else:
            result = f"{verb}{obj}"
        keywords = extract_keywords(source) if source else []
        return result + _format_keywords(keywords)

    phrase = _words_to_phrase(words)
    if receiver_type:
        result = f"{receiver_type} method for {phrase}"
    else:
        result = phrase[0].upper() + phrase[1:] if phrase else name

    keywords = extract_keywords(source) if source else []
    return result + _format_keywords(keywords)


# ---------------------------------------------------------------------------
# Class summarizer
# ---------------------------------------------------------------------------

_CRUD_METHODS = frozenset({
    "create", "read", "get", "find", "update", "delete", "remove", "save", "list",
})


def summarize_class(
    name: str,
    child_names: list[str] | None = None,
    source: str | None = None,
) -> str:
    words = split_identifier(name)
    readable_name = _words_to_phrase(words)
    capitalized_name = readable_name[0].upper() + readable_name[1:] if readable_name else name

    last_word = words[-1].lower() if words else ""
    suffix_label = CLASS_SUFFIX_MAP.get(last_word)

    has_crud = False
    if child_names and len(child_names) > 0:
        lower_children = [split_identifier(c)[0].lower() for c in child_names]
        crud_count = sum(1 for c in lower_children if c in _CRUD_METHODS)
        has_crud = crud_count >= 3

    summary = capitalized_name
    if has_crud:
        summary += " for CRUD operations"

    if child_names and len(child_names) > 0:
        method_list = ", ".join(child_names[:5])
        extra = f" and {len(child_names) - 5} more" if len(child_names) > 5 else ""
        summary += f" with methods: {method_list}{extra}"

    keywords = extract_keywords(source) if source else []
    return summary + _format_keywords(keywords)


# ---------------------------------------------------------------------------
# File summarizer
# ---------------------------------------------------------------------------


def summarize_file(
    file_name: str,
    symbol_names: list[str] | None = None,
    language: str | None = None,
    source: str | None = None,
) -> str:
    lower_file = file_name.lower()

    for pattern, prefix in FILE_PATTERNS:
        if pattern.search(lower_file):
            if prefix.endswith("for"):
                base_name = re.sub(r"_test\.\w+$", "", file_name)
                base_name = re.sub(r"\.test\.\w+$", "", base_name)
                base_name = re.sub(r"\.spec\.\w+$", "", base_name)
                base_name = re.sub(r"^test_", "", base_name)
                base_name = re.sub(r"\.\w+$", "", base_name)
                subject = _words_to_phrase(split_identifier(base_name))
                return f"{prefix} {subject}"
            if prefix == "Barrel exports for":
                if symbol_names and len(symbol_names) > 0:
                    listing = ", ".join(symbol_names[:3])
                    extra = f" and {len(symbol_names) - 3} more" if len(symbol_names) > 3 else ""
                    return f"{prefix} {listing}{extra}"
            return prefix

    if symbol_names and len(symbol_names) > 0:
        listing = ", ".join(symbol_names[:3])
        extra = f" and {len(symbol_names) - 3} more" if len(symbol_names) > 3 else ""
        lang_note = f" {language}" if language else ""
        return f"Defines{lang_note} {listing}{extra}"

    return f"Source file {file_name}"


# ---------------------------------------------------------------------------
# Directory summarizer
# ---------------------------------------------------------------------------


def summarize_directory(dir_name: str, child_names: list[str]) -> str:
    lower_dir = dir_name.lower()
    known_purpose = DIR_PATTERNS.get(lower_dir)

    if known_purpose:
        if child_names:
            listing = ", ".join(child_names[:5])
            extra = f" and {len(child_names) - 5} more" if len(child_names) > 5 else ""
            return f"{known_purpose} containing {listing}{extra}"
        return known_purpose

    if child_names:
        listing = ", ".join(child_names[:5])
        extra = f" and {len(child_names) - 5} more" if len(child_names) > 5 else ""
        return f"Directory containing {listing}{extra}"

    return f"Directory {dir_name}"


# ---------------------------------------------------------------------------
# Unified summarizer
# ---------------------------------------------------------------------------


def summarize_from_metadata(meta: SymbolMetadata) -> str:
    """Generate a summary from structured symbol metadata."""
    if meta.docs:
        first_sentence = re.split(r"\.\s|\n", meta.docs)[0].strip()
        if first_sentence:
            return first_sentence.rstrip(".")

    if meta.kind == "function":
        return summarize_function(
            meta.name,
            meta.signature,
            meta.language,
            meta.line_count,
            meta.receiver_type,
            meta.source,
        )
    elif meta.kind == "class":
        return summarize_class(meta.name, meta.child_names, meta.source)
    elif meta.kind == "file":
        return summarize_file(
            meta.file_name or meta.name,
            meta.child_names,
            meta.language,
            meta.source,
        )
    elif meta.kind == "directory":
        return summarize_directory(meta.name, meta.child_names or [])
    else:
        return f"{meta.kind} {meta.name}"
