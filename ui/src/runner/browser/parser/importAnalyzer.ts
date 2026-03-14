/**
 * Per-language import analysis using tree-sitter ASTs.
 * Ported from agent/src/opentrace_agent/sources/code/import_analyzer.py
 *
 * Parses import statements from already-parsed source files and maps local
 * aliases to repo-relative file paths (internal) or package IDs (external).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { npmPackageName, normalizePyName, packageId } from './manifestParser';

/** Result of import analysis for a single file. */
export interface ImportAnalysisResult {
  /** Internal imports: alias → repo-relative file path (existing behavior). */
  internal: Record<string, string>;
  /** External imports: package name → deterministic package ID (pkg:registry:name). */
  external: Record<string, string>;
}

// --- Python imports ---

export function analyzePythonImports(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};
  const fileDir = parentDir(filePath);

  for (const child of rootNode.children) {
    if (child.type === 'import_statement') {
      parsePythonImport(child, knownFiles, internal, external);
    } else if (child.type === 'import_from_statement') {
      parsePythonFromImport(child, fileDir, knownFiles, internal, external);
    }
  }
  return { internal, external };
}

function parsePythonImport(
  node: SyntaxNode,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  for (const child of node.children) {
    if (child.type === 'dotted_name') {
      const moduleName = child.text;
      const candidates = moduleToPaths(moduleName);
      let found = false;
      for (const candidate of candidates) {
        if (knownFiles.has(candidate)) {
          const parts = moduleName.split('.');
          internal[parts[parts.length - 1]] = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        const topLevel = moduleName.split('.')[0];
        const name = normalizePyName(topLevel);
        external[name] = packageId('pypi', name);
      }
    } else if (child.type === 'aliased_import') {
      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');
      if (nameNode && aliasNode) {
        const moduleName = nameNode.text;
        const alias = aliasNode.text;
        const candidates = moduleToPaths(moduleName);
        let found = false;
        for (const candidate of candidates) {
          if (knownFiles.has(candidate)) {
            internal[alias] = candidate;
            found = true;
            break;
          }
        }
        if (!found) {
          const topLevel = moduleName.split('.')[0];
          const name = normalizePyName(topLevel);
          external[name] = packageId('pypi', name);
        }
      }
    }
  }
}

function parsePythonFromImport(
  node: SyntaxNode,
  fileDir: string,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  const moduleNameNode = node.childForFieldName('module_name');
  if (!moduleNameNode) return;

  let moduleText = moduleNameNode.text;
  let isRelative = false;
  let baseDir = fileDir;

  for (const child of node.children) {
    if (child.type === 'relative_import') {
      isRelative = true;
      for (const sub of child.children) {
        if (sub.type === 'dotted_name') {
          moduleText = sub.text;
        } else if (sub.type === 'import_prefix') {
          const dots = sub.text;
          baseDir = fileDir;
          for (let i = 0; i < dots.length - 1; i++) {
            baseDir = parentDir(baseDir);
          }
          if (
            moduleText === moduleNameNode.text &&
            moduleText.startsWith('.')
          ) {
            moduleText = '';
          }
        }
      }
      break;
    }
  }

  let candidates: string[];
  if (isRelative) {
    const basePath = moduleText
      ? baseDir
        ? `${baseDir}/${moduleText.replace(/\./g, '/')}`
        : moduleText.replace(/\./g, '/')
      : baseDir;
    candidates = [`${basePath}.py`, `${basePath}/__init__.py`];
  } else {
    candidates = moduleToPaths(moduleText);
  }

  let found = false;
  let resolvedPath: string | null = null;
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      const alias = moduleText ? moduleText.split('.').pop()! : '';
      if (alias) {
        internal[alias] = candidate;
      }
      resolvedPath = candidate;
      found = true;
      break;
    }
  }

  // Store individual imported symbol names from `from X import Y, Z`
  if (resolvedPath) {
    for (const child of node.children) {
      if (
        child.type === 'dotted_name' &&
        child !== node.childForFieldName('module_name')
      ) {
        // Bare imported name: `from X import Y`
        internal[child.text] = resolvedPath;
      } else if (child.type === 'aliased_import') {
        // `from X import Y as Z` — store the alias
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (aliasNode) {
          internal[aliasNode.text] = resolvedPath;
        } else if (nameNode) {
          internal[nameNode.text] = resolvedPath;
        }
      }
    }
  }

  // Only track external for absolute (non-relative) imports that didn't resolve
  if (!found && !isRelative && moduleText) {
    const topLevel = moduleText.split('.')[0];
    const name = normalizePyName(topLevel);
    external[name] = packageId('pypi', name);
  }
}

