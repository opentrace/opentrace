import { describe, it, expect } from "vitest";
import { analyzeTypeScriptImports } from "../parser/importAnalyzer";
import { parseTS } from "./helpers";

describe("analyzeTypeScriptImports", () => {
  it("resolves relative import", async () => {
    const root = await parseTS("import { helper } from './utils';\n");
    const known = new Set(["src/utils.ts", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["utils"]).toBe("src/utils.ts");
    expect(result.external).toEqual({});
  });

  it("resolves parent dir import", async () => {
    const root = await parseTS("import { config } from '../config';\n");
    const known = new Set(["src/config.ts", "src/app/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/app/main.ts", known);
    expect(result.internal["config"]).toBe("src/config.ts");
  });

  it("captures bare specifier as external", async () => {
    const root = await parseTS("import React from 'react';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal).toEqual({});
    expect(result.external["react"]).toBe("pkg:npm:react");
  });

  it("resolves index file", async () => {
    const root = await parseTS("import { App } from './components';\n");
    const known = new Set(["src/components/index.ts", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["components"]).toBe("src/components/index.ts");
  });

  it("resolves tsx extension", async () => {
    const root = await parseTS("import { Widget } from './Widget';\n");
    const known = new Set(["src/Widget.tsx", "src/App.tsx"]);
    const result = analyzeTypeScriptImports(root, "src/App.tsx", known);
    expect(result.internal["Widget"]).toBe("src/Widget.tsx");
  });

  it("resolves named re-export", async () => {
    const root = await parseTS("export { Config } from './config';\n");
    const known = new Set(["src/config.ts", "src/index.ts"]);
    const result = analyzeTypeScriptImports(root, "src/index.ts", known);
    expect(result.internal["config"]).toBe("src/config.ts");
  });

  it("captures external re-export", async () => {
    const root = await parseTS("export { useState } from 'react';\n");
    const known = new Set(["src/index.ts"]);
    const result = analyzeTypeScriptImports(root, "src/index.ts", known);
    expect(result.internal).toEqual({});
    expect(result.external["react"]).toBe("pkg:npm:react");
  });

  it("extracts scoped npm package name", async () => {
    const root = await parseTS("import { Button } from '@grafana/ui/components';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["@grafana/ui"]).toBe("pkg:npm:@grafana/ui");
  });

  it("extracts unscoped npm subpath import", async () => {
    const root = await parseTS("import fp from 'lodash/fp';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["lodash"]).toBe("pkg:npm:lodash");
  });

  it("handles mixed internal and external imports", async () => {
    const root = await parseTS(
      "import { helper } from './utils';\nimport React from 'react';\n",
    );
    const known = new Set(["src/utils.ts", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["utils"]).toBe("src/utils.ts");
    expect(result.external["react"]).toBe("pkg:npm:react");
  });

  it("resolves .js extension import", async () => {
    const root = await parseTS("import { legacy } from './old';\n");
    const known = new Set(["src/old.js", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["old"]).toBe("src/old.js");
  });

  it("resolves .jsx extension import", async () => {
    const root = await parseTS("import { Component } from './Button';\n");
    const known = new Set(["src/Button.jsx", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["Button"]).toBe("src/Button.jsx");
  });

  it("resolves index.tsx barrel", async () => {
    const root = await parseTS("import { Page } from './pages';\n");
    const known = new Set(["src/pages/index.tsx", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["pages"]).toBe("src/pages/index.tsx");
  });

  it("resolves index.js barrel", async () => {
    const root = await parseTS("import { util } from './lib';\n");
    const known = new Set(["src/lib/index.js", "src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal["lib"]).toBe("src/lib/index.js");
  });

  it("handles default import from external", async () => {
    const root = await parseTS("import express from 'express';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["express"]).toBe("pkg:npm:express");
  });

  it("handles namespace import from external", async () => {
    const root = await parseTS("import * as path from 'path';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["path"]).toBe("pkg:npm:path");
  });

  it("handles type-only import as external", async () => {
    const root = await parseTS("import type { FC } from 'react';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["react"]).toBe("pkg:npm:react");
  });

  it("handles multiple named imports from same source", async () => {
    const root = await parseTS("import { useState, useEffect, useRef } from 'react';\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.external["react"]).toBe("pkg:npm:react");
  });

  it("handles wildcard re-export", async () => {
    const root = await parseTS("export * from './types';\n");
    const known = new Set(["src/types.ts", "src/index.ts"]);
    const result = analyzeTypeScriptImports(root, "src/index.ts", known);
    expect(result.internal["types"]).toBe("src/types.ts");
  });

  it("ignores bare export statements (no source)", async () => {
    const root = await parseTS("export class Foo {}\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal).toEqual({});
    expect(result.external).toEqual({});
  });

  it("handles deeply nested relative path", async () => {
    const root = await parseTS("import { db } from '../../../shared/db';\n");
    const known = new Set(["shared/db.ts", "src/features/auth/login.ts"]);
    const result = analyzeTypeScriptImports(root, "src/features/auth/login.ts", known);
    expect(result.internal["db"]).toBe("shared/db.ts");
  });

  it("returns empty result for file with no imports", async () => {
    const root = await parseTS("const x = 42;\n");
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(result.internal).toEqual({});
    expect(result.external).toEqual({});
  });

  it("handles multiple different external packages", async () => {
    const root = await parseTS(`import React from 'react';
import { render } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import axios from 'axios';
`);
    const known = new Set(["src/main.ts"]);
    const result = analyzeTypeScriptImports(root, "src/main.ts", known);
    expect(Object.keys(result.external)).toHaveLength(4);
    expect(result.external["react"]).toBe("pkg:npm:react");
    expect(result.external["react-dom"]).toBe("pkg:npm:react-dom");
    expect(result.external["react-router-dom"]).toBe("pkg:npm:react-router-dom");
    expect(result.external["axios"]).toBe("pkg:npm:axios");
  });
});

