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

from opentrace_agent.sources.code.extractors.base import CallArg, CallRef, VariableRef
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
        call_keys = [(c.name, c.receiver, c.kind) for c in calls]
        assert ("validate", "self", "attribute") in call_keys
        assert ("join", "os.path", "attribute") in call_keys
        assert ("helper", None, "bare") in call_keys

    def test_extract_nested_calls(self):
        source = b"""\
def main():
    foo(bar())
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        call_names = [c.name for c in calls]
        assert "foo" in call_names
        assert "bar" in call_names
        # foo's argument should be the nested bar() call
        foo_call = [c for c in calls if c.name == "foo"][0]
        assert len(foo_call.arguments) == 1
        assert foo_call.arguments[0].kind == "call"

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

    # --- call arguments extraction tests ---

    def test_call_arguments_with_variables(self):
        """Call arguments capture variable references."""
        source = b"""\
def process():
    data = load()
    result = transform(data)
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        transform_call = [c for c in calls if c.name == "transform"][0]
        assert len(transform_call.arguments) == 1
        assert transform_call.arguments[0] == CallArg(name="data", kind="variable")

    def test_call_arguments_with_literals(self):
        """Literal arguments are classified correctly."""
        source = b"""\
def run():
    print("hello", 42)
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        print_call = [c for c in calls if c.name == "print"][0]
        assert len(print_call.arguments) == 2
        assert print_call.arguments[0].kind == "literal"
        assert print_call.arguments[1].kind == "literal"

    def test_call_arguments_with_keyword(self):
        """Keyword arguments capture the value side."""
        source = b"""\
def run():
    x = 1
    foo(key=x)
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        foo_call = [c for c in calls if c.name == "foo"][0]
        assert len(foo_call.arguments) == 1
        assert foo_call.arguments[0] == CallArg(name="x", kind="variable")

    def test_call_arguments_mixed(self):
        """Mixed argument types are all captured."""
        source = b"""\
def run():
    a = 1
    foo(a, "lit", bar())
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        foo_call = [c for c in calls if c.name == "foo"][0]
        assert len(foo_call.arguments) == 3
        assert foo_call.arguments[0].kind == "variable"
        assert foo_call.arguments[1].kind == "literal"
        assert foo_call.arguments[2].kind == "call"

    def test_call_with_no_arguments(self):
        """Calls with no arguments have empty arguments list."""
        source = b"""\
def run():
    foo()
"""
        result = self.extractor.extract(source)
        assert result.symbols[0].calls[0].arguments == []

    # --- variable extraction tests ---

    def test_extract_simple_variables(self):
        """Simple assignments produce VariableRef entries."""
        source = b"""\
def process():
    x = 1
    y = "hello"
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        names = [v.name for v in variables]
        assert "x" in names
        assert "y" in names

    def test_extract_annotated_variable(self):
        """Annotated assignments capture the type annotation."""
        source = b"""\
def process():
    x: int = 42
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        x_var = [v for v in variables if v.name == "x"][0]
        assert x_var.type_annotation == "int"

    def test_extract_tuple_unpacking(self):
        """Tuple unpacking produces separate VariableRef entries."""
        source = b"""\
def process():
    a, b = get_pair()
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        names = [v.name for v in variables]
        assert "a" in names
        assert "b" in names

    def test_extract_for_loop_variable(self):
        """For-loop targets are captured as variables."""
        source = b"""\
def process():
    for item in items:
        print(item)
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        names = [v.name for v in variables]
        assert "item" in names

    def test_extract_self_attribute_variable(self):
        """self.x = ... is captured as a variable."""
        source = b"""\
class Foo:
    def __init__(self):
        self.x = 1
        self.y = 2
"""
        result = self.extractor.extract(source)
        init = result.symbols[0].children[0]
        names = [v.name for v in init.variables]
        assert "self.x" in names
        assert "self.y" in names

    def test_extract_augmented_assignment(self):
        """Augmented assignments (+=, etc.) are captured."""
        source = b"""\
def process():
    count = 0
    count += 1
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        names = [v.name for v in variables]
        assert names.count("count") == 2  # initial + augmented

    def test_no_variables_for_empty_function(self):
        """Function with no assignments has empty variables list."""
        source = b"def stub(): pass\n"
        result = self.extractor.extract(source)
        assert result.symbols[0].variables == []

    def test_variables_skip_self_and_underscore(self):
        """self, cls, and _ are excluded from variable tracking."""
        source = b"""\
def process():
    _ = ignore()
    self = bad()
"""
        result = self.extractor.extract(source)
        names = [v.name for v in result.symbols[0].variables]
        assert "_" not in names
        assert "self" not in names

    def test_variable_line_numbers(self):
        """Variables track their line numbers."""
        source = b"""\
def process():
    x = 1
    y = 2
"""
        result = self.extractor.extract(source)
        variables = result.symbols[0].variables
        x_var = [v for v in variables if v.name == "x"][0]
        y_var = [v for v in variables if v.name == "y"][0]
        assert x_var.line == 2
        assert y_var.line == 3
