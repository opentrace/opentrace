import { describe, it, expect } from 'vitest';
import { analyzeGoImports } from '../parser/importAnalyzer';
import { parseGo } from './helpers';

describe('analyzeGoImports', () => {
  describe('stdlib imports (skipped)', () => {
    it('skips stdlib single import', async () => {
      const root = await parseGo(`package main

import "fmt"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });

    it('skips stdlib grouped imports', async () => {
      const root = await parseGo(`package main

import (
    "fmt"
    "os"
    "net/http"
    "encoding/json"
)
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });
  });

  describe('external package imports', () => {
    it('captures github.com packages', async () => {
      const root = await parseGo(`package main

import "github.com/gorilla/mux"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.external['github.com/gorilla/mux']).toBe(
        'pkg:go:github.com/gorilla/mux',
      );
    });

    it('captures grouped external imports', async () => {
      const root = await parseGo(`package main

import (
    "github.com/gorilla/mux"
    "github.com/kuzudb/go-kuzu"
    "golang.org/x/text"
)
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.external['github.com/gorilla/mux']).toBe(
        'pkg:go:github.com/gorilla/mux',
      );
      expect(result.external['github.com/kuzudb/go-kuzu']).toBe(
        'pkg:go:github.com/kuzudb/go-kuzu',
      );
      expect(result.external['golang.org/x/text']).toBe(
        'pkg:go:golang.org/x/text',
      );
    });

    it('extracts module root from subpackage imports', async () => {
      const root = await parseGo(`package main

import "github.com/gorilla/mux/middleware"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      // Module root is first 3 segments
      expect(result.external['github.com/gorilla/mux']).toBe(
        'pkg:go:github.com/gorilla/mux',
      );
    });
  });

  describe('aliased imports', () => {
    it('captures aliased external import', async () => {
      const root = await parseGo(`package main

import muxRouter "github.com/gorilla/mux"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.external['github.com/gorilla/mux']).toBe(
        'pkg:go:github.com/gorilla/mux',
      );
    });

    it('skips blank import (_)', async () => {
      const root = await parseGo(`package main

import _ "github.com/lib/pq"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });

    it('skips dot import (.)', async () => {
      const root = await parseGo(`package main

import . "github.com/onsi/ginkgo"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });
  });

  describe('internal imports', () => {
    it('resolves import matching known file directory', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/myapp/internal/store"
`);
      const known = new Set(['internal/store/store.go', 'cmd/main.go']);
      const result = analyzeGoImports(root, known);
      // Should match internal/store/store.go via directory matching
      expect(result.internal['store']).toBe('internal/store/store.go');
    });
  });

  describe('mixed stdlib and external imports', () => {
    it('correctly separates stdlib (skipped) from external', async () => {
      const root = await parseGo(`package main

import (
    "fmt"
    "net/http"

    "github.com/gorilla/mux"
    "github.com/sirupsen/logrus"
)
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      // Only external packages
      expect(Object.keys(result.external)).toHaveLength(2);
      expect(result.external['github.com/gorilla/mux']).toBeDefined();
      expect(result.external['github.com/sirupsen/logrus']).toBeDefined();
    });
  });

  describe('module path filtering', () => {
    it('skips own module imports when modulePath is provided', async () => {
      const root = await parseGo(`package main

import "github.com/opentrace/opentrace/internal/graph"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(
        root,
        known,
        'github.com/opentrace/opentrace',
      );
      // Own module that doesn't match known files — should not appear as external
      expect(result.external).toEqual({});
    });

    it('keeps other external imports even with modulePath', async () => {
      const root = await parseGo(`package main

import (
    "github.com/opentrace/opentrace/internal/graph"
    "github.com/gorilla/mux"
)
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(
        root,
        known,
        'github.com/opentrace/opentrace',
      );
      expect(result.external['github.com/gorilla/mux']).toBe(
        'pkg:go:github.com/gorilla/mux',
      );
      // Own module filtered out
      expect(Object.keys(result.external)).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty result for file with no imports', async () => {
      const root = await parseGo(`package main

func main() {}
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });

    it('handles gopkg.in imports', async () => {
      const root = await parseGo(`package main

import "gopkg.in/yaml.v3"
`);
      const known = new Set(['main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.external['gopkg.in/yaml.v3']).toBe(
        'pkg:go:gopkg.in/yaml.v3',
      );
    });
  });
});
