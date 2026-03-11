/**
 * Per-language import analysis using tree-sitter ASTs.
 * Ported from agent/src/opentrace_agent/sources/code/import_analyzer.py
 *
 * Parses import statements from already-parsed source files and maps local
 * aliases to repo-relative file paths (internal) or package IDs (external).
 */

import type { Node as SyntaxNode } from "web-tree-sitter";
import { npmPackageName, normalizePyName, packageId } from "./manifestParser";

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
    if (child.type === "import_statement") {
      parsePythonImport(child, knownFiles, internal, external);
    } else if (child.type === "import_from_statement") {
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
    if (child.type === "dotted_name") {
      const moduleName = child.text;
      const candidates = moduleToPaths(moduleName);
      let found = false;
      for (const candidate of candidates) {
        if (knownFiles.has(candidate)) {
          const parts = moduleName.split(".");
          internal[parts[parts.length - 1]] = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        const topLevel = moduleName.split(".")[0];
        const name = normalizePyName(topLevel);
        external[name] = packageId("pypi", name);
      }
    } else if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
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
          const topLevel = moduleName.split(".")[0];
          const name = normalizePyName(topLevel);
          external[name] = packageId("pypi", name);
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
  const moduleNameNode = node.childForFieldName("module_name");
  if (!moduleNameNode) return;

  let moduleText = moduleNameNode.text;
  let isRelative = false;

  for (const child of node.children) {
    if (child.type === "relative_import") {
      isRelative = true;
      for (const sub of child.children) {
        if (sub.type === "dotted_name") {
          moduleText = sub.text;
        } else if (sub.type === "import_prefix") {
          const dots = sub.text;
          let baseDir = fileDir;
          for (let i = 0; i < dots.length - 1; i++) {
            baseDir = parentDir(baseDir);
          }
          if (moduleText === moduleNameNode.text && moduleText.startsWith(".")) {
            moduleText = "";
          }
        }
      }
      break;
    }
  }

  let candidates: string[];
  if (isRelative) {
    const basePath = moduleText
      ? (fileDir ? `${fileDir}/${moduleText.replace(/\./g, "/")}` : moduleText.replace(/\./g, "/"))
      : fileDir;
    candidates = [`${basePath}.py`, `${basePath}/__init__.py`];
  } else {
    candidates = moduleToPaths(moduleText);
  }

  let found = false;
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      const alias = moduleText ? moduleText.split(".").pop()! : "";
      if (alias) {
        internal[alias] = candidate;
      }
      found = true;
      break;
    }
  }

  // Only track external for absolute (non-relative) imports that didn't resolve
  if (!found && !isRelative && moduleText) {
    const topLevel = moduleText.split(".")[0];
    const name = normalizePyName(topLevel);
    external[name] = packageId("pypi", name);
  }
}

// --- Go imports ---

export function analyzeGoImports(
  rootNode: SyntaxNode,
  knownFiles: Set<string>,
  modulePath?: string,
): ImportAnalysisResult {
  const internal: Record<string, string> = {};
  const external: Record<string, string> = {};

  for (const child of rootNode.children) {
    if (child.type === "import_declaration") {
      parseGoImportDecl(child, knownFiles, internal, external, modulePath);
    }
  }
  return { internal, external };
}

function parseGoImportDecl(
  node: SyntaxNode,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
  modulePath?: string,
): void {
  for (const child of node.children) {
    if (child.type === "import_spec") {
      parseGoImportSpec(child, knownFiles, internal, external, modulePath);
    } else if (child.type === "import_spec_list") {
      for (const spec of child.children) {
        if (spec.type === "import_spec") {
          parseGoImportSpec(spec, knownFiles, internal, external, modulePath);
        }
      }
    }
  }
}