// --- Go imports ---

/**
 * Pre-compute directory → file index for O(1) Go import resolution.
 * Maps full directory paths and their suffixes to a representative file.
 */
function buildDirIndex(knownFiles: Set<string>): Map<string, string> {
  const index = new Map<string, string>();
  // Track all dirs per basename to detect ambiguity
  const baseDirs = new Map<string, Set<string>>();
  for (const filePath of knownFiles) {
    // Only index .go files — non-code files shouldn't create false Go package matches
    if (!filePath.endsWith('.go')) continue;
    const dir = parentDir(filePath);
    if (!dir) continue;
    // Store full dir path
    if (!index.has(dir)) index.set(dir, filePath);
    // Collect dirs per basename for ambiguity check
    const dirBase = dir.split('/').pop()!;
    let dirs = baseDirs.get(dirBase);
    if (!dirs) {
      dirs = new Set();
      baseDirs.set(dirBase, dirs);
    }
    dirs.add(dir);
  }
  // Only store dirBase shortcut when exactly one directory has that name
  for (const [dirBase, dirs] of baseDirs) {
    if (dirs.size === 1) {
      const dir = dirs.values().next().value!;
      index.set(dirBase, index.get(dir)!);
    }
  }
  return index;
}

// Cache the dir index — knownFiles doesn't change between calls
let cachedDirIndex: Map<string, string> | null = null;
let cachedDirIndexSource: Set<string> | null = null;

function getDirIndex(knownFiles: Set<string>): Map<string, string> {
  if (cachedDirIndex && cachedDirIndexSource === knownFiles) {
    return cachedDirIndex;
  }
  cachedDirIndex = buildDirIndex(knownFiles);
  cachedDirIndexSource = knownFiles;
  return cachedDirIndex;
}

/** Reset the module-level dir index cache. Call in tests to prevent cross-test pollution. */
export function resetDirIndexCache(): void {
  cachedDirIndex = null;
  cachedDirIndexSource = null;
}

export function analyzeGoImports(
  rootNode: SyntaxNode,
  knownFiles: Set<string>,
  modulePath?: string,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};
  const dirIndex = getDirIndex(knownFiles);

  for (const child of rootNode.children) {
    if (child.type === 'import_declaration') {
      parseGoImportDecl(child, dirIndex, internal, external, modulePath);
    }
  }
  return { internal, external };
}

function parseGoImportDecl(
  node: SyntaxNode,
  dirIndex: Map<string, string>,
  internal: Record<string, string>,
  external: Record<string, string>,
  modulePath?: string,
): void {
  for (const child of node.children) {
    if (child.type === 'import_spec') {
      parseGoImportSpec(child, dirIndex, internal, external, modulePath);
    } else if (child.type === 'import_spec_list') {
      for (const spec of child.children) {
        if (spec.type === 'import_spec') {
          parseGoImportSpec(spec, dirIndex, internal, external, modulePath);
        }
      }
    }
  }
}

