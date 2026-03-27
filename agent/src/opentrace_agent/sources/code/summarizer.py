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
# Verb prefix → description mapping
# ---------------------------------------------------------------------------

VERB_MAP: dict[str, str] = {
    "get": "Retrieves",
    "fetch": "Retrieves",
    "load": "Retrieves",
    "find": "Retrieves",
    "query": "Retrieves",
    "read": "Reads",
    "lookup": "Looks up",
    "set": "Updates",
    "update": "Updates",
    "modify": "Updates",
    "patch": "Updates",
    "put": "Updates",
    "validate": "Validates",
    "verify": "Validates",
    "check": "Validates",
    "ensure": "Ensures",
    "create": "Creates",
    "make": "Creates",
    "build": "Creates",
    "generate": "Creates",
    "new": "Creates",
    "add": "Adds",
    "insert": "Adds",
    "append": "Adds",
    "register": "Registers",
    "delete": "Removes",
    "remove": "Removes",
    "destroy": "Removes",
    "drop": "Removes",
    "unset": "Removes",
    "clear": "Clears",
    "parse": "Parses",
    "extract": "Extracts",
    "decode": "Decodes",
    "handle": "Handles",
    "process": "Processes",
    "run": "Runs",
    "execute": "Executes",
    "do": "Performs",
    "perform": "Performs",
    "convert": "Converts",
    "transform": "Converts",
    "to": "Converts to",
    "format": "Formats",
    "encode": "Encodes",
    "serialize": "Serializes",
    "marshal": "Serializes",
    "deserialize": "Deserializes",
    "unmarshal": "Deserializes",
    "is": "Checks whether",
    "has": "Checks whether",
    "can": "Checks whether",
    "should": "Checks whether",
    "init": "Initializes",
    "setup": "Initializes",
    "configure": "Configures",
    "start": "Starts",
    "stop": "Stops",
    "open": "Opens",
    "close": "Closes",
    "connect": "Connects",
    "disconnect": "Disconnects",
    "render": "Renders",
    "display": "Renders",
    "show": "Renders",
    "draw": "Renders",
    "paint": "Renders",
    "hide": "Hides",
    "send": "Sends",
    "emit": "Emits",
    "dispatch": "Dispatches",
    "publish": "Publishes",
    "broadcast": "Broadcasts",
    "notify": "Notifies",
    "receive": "Receives",
    "listen": "Listens for",
    "subscribe": "Subscribes to",
    "on": "Handles",
    "sort": "Sorts",
    "filter": "Filters",
    "map": "Maps",
    "reduce": "Reduces",
    "merge": "Merges",
    "join": "Joins",
    "split": "Splits",
    "group": "Groups",
    "flatten": "Flattens",
    "test": "Tests",
    "assert": "Tests",
    "expect": "Tests",
    "log": "Logs",
    "print": "Logs",
    "warn": "Logs warning for",
    "error": "Logs error for",
    "debug": "Logs debug info for",
    "write": "Writes",
    "save": "Saves",
    "store": "Stores",
    "cache": "Caches",
    "flush": "Flushes",
    "sync": "Synchronizes",
    "reset": "Resets",
    "refresh": "Refreshes",
    "reload": "Reloads",
    "retry": "Retries",
    "wrap": "Wraps",
    "unwrap": "Unwraps",
    "apply": "Applies",
    "resolve": "Resolves",
    "reject": "Rejects",
    "throw": "Throws",
    "raise": "Raises",
    "try": "Attempts",
    "await": "Awaits",
    "wait": "Waits for",
    "schedule": "Schedules",
    "defer": "Defers",
    "cancel": "Cancels",
    "abort": "Aborts",
    "clone": "Clones",
    "copy": "Copies",
    "compare": "Compares",
    "equals": "Checks equality of",
    "match": "Matches",
    "contains": "Checks whether contains",
    "include": "Includes",
    "exclude": "Excludes",
    "enable": "Enables",
    "disable": "Disables",
    "toggle": "Toggles",
    "mount": "Mounts",
    "unmount": "Unmounts",
    "use": "Uses",
    "with": "Configures with",
    "from": "Creates from",
    "of": "Creates",
}

# ---------------------------------------------------------------------------
# Class suffix patterns
# ---------------------------------------------------------------------------

