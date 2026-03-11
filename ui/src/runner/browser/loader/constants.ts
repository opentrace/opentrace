/**
 * Constants for directory/file filtering during indexing.
 * Ported from agent/src/opentrace_agent/sources/code/directory_walker.py
 */

export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "dist",
  "build",
  ".idea",
  ".vscode",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".tox",
  ".eggs",
  "egg-info",
]);

export const INCLUDED_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".md",
  ".proto",
  ".graphql",
  ".sql",
  ".sh",
  ".bash",
  ".dockerfile",
  ".tf",
  ".hcl",
]);

export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".sql": "sql",
};

/** Languages we have tree-sitter WASM parsers for. */
export const PARSEABLE_LANGUAGES = new Set(["python", "typescript", "go", "javascript"]);

/** Max file size (bytes) to attempt parsing. Files larger are skipped. */
export const MAX_FILE_SIZE = 1_000_000;
