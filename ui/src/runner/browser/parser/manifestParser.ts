/**
 * Parse dependency manifests (package.json, go.mod, requirements.txt, pyproject.toml)
 * into structured dependency records. Pure functions — no tree-sitter needed.
 */

export interface ParsedDependency {
  name: string; // "react", "github.com/gorilla/mux", "requests"
  version: string; // "^18.0.0", "v1.8.1", ">=3.0"
  registry: string; // "npm" | "pypi" | "go" | "crates"
  source: string; // manifest file path: "package.json"
  dependencyType: string; // "runtime" | "dev" | "peer" | "optional" | "indirect"
}

export interface ManifestParseResult {
  dependencies: ParsedDependency[];
  errors: string[];
}

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
]);

const LOCK_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'poetry.lock',
  'Cargo.lock',
  'uv.lock',
]);

/** Returns true if the file path is a supported dependency manifest. */
export function isManifestFile(path: string): boolean {
  const basename = path.split('/').pop() ?? '';
  if (LOCK_BASENAMES.has(basename)) return false;
  return MANIFEST_BASENAMES.has(basename);
}

/** Dispatch to the correct parser based on filename. */
export function parseManifest(
  path: string,
  content: string,
): ManifestParseResult {
  const basename = path.split('/').pop() ?? '';
  switch (basename) {
    case 'package.json':
      return parsePackageJson(content, path);
    case 'go.mod':
      return parseGoMod(content, path);
    case 'requirements.txt':
      return parseRequirementsTxt(content, path);
    case 'pyproject.toml':
      return parsePyprojectToml(content, path);
    case 'Cargo.toml':
      return parseCargoToml(content, path);
    default:
      return {
        dependencies: [],
        errors: [`Unsupported manifest: ${basename}`],
      };
  }
}

/** Deterministic package ID: pkg:{registry}:{name} */
export function packageId(registry: string, name: string): string {
  return `pkg:${registry}:${name}`;
}

