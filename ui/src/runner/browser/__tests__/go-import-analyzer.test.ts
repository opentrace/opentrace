import { describe, it, expect, beforeEach } from 'vitest';
import { analyzeGoImports, resetDirIndexCache } from '../parser/importAnalyzer';
import { parseGo } from './helpers';

describe('analyzeGoImports', () => {
  beforeEach(() => {
    resetDirIndexCache();
  });

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

  describe('dir index filtering', () => {
    it('non-.go files do not produce false internal imports', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/docs"
`);
      // Directory "docs" only contains a README — should NOT resolve as internal
      const known = new Set(['docs/README.md', 'cmd/main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal).toEqual({});
    });

    it('resolves when .go and non-.go files coexist in same directory', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/internal/store"
`);
      const known = new Set([
        'internal/store/store.go',
        'internal/store/README.md',
        'cmd/main.go',
      ]);
      const result = analyzeGoImports(root, known);
      // Should resolve via the .go file, ignoring the README
      expect(result.internal['store']).toBe('internal/store/store.go');
    });
  });

  describe('ambiguous dirBase resolution', () => {
    it('resolves ambiguous package name via modulePath stripping', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/internal/graph"
`);
      // Two dirs named "graph" — dirBase shortcut should be omitted
      const known = new Set([
        'api/graph/graph.go',
        'internal/graph/graph.go',
        'cmd/main.go',
      ]);
      const result = analyzeGoImports(root, known, 'github.com/myorg/app');
      // modulePath stripping: "github.com/myorg/app/internal/graph" → "internal/graph"
      expect(result.internal['graph']).toBe('internal/graph/graph.go');
    });

    it('ambiguous dirBase without modulePath does not resolve as internal', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/internal/graph"
`);
      // Two dirs named "graph" — ambiguous, and no modulePath to disambiguate
      const known = new Set([
        'api/graph/graph.go',
        'internal/graph/graph.go',
        'cmd/main.go',
      ]);
      const result = analyzeGoImports(root, known);
      // Without modulePath, can't resolve ambiguous "graph" — falls through to own-module check
      expect(result.internal).toEqual({});
    });

    it('unambiguous dirBase still resolves without modulePath', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/internal/store"
`);
      // Only one dir named "store" — dirBase shortcut works
      const known = new Set(['internal/store/store.go', 'cmd/main.go']);
      const result = analyzeGoImports(root, known);
      expect(result.internal['store']).toBe('internal/store/store.go');
    });
  });

  describe('cache reset', () => {
    it('cache reset prevents stale data between calls', async () => {
      const root = await parseGo(`package main

import "github.com/myorg/app/pkg/utils"
`);
      // First call with "utils" dir
      const known1 = new Set(['pkg/utils/utils.go']);
      const result1 = analyzeGoImports(root, known1);
      expect(result1.internal['utils']).toBe('pkg/utils/utils.go');

      // Reset cache, call with different files
      resetDirIndexCache();
      const known2 = new Set(['cmd/main.go']);
      const result2 = analyzeGoImports(root, known2);
      expect(result2.internal).toEqual({});
    });
  });
});
