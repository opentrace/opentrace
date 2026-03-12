import { describe, it, expect, beforeAll } from 'vitest';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { extractTypeScript } from '../parser/extractors/typescript';
import { parseTS, parseTSX } from './helpers';

let rootNode: SyntaxNode;

describe('extractTypeScript', () => {
  describe('function declarations', () => {
    it('extracts a simple function', async () => {
      rootNode = await parseTS(
        'function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
      );
      const result = extractTypeScript(rootNode);
      expect(result.language).toBe('typescript');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('greet');
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].endLine).toBe(3);
      expect(result.symbols[0].signature).toContain('(name: string)');
    });

    it('extracts exported function', async () => {
      rootNode = await parseTS('export function helper(): void {}\n');
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('helper');
    });
  });

  describe('arrow functions', () => {
    it('extracts const arrow function', async () => {
      rootNode = await parseTS(
        'const greet = (name: string): string => {\n  return `Hi ${name}`;\n};\n',
      );
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('greet');
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].signature).toContain('(name: string)');
    });

    it('extracts concise arrow function', async () => {
      rootNode = await parseTS('const double = (n: number) => n * 2;\n');
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('double');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('extracts exported arrow function', async () => {
      rootNode = await parseTS(
        'export const handler = async (req: Request) => {\n  return Response.json({});\n};\n',
      );
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('handler');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('captures calls in arrow function body', async () => {
      rootNode = await parseTS(
        'const init = () => {\n  setup();\n  configure();\n};\n',
      );
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'setup',
        receiver: null,
        kind: 'bare',
      });
      expect(calls).toContainEqual({
        name: 'configure',
        receiver: null,
        kind: 'bare',
      });
    });
  });

  describe('function expressions', () => {
    it('extracts const function expression', async () => {
      rootNode = await parseTS(
        'const handler = function(req: Request) {\n  return process(req);\n};\n',
      );
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('handler');
      expect(result.symbols[0].kind).toBe('function');
    });
  });

  describe('class declarations', () => {
    it('extracts class with methods', async () => {
      rootNode = await parseTS(`class UserService {
  constructor(private db: Database) {}
  getUser(id: string): User {
    return this.db.find(id);
  }
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      const cls = result.symbols[0];
      expect(cls.name).toBe('UserService');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(2);
      const methodNames = cls.children.map((c) => c.name);
      expect(methodNames).toContain('constructor');
      expect(methodNames).toContain('getUser');
    });

    it('extracts exported class', async () => {
      rootNode = await parseTS('export class AppModule {}\n');
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('AppModule');
      expect(result.symbols[0].kind).toBe('class');
    });
  });

  describe('const class expressions', () => {
    it('extracts const class with methods', async () => {
      rootNode = await parseTS(`const Validator = class {
  validate(input: string) {
    return this.check(input);
  }
};
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      const cls = result.symbols[0];
      expect(cls.name).toBe('Validator');
      expect(cls.kind).toBe('class');
      expect(cls.children).toHaveLength(1);
      expect(cls.children[0].name).toBe('validate');
    });
  });

  describe('decorators', () => {
    it('extracts decorated class', async () => {
      rootNode = await parseTSX(`@Component({ selector: 'app-root' })
class AppComponent {
  ngOnInit() {}
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('AppComponent');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].children).toHaveLength(1);
      expect(result.symbols[0].children[0].name).toBe('ngOnInit');
    });

    it('extracts decorated exported class', async () => {
      rootNode = await parseTSX(`@Injectable()
export class AuthService {
  login() {}
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('AuthService');
    });

    it('extracts methods with decorators', async () => {
      rootNode = await parseTSX(`class Controller {
  @Log()
  handle(req: Request) {
    this.process(req);
  }
}
`);
      const result = extractTypeScript(rootNode);
      const cls = result.symbols[0];
      expect(cls.children).toHaveLength(1);
      expect(cls.children[0].name).toBe('handle');
    });
  });

  describe('multiple top-level symbols', () => {
    it('extracts all symbols in order', async () => {
      rootNode = await parseTS(`class A {}
class B {}
function helper() {}
const init = () => {};
`);
      const result = extractTypeScript(rootNode);
      const names = result.symbols.map((s) => s.name);
      expect(names).toEqual(['A', 'B', 'helper', 'init']);
    });
  });

  describe('empty file', () => {
    it('returns no symbols', async () => {
      rootNode = await parseTS('');
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toEqual([]);
    });
  });

  describe('language parameter', () => {
    it('defaults to typescript', async () => {
      rootNode = await parseTS('function foo() {}');
      const result = extractTypeScript(rootNode);
      expect(result.language).toBe('typescript');
    });

    it('accepts javascript', async () => {
      rootNode = await parseTS('function foo() {}');
      const result = extractTypeScript(rootNode, 'javascript');
      expect(result.language).toBe('javascript');
    });
  });

  describe('async functions', () => {
    it('extracts async function declaration', async () => {
      rootNode =
        await parseTS(`async function fetchData(url: string): Promise<Response> {
  const resp = await fetch(url);
  return resp.json();
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('fetchData');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('extracts async arrow function', async () => {
      rootNode = await parseTS(`const loadUser = async (id: string) => {
  const data = await db.findOne(id);
  return transform(data);
};
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('loadUser');
      expect(result.symbols[0].kind).toBe('function');
    });

    it('captures calls from async function body', async () => {
      rootNode = await parseTS(`async function sync() {
  await connect();
  const data = await api.fetchAll();
  await save(data);
}
`);
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'connect',
        receiver: null,
        kind: 'bare',
      });
      expect(calls).toContainEqual({
        name: 'fetchAll',
        receiver: 'api',
        kind: 'attribute',
      });
      expect(calls).toContainEqual({
        name: 'save',
        receiver: null,
        kind: 'bare',
      });
    });
  });

  describe('generator functions', () => {
    it('extracts generator function', async () => {
      rootNode = await parseTS(`function* range(start: number, end: number) {
  for (let i = start; i < end; i++) {
    yield i;
  }
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('range');
      expect(result.symbols[0].kind).toBe('function');
    });
  });

  describe('call extraction scenarios', () => {
    it('captures this.method() calls in class methods', async () => {
      rootNode = await parseTS(`class Service {
  validate(input: string) {
    this.checkFormat(input);
    this.checkLength(input);
  }
}
`);
      const result = extractTypeScript(rootNode);
      const method = result.symbols[0].children[0];
      expect(method.calls).toContainEqual({
        name: 'checkFormat',
        receiver: 'this',
        kind: 'attribute',
      });
      expect(method.calls).toContainEqual({
        name: 'checkLength',
        receiver: 'this',
        kind: 'attribute',
      });
    });

    it('captures nested member expression calls', async () => {
      rootNode = await parseTS(`function run() {
  console.log("hello");
  process.exit(0);
  Math.floor(3.14);
}
`);
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'log',
        receiver: 'console',
        kind: 'attribute',
      });
      expect(calls).toContainEqual({
        name: 'exit',
        receiver: 'process',
        kind: 'attribute',
      });
      expect(calls).toContainEqual({
        name: 'floor',
        receiver: 'Math',
        kind: 'attribute',
      });
    });

    it('captures calls inside if/else blocks', async () => {
      rootNode = await parseTS(`function check(ok: boolean) {
  if (ok) {
    proceed();
  } else {
    fallback();
  }
}
`);
      const result = extractTypeScript(rootNode);
      const callNames = result.symbols[0].calls.map((c) => c.name);
      expect(callNames).toContain('proceed');
      expect(callNames).toContain('fallback');
    });

    it('captures calls inside try/catch/finally', async () => {
      rootNode = await parseTS(`function safeOp() {
  try {
    riskyCall();
  } catch (e) {
    handleError(e);
  } finally {
    cleanup();
  }
}
`);
      const result = extractTypeScript(rootNode);
      const callNames = result.symbols[0].calls.map((c) => c.name);
      expect(callNames).toContain('riskyCall');
      expect(callNames).toContain('handleError');
      expect(callNames).toContain('cleanup');
    });

    it('captures calls inside for loops', async () => {
      rootNode = await parseTS(`function batch(items: string[]) {
  for (const item of items) {
    const result = transform(item);
    db.save(result);
  }
}
`);
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'transform',
        receiver: null,
        kind: 'bare',
      });
      expect(calls).toContainEqual({
        name: 'save',
        receiver: 'db',
        kind: 'attribute',
      });
    });

    it('captures calls from function expression body', async () => {
      rootNode = await parseTS(`const fn = function() {
  init();
  service.start();
};
`);
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'init',
        receiver: null,
        kind: 'bare',
      });
      expect(calls).toContainEqual({
        name: 'start',
        receiver: 'service',
        kind: 'attribute',
      });
    });

    it('captures calls in concise arrow body', async () => {
      rootNode = await parseTS('const run = () => execute();\n');
      const result = extractTypeScript(rootNode);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'execute',
        receiver: null,
        kind: 'bare',
      });
    });
  });

  describe('abstract classes', () => {
    it('extracts abstract class', async () => {
      rootNode = await parseTS(`abstract class Shape {
  abstract area(): number;
  describe() {
    return this.area();
  }
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Shape');
      expect(result.symbols[0].kind).toBe('class');
    });
  });

  describe('class with various member types', () => {
    it('extracts getter and setter methods', async () => {
      rootNode = await parseTS(`class Config {
  get value() {
    return this._value;
  }
  set value(v: string) {
    this._value = v;
  }
}
`);
      const result = extractTypeScript(rootNode);
      const cls = result.symbols[0];
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('value');
    });

    it('extracts static methods', async () => {
      rootNode = await parseTS(`class Factory {
  static create() {
    return new Factory();
  }
  build() {
    return setup();
  }
}
`);
      const result = extractTypeScript(rootNode);
      const cls = result.symbols[0];
      const names = cls.children.map((c) => c.name);
      expect(names).toContain('create');
      expect(names).toContain('build');
    });
  });

  describe('class inheritance', () => {
    it('extracts extends clause', async () => {
      rootNode = await parseTS(`class Dog extends Animal {
  bark() {}
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toEqual(['Animal']);
      expect(result.symbols[0].interfaces).toBeUndefined();
    });

    it('extracts implements clause', async () => {
      rootNode = await parseTS(`class Worker implements Runnable {
  run() {}
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toBeUndefined();
      expect(result.symbols[0].interfaces).toEqual(['Runnable']);
    });

    it('extracts both extends and implements', async () => {
      rootNode =
        await parseTS(`class Dog extends Animal implements Pet, Trainable {
  fetch() {}
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toEqual(['Animal']);
      expect(result.symbols[0].interfaces).toEqual(['Pet', 'Trainable']);
    });

    it('no inheritance for plain class', async () => {
      rootNode = await parseTS(`class Foo {}`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toBeUndefined();
      expect(result.symbols[0].interfaces).toBeUndefined();
    });

    it('extracts abstract class with extends', async () => {
      rootNode = await parseTS(`abstract class Shape extends BaseShape {
  abstract area(): number;
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toEqual(['BaseShape']);
    });

    it('extracts class expression with extends', async () => {
      rootNode = await parseTS(`const Dog = class extends Animal {
  bark() {}
};
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].superclasses).toEqual(['Animal']);
    });
  });

  describe('edge cases', () => {
    it('returns no symbols for import-only file', async () => {
      rootNode = await parseTS(`import { useState } from 'react';
import type { FC } from 'react';
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toEqual([]);
    });

    it('returns no symbols for interface-only file', async () => {
      rootNode = await parseTS(`interface User {
  name: string;
  age: number;
}
`);
      const result = extractTypeScript(rootNode);
      // Interfaces are not extracted as symbols (only classes and functions)
      expect(result.symbols).toEqual([]);
    });

    it('returns no symbols for type alias file', async () => {
      rootNode = await parseTS(`type ID = string;
type Handler = (req: Request) => Response;
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toEqual([]);
    });

    it('preserves rootNode in result', async () => {
      rootNode = await parseTS('function foo() {}');
      const result = extractTypeScript(rootNode);
      expect(result.rootNode).toBe(rootNode);
    });

    it('extracts function with default parameters', async () => {
      rootNode = await parseTS(`function greet(name: string = "world"): string {
  return \`Hello \${name}\`;
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].signature).toContain('name: string = "world"');
    });

    it('extracts function with rest parameters', async () => {
      rootNode = await parseTS(`function collect(...items: string[]) {
  return items;
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols[0].signature).toContain('...items');
    });

    it('extracts function with destructured parameters', async () => {
      rootNode = await parseTS(`function setup({ host, port }: Config) {
  connect(host, port);
}
`);
      const result = extractTypeScript(rootNode);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setup');
      expect(result.symbols[0].calls).toContainEqual({
        name: 'connect',
        receiver: null,
        kind: 'bare',
      });
    });
  });
});