function parseGoImportSpec(
  node: SyntaxNode,
  dirIndex: Map<string, string>,
  internal: Record<string, string>,
  external: Record<string, string>,
  modulePath?: string,
): void {
  const pathNode = node.childForFieldName('path');
  const nameNode = node.childForFieldName('name');
  if (!pathNode) return;

  const importPath = pathNode.text.replace(/^["']|["']$/g, '');

  // Skip stdlib (no dot in first segment — stdlib packages like "fmt", "net/http")
  if (!importPath.includes('.')) return;

  let alias: string;
  if (nameNode) {
    alias = nameNode.text;
    if (alias === '_' || alias === '.') return;
  } else {
    alias = importPath.split('/').pop()!;
  }

  // Try to resolve as internal file via O(1) directory index lookup
  // Priority: full import path → modulePath-stripped repo-relative → bare dirBase shortcut
  const fullMatch = dirIndex.get(importPath);
  if (fullMatch) {
    internal[alias] = fullMatch;
    return;
  }

  // Strip modulePath prefix to get repo-relative dir (e.g. "github.com/org/app/internal/graph" → "internal/graph")
  if (modulePath && importPath.startsWith(modulePath + '/')) {
    const repoRelDir = importPath.slice(modulePath.length + 1);
    const relMatch = dirIndex.get(repoRelDir);
    if (relMatch) {
      internal[alias] = relMatch;
      return;
    }
  }

  // Fall back to bare package name (only works when unambiguous)
  const pkgName = importPath.split('/').pop()!;
  const baseMatch = dirIndex.get(pkgName);
  if (baseMatch) {
    internal[alias] = baseMatch;
    return;
  }

  // If not internal and doesn't match our module path, it's external
  const isOwnModule = modulePath && importPath.startsWith(modulePath);
  if (!isOwnModule) {
    const goModuleName = goModuleRoot(importPath);
    external[goModuleName] = packageId('go', goModuleName);
  }
}

/**
 * Extract Go module root from an import path.
 * For well-known hosts (github.com, gitlab.com, etc.), take first 3 segments.
 * For others, take the full path (it might be the module itself).
 */
function goModuleRoot(importPath: string): string {
  const parts = importPath.split('/');
  const host = parts[0];

  // Well-known hosting: github.com/owner/repo, gitlab.com/owner/repo, etc.
  if (
    host === 'github.com' ||
    host === 'gitlab.com' ||
    host === 'bitbucket.org' ||
    host === 'golang.org' ||
    host === 'google.golang.org' ||
    host === 'gopkg.in'
  ) {
    return parts.slice(0, 3).join('/');
  }

  // For vanity imports and others, take up to 3 segments as a reasonable default
  return parts.length >= 3 ? parts.slice(0, 3).join('/') : importPath;
}

// --- TypeScript imports ---

export function analyzeTypeScriptImports(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};
  const fileDir = parentDir(filePath);

  for (const child of rootNode.children) {
    if (child.type === 'import_statement') {
      parseTsImport(child, fileDir, knownFiles, internal, external);
    } else if (child.type === 'export_statement') {
      parseTsReexport(child, fileDir, knownFiles, internal, external);
    }
  }
  return { internal, external };
}

function parseTsImport(
  node: SyntaxNode,
  fileDir: string,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;

  const sourceText = sourceNode.text.replace(/^["']|["']$/g, '');

  // Non-relative import → external package
  if (!sourceText.startsWith('.')) {
    const pkgName = npmPackageName(sourceText);
    external[pkgName] = packageId('npm', pkgName);
    return;
  }

  const resolved = resolveRelativePath(fileDir, sourceText);
  const extensions = [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) {
      const alias = sourceText.split('/').pop()!;
      internal[alias] = candidate;
      break;
    }
  }
}

function parseTsReexport(
  node: SyntaxNode,
  fileDir: string,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return; // Bare export (e.g. `export class Foo {}`), not a re-export

  const sourceText = sourceNode.text.replace(/^["']|["']$/g, '');

  // Non-relative re-export → external package
  if (!sourceText.startsWith('.')) {
    const pkgName = npmPackageName(sourceText);
    external[pkgName] = packageId('npm', pkgName);
    return;
  }

  const resolved = resolveRelativePath(fileDir, sourceText);
  const extensions = [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '/index.ts',
    '/index.tsx',
    '/index.js',
  ];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) {
      const alias = sourceText.split('/').pop()!;
      internal[alias] = candidate;
      break;
    }
  }
}

// --- Rust imports ---

export function analyzeRustImports(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};
  const fileDir = parentDir(filePath);

  for (const child of rootNode.children) {
    if (child.type === 'mod_item') {
      // `mod foo;` → maps to foo.rs or foo/mod.rs
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      // Only external mod declarations (with `;`), not inline `mod foo { ... }`
      const hasBody = child.children.some((c) => c.type === 'declaration_list');
      if (hasBody) continue;

      const modName = nameNode.text;
      const candidates = [
        fileDir ? `${fileDir}/${modName}.rs` : `${modName}.rs`,
        fileDir ? `${fileDir}/${modName}/mod.rs` : `${modName}/mod.rs`,
      ];
      let found = false;
      for (const candidate of candidates) {
        if (knownFiles.has(candidate)) {
          internal[modName] = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        // Could be an external crate re-exported via mod
        external[modName] = packageId('crates', modName);
      }
    } else if (child.type === 'use_declaration') {
      parseRustUseDecl(child, fileDir, knownFiles, internal, external);
    }
  }
  return { internal, external };
}

function parseRustUseDecl(
  node: SyntaxNode,
  fileDir: string,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  // Extract the root crate/module name from use declarations
  for (const child of node.children) {
    if (child.type === 'scoped_identifier') {
      // `use foo::bar` — root is first identifier
      const parts = child.text.split('::');
      const root = parts[0];
      resolveRustRoot(root, fileDir, knownFiles, internal, external);
    } else if (child.type === 'scoped_use_list') {
      // `use foo::{bar, baz}` — root is the identifier before ::
      for (const sub of child.children) {
        if (sub.type === 'identifier' || sub.type === 'scoped_identifier') {
          const root = sub.text.split('::')[0];
          resolveRustRoot(root, fileDir, knownFiles, internal, external);
          break;
        }
      }
    } else if (child.type === 'identifier') {
      // `use foo;` — bare use
      resolveRustRoot(child.text, fileDir, knownFiles, internal, external);
    }
  }
}

function resolveRustRoot(
  root: string,
  fileDir: string,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
): void {
  // Skip Rust built-ins
  if (
    root === 'std' ||
    root === 'core' ||
    root === 'alloc' ||
    root === 'self' ||
    root === 'super' ||
    root === 'crate'
  ) {
    return;
  }

  // Check if this maps to a known file (sibling module)
  if (!internal[root]) {
    const candidates = [
      fileDir ? `${fileDir}/${root}.rs` : `${root}.rs`,
      fileDir ? `${fileDir}/${root}/mod.rs` : `${root}/mod.rs`,
      `src/${root}.rs`,
      `src/${root}/mod.rs`,
    ];
    for (const candidate of candidates) {
      if (knownFiles.has(candidate)) {
        internal[root] = candidate;
        return;
      }
    }
    // External crate
    external[root] = packageId('crates', root);
  }
}

// --- Ruby imports ---

export function analyzeRubyImports(
  rootNode: SyntaxNode,
  filePath: string,
  knownFiles: Set<string>,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};
  const fileDir = parentDir(filePath);

  for (const child of rootNode.children) {
    if (child.type === 'call') {
      const funcNode = child.children[0];
      if (!funcNode || funcNode.type !== 'identifier') continue;
      const funcName = funcNode.text;

      if (funcName === 'require_relative') {
        const argNode =
          child.childForFieldName('arguments') ??
          child.children.find((c) => c.type === 'argument_list');
        if (!argNode) continue;
        const strNode = argNode.children.find((c) => c.type === 'string');
        if (!strNode) continue;
        const contentNode = strNode.children.find(
          (c) => c.type === 'string_content',
        );
        if (!contentNode) continue;

        const requirePath = contentNode.text;
        const resolved = resolveRelativePath(fileDir, requirePath);
        const candidates = [`${resolved}.rb`, resolved, `${resolved}/index.rb`];
        for (const candidate of candidates) {
          if (knownFiles.has(candidate)) {
            const alias = requirePath.split('/').pop()!;
            internal[alias] = candidate;
            break;
          }
        }
      } else if (funcName === 'require') {
        const argNode =
          child.childForFieldName('arguments') ??
          child.children.find((c) => c.type === 'argument_list');
        if (!argNode) continue;
        const strNode = argNode.children.find((c) => c.type === 'string');
        if (!strNode) continue;
        const contentNode = strNode.children.find(
          (c) => c.type === 'string_content',
        );
        if (!contentNode) continue;

        const gemName = contentNode.text;
        // Check if it resolves to a local file first
        const candidates = [
          `${gemName}.rb`,
          `lib/${gemName}.rb`,
          `${gemName}/init.rb`,
        ];
        let found = false;
        for (const candidate of candidates) {
          if (knownFiles.has(candidate)) {
            internal[gemName] = candidate;
            found = true;
            break;
          }
        }
        if (!found) {
          const name = gemName.split('/')[0];
          external[name] = packageId('rubygems', name);
        }
      }
    }
  }
  return { internal, external };
}

// --- Path utilities ---

function parentDir(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function moduleToPaths(moduleName: string): string[] {
  const path = moduleName.replace(/\./g, '/');
  return [`${path}.py`, `${path}/__init__.py`];
}

function resolveRelativePath(baseDir: string, relative: string): string {
  const parts = relative.split('/');
  const baseParts = baseDir ? baseDir.split('/') : [];

  for (const part of parts) {
    if (part === '.') continue;
    else if (part === '..') {
      if (baseParts.length > 0) baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

/** Dispatch to the correct language-specific analyzer. */
export function analyzeImports(
  rootNode: SyntaxNode,
  language: string,
  filePath: string,
  knownPaths: Set<string>,
  modulePath?: string,
): ImportAnalysisResult {
  switch (language) {
    case 'python':
      return analyzePythonImports(rootNode, filePath, knownPaths);
    case 'go':
      return analyzeGoImports(rootNode, knownPaths, modulePath);
    case 'typescript':
    case 'javascript':
      return analyzeTypeScriptImports(rootNode, filePath, knownPaths);
    case 'rust':
      return analyzeRustImports(rootNode, filePath, knownPaths);
    case 'ruby':
      return analyzeRubyImports(rootNode, filePath, knownPaths);
    default:
      return { internal: {}, external: {} };
  }
}
