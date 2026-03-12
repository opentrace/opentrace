declare module '@kuzu/kuzu-wasm' {
  export interface QueryResult {
    table: { toString(): string };
  }

  export interface Connection {
    execute(query: string): Promise<QueryResult>;
  }

  export interface Database {}

  export interface KuzuModule {
    Database(): Promise<Database>;
    Connection(db: Database): Promise<Connection>;
  }

  export default function kuzu_wasm(): Promise<KuzuModule>;
}