CLASS_SUFFIX_MAP: dict[str, str] = {
    "service": "Service",
    "handler": "Handler",
    "controller": "Controller",
    "factory": "Factory",
    "repository": "Repository",
    "repo": "Repository",
    "manager": "Manager",
    "provider": "Provider",
    "adapter": "Adapter",
    "middleware": "Middleware",
    "guard": "Guard",
    "interceptor": "Interceptor",
    "resolver": "Resolver",
    "validator": "Validator",
    "builder": "Builder",
    "parser": "Parser",
    "formatter": "Formatter",
    "converter": "Converter",
    "serializer": "Serializer",
    "client": "Client",
    "server": "Server",
    "router": "Router",
    "store": "Store",
    "cache": "Cache",
    "queue": "Queue",
    "pool": "Pool",
    "registry": "Registry",
    "observer": "Observer",
    "emitter": "Emitter",
    "listener": "Listener",
    "subscriber": "Subscriber",
    "publisher": "Publisher",
    "component": "Component",
    "module": "Module",
    "plugin": "Plugin",
    "helper": "Helper",
    "util": "Utility",
    "utils": "Utility",
    "error": "Error",
    "exception": "Exception",
    "model": "Model",
    "entity": "Entity",
    "dto": "DTO",
    "config": "Configuration",
    "options": "Options",
    "context": "Context",
    "state": "State",
    "hook": "Hook",
}

# ---------------------------------------------------------------------------
# File / directory pattern maps
# ---------------------------------------------------------------------------

FILE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"_test\.go$"), "Tests for"),
    (re.compile(r"_test\.py$"), "Tests for"),
    (re.compile(r"\.test\.[jt]sx?$"), "Tests for"),
    (re.compile(r"\.spec\.[jt]sx?$"), "Tests for"),
    (re.compile(r"^test_"), "Tests for"),
    (re.compile(r"^conftest\.py$"), "Pytest fixtures and configuration"),
    (re.compile(r"^setup\.[jt]s$"), "Setup configuration"),
    (re.compile(r"^index\.[jt]sx?$"), "Barrel exports for"),
    (re.compile(r"^main\.[a-z]+$"), "Application entry point"),
    (re.compile(r"^mod\.rs$"), "Module declarations"),
    (re.compile(r"^__init__\.py$"), "Package initialization for"),
    (re.compile(r"^constants?\.[a-z]+$"), "Constants and configuration values"),
    (re.compile(r"^types?\.[a-z]+$"), "Type definitions"),
    (re.compile(r"^utils?\.[a-z]+$"), "Utility functions"),
    (re.compile(r"^helpers?\.[a-z]+$"), "Helper functions"),
    (re.compile(r"^middleware\.[a-z]+$"), "Middleware definitions"),
    (re.compile(r"^routes?\.[a-z]+$"), "Route definitions"),
    (re.compile(r"^models?\.[a-z]+$"), "Data model definitions"),
    (re.compile(r"^schema\.[a-z]+$"), "Schema definitions"),
    (re.compile(r"^migrations?"), "Database migration"),
    (re.compile(r"^dockerfile", re.IGNORECASE), "Docker container configuration"),
    (re.compile(r"^makefile$", re.IGNORECASE), "Build automation rules"),
    (re.compile(r"^readme", re.IGNORECASE), "Project documentation"),
    (re.compile(r"^changelog", re.IGNORECASE), "Version change history"),
    (re.compile(r"^license", re.IGNORECASE), "License information"),
    (re.compile(r"\.config\.[a-z]+$"), "Configuration for"),
    (re.compile(r"rc\.[a-z]+$"), "Configuration for"),
]

