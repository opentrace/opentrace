"""Tests for opentrace_agent.sources.code.extractors.go_extractor."""

from __future__ import annotations

from opentrace_agent.sources.code.extractors.base import CallRef
from opentrace_agent.sources.code.extractors.go_extractor import GoExtractor


class TestGoExtractor:
    def setup_method(self):
        self.extractor = GoExtractor()

    def test_extensions(self):
        assert self.extractor.can_handle(".go")
        assert not self.extractor.can_handle(".py")

    def test_extract_function(self):
        source = b"""\
package main

func Hello(name string) string {
	return "Hi " + name
}
"""
        result = self.extractor.extract(source)

        assert result.language == "go"
        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "Hello"
        assert sym.kind == "function"
        assert sym.start_line == 3
        assert sym.end_line == 5
        assert "(name string)" in sym.signature

    def test_extract_struct(self):
        source = b"""\
package main

type User struct {
	Name  string
	Email string
}
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "User"
        assert sym.kind == "class"
        assert sym.start_line == 3
        assert sym.end_line == 6

    def test_extract_interface_with_methods(self):
        source = b"""\
package main

type Repository interface {
	Get(id string) (*Entity, error)
	Save(entity *Entity) error
}
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        iface = result.symbols[0]
        assert iface.name == "Repository"
        assert iface.kind == "class"
        assert len(iface.children) == 2
        assert iface.children[0].name == "Get"
        assert iface.children[1].name == "Save"

    def test_extract_method(self):
        source = b"""\
package main

type Server struct{}

func (s *Server) Start(port int) error {
	return nil
}
"""
        result = self.extractor.extract(source)

        # Should have the struct + the method as separate top-level symbols
        names = [s.name for s in result.symbols]
        assert "Server" in names
        assert "Start" in names

        method = next(s for s in result.symbols if s.name == "Start")
        assert method.kind == "function"
        # Signature should include the receiver
        assert "(s *Server)" in method.signature
        assert "(port int)" in method.signature

    def test_extract_method_receiver_fields(self):
        """Go method declarations should populate receiver_var and receiver_type."""
        source = b"""\
package main

type Handler struct{}

func (h *Handler) ServeHTTP() {}
"""
        result = self.extractor.extract(source)
        method = next(s for s in result.symbols if s.name == "ServeHTTP")
        assert method.receiver_var == "h"
        assert method.receiver_type == "Handler"

    def test_extract_method_value_receiver(self):
        """Non-pointer receiver like (s Server) should also be parsed."""
        source = b"""\
package main

type Config struct{}

func (c Config) String() string { return "" }
"""
        result = self.extractor.extract(source)
        method = next(s for s in result.symbols if s.name == "String")
        assert method.receiver_var == "c"
        assert method.receiver_type == "Config"

    def test_extract_multiple(self):
        source = b"""\
package main

type A struct{}
type B struct{}

func Helper() {}
"""
        result = self.extractor.extract(source)
        names = [s.name for s in result.symbols]
        assert names == ["A", "B", "Helper"]

    def test_extract_empty_file(self):
        source = b"package main\n"
        result = self.extractor.extract(source)
        assert result.symbols == []

    # --- calls extraction tests ---

    def test_extract_simple_calls(self):
        source = b"""\
package main

func main() {
	helper()
	setup()
}
"""
        result = self.extractor.extract(source)
        main_fn = result.symbols[0]
        assert main_fn.calls == [CallRef("helper"), CallRef("setup")]

    def test_extract_captures_selector_calls(self):
        source = b"""\
package main

func process() {
	fmt.Println("hello")
	helper()
}
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("Println", receiver="fmt", kind="attribute") in calls
        assert CallRef("helper") in calls

    def test_extract_nested_calls(self):
        source = b"""\
package main

func main() {
	foo(bar())
}
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("foo") in calls
        assert CallRef("bar") in calls

    def test_method_calls_extraction(self):
        source = b"""\
package main

type Server struct{}

func (s *Server) Start() {
	validate()
	s.listen()
}
"""
        result = self.extractor.extract(source)
        method = next(s for s in result.symbols if s.name == "Start")
        assert CallRef("validate") in method.calls
        assert CallRef("listen", receiver="s", kind="attribute") in method.calls

    def test_interface_method_has_empty_calls(self):
        source = b"""\
package main

type Store interface {
	Get(id string) error
}
"""
        result = self.extractor.extract(source)
        iface = result.symbols[0]
        # Interface method signatures have no body
        for child in iface.children:
            assert child.calls == []

    def test_function_has_no_receiver_fields(self):
        """Regular functions (not methods) should have None receiver fields."""
        source = b"""\
package main

func helper() {}
"""
        result = self.extractor.extract(source)
        assert result.symbols[0].receiver_var is None
        assert result.symbols[0].receiver_type is None
