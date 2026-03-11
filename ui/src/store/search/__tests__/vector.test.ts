import { describe, it, expect } from "vitest";
import { VectorIndex } from "../vector";

describe("VectorIndex", () => {
  it("returns empty for empty index", () => {
    const idx = new VectorIndex(3);
    expect(idx.search([1, 0, 0])).toEqual([]);
    expect(idx.size).toBe(0);
  });

  it("finds nearest neighbor correctly", () => {
    const idx = new VectorIndex(3);
    idx.addVector("a", [1, 0, 0]);
    idx.addVector("b", [0, 1, 0]);
    idx.addVector("c", [0, 0, 1]);

    const results = idx.search([1, 0.1, 0], 3);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeCloseTo(1, 1);
  });

  it("returns cosine similarity scores between -1 and 1", () => {
    const idx = new VectorIndex(3);
    idx.addVector("same", [1, 2, 3]);
    idx.addVector("opposite", [-1, -2, -3]);

    const results = idx.search([1, 2, 3]);
    const sameResult = results.find((r) => r.id === "same")!;
    const oppResult = results.find((r) => r.id === "opposite")!;

    expect(sameResult.score).toBeCloseTo(1, 5);
    expect(oppResult.score).toBeCloseTo(-1, 5);
  });

  it("respects limit parameter", () => {
    const idx = new VectorIndex(2);
    for (let i = 0; i < 10; i++) {
      idx.addVector(`v${i}`, [Math.random(), Math.random()]);
    }
    const results = idx.search([1, 0], 3);
    expect(results.length).toBe(3);
  });

  it("supports update (re-add same ID)", () => {
    const idx = new VectorIndex(2);
    idx.addVector("a", [1, 0]);
    idx.addVector("a", [0, 1]);

    const results = idx.search([0, 1]);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(idx.size).toBe(1);
  });

  it("removeVector works", () => {
    const idx = new VectorIndex(2);
    idx.addVector("a", [1, 0]);
    expect(idx.removeVector("a")).toBe(true);
    expect(idx.size).toBe(0);
    expect(idx.removeVector("a")).toBe(false);
  });

  it("throws on dimension mismatch", () => {
    const idx = new VectorIndex(3);
    expect(() => idx.addVector("bad", [1, 2])).toThrow("dimension mismatch");
    expect(() => idx.search([1, 2])).toThrow("dimension mismatch");
  });

  it("handles zero vector gracefully", () => {
    const idx = new VectorIndex(3);
    idx.addVector("zero", [0, 0, 0]);
    idx.addVector("nonzero", [1, 0, 0]);

    // Searching for non-zero should still work
    const results = idx.search([1, 0, 0]);
    expect(results.length).toBe(2);
  });
});