DIR_PATTERNS: dict[str, str] = {
    "api": "API layer",
    "apis": "API layer",
    "handlers": "Request handlers",
    "handler": "Request handlers",
    "controllers": "Request controllers",
    "controller": "Request controllers",
    "routes": "Route definitions",
    "routing": "Route definitions",
    "models": "Data models",
    "model": "Data models",
    "entities": "Data entities",
    "schema": "Schema definitions",
    "schemas": "Schema definitions",
    "services": "Service layer",
    "service": "Service layer",
    "middleware": "Middleware",
    "middlewares": "Middleware",
    "utils": "Utility functions",
    "util": "Utility functions",
    "helpers": "Helper functions",
    "helper": "Helper functions",
    "lib": "Library modules",
    "libs": "Library modules",
    "pkg": "Package modules",
    "internal": "Internal packages",
    "cmd": "Command entry points",
    "config": "Configuration",
    "configs": "Configuration",
    "tests": "Test suite",
    "test": "Test suite",
    "__tests__": "Test suite",
    "spec": "Test specifications",
    "specs": "Test specifications",
    "fixtures": "Test fixtures",
    "mocks": "Test mocks",
    "components": "UI components",
    "component": "UI components",
    "pages": "Page components",
    "views": "View components",
    "layouts": "Layout components",
    "hooks": "React hooks",
    "store": "State management",
    "stores": "State management",
    "state": "State management",
    "reducers": "State reducers",
    "actions": "State actions",
    "selectors": "State selectors",
    "types": "Type definitions",
    "interfaces": "Interface definitions",
    "constants": "Constants",
    "static": "Static assets",
    "assets": "Static assets",
    "public": "Public assets",
    "styles": "Stylesheets",
    "css": "Stylesheets",
    "docs": "Documentation",
    "doc": "Documentation",
    "scripts": "Build and utility scripts",
    "migrations": "Database migrations",
    "seeds": "Database seed data",
    "templates": "Templates",
    "i18n": "Internationalization",
    "locales": "Locale translations",
    "proto": "Protocol buffer definitions",
    "generated": "Generated code",
    "gen": "Generated code",
    "dist": "Build output",
    "build": "Build output",
    "vendor": "Vendored dependencies",
    "node_modules": "NPM dependencies",
    "bin": "Executable binaries",
    "examples": "Usage examples",
    "example": "Usage examples",
    "plugins": "Plugin modules",
    "extensions": "Extension modules",
    "auth": "Authentication and authorization",
    "security": "Security modules",
    "crypto": "Cryptographic utilities",
    "db": "Database layer",
    "database": "Database layer",
    "cache": "Caching layer",
    "queue": "Message queue handlers",
    "workers": "Background workers",
    "jobs": "Background jobs",
    "tasks": "Task definitions",
    "events": "Event handlers",
    "subscribers": "Event subscribers",
    "publishers": "Event publishers",
    "adapters": "Adapter implementations",
    "providers": "Service providers",
    "repositories": "Data repositories",
    "repository": "Data repositories",
    "clients": "External API clients",
    "sdk": "SDK modules",
    "common": "Shared common modules",
    "shared": "Shared modules",
    "core": "Core modules",
    "base": "Base classes and interfaces",
    "errors": "Error definitions",
    "exceptions": "Exception definitions",
    "validators": "Input validators",
    "validation": "Validation logic",
    "serializers": "Data serializers",
    "parsers": "Data parsers",
    "formatters": "Data formatters",
    "converters": "Data converters",
    "transformers": "Data transformers",
    "mappers": "Data mappers",
    "resolvers": "GraphQL resolvers",
    "guards": "Route guards",
    "interceptors": "Request interceptors",
    "decorators": "Decorators",
    "annotations": "Annotations",
    "factories": "Factory functions",
    "builders": "Builder patterns",
    "observers": "Observer implementations",
    "strategies": "Strategy pattern implementations",
    "commands": "Command implementations",
    "queries": "Query implementations",
    "notifications": "Notification handlers",
    "mailers": "Email sending",
    "logging": "Logging configuration",
    "monitoring": "Monitoring and metrics",
    "metrics": "Application metrics",
    "tracing": "Distributed tracing",
    "indexer": "Indexing pipeline",
    "graph": "Graph data structures",
    "summarizer": "Summarization modules",
    "embedder": "Embedding modules",
    "extractors": "Data extractors",
}

# ---------------------------------------------------------------------------
# Keyword extraction patterns
# ---------------------------------------------------------------------------