function parseGoImportSpec(
  node: SyntaxNode,
  knownFiles: Set<string>,
  internal: Record<string, string>,
  external: Record<string, string>,
  modulePath?: string,
): void {
  const pathNode = node.childForFieldName("path");
  const nameNode = node.childForFieldName("name");
  if (!pathNode) return;

  const importPath = pathNode.text.replace(/^["']|["']$/g, "");

  // Skip stdlib (no dot in first segment — stdlib packages like "fmt", "net/http")
  if (!importPath.includes(".")) return;

  let alias: string;
  if (nameNode) {
    alias = nameNode.text;
    if (alias === "_" || alias === ".") return;
  } else {
    alias = importPath.split("/").pop()!;
  }

  // Try to resolve as internal file
  const pkgName = importPath.split("/").pop()!;
  let found = false;
  for (const known of knownFiles) {
    const knownDir = parentDir(known);
    if (
      knownDir === importPath ||
      knownDir.endsWith("/" + importPath) ||
      knownDir.endsWith(importPath) ||
      knownDir === pkgName ||
      knownDir.endsWith("/" + pkgName)
    ) {
      internal[alias] = known;
      found = true;
      break;
    }
  }

  // If not internal and doesn't match our module path, it's external
  if (!found) {
    const isOwnModule = modulePath && importPath.startsWith(modulePath);
    if (!isOwnModule) {
      // Use the module root (match against known Go module patterns)
      // Go modules typically have 3 segments: host/owner/repo
      const goModuleName = goModuleRoot(importPath);
      external[goModuleName] = packageId("go", goModuleName);
    }
  }
}

/**
 * Extract Go module root from an import path.
 * For well-known hosts (github.com, gitlab.com, etc.), take first 3 segments.
 * For others, take the full path (it might be the module itself).
 */
function goModuleRoot(importPath: string): string {
  const parts = importPath.split("/");
  const host = parts[0];

  // Well-known hosting: github.com/owner/repo, gitlab.com/owner/repo, etc.
  if (
    host === "github.com" || host === "gitlab.com" ||
    host === "bitbucket.org" || host === "golang.org" ||
    host === "google.golang.org" || host === "gopkg.in"
  ) {
    return parts.slice(0, 3).join("/");
  }

  // For vanity imports and others, take up to 3 segments as a reasonable default
  return parts.length >= 3 ? parts.slice(0, 3).join("/") : importPath;
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
    if (child.type === "import_statement") {
      parseTsImport(child, fileDir, knownFiles, internal, external);
    } else if (child.type === "export_statement") {
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
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return;

  const sourceText = sourceNode.text.replace(/^["']|["']$/g, "");

  // Non-relative import → external package
  if (!sourceText.startsWith(".")) {
    const pkgName = npmPackageName(sourceText);
    external[pkgName] = packageId("npm", pkgName);
    return;
  }

  const resolved = resolveRelativePath(fileDir, sourceText);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) {
      const alias = sourceText.split("/").pop()!;
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
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return; // Bare export (e.g. `export class Foo {}`), not a re-export

  const sourceText = sourceNode.text.replace(/^["']|["']$/g, "");

  // Non-relative re-export → external package
  if (!sourceText.startsWith(".")) {
    const pkgName = npmPackageName(sourceText);
    external[pkgName] = packageId("npm", pkgName);
    return;
  }

  const resolved = resolveRelativePath(fileDir, sourceText);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) {
      const alias = sourceText.split("/").pop()!;
      internal[alias] = candidate;
      break;
    }
  }
}

// --- Path utilities ---

function parentDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function moduleToPaths(moduleName: string): string[] {
  const path = moduleName.replace(/\./g, "/");
  return [`${path}.py`, `${path}/__init__.py`];
}

function resolveRelativePath(baseDir: string, relative: string): string {
  const parts = relative.split("/");
  const baseParts = baseDir ? baseDir.split("/") : [];

  for (const part of parts) {
    if (part === ".") continue;
    else if (part === "..") {
      if (baseParts.length > 0) baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
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
    case "python":
      return analyzePythonImports(rootNode, filePath, knownPaths);
    case "go":
      return analyzeGoImports(rootNode, knownPaths, modulePath);
    case "typescript":
      return analyzeTypeScriptImports(rootNode, filePath, knownPaths);
    case "javascript":
      return analyzeTypeScriptImports(rootNode, filePath, knownPaths);
    default:
      return { internal: {}, external: {} };
  }
}
