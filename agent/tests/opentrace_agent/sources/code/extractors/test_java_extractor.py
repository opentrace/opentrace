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

"""Tests for opentrace_agent.sources.code.extractors.java_extractor."""

from __future__ import annotations

from opentrace_agent.sources.code.extractors.base import CallRef
from opentrace_agent.sources.code.extractors.java_extractor import JavaExtractor


class TestJavaExtractor:
    def setup_method(self):
        self.extractor = JavaExtractor()

    def test_extensions(self):
        assert self.extractor.can_handle(".java")
        assert not self.extractor.can_handle(".py")
        assert not self.extractor.can_handle(".go")

    def test_extract_empty_file(self):
        source = b"package com.example;\n"
        result = self.extractor.extract(source)
        assert result.symbols == []
        assert result.language == "java"

    # --- class extraction ---

    def test_extract_simple_class(self):
        source = b"""\
package com.example;

public class User {
    private String name;
}
"""
        result = self.extractor.extract(source)
        assert len(result.symbols) == 1
        sym = result.symbols[0]
        assert sym.name == "User"
        assert sym.kind == "class"
        assert sym.subtype == "class"
        assert sym.start_line == 3
        assert sym.end_line == 5

    def test_extract_class_with_extends_and_implements(self):
        source = b"""\
package com.example;

public class Child extends Base implements Serializable, Comparable {
    public void process() {}
}
"""
        result = self.extractor.extract(source)
        sym = result.symbols[0]
        assert sym.name == "Child"
        assert sym.superclasses == ["Base"]
        assert sym.interfaces == ["Serializable", "Comparable"]

    def test_extract_class_with_generic_interfaces(self):
        source = b"""\
package com.example;

public class Child extends Base implements Comparable<Child> {
}
"""
        result = self.extractor.extract(source)
        sym = result.symbols[0]
        assert sym.superclasses == ["Base"]
        assert sym.interfaces == ["Comparable"]

    # --- method extraction ---

    def test_extract_method(self):
        source = b"""\
package com.example;

public class Service {
    public String process(String input, int count) {
        return input;
    }
}
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        assert len(cls.children) == 1
        method = cls.children[0]
        assert method.name == "process"
        assert method.kind == "function"
        assert method.return_type == "String"
        assert method.type_signature == "(String,int)"
        assert method.start_line == 4
        assert method.end_line == 6

    def test_extract_void_method(self):
        source = b"""\
package com.example;