_KEYWORD_PATTERNS: list[dict[str, object]] = [
    {"domain": "database", "patterns": [
        re.compile(r"\bsql\b", re.IGNORECASE), re.compile(r"\bquery\b", re.IGNORECASE),
        re.compile(r"\bSELECT\b"), re.compile(r"\bINSERT\b"),
        re.compile(r"\bUPDATE\b.*\bSET\b"), re.compile(r"\bdb\.", re.IGNORECASE),
        re.compile(r"\bcursor\b", re.IGNORECASE), re.compile(r"\bconnection\b", re.IGNORECASE),
        re.compile(r"\bprisma\b", re.IGNORECASE), re.compile(r"\bknex\b", re.IGNORECASE),
        re.compile(r"\bsequelize\b", re.IGNORECASE), re.compile(r"\bmongoose\b", re.IGNORECASE),
        re.compile(r"\bsqlx\b", re.IGNORECASE), re.compile(r"\borm\b", re.IGNORECASE),
        re.compile(r"\bmigration\b", re.IGNORECASE), re.compile(r"\bschema\b", re.IGNORECASE),
        re.compile(r"\btable\b", re.IGNORECASE), re.compile(r"\btransaction\b", re.IGNORECASE),
        re.compile(r"\bcolumn\b", re.IGNORECASE),
    ]},
    {"domain": "auth", "patterns": [
        re.compile(r"\bauth\b", re.IGNORECASE), re.compile(r"\bjwt\b", re.IGNORECASE),
        re.compile(r"\btoken\b", re.IGNORECASE), re.compile(r"\bpassword\b", re.IGNORECASE),
        re.compile(r"\blogin\b", re.IGNORECASE), re.compile(r"\bsession\b", re.IGNORECASE),
        re.compile(r"\boauth\b", re.IGNORECASE), re.compile(r"\bbcrypt\b", re.IGNORECASE),
        re.compile(r"\bcredential\b", re.IGNORECASE), re.compile(r"\bpermission\b", re.IGNORECASE),
        re.compile(r"\brole\b", re.IGNORECASE), re.compile(r"\bacl\b", re.IGNORECASE),
        re.compile(r"\bsignin\b", re.IGNORECASE), re.compile(r"\bsignup\b", re.IGNORECASE),
    ]},
    {"domain": "http", "patterns": [
        re.compile(r"\bhttp\b", re.IGNORECASE), re.compile(r"\brequest\b", re.IGNORECASE),
        re.compile(r"\bresponse\b", re.IGNORECASE), re.compile(r"\bfetch\s*\(", re.IGNORECASE),
        re.compile(r"\baxios\b", re.IGNORECASE), re.compile(r"\bhandler\b", re.IGNORECASE),
        re.compile(r"\bmiddleware\b", re.IGNORECASE), re.compile(r"\bcors\b", re.IGNORECASE),
        re.compile(r"\bendpoint\b", re.IGNORECASE), re.compile(r"\broute\b", re.IGNORECASE),
        re.compile(r"\bREST\b", re.IGNORECASE), re.compile(r"\bgraphql\b", re.IGNORECASE),
        re.compile(r"\bheader\b", re.IGNORECASE),
    ]},
    {"domain": "filesystem", "patterns": [
        re.compile(r"\bfs\.", re.IGNORECASE), re.compile(r"\breadFile\b", re.IGNORECASE),
        re.compile(r"\bwriteFile\b", re.IGNORECASE), re.compile(r"\bpath\.", re.IGNORECASE),
        re.compile(r"\bstream\b", re.IGNORECASE), re.compile(r"\bbuffer\b", re.IGNORECASE),
        re.compile(r"\bmkdir\b", re.IGNORECASE), re.compile(r"\bunlink\b", re.IGNORECASE),
        re.compile(r"\bglob\b", re.IGNORECASE),
    ]},
    {"domain": "crypto", "patterns": [
        re.compile(r"\bcrypto\b", re.IGNORECASE), re.compile(r"\bencrypt\b", re.IGNORECASE),
        re.compile(r"\bdecrypt\b", re.IGNORECASE), re.compile(r"\bhash\b", re.IGNORECASE),
        re.compile(r"\bsign\b", re.IGNORECASE), re.compile(r"\bverify\b", re.IGNORECASE),
        re.compile(r"\bcipher\b", re.IGNORECASE), re.compile(r"\bhmac\b", re.IGNORECASE),
    ]},
    {"domain": "cache", "patterns": [
        re.compile(r"\bcache\b", re.IGNORECASE), re.compile(r"\bredis\b", re.IGNORECASE),
        re.compile(r"\bmemcached\b", re.IGNORECASE), re.compile(r"\bttl\b", re.IGNORECASE),
        re.compile(r"\binvalidate\b", re.IGNORECASE), re.compile(r"\bLRU\b"),
    ]},
    {"domain": "queue", "patterns": [
        re.compile(r"\bqueue\b", re.IGNORECASE), re.compile(r"\bworker\b", re.IGNORECASE),
        re.compile(r"\bjob\b", re.IGNORECASE), re.compile(r"\bpublish\b", re.IGNORECASE),
        re.compile(r"\bsubscribe\b", re.IGNORECASE), re.compile(r"\bkafka\b", re.IGNORECASE),
        re.compile(r"\brabbitmq\b", re.IGNORECASE), re.compile(r"\bamqp\b", re.IGNORECASE),
    ]},
    {"domain": "config", "patterns": [
        re.compile(r"\bconfig\b", re.IGNORECASE), re.compile(r"\benv\b", re.IGNORECASE),
        re.compile(r"\bsettings\b", re.IGNORECASE), re.compile(r"\byaml\b", re.IGNORECASE),
        re.compile(r"\bdotenv\b", re.IGNORECASE), re.compile(r"\.env\b", re.IGNORECASE),
    ]},
    {"domain": "logging", "patterns": [
        re.compile(r"\blogger\b", re.IGNORECASE), re.compile(r"\bwinston\b", re.IGNORECASE),
        re.compile(r"\bpino\b", re.IGNORECASE), re.compile(r"\blogrus\b", re.IGNORECASE),
        re.compile(r"\bslog\b", re.IGNORECASE), re.compile(r"\blog\.", re.IGNORECASE),
    ]},
    {"domain": "testing", "patterns": [
        re.compile(r"\btest\b", re.IGNORECASE), re.compile(r"\bassert\b", re.IGNORECASE),
        re.compile(r"\bexpect\b", re.IGNORECASE), re.compile(r"\bmock\b", re.IGNORECASE),
        re.compile(r"\bstub\b", re.IGNORECASE), re.compile(r"\bspy\b", re.IGNORECASE),
        re.compile(r"\bfixture\b", re.IGNORECASE), re.compile(r"\bjest\b", re.IGNORECASE),
        re.compile(r"\bpytest\b", re.IGNORECASE),
    ]},
    {"domain": "async", "patterns": [
        re.compile(r"\basync\b", re.IGNORECASE), re.compile(r"\bawait\b", re.IGNORECASE),
        re.compile(r"\bPromise\b"), re.compile(r"\bgoroutine\b", re.IGNORECASE),
        re.compile(r"\bchannel\b", re.IGNORECASE), re.compile(r"\bconcurrent\b", re.IGNORECASE),
        re.compile(r"\bparallel\b", re.IGNORECASE), re.compile(r"\bmutex\b", re.IGNORECASE),
    ]},
    {"domain": "error", "patterns": [
        re.compile(r"\btry\b"), re.compile(r"\bcatch\b"), re.compile(r"\bthrow\b"),
        re.compile(r"\bError\b"), re.compile(r"\bpanic\b", re.IGNORECASE),
        re.compile(r"\brecover\b", re.IGNORECASE), re.compile(r"\berrno\b", re.IGNORECASE),
    ]},
    {"domain": "validation", "patterns": [
        re.compile(r"\bvalidate\b", re.IGNORECASE), re.compile(r"\bsanitize\b", re.IGNORECASE),
        re.compile(r"\bzod\b", re.IGNORECASE), re.compile(r"\byup\b", re.IGNORECASE),
        re.compile(r"\bjoi\b", re.IGNORECASE), re.compile(r"\bregexp\b", re.IGNORECASE),
        re.compile(r"\bregex\b", re.IGNORECASE),
    ]},
    {"domain": "websocket", "patterns": [
        re.compile(r"\bwebsocket\b", re.IGNORECASE), re.compile(r"\bws\.", re.IGNORECASE),
        re.compile(r"\bsocket\b", re.IGNORECASE), re.compile(r"\bWebSocket\b"),
        re.compile(r"\bemit\s*\(", re.IGNORECASE),
    ]},
    {"domain": "email", "patterns": [
        re.compile(r"\bemail\b", re.IGNORECASE), re.compile(r"\bsmtp\b", re.IGNORECASE),
        re.compile(r"\bsendmail\b", re.IGNORECASE), re.compile(r"\bmailer\b", re.IGNORECASE),
    ]},
]


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
