// A minimal hand-written declaration covering only what this service uses.
// Anything added here has to exist in pg itself; the names below match its
// documented PoolConfig options.
declare module "pg" {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    /** false disables TLS; the object form is node's TLS options. */
    ssl?: boolean | { rejectUnauthorized?: boolean };
    /** Passed through to Postgres as a per-connection setting, in ms. */
    statement_timeout?: number;
  }

  export interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query<T = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<QueryResult<T>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<T = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<QueryResult<T>>;
    end(): Promise<void>;
    on(event: "error", listener: (err: Error) => void): this;
  }
}