public class Service {
    private void validate(String input) {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.name == "validate"
        assert method.return_type == "void"
        assert method.type_signature == "(String)"

    def test_extract_method_with_generic_return(self):
        source = b"""\
package com.example;

public class Service {
    public List<String> getItems() {
        return null;
    }
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.return_type == "List"
        assert method.type_signature == "()"

    def test_extract_method_no_params(self):
        source = b"""\
package com.example;

public class Service {
    public void run() {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.type_signature == "()"

    # --- constructor extraction ---

    def test_extract_constructor(self):
        source = b"""\
package com.example;

public class Service {
    public Service(String name, int port) {
        this.name = name;
    }
}
"""
        result = self.extractor.extract(source)
        cls = result.symbols[0]
        assert len(cls.children) == 1
        ctor = cls.children[0]
        assert ctor.name == "Service"
        assert ctor.kind == "function"
        assert ctor.return_type is None
        assert ctor.type_signature == "(String,int)"

    # --- interface extraction ---

    def test_extract_interface(self):
        source = b"""\
package com.example;

public interface Repository {
    String findById(String id);
    void save(String entity);
}
"""
        result = self.extractor.extract(source)
        assert len(result.symbols) == 1
        iface = result.symbols[0]
        assert iface.name == "Repository"
        assert iface.kind == "class"
        assert iface.subtype == "interface"
        assert len(iface.children) == 2
        assert iface.children[0].name == "findById"
        assert iface.children[1].name == "save"

    def test_interface_methods_have_no_calls(self):
        source = b"""\
package com.example;

interface Store {
    String get(String id);
}
"""
        result = self.extractor.extract(source)
        iface = result.symbols[0]
        for child in iface.children:
            assert child.calls == []

    # --- enum extraction ---

    def test_extract_enum(self):
        source = b"""\
package com.example;

public enum Status {
    ACTIVE, INACTIVE;

    public boolean isActive() {
        return this == ACTIVE;
    }
}
"""
        result = self.extractor.extract(source)
        assert len(result.symbols) == 1
        enum = result.symbols[0]
        assert enum.name == "Status"
        assert enum.kind == "class"
        assert enum.subtype == "enum"
        assert len(enum.children) == 1
        assert enum.children[0].name == "isActive"

    # --- call extraction ---

    def test_extract_bare_calls(self):
        source = b"""\
package com.example;

public class Service {
    public void run() {
        helper();
        validate();
    }
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert CallRef("helper") in method.calls
        assert CallRef("validate") in method.calls

    def test_extract_dotted_calls(self):
        source = b"""\
package com.example;

public class Service {
    public void run() {
        service.process();
        this.validate();
    }
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert CallRef("process", receiver="service", kind="attribute") in method.calls
        assert CallRef("validate", receiver="this", kind="attribute") in method.calls

    def test_extract_nested_calls(self):
        source = b"""\
package com.example;

public class Service {
    public void run() {
        foo(bar());
    }
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert CallRef("foo") in method.calls
        assert CallRef("bar") in method.calls

    def test_extract_chained_calls(self):
        source = b"""\
package com.example;

public class Service {
    public void run() {
        service.getRepo().findAll();
    }
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        # The inner call: service.getRepo()
        assert CallRef("getRepo", receiver="service", kind="attribute") in method.calls
        # The outer call: <result>.findAll()
        assert any(c.name == "findAll" for c in method.calls)

    # --- Javadoc extraction ---

    def test_javadoc_on_class(self):
        source = b"""\
package com.example;

/**
 * A user service.
 */
public class UserService {
}
"""
        result = self.extractor.extract(source)
        assert result.symbols[0].docs == "A user service."

    def test_javadoc_on_method(self):
        source = b"""\
package com.example;

public class Service {
    /**
     * Validate the input.
     * @param input the value
     */
    public void validate(String input) {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert "Validate the input." in method.docs

    def test_line_comments_as_docs(self):
        source = b"""\
package com.example;

public class Service {
    // Process the data.
    // Second line.
    public void process() {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.docs == "Process the data.\nSecond line."

    # --- multiple declarations ---

    def test_extract_multiple_top_level_types(self):
        source = b"""\
package com.example;

class Foo {}
interface Bar {
    void baz();
}
enum Qux {
    A, B;
}
"""
        result = self.extractor.extract(source)
        names = [s.name for s in result.symbols]
        assert names == ["Foo", "Bar", "Qux"]

    # --- inner types ---

    def test_extract_inner_class(self):
        source = b"""\
package com.example;

public class Outer {
    public static class Inner {
        public void run() {}
    }
}
"""
        result = self.extractor.extract(source)
        outer = result.symbols[0]
        assert outer.name == "Outer"
        assert len(outer.children) == 1
        inner = outer.children[0]
        assert inner.name == "Inner"
        assert inner.kind == "class"
        assert len(inner.children) == 1
        assert inner.children[0].name == "run"

    # --- type signature edge cases ---

    def test_type_signature_with_array_param(self):
        source = b"""\
package com.example;

public class Main {
    public static void main(String[] args) {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.type_signature == "(String[])"

    def test_type_signature_with_generic_param(self):
        source = b"""\
package com.example;

public class Service {
    public void process(List<String> items, Map<String, Integer> counts) {}
}
"""
        result = self.extractor.extract(source)
        method = result.symbols[0].children[0]
        assert method.type_signature == "(List,Map)"

    # --- root_node preservation ---

    def test_root_node_is_preserved(self):
        source = b"""\
package com.example;

public class Foo {}
"""
        result = self.extractor.extract(source)
        assert result.root_node is not None
        assert result.root_node.type == "program"
