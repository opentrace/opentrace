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

"""Tests for opentrace_agent.sources.code.extractors.python_extractor."""

from __future__ import annotations

from opentrace_agent.sources.code.extractors.base import CallRef, DerivationRef, VariableSymbol
from opentrace_agent.sources.code.extractors.python_extractor import PythonExtractor


class TestPythonExtractor:
    def setup_method(self):
        self.extractor = PythonExtractor()

    def test_extensions(self):
        assert self.extractor.can_handle(".py")
        assert not self.extractor.can_handle(".ts")

    def test_extract_function(self):
        source = b"def hello(name: str) -> str:\n    return f'Hi {name}'\n"
        result = self.extractor.extract(source)

        assert result.language == "python"
        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "hello"
        assert sym.kind == "function"
        assert sym.start_line == 1
        assert sym.end_line == 2
        assert sym.signature == "(name: str)"

    def test_extract_class_with_methods(self):
        source = b"""\
class MyClass:
    def __init__(self):
        self.x = 1

    def method(self, y):
        return self.x + y
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        cls = result.symbols[0]
        assert cls.name == "MyClass"
        assert cls.kind == "class"
        assert cls.start_line == 1
        assert cls.end_line == 6
        assert len(cls.children) == 2
        assert cls.children[0].name == "__init__"
        assert cls.children[1].name == "method"

    def test_extract_decorated_function(self):
        source = b"""\
@staticmethod
def decorated():
    pass
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "decorated"
        assert result.symbols[0].kind == "function"

    def test_extract_decorated_class(self):
        source = b"""\
@dataclass
class Config:
    name: str = "default"
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "Config"
        assert result.symbols[0].kind == "class"

    def test_extract_multiple_toplevel(self):
        source = b"""\
class A:
    pass

class B:
    pass

def helper():
    pass
"""
        result = self.extractor.extract(source)

        names = [s.name for s in result.symbols]
        assert names == ["A", "B", "helper"]

    def test_extract_empty_file(self):
        result = self.extractor.extract(b"")
        assert result.symbols == []
        assert result.language == "python"

    def test_extract_class_with_decorated_method(self):
        source = b"""\
class Service:
    @property
    def name(self):
        return "svc"
"""
        result = self.extractor.extract(source)

        cls = result.symbols[0]
        assert len(cls.children) == 1
        assert cls.children[0].name == "name"

    def test_function_signature(self):
        source = b"def add(a: int, b: int = 0) -> int:\n    return a + b\n"
        result = self.extractor.extract(source)

        assert result.symbols[0].signature == "(a: int, b: int = 0)"

    # --- calls extraction tests ---

    def test_extract_simple_calls(self):
        source = b"""\
def main():
    helper()
    setup()
"""
        result = self.extractor.extract(source)
        assert result.symbols[0].calls == [CallRef("helper"), CallRef("setup")]

    def test_extract_captures_dotted_calls(self):
        source = b"""\
def process(self):
    self.validate()
    os.path.join("a", "b")
    helper()
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("validate", receiver="self", kind="attribute") in calls
        assert CallRef("join", receiver="os.path", kind="attribute") in calls
        assert CallRef("helper") in calls

    def test_extract_nested_calls(self):
        source = b"""\
def main():
    foo(bar())
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("foo") in calls
        assert CallRef("bar") in calls

    def test_extract_no_body_has_empty_calls(self):
        """A function stub still gets an empty calls list."""
        source = b"def stub(): pass\n"
        result = self.extractor.extract(source)
        assert result.symbols[0].calls == []

    def test_extract_constructor_call(self):
        source = b"""\
def make():
    return MyClass()
"""
        result = self.extractor.extract(source)
        assert CallRef("MyClass") in result.symbols[0].calls

    def test_calls_default_empty_for_existing_symbols(self):
        """Existing symbols without calls should default to empty list."""
        source = b"class Foo:\n    pass\n"
        result = self.extractor.extract(source)
        assert result.symbols[0].calls == []

    def test_self_method_call_has_receiver(self):
        """self.method() produces CallRef with receiver='self' and kind='attribute'."""
        source = b"""\
class Service:
    def handle(self):
        self.validate()
        self.save()
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        handle = cls.children[0]
        assert CallRef("validate", receiver="self", kind="attribute") in handle.calls
        assert CallRef("save", receiver="self", kind="attribute") in handle.calls

    # --- variable extraction tests ---

    def test_extract_function_parameters(self):
        source = b"""\
def process(user_id: int, name: str):
    pass
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        assert len(func.variables) == 2
        assert func.variables[0].name == "user_id"
        assert func.variables[0].kind == "parameter"
        assert func.variables[0].type_annotation == "int"
        assert func.variables[1].name == "name"
        assert func.variables[1].type_annotation == "str"

    def test_extract_parameters_skips_self_cls(self):
        source = b"""\
class Foo:
    def method(self, x: int):
        pass

    @classmethod
    def create(cls, y: str):
        pass
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        method = cls.children[0]
        assert len(method.variables) == 1
        assert method.variables[0].name == "x"
        create = cls.children[1]
        assert len(create.variables) == 1
        assert create.variables[0].name == "y"

    def test_extract_local_variable_from_call(self):
        source = b"""\
def handler():
    result = fetch_data()
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        locals_ = [v for v in func.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "result"
        assert locals_[0].derived_from == [DerivationRef(kind="call", name="fetch_data")]

    def test_extract_local_variable_from_variable(self):
        source = b"""\
def handler(data):
    copy = data
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        locals_ = [v for v in func.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "copy"
        assert locals_[0].derived_from == [DerivationRef(kind="variable", name="data")]

    def test_extract_local_variable_from_method_call(self):
        source = b"""\
def handler(repo):
    user = repo.find_by_id()
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        locals_ = [v for v in func.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "user"
        assert locals_[0].derived_from == [
            DerivationRef(kind="call", name="find_by_id", receiver="repo")
        ]

    def test_extract_local_variable_from_attribute(self):
        source = b"""\
def handler(self):
    name = self.name
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        locals_ = [v for v in func.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "name"
        assert locals_[0].derived_from == [
            DerivationRef(kind="variable", name="name", receiver="self")
        ]

    def test_extract_class_fields_from_init(self):
        source = b"""\
class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        assert len(cls.variables) == 2
        assert cls.variables[0].name == "name"
        assert cls.variables[0].kind == "field"
        assert cls.variables[0].derived_from == [
            DerivationRef(kind="variable", name="name")
        ]
        assert cls.variables[1].name == "email"
        assert cls.variables[1].kind == "field"

    def test_extract_dataclass_fields(self):
        source = b"""\
@dataclass
class Config:
    name: str
    value: int
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        fields = [v for v in cls.variables if v.kind == "field"]
        assert len(fields) == 2
        assert fields[0].name == "name"
        assert fields[1].name == "value"

    def test_call_args_captured(self):
        source = b"""\
def handler(user_id, name):
    result = process(user_id, name)
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        call = func.calls[0]
        assert call.name == "process"
        assert call.args == ["user_id", "name"]

    def test_call_args_keyword(self):
        source = b"""\
def handler(data):
    save(payload=data)
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        call = func.calls[0]
        assert call.name == "save"
        assert call.args == ["data"]

    def test_annotated_local_variable(self):
        source = b"""\
def handler():
    count: int = get_count()
"""
        result = self.extractor.extract(source)
        func = result.symbols[0]
        locals_ = [v for v in func.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "count"
        assert locals_[0].derived_from == [DerivationRef(kind="call", name="get_count")]
