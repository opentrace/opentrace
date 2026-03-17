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

"""Tests for opentrace_agent.sources.code.symbol_attacher."""

from __future__ import annotations

from pathlib import Path

from opentrace_agent.models.base import NodeRelationship
from opentrace_agent.models.nodes import ClassNode, FileNode, FunctionNode, RepoNode
from opentrace_agent.sources.code.extractors.go_extractor import GoExtractor
from opentrace_agent.sources.code.extractors.python_extractor import PythonExtractor
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor,
)
from opentrace_agent.sources.code.symbol_attacher import SymbolAttacher

SAMPLE_PYTHON = b'''\
class Greeter:
    """A sample class."""

    def greet(self, name: str) -> str:
        return f"Hello, {name}"

    def farewell(self):
        return "Goodbye"


def standalone():
    pass
'''


def _make_file_node(repo: RepoNode, filename: str, abs_path: str, ext: str) -> FileNode:
    """Helper to create and attach a FileNode to a repo."""
    file_node = FileNode(
        id=f"{repo.id}/{filename}",
        name=filename,
        path=filename,
        extension=ext,
        abs_path=abs_path,
    )
    repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))
    return file_node


class TestSymbolAttacher:
    def test_attach_python_file(self, tmp_path: Path):
        # Write sample file to disk
        py_file = tmp_path / "greeter.py"
        py_file.write_bytes(SAMPLE_PYTHON)

        # Build a minimal tree
        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/greeter.py",
            name="greeter.py",
            path="greeter.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["classes"] == 1
        assert counts["functions"] == 3  # greet, farewell, standalone

        # File should now have children
        file_children = file_node.children
        assert len(file_children) == 2  # Greeter class + standalone function

        # Check class node
        class_rel = next(r for r in file_children if isinstance(r.target, ClassNode))
        cls = class_rel.target
        assert cls.name == "Greeter"
        assert cls.language == "python"
        assert cls.start_line == 1
        assert cls.end_line == 8

        # Class should have 2 methods
        method_names = {r.target.name for r in cls.children}
        assert method_names == {"greet", "farewell"}

        # Check standalone function
        func_rel = next(r for r in file_children if isinstance(r.target, FunctionNode))
        func = func_rel.target
        assert func.name == "standalone"
        assert func.signature == "()"

    def test_attach_skips_missing_file(self, tmp_path: Path):
        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/missing.py",
            name="missing.py",
            path="missing.py",
            extension=".py",
            language="python",
            abs_path=str(tmp_path / "does_not_exist.py"),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)
        assert counts["classes"] == 0
        assert counts["functions"] == 0

    def test_attach_skips_no_extractor(self, tmp_path: Path):
        # .rs file with no Rust extractor registered
        rs_file = tmp_path / "lib.rs"
        rs_file.write_text("fn main() {}")

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/lib.rs",
            name="lib.rs",
            path="lib.rs",
            extension=".rs",
            abs_path=str(rs_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)
        assert counts["classes"] == 0
        assert counts["functions"] == 0

    def test_attach_empty_tree(self):
        repo = RepoNode(id="test/repo", name="repo")
        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)
        assert counts == {"classes": 0, "functions": 0, "calls": 0, "summaries": 0}

    def test_symbol_node_ids(self, tmp_path: Path):
        py_file = tmp_path / "mod.py"
        py_file.write_bytes(b"class Foo:\n    def bar(self): pass\n")

        repo = RepoNode(id="org/r", name="r")
        file_node = FileNode(
            id="org/r/mod.py",
            name="mod.py",
            path="mod.py",
            extension=".py",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        attacher.attach(repo)

        class_node = file_node.children[0].target
        assert class_node.id == "org/r/mod.py::Foo"
        method_node = class_node.children[0].target
        assert method_node.id == "org/r/mod.py::Foo::bar"

    # --- call relationship tests ---

    def test_intra_file_call_creates_relationship(self, tmp_path: Path):
        source = b"""\
def helper():
    pass

def main():
    helper()
"""
        py_file = tmp_path / "calls.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/calls.py",
            name="calls.py",
            path="calls.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        # Find the main function node
        main_rel = next(r for r in file_node.children if r.target.name == "main")
        main_node = main_rel.target

        # Should have a calls relationship
        call_rels = [r for r in main_node.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "helper"
        assert call_rels[0].direction == "outgoing"
        assert call_rels[0].confidence == 1.0

    def test_duplicate_calls_produce_single_relationship(self, tmp_path: Path):
        source = b"""\
def helper():
    pass

def main():
    helper()
    helper()
    helper()
"""
        py_file = tmp_path / "dupes.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/dupes.py",
            name="dupes.py",
            path="dupes.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

    def test_unresolved_call_produces_no_relationship(self, tmp_path: Path):
        source = b"""\
def main():
    nonexistent()
"""
        py_file = tmp_path / "unresolved.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/unresolved.py",
            name="unresolved.py",
            path="unresolved.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 0

    def test_class_method_calls_file_level_function(self, tmp_path: Path):
        source = b"""\
def validate():
    pass

class Service:
    def handle(self):
        validate()
"""
        py_file = tmp_path / "cross.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/cross.py",
            name="cross.py",
            path="cross.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        # Find the handle method inside Service
        service_rel = next(r for r in file_node.children if r.target.name == "Service")
        handle_rel = next(r for r in service_rel.target.children if r.target.name == "handle")
        handle_node = handle_rel.target

        call_rels = [r for r in handle_node.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "validate"

    def test_call_relationship_does_not_clobber_parent(self, tmp_path: Path):
        """Verify that call targets keep their original parent (file node)."""
        source = b"""\
def helper():
    pass

def main():
    helper()
"""
        py_file = tmp_path / "parent.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = FileNode(
            id="test/repo/parent.py",
            name="parent.py",
            path="parent.py",
            extension=".py",
            language="python",
            abs_path=str(py_file),
        )
        repo.add_child(NodeRelationship(target=file_node, relationship="DEFINED_IN"))

        attacher = SymbolAttacher([PythonExtractor()])
        attacher.attach(repo)

        helper_rel = next(r for r in file_node.children if r.target.name == "helper")
        # helper's parent should still be file_node, not main
        assert helper_rel.target.parent is file_node

    # --- self/this resolution tests ---

    def test_self_method_resolves_within_class(self, tmp_path: Path):
        """Python self.method() should create a CALLS edge to the method in the same class."""
        source = b"""\
class Service:
    def validate(self):
        pass

    def handle(self):
        self.validate()
"""
        py_file = tmp_path / "selfcall.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "selfcall.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        service_rel = next(r for r in file_node.children if r.target.name == "Service")
        handle_rel = next(r for r in service_rel.target.children if r.target.name == "handle")
        call_rels = [r for r in handle_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "validate"
        assert call_rels[0].confidence == 1.0

    # --- cross-file resolution tests ---

    def test_cross_file_bare_call_resolves(self, tmp_path: Path):
        """A bare call to a function defined in another file should resolve (unique match)."""
        file_a = tmp_path / "a.py"
        file_a.write_bytes(b"def shared_helper():\n    pass\n")

        file_b = tmp_path / "b.py"
        file_b.write_bytes(b"def caller():\n    shared_helper()\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "a.py", str(file_a), ".py")
        fn_b = _make_file_node(repo, "b.py", str(file_b), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        caller_rel = next(r for r in fn_b.children if r.target.name == "caller")
        call_rels = [r for r in caller_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "shared_helper"
        assert call_rels[0].confidence == 0.8

    def test_cross_file_ambiguous_skipped(self, tmp_path: Path):
        """When multiple files define the same name, cross-file resolution should skip."""
        file_a = tmp_path / "a.py"
        file_a.write_bytes(b"def helper():\n    pass\n")

        file_b = tmp_path / "b.py"
        file_b.write_bytes(b"def helper():\n    pass\n")

        file_c = tmp_path / "c.py"
        file_c.write_bytes(b"def caller():\n    helper()\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "a.py", str(file_a), ".py")
        _make_file_node(repo, "b.py", str(file_b), ".py")
        fn_c = _make_file_node(repo, "c.py", str(file_c), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        # No calls resolved because helper() is ambiguous across files
        assert counts["calls"] == 0

        caller_rel = next(r for r in fn_c.children if r.target.name == "caller")
        call_rels = [r for r in caller_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 0

    def test_cross_file_call_lower_confidence(self, tmp_path: Path):
        """Cross-file bare call should have confidence 0.8 (not 1.0)."""
        file_a = tmp_path / "a.py"
        file_a.write_bytes(b"def utility():\n    pass\n")

        file_b = tmp_path / "b.py"
        file_b.write_bytes(b"def main():\n    utility()\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "a.py", str(file_a), ".py")
        fn_b = _make_file_node(repo, "b.py", str(file_b), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1
        main_rel = next(r for r in fn_b.children if r.target.name == "main")
        call_rels = [r for r in main_rel.target.children if r.relationship == "CALLS"]
        assert call_rels[0].confidence == 0.8

    # --- Go receiver resolution tests ---

    def test_go_receiver_method_resolves(self, tmp_path: Path):
        """Go s.Listen() should resolve via receiver type when s is the receiver var."""
        source = b"""\
package main

type Server struct{}

func (s *Server) Listen() {}

func (s *Server) Start() {
	s.Listen()
}
"""
        go_file = tmp_path / "server.go"
        go_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "server.go", str(go_file), ".go")

        attacher = SymbolAttacher([GoExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        start_rel = next(r for r in file_node.children if r.target.name == "Start")
        call_rels = [r for r in start_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "Listen"
        assert call_rels[0].confidence == 1.0

    # --- Stage 2: ClassName.method() and constructor resolution ---

    def test_classname_dot_method_resolves(self, tmp_path: Path):
        """ClassName.method() should resolve to the method inside that class."""
        source = b"""\
class Validator:
    @staticmethod
    def check(data):
        pass

def process():
    Validator.check(42)
"""
        py_file = tmp_path / "cls_method.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "cls_method.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        process_rel = next(r for r in file_node.children if r.target.name == "process")
        call_rels = [r for r in process_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "check"
        assert call_rels[0].confidence == 1.0  # same file

    def test_constructor_call_resolves_to_class(self, tmp_path: Path):
        """Bare call matching a class name should resolve to the class (or __init__)."""
        source = b"""\
class Widget:
    def __init__(self):
        pass

    def render(self):
        pass

def create():
    Widget()
"""
        py_file = tmp_path / "ctor.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "ctor.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        create_rel = next(r for r in file_node.children if r.target.name == "create")
        call_rels = [r for r in create_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        # Should resolve to __init__ (preferred over class node when present)
        assert call_rels[0].target.name == "__init__"

    def test_constructor_call_resolves_to_class_without_init(self, tmp_path: Path):
        """When a class has no __init__, constructor call resolves to the ClassNode itself."""
        source = b"""\
class Config:
    name: str = "default"

def build():
    Config()
"""
        py_file = tmp_path / "ctor_no_init.py"
        py_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "ctor_no_init.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        build_rel = next(r for r in file_node.children if r.target.name == "build")
        call_rels = [r for r in build_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "Config"
        assert isinstance(call_rels[0].target, ClassNode)

    def test_go_struct_method_via_type_name(self, tmp_path: Path):
        """Go Server.Listen() should resolve via class_registry → receiver_type methods."""
        source = b"""\
package main

type Server struct{}

func (s *Server) Listen() {}

func main() {
	Server.Listen()
}
"""
        go_file = tmp_path / "go_cls.go"
        go_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "go_cls.go", str(go_file), ".go")

        attacher = SymbolAttacher([GoExtractor()])
        counts = attacher.attach(repo)

        # Should resolve Server.Listen() via class_registry
        assert counts["calls"] >= 1

        main_rel = next(r for r in file_node.children if r.target.name == "main")
        call_rels = [r for r in main_rel.target.children if r.relationship == "CALLS"]
        assert any(r.target.name == "Listen" for r in call_rels)

    def test_ts_constructor_call_resolves(self, tmp_path: Path):
        """TypeScript constructor() resolution via class_registry."""
        source = b"""\
class Service {
  constructor() {}
  start() {}
}

function create() {
  Service();
}
"""
        ts_file = tmp_path / "ctor.ts"
        ts_file.write_bytes(source)

        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "ctor.ts", str(ts_file), ".ts")

        attacher = SymbolAttacher([TypeScriptExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        create_rel = next(r for r in file_node.children if r.target.name == "create")
        call_rels = [r for r in create_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "constructor"

    # --- Stage 3: Import-based resolution ---

    def test_import_resolves_module_call(self, tmp_path: Path):
        """Python import + module.func() should resolve via import analysis."""
        # File with a function
        utils_file = tmp_path / "utils.py"
        utils_file.write_bytes(b"def validate():\n    pass\n")

        # File that imports and calls it
        main_file = tmp_path / "main.py"
        main_file.write_bytes(b"import utils\n\ndef run():\n    utils.validate()\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "utils.py", str(utils_file), ".py")
        fn_main = _make_file_node(repo, "main.py", str(main_file), ".py")
        # Adjust file_node paths to match what import_analyzer expects
        for rel in repo.children:
            if rel.target.name == "utils.py":
                rel.target.path = "utils.py"
            elif rel.target.name == "main.py":
                rel.target.path = "main.py"

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        run_rel = next(r for r in fn_main.children if r.target.name == "run")
        call_rels = [r for r in run_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "validate"
        assert call_rels[0].confidence == 0.9

    def test_external_import_skipped(self, tmp_path: Path):
        """External/stdlib imports should not create call relationships."""
        main_file = tmp_path / "main.py"
        main_file.write_bytes(b"import os\n\ndef run():\n    os.getcwd()\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "main.py", str(main_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        # os.getcwd() should not resolve since 'os' is not a local file
        assert counts["calls"] == 0

    # --- classRegistry collision tests ---

    def test_same_name_class_prefers_same_file(self, tmp_path: Path):
        """When two files define same class name, constructor call prefers same-file class."""
        file_a = tmp_path / "a.py"
        file_a.write_bytes(b"""\
class Servicer:
    def __init__(self):
        pass
""")
        file_b = tmp_path / "b.py"
        file_b.write_bytes(b"""\
class Servicer:
    def __init__(self):
        pass

def create():
    Servicer()
""")
        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "a.py", str(file_a), ".py")
        fn_b = _make_file_node(repo, "b.py", str(file_b), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] >= 1

        create_rel = next(r for r in fn_b.children if r.target.name == "create")
        call_rels = [r for r in create_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        # Should prefer b.py's Servicer (same file as caller)
        assert call_rels[0].target.id.startswith("test/repo/b.py::")
        assert call_rels[0].confidence == 1.0

    # --- from-import bare call resolution tests ---

    def test_from_import_bare_call_resolves(self, tmp_path: Path):
        """from models import User + bare User() should resolve via import symbol."""
        models_file = tmp_path / "models.py"
        models_file.write_bytes(b"""\
class User:
    def __init__(self, name):
        pass
""")
        main_file = tmp_path / "main.py"
        main_file.write_bytes(b"""\
from models import User

def create():
    User("alice")
""")
        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "models.py", str(models_file), ".py")
        fn_main = _make_file_node(repo, "main.py", str(main_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] >= 1

        create_rel = next(r for r in fn_main.children if r.target.name == "create")
        call_rels = [r for r in create_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "__init__"

    # --- parameter type hint resolution tests ---

    def test_param_type_hint_resolves_method_call(self, tmp_path: Path):
        """channel.method() should resolve when channel has a type hint."""
        py_file = tmp_path / "service.py"
        py_file.write_bytes(b"""\
class Channel:
    def unary_stream(self):
        pass

def serve(channel: Channel):
    channel.unary_stream()
""")
        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "service.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] >= 1

        serve_rel = next(r for r in file_node.children if r.target.name == "serve")
        call_rels = [r for r in serve_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "unary_stream"
        assert call_rels[0].confidence == 0.7

    def test_param_type_hint_dotted_resolves(self, tmp_path: Path):
        """grpc.Channel type hint should resolve via the leaf type name."""
        py_file = tmp_path / "service.py"
        py_file.write_bytes(b"""\
class Channel:
    def close(self):
        pass

def serve(channel: grpc.Channel):
    channel.close()
""")
        repo = RepoNode(id="test/repo", name="repo")
        file_node = _make_file_node(repo, "service.py", str(py_file), ".py")

        attacher = SymbolAttacher([PythonExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] >= 1

        serve_rel = next(r for r in file_node.children if r.target.name == "serve")
        call_rels = [r for r in serve_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "close"
        assert call_rels[0].confidence == 0.7

    def test_ts_import_resolves_module_call(self, tmp_path: Path):
        """TypeScript relative import + module.func() should resolve."""
        utils_file = tmp_path / "utils.ts"
        utils_file.write_bytes(b"export function validate(): void {}\n")

        main_file = tmp_path / "main.ts"
        main_file.write_bytes(b"import { validate } from './utils';\n\nfunction run() {\n  utils.validate();\n}\n")

        repo = RepoNode(id="test/repo", name="repo")
        _make_file_node(repo, "utils.ts", str(utils_file), ".ts")
        fn_main = _make_file_node(repo, "main.ts", str(main_file), ".ts")

        attacher = SymbolAttacher([TypeScriptExtractor()])
        counts = attacher.attach(repo)

        assert counts["calls"] == 1

        run_rel = next(r for r in fn_main.children if r.target.name == "run")
        call_rels = [r for r in run_rel.target.children if r.relationship == "CALLS"]
        assert len(call_rels) == 1
        assert call_rels[0].target.name == "validate"
        assert call_rels[0].confidence == 0.9
