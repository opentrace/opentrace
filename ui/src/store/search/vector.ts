/**
 * In-memory vector store with brute-force cosine similarity search.
 *
 * Uses Float32Array for memory efficiency and fast dot-product computation.
 * Brute-force is acceptable for <100k vectors typical of a single-repo graph.
 */

export interface VectorResult {
  id: string;
  score: number;
}

export class VectorIndex {
  private vectors = new Map<string, Float32Array>();
  private dim: number;

  constructor(dim: number) {
    this.dim = dim;
  }

  get size(): number {
    return this.vectors.size;
  }

  /** Add or update a vector. The array must match the configured dimension. */
  addVector(id: string, vector: number[] | Float32Array): void {
    if (vector.length !== this.dim) {
      throw new Error(`Vector dimension mismatch: expected ${this.dim}, got ${vector.length}`);
    }
    const arr = vector instanceof Float32Array ? vector : new Float32Array(vector);
    // Normalize to unit vector for efficient cosine similarity (dot product of unit vectors)
    const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] /= norm;
      }
    }
    this.vectors.set(id, arr);
  }

  /** Remove a vector by ID. */
  removeVector(id: string): boolean {
    return this.vectors.delete(id);
  }

  /** Find the k most similar vectors to the query vector using cosine similarity. */
  search(queryVector: number[] | Float32Array, limit = 50): VectorResult[] {
    if (queryVector.length !== this.dim) {
      throw new Error(`Query dimension mismatch: expected ${this.dim}, got ${queryVector.length}`);
    }

    // Normalize query vector
    const query = queryVector instanceof Float32Array
      ? new Float32Array(queryVector)
      : new Float32Array(queryVector);
    const qNorm = Math.sqrt(query.reduce((sum, v) => sum + v * v, 0));
    if (qNorm > 0) {
      for (let i = 0; i < query.length; i++) {
        query[i] /= qNorm;
      }
    }

    const results: VectorResult[] = [];

    for (const [id, vec] of this.vectors) {
      // Cosine similarity = dot product of unit vectors
      let dot = 0;
      for (let i = 0; i < this.dim; i++) {
        dot += query[i] * vec[i];
      }
      results.push({ id, score: dot });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
