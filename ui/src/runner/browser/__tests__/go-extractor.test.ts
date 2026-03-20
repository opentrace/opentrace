/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect } from 'vitest';
import { extractGo } from '@opentrace/components/pipeline';
import { parseGo } from './helpers';

describe('extractGo', () => {
  describe('struct types', () => {
    it('extracts a simple struct', async () => {
      const root = await parseGo(`package main

type Server struct {
    host string
    port int
}
`);
      const result = extractGo(root);
      expect(result.language).toBe('go');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Server');
      expect(result.symbols[0].kind).toBe('class');
      expect(result.symbols[0].startLine).toBe(3);
      expect(result.symbols[0].children).toEqual([]);
    });

    it('extracts multiple struct types', async () => {
      const root = await parseGo(`package main

type Request struct {
    Method string
    URL    string
}

type Response struct {
    StatusCode int
    Body       []byte
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].name).toBe('Request');
      expect(result.symbols[1].name).toBe('Response');
    });

    it('extracts empty struct', async () => {
      const root = await parseGo(`package main

type Empty struct{}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Empty');
      expect(result.symbols[0].kind).toBe('class');
    });
  });

  describe('interface types', () => {
    it('extracts interface with methods', async () => {
      const root = await parseGo(`package main

type Store interface {
    Get(key string) (string, error)
    Set(key string, value string) error
    Delete(key string) error
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      const iface = result.symbols[0];
      expect(iface.name).toBe('Store');
      expect(iface.kind).toBe('class');
      expect(iface.children).toHaveLength(3);
      const methodNames = iface.children.map((c) => c.name);
      expect(methodNames).toContain('Get');
      expect(methodNames).toContain('Set');
      expect(methodNames).toContain('Delete');
    });

    it('interface methods have correct kind', async () => {
      const root = await parseGo(`package main

type Reader interface {
    Read(p []byte) (int, error)
}
`);
      const result = extractGo(root);
      const readMethod = result.symbols[0].children[0];
      expect(readMethod.kind).toBe('function');
      expect(readMethod.name).toBe('Read');
    });

    it('extracts empty interface', async () => {
      const root = await parseGo(`package main

type Any interface{}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('Any');
      expect(result.symbols[0].children).toEqual([]);
    });
  });

  describe('function declarations', () => {
    it('extracts a simple function', async () => {
      const root = await parseGo(`package main

func main() {
    fmt.Println("hello")
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('main');
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].signature).toBe('()');
      expect(result.symbols[0].receiverVar).toBeNull();
      expect(result.symbols[0].receiverType).toBeNull();
    });

    it('extracts function with parameters and return type', async () => {
      const root = await parseGo(`package main

func add(a int, b int) int {
    return a + b
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('add');
      expect(result.symbols[0].signature).toContain('a int');
    });

    it('extracts exported and unexported functions', async () => {
      const root = await parseGo(`package main

func PublicFunc() {}
func privateFunc() {}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].name).toBe('PublicFunc');
      expect(result.symbols[1].name).toBe('privateFunc');
    });

    it('extracts function with multiple return values', async () => {
      const root = await parseGo(`package main

func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division by zero")
    }
    return a / b, nil
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('divide');
    });

    it('captures bare calls in function body', async () => {
      const root = await parseGo(`package main

func init() {
    setup()
    configure()
    validate()
}
`);
      const result = extractGo(root);
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
      expect(calls).toContainEqual({
        name: 'validate',
        receiver: null,
        kind: 'bare',
      });
    });

    it('captures selector calls (pkg.Func) in function body', async () => {
      const root = await parseGo(`package main

func run() {
    fmt.Println("starting")
    log.Printf("debug: %s", msg)
    http.ListenAndServe(":8080", nil)
}
`);
      const result = extractGo(root);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'Println',
        receiver: 'fmt',
        kind: 'attribute',
      });
      expect(calls).toContainEqual({
        name: 'Printf',
        receiver: 'log',
        kind: 'attribute',
      });
      expect(calls).toContainEqual({
        name: 'ListenAndServe',
        receiver: 'http',
        kind: 'attribute',
      });
    });
  });

  describe('method declarations', () => {
    it('extracts method with value receiver', async () => {
      const root = await parseGo(`package main

type Server struct{}

func (s Server) Start() error {
    return nil
}
`);
      const result = extractGo(root);
      // struct + method
      const method = result.symbols.find((s) => s.name === 'Start')!;
      expect(method).toBeDefined();
      expect(method.kind).toBe('function');
      expect(method.receiverVar).toBe('s');
      expect(method.receiverType).toBe('Server');
    });

    it('extracts method with pointer receiver', async () => {
      const root = await parseGo(`package main

type Cache struct{}

func (c *Cache) Set(key string, val interface{}) {
    c.data[key] = val
}
`);
      const result = extractGo(root);
      const method = result.symbols.find((s) => s.name === 'Set')!;
      expect(method).toBeDefined();
      expect(method.receiverVar).toBe('c');
      expect(method.receiverType).toBe('Cache');
    });

    it('includes receiver in method signature', async () => {
      const root = await parseGo(`package main

type DB struct{}

func (db *DB) Query(sql string) error {
    return nil
}
`);
      const result = extractGo(root);
      const method = result.symbols.find((s) => s.name === 'Query')!;
      expect(method.signature).toContain('db *DB');
      expect(method.signature).toContain('sql string');
    });

    it('captures calls from method bodies', async () => {
      const root = await parseGo(`package main

type Handler struct{}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    h.logRequest(r)
    data := h.process(r)
    json.NewEncoder(w).Encode(data)
}
`);
      const result = extractGo(root);
      const method = result.symbols.find((s) => s.name === 'ServeHTTP')!;
      expect(method.calls).toContainEqual({
        name: 'logRequest',
        receiver: 'h',
        kind: 'attribute',
      });
      expect(method.calls).toContainEqual({
        name: 'process',
        receiver: 'h',
        kind: 'attribute',
      });
    });

    it('extracts multiple methods for same receiver type', async () => {
      const root = await parseGo(`package main

type Stack struct{}

func (s *Stack) Push(val int) {
    append(s.items, val)
}

func (s *Stack) Pop() int {
    return s.items[len(s.items)-1]
}

func (s *Stack) Len() int {
    return len(s.items)
}
`);
      const result = extractGo(root);
      const methods = result.symbols.filter((s) => s.receiverType === 'Stack');
      expect(methods).toHaveLength(3);
      const names = methods.map((m) => m.name);
      expect(names).toContain('Push');
      expect(names).toContain('Pop');
      expect(names).toContain('Len');
    });
  });

  describe('mixed declarations', () => {
    it('extracts structs, interfaces, functions, and methods together', async () => {
      const root = await parseGo(`package main

type Config struct {
    Debug bool
}

type Logger interface {
    Log(msg string)
}

func NewConfig() *Config {
    return &Config{}
}

func (c *Config) Validate() error {
    return nil
}
`);
      const result = extractGo(root);
      expect(result.symbols).toHaveLength(4);
      const names = result.symbols.map((s) => s.name);
      expect(names).toEqual(['Config', 'Logger', 'NewConfig', 'Validate']);
    });

    it('preserves declaration order', async () => {
      const root = await parseGo(`package main

func first() {}

type Middle struct{}

func last() {}
`);
      const result = extractGo(root);
      const names = result.symbols.map((s) => s.name);
      expect(names).toEqual(['first', 'Middle', 'last']);
    });
  });

  describe('subtype and embedding', () => {
    it('sets subtype to struct', async () => {
      const root = await parseGo(`package main

type Server struct {
    host string
}
`);
      const result = extractGo(root);
      expect(result.symbols[0].subtype).toBe('struct');
    });

    it('sets subtype to interface', async () => {
      const root = await parseGo(`package main

type Reader interface {
    Read(p []byte) (int, error)
}
`);
      const result = extractGo(root);
      expect(result.symbols[0].subtype).toBe('interface');
    });

    it('extracts embedded struct types', async () => {
      const root = await parseGo(`package main

type Admin struct {
    User
    role string
}
`);
      const result = extractGo(root);
      const admin = result.symbols[0];
      expect(admin.subtype).toBe('struct');
      expect(admin.superclasses).toEqual(['User']);
    });

    it('extracts embedded interface types', async () => {
      const root = await parseGo(`package main

type ReadWriter interface {
    Reader
    Writer
}
`);
      const result = extractGo(root);
      const rw = result.symbols[0];
      expect(rw.subtype).toBe('interface');
      expect(rw.interfaces).toEqual(['Reader', 'Writer']);
    });

    it('no embedded types for empty struct', async () => {
      const root = await parseGo(`package main

type Empty struct{}
`);
      const result = extractGo(root);
      expect(result.symbols[0].subtype).toBe('struct');
      expect(result.symbols[0].superclasses).toBeUndefined();
    });

    it('no embedded types for empty interface', async () => {
      const root = await parseGo(`package main

type Any interface{}
`);
      const result = extractGo(root);
      expect(result.symbols[0].subtype).toBe('interface');
      expect(result.symbols[0].interfaces).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns no symbols for package-only file', async () => {
      const root = await parseGo('package main\n');
      const result = extractGo(root);
      expect(result.symbols).toEqual([]);
    });

    it('returns no symbols for file with only imports', async () => {
      const root = await parseGo(`package main

import (
    "fmt"
    "os"
)
`);
      const result = extractGo(root);
      expect(result.symbols).toEqual([]);
    });

    it('preserves rootNode in result', async () => {
      const root = await parseGo(`package main
func foo() {}
`);
      const result = extractGo(root);
      expect(result.rootNode).toBe(root);
    });

    it('ignores type aliases (non-struct, non-interface)', async () => {
      const root = await parseGo(`package main

type ID string
type Handler func(w http.ResponseWriter, r *http.Request)
`);
      const result = extractGo(root);
      // Type aliases are not struct or interface — should be skipped
      expect(result.symbols).toEqual([]);
    });
  });

  describe('nested calls', () => {
    it('captures calls inside if/else blocks', async () => {
      const root = await parseGo(`package main

func check(ok bool) {
    if ok {
        proceed()
    } else {
        abort()
    }
}
`);
      const result = extractGo(root);
      const callNames = result.symbols[0].calls.map((c) => c.name);
      expect(callNames).toContain('proceed');
      expect(callNames).toContain('abort');
    });

    it('captures calls inside for loops', async () => {
      const root = await parseGo(`package main

func process(items []string) {
    for _, item := range items {
        result := transform(item)
        db.Save(result)
    }
}
`);
      const result = extractGo(root);
      const calls = result.symbols[0].calls;
      expect(calls).toContainEqual({
        name: 'transform',
        receiver: null,
        kind: 'bare',
      });
      expect(calls).toContainEqual({
        name: 'Save',
        receiver: 'db',
        kind: 'attribute',
      });
    });

    it('captures calls inside switch cases', async () => {
      const root = await parseGo(`package main

func handle(action string) {
    switch action {
    case "start":
        start()
    case "stop":
        stop()
    default:
        log.Warn("unknown")
    }
}
`);
      const result = extractGo(root);
      const callNames = result.symbols[0].calls.map((c) => c.name);
      expect(callNames).toContain('start');
      expect(callNames).toContain('stop');
    });

    it('captures calls inside defer and go statements', async () => {
      const root = await parseGo(`package main

func serve() {
    defer cleanup()
    go handleConnection()
    listen()
}
`);
      const result = extractGo(root);
      const callNames = result.symbols[0].calls.map((c) => c.name);
      expect(callNames).toContain('cleanup');
      expect(callNames).toContain('handleConnection');
      expect(callNames).toContain('listen');
    });
  });
});
