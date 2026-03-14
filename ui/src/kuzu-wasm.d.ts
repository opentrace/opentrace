declare module 'kuzu-wasm' {
  export class Database {
    constructor(
      path: string,
      bufferPoolSize?: number,
      maxNumThreads?: number,
      enableCompression?: boolean,
      readOnly?: boolean,
      autoCheckpoint?: boolean,
      checkpointThreshold?: number,
    );
    init(): Promise<void>;
    close(): Promise<void>;
    /** @internal */
    _getDatabaseObjectId(): Promise<string>;
  }

  export class Connection {
    constructor(database: Database, numThreads?: number | null);
    init(): Promise<void>;
    query(statement: string): Promise<QueryResult>;
    prepare(statement: string): Promise<PreparedStatement>;
    execute(
      ps: PreparedStatement,
      params?: Record<string, unknown>,
    ): Promise<QueryResult>;
    close(): Promise<void>;
  }

  export class QueryResult {
    isSuccess(): boolean;
    getErrorMessage(): Promise<string>;
    getNumTuples(): Promise<number>;
    getNumColumns(): Promise<number>;
    getColumnNames(): Promise<string[]>;
    getColumnTypes(): Promise<string[]>;
    getAllObjects(): Promise<Record<string, unknown>[]>;
    getAllRows(): Promise<unknown[][]>;
    getNext(): Promise<unknown[]>;
    hasNext(): boolean;
    hasNextQueryResult(): boolean;
    getNextQueryResult(): Promise<QueryResult>;
    resetIterator(): Promise<void>;
    toString(): Promise<string>;
    getQuerySummary(): Promise<{
      compilingTime: number;
      executionTime: number;
    }>;
    close(): Promise<void>;
  }

  export class PreparedStatement {
    isSuccess(): boolean;
    getErrorMessage(): Promise<string>;
    close(): Promise<void>;
  }

  export const FS: {
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    mkdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<Record<string, unknown>>;
    readDir(path: string): Promise<string[]>;
  };

  export function init(): Promise<void>;
  export function setWorkerPath(path: string): void;
  export function getVersion(): Promise<string>;
  export function getStorageVersion(): Promise<bigint>;
  export function close(): Promise<void>;

  const kuzu: {
    Database: typeof Database;
    Connection: typeof Connection;
    PreparedStatement: typeof PreparedStatement;
    QueryResult: typeof QueryResult;
    FS: typeof FS;
    init: typeof init;
    setWorkerPath: typeof setWorkerPath;
    getVersion: typeof getVersion;
    getStorageVersion: typeof getStorageVersion;
    close: typeof close;
  };
  export default kuzu;
}
