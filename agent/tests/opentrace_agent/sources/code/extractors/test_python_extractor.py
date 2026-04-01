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

from opentrace_agent.sources.code.extractors.base import CallRef, DerivationRef
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
        """Function parameters are extracted as VariableSymbol(kind='parameter')."""
        source = b"def greet(name: str, count: int = 1):\n    pass\n"
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        params = [v for v in fn.variables if v.kind == "parameter"]
        names = [p.name for p in params]
        assert "name" in names
        assert "count" in names
        name_var = next(p for p in params if p.name == "name")
        assert name_var.type_annotation == "str"

    def test_extract_skips_self_cls_parameters(self):
        """self and cls parameters are not extracted."""
        source = b"""\
class Foo:
    def method(self, x):
        pass
    @classmethod
    def from_val(cls, val):
        pass
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        method = cls.children[0]
        param_names = [v.name for v in method.variables if v.kind == "parameter"]
        assert "self" not in param_names
        assert "x" in param_names
        from_val = cls.children[1]
        param_names2 = [v.name for v in from_val.variables if v.kind == "parameter"]
        assert "cls" not in param_names2
        assert "val" in param_names2

    def test_extract_local_from_call(self):
        """Local variable assigned from a function call."""
        source = b"""\
def process():
    result = compute()
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        locals_ = [v for v in fn.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "result"
        assert DerivationRef(kind="call", name="compute") in locals_[0].derived_from

    def test_extract_local_from_variable(self):
        """Local variable assigned from another variable."""
        source = b"""\
def copy(x):
    y = x
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        locals_ = [v for v in fn.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "y"
        assert DerivationRef(kind="identifier", name="x") in locals_[0].derived_from

    def test_extract_local_from_method_call(self):
        """Local variable assigned from a method call (attribute)."""
        source = b"""\
def fetch(client):
    data = client.get()
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        locals_ = [v for v in fn.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert DerivationRef(kind="call", name="get", receiver="client") in locals_[0].derived_from

    def test_extract_local_from_attribute(self):
        """Local variable assigned from attribute access."""
        source = b"""\
def read(obj):
    val = obj.value
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        locals_ = [v for v in fn.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert DerivationRef(kind="attribute", name="value", receiver="obj") in locals_[0].derived_from

    def test_extract_class_fields_dataclass(self):
        """Dataclass-style annotated fields are extracted."""
        source = b"""\
class Config:
    name: str = "default"
    port: int = 8080
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        field_names = [v.name for v in cls.variables if v.kind == "field"]
        assert "name" in field_names
        assert "port" in field_names
        name_field = next(v for v in cls.variables if v.name == "name")
        assert name_field.type_annotation == "str"

    def test_extract_self_assignments_as_fields(self):
        """self.x = ... in __init__ creates class fields."""
        source = b"""\
class Foo:
    def __init__(self, val):
        self.val = val
        self.computed = process(val)
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        field_names = [v.name for v in cls.variables if v.kind == "field"]
        assert "val" in field_names
        assert "computed" in field_names
        val_field = next(v for v in cls.variables if v.name == "val")
        assert DerivationRef(kind="identifier", name="val") in val_field.derived_from
        computed_field = next(v for v in cls.variables if v.name == "computed")
        assert DerivationRef(kind="call", name="process") in computed_field.derived_from

    def test_extract_call_args(self):
        """Identifier arguments to function calls are captured."""
        source = b"""\
def main():
    process(data, config)
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        assert len(fn.calls) == 1
        assert fn.calls[0].args == ["data", "config"]

    def test_extract_annotated_local(self):
        """Annotated local variable assignment."""
        source = b"""\
def typed():
    x: int = compute()
"""
        result = self.extractor.extract(source)
        fn = result.symbols[0]
        locals_ = [v for v in fn.variables if v.kind == "local"]
        assert len(locals_) == 1
        assert locals_[0].name == "x"
        assert locals_[0].type_annotation == "int"
        assert DerivationRef(kind="call", name="compute") in locals_[0].derived_from
