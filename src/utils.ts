import {
	DB_SYSTEM_MYSQL,
	DB_SYSTEM_POSTGRESQL,
	DB_SYSTEM_SQLITE,
	SPAN_NAME_MAX_LENGTH,
} from "./semconv.js";

import type { DbSystemName } from "./types.js";
import type { SqlOptions } from "./internal-types.js";

// Match SQL operations at the start of a query (case-insensitive)
const SQL_OPERATION_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|EXPLAIN|SET|SHOW|GRANT|REVOKE|CALL|EXECUTE|PREPARE|DEALLOCATE|WITH)\b/i;

// Match the target table/namespace from common DML statements
const SQL_TABLE_RE =
	/^\s*(?:SELECT\s+.*?\s+FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|CREATE\s+(?:TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE)(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE)(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:ONLY\s+)?["'`]?(\w+)["'`]?/i;

// Match string literals (single-quoted), numeric literals, and boolean literals
const LITERAL_RE = /('[^']*'|\b\d+(?:\.\d+)?\b|\b(?:TRUE|FALSE|NULL)\b)/gi;

/**
 * Extract the SQL operation name (SELECT, INSERT, etc.) from a query string.
 */
export function extractOperationName(query: string): string | undefined {
	const match = SQL_OPERATION_RE.exec(query);
	return match?.[1]?.toUpperCase();
}

/**
 * Extract the target table name from a query string.
 */
export function extractTableName(query: string): string | undefined {
	const match = SQL_TABLE_RE.exec(query);
	return match?.[1];
}

/**
 * Build a span name following the OTel DB semantic conventions priority:
 * 1. {db.query.summary} if available
 * 2. {db.operation.name} {db.namespace}
 * 3. {db.namespace} alone
 * 4. {db.system.name} as fallback
 */
export function buildSpanName(
	dbSystem: DbSystemName,
	operation?: string,
	table?: string,
	namespace?: string,
): string {
	// Priority 1: query summary (operation + table)
	if (operation !== undefined && operation !== "" && table !== undefined && table !== "") {
		return truncate(`${operation} ${table}`, SPAN_NAME_MAX_LENGTH);
	}

	// Priority 2: operation + namespace
	if (operation !== undefined && operation !== "" && namespace !== undefined && namespace !== "") {
		return truncate(`${operation} ${namespace}`, SPAN_NAME_MAX_LENGTH);
	}

	// Priority 3: namespace alone
	if (namespace !== undefined && namespace !== "") {
		return truncate(namespace, SPAN_NAME_MAX_LENGTH);
	}

	// Priority 4: db.system.name fallback
	return dbSystem;
}

/**
 * Sanitize a non-parameterized query by replacing literal values with '?'.
 * IN-clauses are collapsed to a single placeholder for lower cardinality.
 */
export function sanitizeQuery(query: string): string {
	return query.replace(LITERAL_RE, "?");
}

/**
 * Build a parameterized query string from tagged template parts.
 * E.g., ["SELECT * FROM users WHERE id = ", " AND active = ", ""]
 * becomes "SELECT * FROM users WHERE id = $1 AND active = $2"
 */
export function buildParameterizedQuery(strings: readonly string[], valueCount: number): string {
	let result = "";
	for (let i = 0; i < strings.length; i++) {
		result += strings[i];
		if (i < valueCount) {
			result += `$${String(i + 1)}`;
		}
	}
	return result;
}

/**
 * Generate a query summary from a query string.
 * This is a simplified version that extracts the operation and table name.
 */
export function buildQuerySummary(query: string): string | undefined {
	const operation = extractOperationName(query);
	const table = extractTableName(query);

	if (operation !== undefined && table !== undefined) {
		return truncate(`${operation} ${table}`, SPAN_NAME_MAX_LENGTH);
	}

	if (operation !== undefined) {
		return operation;
	}

	return undefined;
}

/**
 * Detect the database system from SQL options.
 */
export function detectDbSystem(options: SqlOptions): DbSystemName {
	const adapter = options.adapter?.toLowerCase();

	if (adapter === "postgres" || adapter === "postgresql") {
		return DB_SYSTEM_POSTGRESQL;
	}
	if (adapter === "mysql") {
		return DB_SYSTEM_MYSQL;
	}
	if (adapter === "sqlite") {
		return DB_SYSTEM_SQLITE;
	}

	// Try to detect from URL
	const url = options.url;
	if (url !== undefined && url !== "") {
		if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
			return DB_SYSTEM_POSTGRESQL;
		}
		if (url.startsWith("mysql://")) {
			return DB_SYSTEM_MYSQL;
		}
		if (url.startsWith("sqlite://") || url.startsWith("file:")) {
			return DB_SYSTEM_SQLITE;
		}
	}

	// Default fallback
	return DB_SYSTEM_POSTGRESQL;
}

/**
 * Extract the database namespace (database name) from SQL options.
 */
export function extractNamespace(options: SqlOptions): string | undefined {
	return options.database ?? options.filename;
}

/**
 * Extract server address from SQL options.
 */
export function extractServerAddress(options: SqlOptions): string | undefined {
	return options.hostname ?? options.host;
}

/** Default port for each database system. */
const DEFAULT_PORTS: Record<DbSystemName, number> = {
	postgresql: 5432,
	mysql: 3306,
	sqlite: 0,
};

/**
 * Extract server port from SQL options, only if it differs from the default.
 */
export function extractServerPort(
	options: SqlOptions,
	dbSystem: DbSystemName,
): number | undefined {
	const port = options.port;
	if (port !== undefined && port !== DEFAULT_PORTS[dbSystem]) {
		return port;
	}
	return undefined;
}

/**
 * Build a SQL commenter comment string with traceparent.
 */
export function buildSqlComment(traceparent: string): string {
	return `/*traceparent='${traceparent}'*/`;
}

/**
 * Format a W3C traceparent string from span context.
 */
export function formatTraceparent(traceId: string, spanId: string, traceFlags: number): string {
	const flags = traceFlags.toString(16).padStart(2, "0");
	return `00-${traceId}-${spanId}-${flags}`;
}

function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) {
		return str;
	}
	return str.slice(0, maxLength);
}
