/**
 * Shared normalizers and fixture-discovery helpers for the fixture test runners.
 *
 * - normalizeSymbol: standard fields (used by TS, Python, cross-validation)
 * - normalizeSymbolFull: includes receiver_var / receiver_type (used by Go)
 * - discoverExtractionFixtures: find paired source + .expected.json files
 * - discoverImportFixtures: find .fixture.json files
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CodeSymbol } from "../types";

/** Convert camelCase CodeSymbol to snake_case dict (excludes receiver fields). */
export function normalizeSymbol(sym: CodeSymbol): Record<string, unknown> {
  return {
    name: sym.name,
    kind: sym.kind,
    start_line: sym.startLine,
    end_line: sym.endLine,
    signature: sym.signature,
    children: sym.children.map(normalizeSymbol),
    calls: sym.calls.map((c) => ({
      name: c.name,
      receiver: c.receiver,
      kind: c.kind,
    })),
  };
}

/** Convert camelCase CodeSymbol to snake_case dict with Go receiver fields. */
export function normalizeSymbolFull(sym: CodeSymbol): Record<string, unknown> {
  return {
    name: sym.name,
    kind: sym.kind,
    start_line: sym.startLine,
    end_line: sym.endLine,
    signature: sym.signature,
    receiver_var: sym.receiverVar,
    receiver_type: sym.receiverType,
    children: sym.children.map(normalizeSymbolFull),
    calls: sym.calls.map((c) => ({
      name: c.name,
      receiver: c.receiver,
      kind: c.kind,
    })),
  };
}

/**
 * Discover extraction fixture pairs: source file + matching .expected.json.
 * Returns fixture names (without extension) that have BOTH files present.
 * Warns on orphaned source files missing their expected JSON.
 */
export function discoverExtractionFixtures(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const sourceFiles = readdirSync(dir).filter((f) => f.endsWith(ext));
  const names: string[] = [];
  for (const f of sourceFiles) {
    const name = f.slice(0, -ext.length);
    const expectedPath = join(dir, `${name}.expected.json`);
    if (existsSync(expectedPath)) {
      names.push(name);
    } else {
      console.warn(`fixture "${f}" has no matching .expected.json — skipping`);
    }
  }
  return names;
}

/** Discover import fixture files (*.fixture.json) in a directory. */
export function discoverImportFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".fixture.json"))
    .map((f) => f.replace(".fixture.json", ""));
}
