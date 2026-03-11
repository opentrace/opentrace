import { describe, it, expect } from "vitest";
import { analyzePythonImports } from "../parser/importAnalyzer";
import { parsePy } from "./helpers";

describe("analyzePythonImports", () => {
  describe("import statements", () => {
    it("resolves absolute import of internal module", async () => {
      const root = await parsePy("import utils\n");
      const known = new Set(["utils.py", "src/main.py"]);
      const result = analyzePythonImports(root, "src/main.py", known);
      expect(result.internal["utils"]).toBe("utils.py");
      expect(result.external).toEqual({});
    });

    it("resolves dotted import of internal package", async () => {
      const root = await parsePy("import myapp.models\n");
      const known = new Set(["myapp/models.py", "src/main.py"]);
      const result = analyzePythonImports(root, "src/main.py", known);
      expect(result.internal["models"]).toBe("myapp/models.py");
    });

    it("captures external package when not found in known files", async () => {
      const root = await parsePy("import requests\n");
      const known = new Set(["src/main.py"]);
      const result = analyzePythonImports(root, "src/main.py", known);
      expect(result.internal).toEqual({});
      expect(result.external["requests"]).toBe("pkg:pypi:requests");
    });

    it("resolves aliased import", async () => {
      const root = await parsePy("import numpy as np\n");
      const known = new Set(["src/main.py"]);
      const result = analyzePythonImports(root, "src/main.py", known);
      expect(result.external["numpy"]).toBe("pkg:pypi:numpy");
    });

    it("resolves aliased internal import", async () => {
      const root = await parsePy("import utils as u\n");
      const known = new Set(["utils.py", "app.py"]);
      const result = analyzePythonImports(root, "app.py", known);
      expect(result.internal["u"]).toBe("utils.py");
    });

    it("normalizes external package names (underscores to dashes)", async () => {
      const root = await parsePy("import Flask_Cors\n");
      const known = new Set(["main.py"]);
      const result = analyzePythonImports(root, "main.py", known);
      expect(result.external["flask-cors"]).toBe("pkg:pypi:flask-cors");
    });
  });

  describe("from ... import statements", () => {
    it("resolves absolute from-import of internal module", async () => {
      const root = await parsePy("from utils import helper\n");
      const known = new Set(["utils.py", "main.py"]);
      const result = analyzePythonImports(root, "main.py", known);
      expect(result.internal["utils"]).toBe("utils.py");
    });

    it("captures external from-import", async () => {
      const root = await parsePy("from flask import Flask, request\n");
      const known = new Set(["main.py"]);
      const result = analyzePythonImports(root, "main.py", known);
      expect(result.external["flask"]).toBe("pkg:pypi:flask");
    });

    it("resolves dotted from-import", async () => {
      const root = await parsePy("from myapp.utils import helper\n");
      const known = new Set(["myapp/utils.py", "src/app.py"]);
      const result = analyzePythonImports(root, "src/app.py", known);
      expect(result.internal["utils"]).toBe("myapp/utils.py");
    });
  });

  describe("relative imports", () => {
    it("resolves single-dot relative import", async () => {
      const root = await parsePy("from .utils import helper\n");
      const known = new Set(["src/utils.py", "src/main.py"]);
      const result = analyzePythonImports(root, "src/main.py", known);
      expect(result.internal["utils"]).toBe("src/utils.py");
    });

    it("does not resolve double-dot relative import (known limitation — baseDir not propagated)", async () => {
      // from ..config in src/app/main.py should go up to src/ and resolve src/config.py
      // However, the baseDir computed in the import_prefix handler is a local variable
      // and is not used in the path resolution below. The code falls through to use
      // fileDir (src/app) instead, producing wrong candidates (src/app/config.py).
      const root = await parsePy("from ..config import settings\n");
      const known = new Set(["src/config.py", "src/app/main.py"]);
      const result = analyzePythonImports(root, "src/app/main.py", known);
      // Does not resolve because it looks for src/app/config.py (wrong path)
      expect(result.internal["config"]).toBeUndefined();
    });

    it("resolves relative import to __init__.py", async () => {
      const root = await parsePy("from .models import User\n");
      const known = new Set(["pkg/models/__init__.py", "pkg/views.py"]);
      const result = analyzePythonImports(root, "pkg/views.py", known);
      expect(result.internal["models"]).toBe("pkg/models/__init__.py");
    });
  });

  describe("mixed imports", () => {
    it("handles mixed internal, external, and relative imports", async () => {
      const root = await parsePy(`import os
from flask import Flask
from .utils import helper
import mylib
`);
      const known = new Set(["pkg/utils.py", "mylib.py", "pkg/app.py"]);
      const result = analyzePythonImports(root, "pkg/app.py", known);

      // os → external
      expect(result.external["os"]).toBe("pkg:pypi:os");
      // flask → external
      expect(result.external["flask"]).toBe("pkg:pypi:flask");
      // .utils → internal
      expect(result.internal["utils"]).toBe("pkg/utils.py");
      // mylib → internal
      expect(result.internal["mylib"]).toBe("mylib.py");
    });
  });

  describe("edge cases", () => {
    it("returns empty result for file with no imports", async () => {
      const root = await parsePy("x = 42\n");
      const known = new Set(["main.py"]);
      const result = analyzePythonImports(root, "main.py", known);
      expect(result.internal).toEqual({});
      expect(result.external).toEqual({});
    });

    it("handles multiple imports on separate lines", async () => {
      const root = await parsePy(`import json
import sys
import pathlib
`);
      const known = new Set(["main.py"]);
      const result = analyzePythonImports(root, "main.py", known);
      expect(Object.keys(result.external)).toHaveLength(3);
    });
  });
});
