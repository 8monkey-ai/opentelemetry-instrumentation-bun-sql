/**
 * Shape of the options object on a Bun.SQL instance.
 * Used to detect adapter type, hostname, port, and database name.
 */
export interface SqlOptions {
	url?: string;
	adapter?: string;
	hostname?: string;
	host?: string;
	port?: number;
	database?: string;
	filename?: string;
	username?: string;
}

/**
 * Shape of query results returned by Bun.SQL.
 * Extends Array with additional metadata properties.
 */
export interface SqlResultArray<T = Record<string, unknown>> extends Array<T> {
	count: number;
	command: string;
	lastInsertRowid?: number;
	affectedRows?: number;
}

/**
 * Shape of a Bun.SQL query object (the lazy Promise-like returned by tagged templates).
 */
export interface SqlQuery extends Promise<SqlResultArray> {
	active: boolean;
	cancelled: boolean;
	values(): SqlQuery;
	raw(): SqlQuery;
	simple(): SqlQuery;
	execute(): Promise<SqlResultArray>;
	run(): Promise<SqlResultArray>;
	cancel(): void;
}

/**
 * Shape of a Bun.SQL instance (which is a callable function with methods).
 * This represents both the main `sql` connection and transaction `tx` objects.
 */
export interface SqlInstance {
	(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery;
	unsafe(query: string, params?: unknown[]): SqlQuery;
	file(path: string, params?: unknown[]): SqlQuery;
	begin<T>(fn: (tx: SqlInstance) => Promise<T>): Promise<T>;
	savepoint?<T>(fn: (tx: SqlInstance) => Promise<T>): Promise<T>;
	beginDistributed<T>(id: string, fn: (tx: SqlInstance) => Promise<T>): Promise<T>;
	commitDistributed(id: string): Promise<void>;
	rollbackDistributed(id: string): Promise<void>;
	reserve(): Promise<SqlInstance>;
	close(): Promise<void>;
	end(): Promise<void>;
	connect(): Promise<void>;
	flush(): void;
	options: SqlOptions;
}
