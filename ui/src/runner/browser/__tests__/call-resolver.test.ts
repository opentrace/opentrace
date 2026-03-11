import { describe, it, expect } from "vitest";
import {
  resolveCalls,
  type CallInfo,
  type Registries,
  type SymbolNode,
} from "../parser/callResolver";
import type { CallRef } from "../types";

function makeNode(
  id: string,
  name: string,
  kind: "class" | "function" = "function",
  opts: Partial<Pick<SymbolNode, "receiverVar" | "receiverType" | "children">> = {},
): SymbolNode {
  return {
    id,
    name,
    kind,
    fileId: id.split("::")[0],
    parentId: id.split("::").slice(0, -1).join("::") || id.split("::")[0],
    receiverVar: opts.receiverVar ?? null,
    receiverType: opts.receiverType ?? null,
    children: opts.children ?? [],
  };
}

function emptyRegistries(): Registries {
  return {
    nameRegistry: new Map(),
    fileRegistry: new Map(),
    classRegistry: new Map(),
    importRegistry: new Map(),
  };
}

function registerNode(reg: Registries, node: SymbolNode): void {
  const existing = reg.nameRegistry.get(node.name);
  if (existing) existing.push(node);
  else reg.nameRegistry.set(node.name, [node]);

  if (!reg.fileRegistry.has(node.fileId)) reg.fileRegistry.set(node.fileId, new Map());
  reg.fileRegistry.get(node.fileId)!.set(node.name, node);
}

describe("resolveCalls", () => {
  // Strategy 1: self/this resolution
  it("resolves this.method() to enclosing class child", () => {
    const reg = emptyRegistries();
    const method = makeNode("file1::MyClass::save", "save");
    const cls = makeNode("file1::MyClass", "MyClass", "class", { children: [method] });
    const caller = makeNode("file1::MyClass::handle", "handle");
    cls.children.push(caller);

    registerNode(reg, cls);
    registerNode(reg, method);
    registerNode(reg, caller);
    reg.classRegistry.set("MyClass", cls);

    const calls: CallRef[] = [{ name: "save", receiver: "this", kind: "attribute" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file1::MyClass::save");
    expect(resolved[0].confidence).toBe(1.0);
  });

  // Strategy 2: Go receiver var
  it("resolves Go receiver variable call", () => {
    const reg = emptyRegistries();
    const target = makeNode("file1::GetName", "GetName", "function", {
      receiverType: "Server",
    });
    const caller = makeNode("file1::Start", "Start", "function", {
      receiverVar: "s",
      receiverType: "Server",
    });

    registerNode(reg, target);
    registerNode(reg, caller);

    const calls: CallRef[] = [{ name: "GetName", receiver: "s", kind: "attribute" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file1::GetName");
    expect(resolved[0].confidence).toBe(1.0);
  });

  // Strategy 3: ClassName.method()
  it("resolves ClassName.method() via class registry", () => {
    const reg = emptyRegistries();
    const method = makeNode("file1::Helper::run", "run");
    const cls = makeNode("file1::Helper", "Helper", "class", { children: [method] });
    const caller = makeNode("file1::main", "main");

    registerNode(reg, cls);
    registerNode(reg, method);
    registerNode(reg, caller);
    reg.classRegistry.set("Helper", cls);

    const calls: CallRef[] = [{ name: "run", receiver: "Helper", kind: "attribute" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file1::Helper::run");
    expect(resolved[0].confidence).toBe(1.0);
  });

  // Strategy 4: import-based resolution
  it("resolves import-based attribute call", () => {
    const reg = emptyRegistries();
    const target = makeNode("file2::validate", "validate");
    const caller = makeNode("file1::main", "main");

    registerNode(reg, target);
    registerNode(reg, caller);
    reg.importRegistry.set("file1", { utils: "file2" });

    const calls: CallRef[] = [{ name: "validate", receiver: "utils", kind: "attribute" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file2::validate");
    expect(resolved[0].confidence).toBe(0.9);
  });

  // Strategy 5: constructor call
  it("resolves constructor call to class", () => {
    const reg = emptyRegistries();
    const ctor = makeNode("file1::Widget::constructor", "constructor");
    const cls = makeNode("file1::Widget", "Widget", "class", { children: [ctor] });
    const caller = makeNode("file1::main", "main");

    registerNode(reg, cls);
    registerNode(reg, ctor);
    registerNode(reg, caller);
    reg.classRegistry.set("Widget", cls);

    const calls: CallRef[] = [{ name: "Widget", receiver: null, kind: "bare" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file1::Widget::constructor");
    expect(resolved[0].confidence).toBe(1.0);
  });

  // Strategy 6: intra-file bare call
  it("resolves intra-file bare call", () => {
    const reg = emptyRegistries();
    const target = makeNode("file1::helper", "helper");
    const caller = makeNode("file1::main", "main");

    registerNode(reg, target);
    registerNode(reg, caller);

    const calls: CallRef[] = [{ name: "helper", receiver: null, kind: "bare" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file1::helper");
    expect(resolved[0].confidence).toBe(1.0);
  });

  // Strategy 7: cross-file bare call (unique)
  it("resolves cross-file bare call when unique", () => {
    const reg = emptyRegistries();
    const target = makeNode("file2::setup", "setup");
    const caller = makeNode("file1::main", "main");

    registerNode(reg, target);
    registerNode(reg, caller);

    const calls: CallRef[] = [{ name: "setup", receiver: null, kind: "bare" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetId).toBe("file2::setup");
    expect(resolved[0].confidence).toBe(0.8);
  });

  it("does not resolve cross-file bare call with multiple matches", () => {
    const reg = emptyRegistries();
    const target1 = makeNode("file2::setup", "setup");
    const target2 = makeNode("file3::setup", "setup");
    const caller = makeNode("file1::main", "main");

    registerNode(reg, caller);
    // Manually register both targets under the same name
    reg.nameRegistry.set("setup", [target1, target2]);
    reg.fileRegistry.set("file2", new Map([["setup", target1]]));
    reg.fileRegistry.set("file3", new Map([["setup", target2]]));

    const calls: CallRef[] = [{ name: "setup", receiver: null, kind: "bare" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(0);
  });

  it("deduplicates identical call refs", () => {
    const reg = emptyRegistries();
    const target = makeNode("file1::helper", "helper");
    const caller = makeNode("file1::main", "main");

    registerNode(reg, target);
    registerNode(reg, caller);

    const calls: CallRef[] = [
      { name: "helper", receiver: null, kind: "bare" },
      { name: "helper", receiver: null, kind: "bare" },
    ];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(1);
  });

  it("skips self-recursive calls", () => {
    const reg = emptyRegistries();
    const caller = makeNode("file1::fib", "fib");
    registerNode(reg, caller);

    const calls: CallRef[] = [{ name: "fib", receiver: null, kind: "bare" }];
    const infos: CallInfo[] = [{ callerNode: caller, calls, fileId: "file1" }];

    const resolved = resolveCalls(infos, reg);
    expect(resolved).toHaveLength(0);
  });
});
