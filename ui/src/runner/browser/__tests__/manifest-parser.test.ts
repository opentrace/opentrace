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
import {
  isManifestFile,
  parsePackageJson,
  parseGoMod,
  parseRequirementsTxt,
  parsePyprojectToml,
  parseManifest,
  npmPackageName,
  normalizePyName,
  packageId,
} from '../parser/manifestParser';

describe('isManifestFile', () => {
  it('accepts supported manifests', () => {
    expect(isManifestFile('package.json')).toBe(true);
    expect(isManifestFile('go.mod')).toBe(true);
    expect(isManifestFile('requirements.txt')).toBe(true);
    expect(isManifestFile('pyproject.toml')).toBe(true);
    expect(isManifestFile('Cargo.toml')).toBe(true);
  });

  it('accepts nested paths', () => {
    expect(isManifestFile('services/api/package.json')).toBe(true);
    expect(isManifestFile('backend/go.mod')).toBe(true);
  });

  it('rejects lock files', () => {
    expect(isManifestFile('package-lock.json')).toBe(false);
    expect(isManifestFile('yarn.lock')).toBe(false);
    expect(isManifestFile('go.sum')).toBe(false);
    expect(isManifestFile('poetry.lock')).toBe(false);
    expect(isManifestFile('uv.lock')).toBe(false);
  });

  it('rejects non-manifest files', () => {
    expect(isManifestFile('src/main.ts')).toBe(false);
    expect(isManifestFile('README.md')).toBe(false);
  });
});

