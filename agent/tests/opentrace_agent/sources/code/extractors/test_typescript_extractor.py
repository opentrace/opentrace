"""Tests for opentrace_agent.sources.code.extractors.typescript_extractor."""

from __future__ import annotations

from opentrace_agent.sources.code.extractors.base import CallRef
from opentrace_agent.sources.code.extractors.typescript_extractor import (
    TypeScriptExtractor,
)


class TestTypeScriptExtractor:
    def setup_method(self):
        self.extractor = TypeScriptExtractor()

    def test_extensions(self):
        assert self.extractor.can_handle(".ts")
        assert self.extractor.can_handle(".tsx")
        assert not self.extractor.can_handle(".py")

    def test_extract_function(self):
        source = b"function greet(name: string): string {\n  return `Hi ${name}`;\n}\n"
        result = self.extractor.extract(source)

        assert result.language == "typescript"
        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "greet"
        assert sym.kind == "function"
        assert sym.start_line == 1
        assert sym.end_line == 3
        assert "(name: string)" in sym.signature

    def test_extract_class_with_methods(self):
        source = b"""\
class UserService {
  constructor(private db: Database) {}

  getUser(id: string): User {
    return this.db.find(id);
  }
}
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        cls = result.symbols[0]
        assert cls.name == "UserService"
        assert cls.kind == "class"
        assert len(cls.children) == 2  # constructor + getUser
        method_names = {c.name for c in cls.children}
        assert "constructor" in method_names
        assert "getUser" in method_names

    def test_extract_exported_function(self):
        source = b"export function helper(): void {}\n"
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "helper"

    def test_extract_exported_class(self):
        source = b"export class AppModule {}\n"
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "AppModule"
        assert result.symbols[0].kind == "class"

    def test_extract_empty_file(self):
        result = self.extractor.extract(b"")
        assert result.symbols == []

    def test_extract_for_extension_ts(self):
        source = b"function foo(): void {}\n"
        result = self.extractor.extract_for_extension(source, ".ts")
        assert len(result.symbols) == 1

    def test_extract_for_extension_tsx(self):
        source = b"function Component(): JSX.Element {\n  return <div>hello</div>;\n}\n"
        result = self.extractor.extract_for_extension(source, ".tsx")
        assert len(result.symbols) == 1
        assert result.symbols[0].name == "Component"

    def test_extract_multiple_toplevel(self):
        source = b"""\
class A {}
class B {}
function helper() {}
"""
        result = self.extractor.extract(source)
        names = [s.name for s in result.symbols]
        assert names == ["A", "B", "helper"]

    # --- calls extraction tests ---

    def test_extract_simple_calls(self):
        source = b"""\
function main() {
  helper();
  setup();
}
"""
        result = self.extractor.extract(source)
        assert result.symbols[0].calls == [CallRef("helper"), CallRef("setup")]

    def test_extract_captures_member_calls(self):
        source = b"""\
function process() {
  this.validate();
  console.log("hi");
  helper();
}
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("validate", receiver="this", kind="attribute") in calls
        assert CallRef("log", receiver="console", kind="attribute") in calls
        assert CallRef("helper") in calls

    def test_extract_nested_calls(self):
        source = b"""\
function main() {
  foo(bar());
}
"""
        result = self.extractor.extract(source)
        calls = result.symbols[0].calls
        assert CallRef("foo") in calls
        assert CallRef("bar") in calls

    def test_method_calls_extraction(self):
        source = b"""\
class Service {
  handle() {
    validate();
    this.save();
  }
}
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        method = cls.children[0]
        assert CallRef("validate") in method.calls
        assert CallRef("save", receiver="this", kind="attribute") in method.calls

    def test_empty_function_has_empty_calls(self):
        source = b"function noop() {}\n"
        result = self.extractor.extract(source)
        assert result.symbols[0].calls == []

    def test_this_method_call_has_receiver(self):
        """this.method() produces CallRef with receiver='this' and kind='attribute'."""
        source = b"""\
class Controller {
  run() {
    this.init();
    this.execute();
  }
}
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        run_method = cls.children[0]
        assert CallRef("init", receiver="this", kind="attribute") in run_method.calls
        assert CallRef("execute", receiver="this", kind="attribute") in run_method.calls

    # --- arrow function / const declaration tests ---

    def test_extract_arrow_function(self):
        source = (
            b"const greet = (name: string): string => {\n  return `Hi ${name}`;\n};\n"
        )
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "greet"
        assert sym.kind == "function"
        assert sym.start_line == 1
        assert "(name: string)" in sym.signature

    def test_extract_arrow_function_concise(self):
        source = b"const double = (n: number) => n * 2;\n"
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "double"
        assert result.symbols[0].kind == "function"

    def test_extract_const_class_expression(self):
        source = b"""\
const Validator = class {
  validate(input: string) {
    return this.check(input);
  }
};
"""
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        cls = result.symbols[0]
        assert cls.name == "Validator"
        assert cls.kind == "class"
        assert len(cls.children) == 1
        assert cls.children[0].name == "validate"

    def test_extract_function_expression(self):
        source = (
            b"const handler = function(req: Request) {\n  return process(req);\n};\n"
        )
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "handler"
        assert result.symbols[0].kind == "function"

    def test_extract_exported_arrow_function(self):
        source = b"export const handler = async (req: Request) => {\n  return Response.json({});\n};\n"
        result = self.extractor.extract(source)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "handler"
        assert result.symbols[0].kind == "function"

    def test_arrow_function_calls_captured(self):
        source = b"const init = () => {\n  setup();\n  configure();\n};\n"
        result = self.extractor.extract(source)

        calls = result.symbols[0].calls
        assert CallRef("setup") in calls
        assert CallRef("configure") in calls

    # --- decorator tests (verify existing behavior) ---

    def test_decorated_class_extracted(self):
        source = b"""\
@Component({ selector: 'app-root' })
class AppComponent {
  ngOnInit() {}
}
"""
        result = self.extractor.extract(source, tsx=True)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "AppComponent"
        assert result.symbols[0].kind == "class"
        assert len(result.symbols[0].children) == 1
        assert result.symbols[0].children[0].name == "ngOnInit"

    def test_decorated_exported_class(self):
        source = b"""\
@Injectable()
export class AuthService {
  login() {}
}
"""
        result = self.extractor.extract(source, tsx=True)

        assert len(result.symbols) == 1
        assert result.symbols[0].name == "AuthService"

    def test_decorated_method_in_class(self):
        source = b"""\
class Controller {
  @Log()
  handle(req: Request) {
    this.process(req);
  }
}
"""
        result = self.extractor.extract(source, tsx=True)

        cls = result.symbols[0]
        assert len(cls.children) == 1
        assert cls.children[0].name == "handle"

    # --- JavaScript/JSX support ---

    def test_extract_js_function(self):
        source = b"function greet(name) {\n  return 'Hi ' + name;\n}\n"
        result = self.extractor.extract_for_extension(source, ".js")

        assert result.language == "javascript"
        assert len(result.symbols) == 1
        assert result.symbols[0].name == "greet"

    def test_extract_jsx_component(self):
        source = b"function App() {\n  return <div>Hello</div>;\n}\n"
        result = self.extractor.extract_for_extension(source, ".jsx")

        assert result.language == "javascript"
        assert len(result.symbols) == 1
        assert result.symbols[0].name == "App"

    def test_js_extensions_handled(self):
        assert self.extractor.can_handle(".js")
        assert self.extractor.can_handle(".jsx")
