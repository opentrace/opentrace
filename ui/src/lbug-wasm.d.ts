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

declare module '@lbug/lbug-wasm' {
  /** Row returned by iterating an Arrow Table from execute(). */
  interface ArrowRow {
    toJSON(): Record<string, unknown>;
  }

  /** Arrow Table returned by Connection.execute(). */
  interface ArrowTable {
    [Symbol.iterator](): Iterator<ArrowRow>;
    numRows: number;
    numCols: number;
    toString(): string;
  }

  interface WebDatabase {
    close(): void;
  }

  interface WebQueryResult {
    isSuccess(): boolean;
    getErrorMessage(): string;
    getNumTuples(): number;
    hasNext(): boolean;
    hasNextQueryResult(): boolean;
    getNextQueryResult(): WebQueryResult;
    resetIterator(): void;
    getColumnNames(): unknown;
    getColumnDataTypes(): unknown;
    getArrowSchema(): number;
    getArrowChunk(): number;
    getCompilingTime(): number;
    getExecutionTime(): number;
    toString(): string;
    close(): void;
  }

  interface WebConnection {
    /** Raw synchronous query — returns a WebQueryResult with error info. */
    query(statement: string): WebQueryResult;
    /** High-level async query — returns an Arrow Table, or undefined on failure. */
    execute(statement: string): Promise<ArrowTable | undefined>;
    close(): void;
    setQueryTimeout(ms: number): void;
    setMaxNumThreadForExec(n: number): void;
    getNumNodes(tableName: string): number;
    getNumRels(tableName: string): number;
  }

  interface LbugFS {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string): Uint8Array;
    mkdir(path: string): void;
    unlink(path: string): void;
    rename(oldPath: string, newPath: string): void;
    rmdir(path: string): void;
  }

  interface LbugModule {
    Database(
      path?: string,
      bufferPoolSize?: number,
      maxNumThreads?: number,
      compression?: boolean,
      readOnly?: boolean,
      maxDBSize?: number,
    ): Promise<WebDatabase>;
    Connection(db: WebDatabase, numThreads?: number): Promise<WebConnection>;
    FS: LbugFS;
    wasmMemory: WebAssembly.Memory;
  }

  export default function lbugInit(): Promise<LbugModule>;
}
