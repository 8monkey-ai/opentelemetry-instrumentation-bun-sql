/**
 * Internal type definitions for the Bun.SQL runtime API surface.
 * These are not exported publicly — they describe the shapes we patch at runtime.
 */

export interface BunSqlOptions {
  adapter?: string;
  hostname?: string;
  host?: string;
  port?: number;
  database?: string;
  filename?: string;
  url?: string;
}

export interface BunSqlResult extends Array<Record<string, unknown>> {
  count: number;
  command: string;
  lastInsertRowid: number | null;
  affectedRows: number | null;
}

export interface BunSqlQueryObject extends PromiseLike<BunSqlResult> {
  values(): BunSqlQueryObject;
  raw(): BunSqlQueryObject;
  simple(): BunSqlQueryObject;
  execute(): BunSqlQueryObject;
  cancel(): void;
}

/** A Bun SQL instance — both callable (tagged template) and an object with methods. */
export interface BunSqlInstance {
  (strings: TemplateStringsArray, ...values: unknown[]): BunSqlQueryObject;
  unsafe(query: string, params?: unknown[]): BunSqlQueryObject;
  file(path: string, params?: unknown[]): BunSqlQueryObject;
  begin(callback: (tx: BunSqlTransaction) => Promise<unknown>): Promise<unknown>;
  beginDistributed(
    id: string,
    callback: (tx: BunSqlTransaction) => Promise<unknown>,
  ): Promise<unknown>;
  commitDistributed(id: string): Promise<void>;
  rollbackDistributed(id: string): Promise<void>;
  reserve(): Promise<BunSqlReservedConnection>;
  close(): Promise<void>;
  options: BunSqlOptions;
}

export interface BunSqlTransaction extends BunSqlInstance {
  savepoint(callback: (tx: BunSqlTransaction) => Promise<unknown>): Promise<unknown>;
}

export interface BunSqlReservedConnection extends BunSqlInstance {
  release(): void;
}
