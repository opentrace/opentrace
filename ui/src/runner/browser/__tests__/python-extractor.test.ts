import { describe, it, expect } from "vitest";
import { extractPython } from "../parser/extractors/python";
import { parsePy } from "./helpers";

describe("extractPython", () => {
  describe("function definitions", () => {
    it("extracts a simple function", async () => {
      const root = await parsePy(`def greet(name):
    return f"Hi {name}"
`);
      const result = extractPython(root);
      expect(result.language).toBe("python");
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("greet");
      expect(result.symbols[0].kind).toBe("function");
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].endLine).toBe(2);
      expect(result.symbols[0].signature).toBe("(name)");
    });

    it("extracts function with type hints", async () => {
      const root = await parsePy(`def add(a: int, b: int) -> int:
    return a + b
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("add");
      expect(result.symbols[0].signature).toContain("a: int");
    });

    it("extracts async function", async () => {
      const root = await parsePy(`async def fetch_data(url: str):
    response = await get(url)
    return response
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("fetch_data");
      expect(result.symbols[0].kind).toBe("function");
    });

    it("captures bare calls in function body", async () => {
      const root = await parsePy(`def process():
    validate()
    transform()
    save()
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({ name: "validate", receiver: null, kind: "bare" });
      expect(calls).toContainEqual({ name: "transform", receiver: null, kind: "bare" });
      expect(calls).toContainEqual({ name: "save", receiver: null, kind: "bare" });
    });

    it("captures attribute calls in function body", async () => {
      const root = await parsePy(`def run():
    self.setup()
    db.connect()
    logger.info("done")
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({ name: "setup", receiver: "self", kind: "attribute" });
      expect(calls).toContainEqual({ name: "connect", receiver: "db", kind: "attribute" });
      expect(calls).toContainEqual({ name: "info", receiver: "logger", kind: "attribute" });
    });

    it("captures mixed bare and attribute calls", async () => {
      const root = await parsePy(`def handler(request):
    data = parse(request.body)
    result = self.transform(data)
    return json.dumps(result)
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      const bareNames = calls.filter(c => c.kind === "bare").map(c => c.name);
      const attrCalls = calls.filter(c => c.kind === "attribute");
      expect(bareNames).toContain("parse");
      expect(attrCalls).toContainEqual({ name: "transform", receiver: "self", kind: "attribute" });
      expect(attrCalls).toContainEqual({ name: "dumps", receiver: "json", kind: "attribute" });
    });
  });

  describe("class definitions", () => {
    it("extracts a simple class", async () => {
      const root = await parsePy(`class User:
    pass
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("User");
      expect(result.symbols[0].kind).toBe("class");
      expect(result.symbols[0].children).toEqual([]);
    });

    it("extracts class with methods", async () => {
      const root = await parsePy(`class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str):
        return self.db.find(user_id)

    def delete_user(self, user_id: str):
        self.db.remove(user_id)
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      const cls = result.symbols[0];
      expect(cls.name).toBe("UserService");
      expect(cls.kind).toBe("class");
      expect(cls.children).toHaveLength(3);
      const methodNames = cls.children.map(c => c.name);
      expect(methodNames).toContain("__init__");
      expect(methodNames).toContain("get_user");
      expect(methodNames).toContain("delete_user");
    });

    it("captures calls within class methods", async () => {
      const root = await parsePy(`class Processor:
    def run(self):
        self.validate()
        data = load_data()
        self.save(data)
`);
      const result = extractPython(root);
      const runMethod = result.symbols[0].children.find(c => c.name === "run")!;
      expect(runMethod.calls).toContainEqual({ name: "validate", receiver: "self", kind: "attribute" });
      expect(runMethod.calls).toContainEqual({ name: "load_data", receiver: null, kind: "bare" });
      expect(runMethod.calls).toContainEqual({ name: "save", receiver: "self", kind: "attribute" });
    });

    it("extracts class with inheritance", async () => {
      const root = await parsePy(`class Admin(User):
    def promote(self):
        pass
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("Admin");
      expect(result.symbols[0].kind).toBe("class");
      expect(result.symbols[0].children).toHaveLength(1);
      expect(result.symbols[0].children[0].name).toBe("promote");
    });
  });

  describe("decorated definitions", () => {
    it("extracts decorated function", async () => {
      const root = await parsePy(`@app.route("/api/users")
def list_users():
    return get_all()
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("list_users");
      expect(result.symbols[0].kind).toBe("function");
    });

    it("extracts function with multiple decorators", async () => {
      const root = await parsePy(`@login_required
@cache(timeout=300)
def dashboard():
    return render()
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("dashboard");
    });

    it("extracts decorated class", async () => {
      const root = await parsePy(`@dataclass
class Config:
    host: str
    port: int
`);
      const result = extractPython(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe("Config");
      expect(result.symbols[0].kind).toBe("class");
    });

    it("extracts decorated methods within a class", async () => {
      const root = await parsePy(`class MyClass:
    @staticmethod
    def create():
        return MyClass()

    @classmethod
    def from_dict(cls, data):
        return cls(**data)

    @property
    def name(self):
        return self._name
`);
      const result = extractPython(root);
      const cls = result.symbols[0];
      expect(cls.children).toHaveLength(3);
      const names = cls.children.map(c => c.name);
      expect(names).toContain("create");
      expect(names).toContain("from_dict");
      expect(names).toContain("name");
    });
  });

  describe("multiple top-level symbols", () => {
    it("extracts all symbols in order", async () => {
      const root = await parsePy(`class Config:
    pass

def setup():
    pass

class App:
    def run(self):
        pass

def main():
    pass
`);
      const result = extractPython(root);
      const names = result.symbols.map(s => s.name);
      expect(names).toEqual(["Config", "setup", "App", "main"]);
    });

    it("preserves kinds correctly", async () => {
      const root = await parsePy(`class A:
    pass

def b():
    pass
`);
      const result = extractPython(root);
      expect(result.symbols[0].kind).toBe("class");
      expect(result.symbols[1].kind).toBe("function");
    });
  });

  describe("edge cases", () => {
    it("returns no symbols for empty file", async () => {
      const root = await parsePy("");
      const result = extractPython(root);
      expect(result.symbols).toEqual([]);
    });

    it("returns no symbols for file with only comments", async () => {
      const root = await parsePy(`# This is a module comment
# No definitions here
`);
      const result = extractPython(root);
      expect(result.symbols).toEqual([]);
    });

    it("returns no symbols for file with only imports", async () => {
      const root = await parsePy(`import os
from pathlib import Path
`);
      const result = extractPython(root);
      expect(result.symbols).toEqual([]);
    });

    it("preserves rootNode in result", async () => {
      const root = await parsePy("def foo(): pass");
      const result = extractPython(root);
      expect(result.rootNode).toBe(root);
    });

    it("extracts function with no parameters", async () => {
      const root = await parsePy(`def no_args():
    return 42
`);
      const result = extractPython(root);
      expect(result.symbols[0].signature).toBe("()");
    });

    it("extracts function with *args and **kwargs", async () => {
      const root = await parsePy(`def flexible(*args, **kwargs):
    pass
`);
      const result = extractPython(root);
      expect(result.symbols[0].signature).toContain("*args");
      expect(result.symbols[0].signature).toContain("**kwargs");
    });
  });

  describe("nested calls", () => {
    it("captures calls inside conditionals", async () => {
      const root = await parsePy(`def check():
    if validate():
        process()
    else:
        handle_error()
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      const callNames = calls.map(c => c.name);
      expect(callNames).toContain("validate");
      expect(callNames).toContain("process");
      expect(callNames).toContain("handle_error");
    });

    it("captures calls inside loops", async () => {
      const root = await parsePy(`def batch_process(items):
    for item in items:
        result = transform(item)
        db.save(result)
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({ name: "transform", receiver: null, kind: "bare" });
      expect(calls).toContainEqual({ name: "save", receiver: "db", kind: "attribute" });
    });

    it("captures calls inside try/except", async () => {
      const root = await parsePy(`def safe_call():
    try:
        connect()
    except Exception:
        log_error()
        retry()
`);
      const result = extractPython(root);
      const callNames = result.symbols[0].calls.map(c => c.name);
      expect(callNames).toContain("connect");
      expect(callNames).toContain("log_error");
      expect(callNames).toContain("retry");
    });

    it("captures calls inside with statements", async () => {
      const root = await parsePy(`def read_file():
    with open("test.txt") as f:
        content = f.read()
        process(content)
`);
      const result = extractPython(root);
      const calls = result.symbols[0].calls;
      const callNames = calls.map(c => c.name);
      expect(callNames).toContain("open");
      expect(callNames).toContain("process");
      expect(calls).toContainEqual({ name: "read", receiver: "f", kind: "attribute" });
    });
  });
});