/** Return the canonical web URL for a package on its registry. */
export function packageSourceUrl(
  registry: string,
  name: string,
): string | undefined {
  switch (registry) {
    case 'npm':
      return `https://www.npmjs.com/package/${name}`;
    case 'pypi':
      return `https://pypi.org/project/${name}/`;
    case 'go':
      return `https://pkg.go.dev/${name}`;
    case 'crates':
      return `https://crates.io/crates/${name}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

export function parsePackageJson(
  content: string,
  source: string,
): ManifestParseResult {
  const errors: string[] = [];
  const deps: ParsedDependency[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { dependencies: [], errors: [`Failed to parse ${source}: ${e}`] };
  }

  const sections: Array<[string, string]> = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ];

  for (const [key, depType] of sections) {
    const section = parsed[key];
    if (!section || typeof section !== 'object') continue;
    for (const [name, version] of Object.entries(
      section as Record<string, string>,
    )) {
      deps.push({
        name,
        version: typeof version === 'string' ? version : '',
        registry: 'npm',
        source,
        dependencyType: depType,
      });
    }
  }

  return { dependencies: deps, errors };
}

// ---------------------------------------------------------------------------
// go.mod
// ---------------------------------------------------------------------------

export function parseGoMod(
  content: string,
  source: string,
): ManifestParseResult {
  const deps: ParsedDependency[] = [];
  const errors: string[] = [];

  // Match require blocks: require ( ... )
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(content)) !== null) {
    const block = match[1];
    for (const line of block.split('\n')) {
      const dep = parseGoRequireLine(line, source);
      if (dep) deps.push(dep);
    }
  }

  // Match single-line requires: require path version
  const singleRe = /^require\s+(\S+)\s+(\S+)(.*)$/gm;
  while ((match = singleRe.exec(content)) !== null) {
    const depType = match[3]?.includes('// indirect') ? 'indirect' : 'runtime';
    deps.push({
      name: match[1],
      version: match[2],
      registry: 'go',
      source,
      dependencyType: depType,
    });
  }

  return { dependencies: deps, errors };
}

function parseGoRequireLine(
  line: string,
  source: string,
): ParsedDependency | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;

  // e.g. "github.com/gorilla/mux v1.8.1 // indirect"
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;

  const depType = trimmed.includes('// indirect') ? 'indirect' : 'runtime';
  return {
    name: parts[0],
    version: parts[1],
    registry: 'go',
    source,
    dependencyType: depType,
  };
}

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

export function parseRequirementsTxt(
  content: string,
  source: string,
): ManifestParseResult {
  const deps: ParsedDependency[] = [];
  const errors: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip blanks, comments, flags (-r, -e, -c, --), and URL references
    if (
      !line ||
      line.startsWith('#') ||
      line.startsWith('-') ||
      line.startsWith('http')
    )
      continue;

    // Parse: name[extras]<op>version or bare name
    const match = line.match(
      /^([A-Za-z0-9_.-]+)(?:\[.*?\])?\s*([<>=!~]+\s*\S+)?/,
    );
    if (!match) continue;

    const rawName = match[1];
    const version = match[2]?.trim() ?? '*';

    deps.push({
      name: normalizePyName(rawName),
      version,
      registry: 'pypi',
      source,
      dependencyType: 'runtime',
    });
  }

  return { dependencies: deps, errors };
}

// ---------------------------------------------------------------------------
// pyproject.toml (limited line-based parser — no TOML library)
// ---------------------------------------------------------------------------

/**
 * Parses dependencies from pyproject.toml using a simple line-based state machine.
 * Handles `[project] dependencies = [...]` and `[tool.poetry.dependencies]` sections.
 * Falls back gracefully on unusual formatting.
 */
export function parsePyprojectToml(
  content: string,
  source: string,
): ManifestParseResult {
  const deps: ParsedDependency[] = [];
  const errors: string[] = [];

  const lines = content.split('\n');
  let i = 0;

  // Track current section header
  let currentSection = '';

  while (i < lines.length) {
    const line = lines[i].trim();

    // Section headers
    if (line.startsWith('[')) {
      currentSection = line;
      i++;
      continue;
    }

    // [project] section: look for dependencies = [...]
    if (currentSection === '[project]' && line.startsWith('dependencies')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) {
        i++;
        continue;
      }

      const afterEq = line.slice(eqIdx + 1).trim();
      if (afterEq.startsWith('[')) {
        // Could be single-line or multi-line array
        const arrayContent = collectTomlArray(lines, i, eqIdx + 1);
        for (const item of parseTomlStringArray(arrayContent)) {
          const dep = parsePep508(item, source);
          if (dep) deps.push(dep);
        }
      }
      i++;
      continue;
    }

    // [tool.poetry.dependencies] section
    if (currentSection === '[tool.poetry.dependencies]') {
      // key = "version" or key = {version = "...", ...}
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0 && !line.startsWith('#') && !line.startsWith('[')) {
        const name = line.slice(0, eqIdx).trim();
        if (name === 'python') {
          i++;
          continue;
        } // skip python version constraint
        const value = line.slice(eqIdx + 1).trim();
        const version = value.replace(/^["']|["']$/g, '');
        deps.push({
          name: normalizePyName(name),
          version,
          registry: 'pypi',
          source,
          dependencyType: 'runtime',
        });
      }
    }

    // [project.optional-dependencies] section
    if (currentSection.startsWith('[project.optional-dependencies')) {
      if (line.includes('=') && !line.startsWith('#')) {
        const eqIdx = line.indexOf('=');
        const afterEq = line.slice(eqIdx + 1).trim();
        if (afterEq.startsWith('[')) {
          const arrayContent = collectTomlArray(lines, i, eqIdx + 1);
          for (const item of parseTomlStringArray(arrayContent)) {
            const dep = parsePep508(item, source, 'optional');
            if (dep) deps.push(dep);
          }
        }
      }
    }

    i++;
  }

  return { dependencies: deps, errors };
}

/** Collect a TOML array that may span multiple lines, starting from a [ character. */
function collectTomlArray(
  lines: string[],
  startLine: number,
  charOffset: number,
): string {
  let result = lines[startLine].slice(charOffset).trim();
  // Check if the array closes on the same line (track bracket depth)
  if (bracketsClosed(result)) return result;

  for (let i = startLine + 1; i < lines.length; i++) {
    result += '\n' + lines[i];
    if (bracketsClosed(result)) break;
  }
  return result;
}

/** Returns true if all brackets in the string are balanced (outermost [ has its matching ]). */
function bracketsClosed(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth === 0 && s.indexOf('[') !== -1) return true;
  }
  return false;
}

/** Parse a TOML string array like `["foo>=1.0", "bar"]` into its elements. */
function parseTomlStringArray(raw: string): string[] {
  const items: string[] = [];
  // Match quoted strings inside brackets
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    items.push(m[1]);
  }
  return items;
}

/** Parse a PEP 508 dependency string like "requests>=2.0" or "Flask[async]~=2.0". */
function parsePep508(
  spec: string,
  source: string,
  depType = 'runtime',
): ParsedDependency | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  // name[extras]<op>version
  const match = trimmed.match(
    /^([A-Za-z0-9_.-]+)(?:\[.*?\])?\s*([<>=!~]+.*)?$/,
  );
  if (!match) return null;

  return {
    name: normalizePyName(match[1]),
    version: match[2]?.trim() ?? '*',
    registry: 'pypi',
    source,
    dependencyType: depType,
  };
}

/** Normalize Python package name: lowercase, underscores to dashes. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-');
}

// ---------------------------------------------------------------------------
// Cargo.toml (line-based parser — no TOML library)
// ---------------------------------------------------------------------------

/**
 * Parses dependencies from Cargo.toml using a line-based state machine.
 * Handles [dependencies], [dev-dependencies], and [build-dependencies] sections.
 */
export function parseCargoToml(
  content: string,
  source: string,
): ManifestParseResult {
  const deps: ParsedDependency[] = [];
  const errors: string[] = [];

  const lines = content.split('\n');
  let currentSection = '';

  const depSections: Record<string, string> = {
    '[dependencies]': 'runtime',
    '[dev-dependencies]': 'dev',
    '[build-dependencies]': 'dev',
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section headers
    if (line.startsWith('[')) {
      currentSection = line;
      continue;
    }

    if (line.startsWith('#') || !line) continue;

    // Check if we're in a dependency section
    const depType = depSections[currentSection];
    if (!depType) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const name = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    // value can be: "1.0", { version = "1.0", ... }, or a bare version
    let version = '*';
    if (value.startsWith('"') || value.startsWith("'")) {
      version = value.replace(/^["']|["']$/g, '');
    } else if (value.startsWith('{')) {
      const verMatch = value.match(/version\s*=\s*["']([^"']+)["']/);
      if (verMatch) version = verMatch[1];
    }

    deps.push({
      name,
      version,
      registry: 'crates',
      source,
      dependencyType: depType,
    });
  }

  return { dependencies: deps, errors };
}

/** Extract npm package name from import specifier: @scope/pkg/sub → @scope/pkg, lodash/fp → lodash */
export function npmPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    // Scoped: @scope/pkg or @scope/pkg/sub
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  // Unscoped: lodash or lodash/fp
  return specifier.split('/')[0];
}