describe('parsePackageJson', () => {
  it('parses dependencies and devDependencies', () => {
    const content = JSON.stringify({
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      devDependencies: { typescript: '~5.0.0', vitest: '^1.0.0' },
    });
    const result = parsePackageJson(content, 'package.json');
    expect(result.errors).toEqual([]);
    expect(result.dependencies).toHaveLength(4);

    const react = result.dependencies.find((d) => d.name === 'react')!;
    expect(react.version).toBe('^18.0.0');
    expect(react.registry).toBe('npm');
    expect(react.dependencyType).toBe('runtime');

    const ts = result.dependencies.find((d) => d.name === 'typescript')!;
    expect(ts.dependencyType).toBe('dev');
  });

  it('parses peer and optional dependencies', () => {
    const content = JSON.stringify({
      peerDependencies: { react: '>=16' },
      optionalDependencies: { fsevents: '^2.3.0' },
    });
    const result = parsePackageJson(content, 'package.json');
    expect(result.dependencies).toHaveLength(2);
    expect(result.dependencies[0].dependencyType).toBe('peer');
    expect(result.dependencies[1].dependencyType).toBe('optional');
  });

  it('handles invalid JSON', () => {
    const result = parsePackageJson('not json', 'package.json');
    expect(result.dependencies).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse');
  });

  it('handles missing sections', () => {
    const result = parsePackageJson('{}', 'package.json');
    expect(result.dependencies).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('parseGoMod', () => {
  const gomod = `module github.com/opentrace/opentrace

go 1.22

require (
\tgithub.com/gorilla/mux v1.8.1
\tgithub.com/kuzudb/go-kuzu v0.11.3
\tgolang.org/x/text v0.14.0 // indirect
)

require github.com/stretchr/testify v1.9.0
`;

  it('parses block and single-line requires', () => {
    const result = parseGoMod(gomod, 'go.mod');
    expect(result.errors).toEqual([]);
    expect(result.dependencies.length).toBeGreaterThanOrEqual(4);

    const mux = result.dependencies.find(
      (d) => d.name === 'github.com/gorilla/mux',
    )!;
    expect(mux.version).toBe('v1.8.1');
    expect(mux.registry).toBe('go');
    expect(mux.dependencyType).toBe('runtime');

    const text = result.dependencies.find(
      (d) => d.name === 'golang.org/x/text',
    )!;
    expect(text.dependencyType).toBe('indirect');
  });

  it('parses single-line require', () => {
    const result = parseGoMod(gomod, 'go.mod');
    const testify = result.dependencies.find(
      (d) => d.name === 'github.com/stretchr/testify',
    )!;
    expect(testify.version).toBe('v1.9.0');
    expect(testify.dependencyType).toBe('runtime');
  });
});

describe('parseRequirementsTxt', () => {
  const requirements = `# Core deps
requests==2.31.0
Flask>=2.0,<3.0
Flask_Cors~=4.0.0
click
boto3[crt]>=1.26

# Skip these
-r base.txt
-e .
`;

  it('parses package names and versions', () => {
    const result = parseRequirementsTxt(requirements, 'requirements.txt');
    expect(result.errors).toEqual([]);

    const requests = result.dependencies.find((d) => d.name === 'requests')!;
    expect(requests.version).toBe('==2.31.0');
    expect(requests.registry).toBe('pypi');

    const flask = result.dependencies.find((d) => d.name === 'flask')!;
    expect(flask.version).toBe('>=2.0,<3.0');
  });

  it('normalizes names (underscore to dash, lowercase)', () => {
    const result = parseRequirementsTxt(requirements, 'requirements.txt');
    const flaskCors = result.dependencies.find((d) => d.name === 'flask-cors')!;
    expect(flaskCors).toBeDefined();
  });

  it('strips extras brackets', () => {
    const result = parseRequirementsTxt(requirements, 'requirements.txt');
    const boto3 = result.dependencies.find((d) => d.name === 'boto3')!;
    expect(boto3).toBeDefined();
    expect(boto3.version).toBe('>=1.26');
  });

  it('skips comments and flags', () => {
    const result = parseRequirementsTxt(requirements, 'requirements.txt');
    // Should not include "-r base.txt" or "-e ." or "# Core deps"
    for (const dep of result.dependencies) {
      expect(dep.name).not.toMatch(/^[#-]/);
    }
  });
});

describe('parsePyprojectToml', () => {
  it('parses [project] dependencies array', () => {
    const content = `[project]
name = "myapp"
version = "0.1.0"
dependencies = [
  "requests>=2.0",
  "Flask[async]~=2.0",
  "click",
]
`;
    const result = parsePyprojectToml(content, 'pyproject.toml');
    expect(result.errors).toEqual([]);
    expect(result.dependencies).toHaveLength(3);

    const req = result.dependencies.find((d) => d.name === 'requests')!;
    expect(req.version).toBe('>=2.0');
    expect(req.registry).toBe('pypi');

    const flask = result.dependencies.find((d) => d.name === 'flask')!;
    expect(flask.version).toBe('~=2.0');
  });

  it('parses [tool.poetry.dependencies]', () => {
    const content = `[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.28"
Flask = {version = "^2.0", extras = ["async"]}
`;
    const result = parsePyprojectToml(content, 'pyproject.toml');
    // Should skip "python"
    const pyDep = result.dependencies.find((d) => d.name === 'python');
    expect(pyDep).toBeUndefined();

    const req = result.dependencies.find((d) => d.name === 'requests')!;
    expect(req).toBeDefined();
    expect(req.version).toBe('^2.28');
  });

  it('handles single-line dependencies array', () => {
    const content = `[project]
dependencies = ["click>=7.0"]
`;
    const result = parsePyprojectToml(content, 'pyproject.toml');
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0].name).toBe('click');
  });
});

describe('parseManifest dispatcher', () => {
  it('dispatches to correct parser', () => {
    const pkgJson = JSON.stringify({ dependencies: { react: '^18' } });
    const result = parseManifest('package.json', pkgJson);
    expect(result.dependencies[0].registry).toBe('npm');
  });

  it('returns error for unsupported manifests', () => {
    const result = parseManifest('Makefile', 'all: build');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Unsupported manifest');
  });
});

describe('npmPackageName', () => {
  it('extracts unscoped package', () => {
    expect(npmPackageName('lodash')).toBe('lodash');
    expect(npmPackageName('lodash/fp')).toBe('lodash');
  });

  it('extracts scoped package', () => {
    expect(npmPackageName('@grafana/ui')).toBe('@grafana/ui');
    expect(npmPackageName('@grafana/ui/components')).toBe('@grafana/ui');
  });
});

describe('normalizePyName', () => {
  it('lowercases and replaces underscores', () => {
    expect(normalizePyName('Flask_Cors')).toBe('flask-cors');
    expect(normalizePyName('SQLAlchemy')).toBe('sqlalchemy');
  });
});

describe('packageId', () => {
  it('produces deterministic IDs', () => {
    expect(packageId('npm', 'react')).toBe('pkg:npm:react');
    expect(packageId('go', 'github.com/gorilla/mux')).toBe(
      'pkg:go:github.com/gorilla/mux',
    );
    expect(packageId('pypi', 'requests')).toBe('pkg:pypi:requests');
  });
});
