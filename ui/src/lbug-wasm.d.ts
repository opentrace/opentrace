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

declare module '@ladybugdb/wasm-core' {
  class Database {
    constructor(
      databasePath?: string,
      bufferPoolSize?: number,
      maxNumThreads?: number,
      enableCompression?: boolean,
      readOnly?: boolean,
      autoCheckpoint?: boolean,
      checkpointThreshold?: number,
    );
    init(): Promise<void>;
    close(): Promise<void>;
    _getDatabaseObjectId(): Promise<string>;
  }

  class Connection {
    constructor(database: Database, numThreads?: number | null);
    init(): Promise<void>;
    query(statement: string): Promise<QueryResult>;
    execute(
      preparedStatement: PreparedStatement,
      params?: Record<string, unknown>,
    ): Promise<QueryResult>;
    prepare(statement: string): Promise<PreparedStatement>;
    close(): Promise<void>;
  }

  class PreparedStatement {
    close(): Promise<void>;
    isSuccess(): boolean;
    getErrorMessage(): string;
  }

  class QueryResult {
    close(): Promise<void>;
    hasNext(): boolean;
    hasNextQueryResult(): boolean;
    getNext(): Promise<Record<string, unknown>>;
    getNextQueryResult(): Promise<QueryResult>;
    getAllRows(): Promise<unknown[][]>;
    getAllObjects(): Promise<Record<string, unknown>[]>;
    getColumnNames(): Promise<string[]>;
    resetIterator(): Promise<void>;
  }

  class FS {
    static writeFile(path: string, data: string | Uint8Array): Promise<void>;
    static readFile(path: string): Promise<Uint8Array>;
    static mkdir(path: string): Promise<void>;
    static unlink(path: string): Promise<void>;
    static rename(oldPath: string, newPath: string): Promise<void>;
  }

  const _default: {
    init(): Promise<void>;
    getVersion(): Promise<string>;
    setWorkerPath(workerPath: string): void;
    close(): Promise<void>;
    Database: typeof Database;
    Connection: typeof Connection;
    PreparedStatement: typeof PreparedStatement;
    QueryResult: typeof QueryResult;
    FS: typeof FS;
  };

  export default _default;
  export { Database, Connection, PreparedStatement, QueryResult, FS };
}
