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

"""Tests for opentrace_agent.sources.code.import_analyzer."""

from __future__ import annotations

import tree_sitter
import tree_sitter_go
import tree_sitter_python
import tree_sitter_typescript

from opentrace_agent.sources.code.import_analyzer import (
    analyze_go_imports,
    analyze_python_imports,
    analyze_typescript_imports,
)


def _parse_python(source: bytes) -> tree_sitter.Node:
    lang = tree_sitter.Language(tree_sitter_python.language())
    parser = tree_sitter.Parser(lang)
    return parser.parse(source).root_node


def _parse_go(source: bytes) -> tree_sitter.Node:
    lang = tree_sitter.Language(tree_sitter_go.language())
    parser = tree_sitter.Parser(lang)
    return parser.parse(source).root_node


def _parse_typescript(source: bytes) -> tree_sitter.Node:
    lang = tree_sitter.Language(tree_sitter_typescript.language_typescript())
    parser = tree_sitter.Parser(lang)
    return parser.parse(source).root_node


class TestPythonImports:
    def test_import_module(self):
        source = b"import utils\n"
        known = {"utils.py", "utils/__init__.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal["utils"] == "utils.py"

    def test_import_dotted_module(self):
        source = b"import mypackage.helpers\n"
        known = {"mypackage/helpers.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal["helpers"] == "mypackage/helpers.py"

    def test_import_aliased(self):
        source = b"import mypackage.helpers as h\n"
        known = {"mypackage/helpers.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal["h"] == "mypackage/helpers.py"

    def test_import_external_produces_package_ref(self):
        """Imports not matching any known file should produce external refs."""
        source = b"import os\nimport json\n"
        known = {"main.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal == {}
        assert result.external.get("os") == "pkg:pypi:os"
        assert result.external.get("json") == "pkg:pypi:json"

    def test_from_import_module(self):
        source = b"from mypackage import helpers\n"
        known = {"mypackage.py", "mypackage/__init__.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        # from X import Y — the alias is for module X
        assert "mypackage" in result.internal or result.internal == {}

    def test_multiple_imports(self):
        source = b"import utils\nimport config\n"
        known = {"utils.py", "config.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert "utils" in result.internal
        assert "config" in result.internal

    def test_from_import_stores_symbol_names(self):
        """from models import User should store 'User' → target file."""
        source = b"from models import User\n"
        known = {"models.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal.get("models") == "models.py"
        assert result.internal.get("User") == "models.py"

    def test_from_import_stores_multiple_symbols(self):
        """from models import User, Order should store both symbol names."""
        source = b"from models import User, Order\n"
        known = {"models.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal.get("User") == "models.py"
        assert result.internal.get("Order") == "models.py"

    def test_from_import_stores_aliased_symbol(self):
        """from models import User as U should store 'U' → target file."""
        source = b"from models import User as U\n"
        known = {"models.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal.get("U") == "models.py"

    def test_from_import_external(self):
        """from requests import get should produce external ref."""
        source = b"from requests import get\n"
        known = {"main.py"}
        result = analyze_python_imports(_parse_python(source), "main.py", known)
        assert result.internal == {}
        assert result.external.get("requests") == "pkg:pypi:requests"


class TestGoImports:
    def test_import_local_package(self):
        source = b'package main\n\nimport "myproject/internal/store"\n'
        known = {"internal/store/store.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert result.internal.get("store") == "internal/store/store.go"

    def test_import_aliased(self):
        source = b'package main\n\nimport s "myproject/internal/store"\n'
        known = {"internal/store/store.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert result.internal.get("s") == "internal/store/store.go"

    def test_import_skips_stdlib(self):
        """Stdlib imports (no slash) should be skipped."""
        source = b'package main\n\nimport "fmt"\n'
        known = {"main.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert result.internal == {}
        assert result.external == {}

    def test_grouped_imports(self):
        source = b"""\
package main

import (
\t"fmt"
\t"myproject/internal/store"
)
"""
        known = {"internal/store/store.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert "fmt" not in result.internal
        assert result.internal.get("store") == "internal/store/store.go"

    def test_import_blank_skipped(self):
        """Blank imports (_ alias) should be skipped."""
        source = b'package main\n\nimport _ "myproject/internal/store"\n'
        known = {"internal/store/store.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert result.internal == {}

    def test_external_go_import(self):
        """Non-local Go imports produce external package refs."""
        source = b'package main\n\nimport "github.com/gorilla/mux"\n'
        known = {"main.go"}
        result = analyze_go_imports(_parse_go(source), known)
        assert result.internal == {}
        assert result.external.get("github.com/gorilla/mux") == "pkg:go:github.com/gorilla/mux"


class TestTypeScriptImports:
    def test_relative_import(self):
        source = b"import { helper } from './utils';\n"
        known = {"src/utils.ts", "src/main.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/main.ts", known)
        assert result.internal.get("utils") == "src/utils.ts"

    def test_relative_import_parent_dir(self):
        source = b"import { config } from '../config';\n"
        known = {"src/config.ts", "src/app/main.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/app/main.ts", known)
        assert result.internal.get("config") == "src/config.ts"

    def test_bare_specifier_produces_external(self):
        """Non-relative imports produce external Package refs."""
        source = b"import React from 'react';\n"
        known = {"src/main.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/main.ts", known)
        assert result.internal == {}
        assert result.external.get("react") == "pkg:npm:react"

    def test_scoped_package_external(self):
        """Scoped npm packages produce correct package IDs."""
        source = b"import { useState } from '@tanstack/react-query';\n"
        known = {"src/main.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/main.ts", known)
        assert result.external.get("@tanstack/react-query") == "pkg:npm:@tanstack/react-query"

    def test_index_file_resolution(self):
        source = b"import { App } from './components';\n"
        known = {"src/components/index.ts", "src/main.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/main.ts", known)
        assert result.internal.get("components") == "src/components/index.ts"

    def test_tsx_extension_resolution(self):
        source = b"import { Widget } from './Widget';\n"
        known = {"src/Widget.tsx", "src/App.tsx"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/App.tsx", known)
        assert result.internal.get("Widget") == "src/Widget.tsx"

    def test_named_reexport(self):
        """export { Config } from './config' should create an alias."""
        source = b"export { Config } from './config';\n"
        known = {"src/config.ts", "src/index.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/index.ts", known)
        assert result.internal.get("config") == "src/config.ts"

    def test_reexport_skips_external(self):
        """Re-exports from external packages should be skipped."""
        source = b"export { useState } from 'react';\n"
        known = {"src/index.ts"}
        result = analyze_typescript_imports(_parse_typescript(source), "src/index.ts", known)
        assert result.internal == {}
