const MAX_QUERY_SUMMARY_LENGTH = 255;

const SQL_OPERATIONS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "SET",
  "SHOW",
  "EXPLAIN",
  "ANALYZE",
  "GRANT",
  "REVOKE",
  "MERGE",
  "CALL",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "VACUUM",
  "REINDEX",
  "PRAGMA",
]);

/**
 * Extract the SQL operation name (SELECT, INSERT, etc.) from a query string.
 */
export function extractOperationName(sql: string): string | undefined {
  const trimmed = sql.trimStart();
  // Skip leading comments (-- line comments and /* block comments */)
  const withoutComments = trimmed
    .replaceAll(/^--[^\n]*\n\s*/g, "")
    .replaceAll(/^\/\*[\s\S]*?\*\/\s*/g, "");

  const match = withoutComments.match(/^(\w+)/);
  if (match?.[1] === undefined) return undefined;

  const op = match[1].toUpperCase();
  return SQL_OPERATIONS.has(op) ? op : undefined;
}

/**
 * Build parameterized query text from tagged template strings.
 * Replaces interpolated values with $1, $2, ... placeholders.
 */
export function buildParameterizedQuery(strings: TemplateStringsArray): string {
  let query = "";
  for (let i = 0; i < strings.length; i++) {
    query += strings[i];
    if (i < strings.length - 1) {
      query += `$${i + 1}`;
    }
  }
  return query;
}

/**
 * Sanitize a non-parameterized query by replacing literal values with `?`.
 *
 * Replaces:
 * - Single-quoted strings: 'hello' → ?
 * - Double-quoted strings (MySQL): "hello" → ?  (not identifiers in PostgreSQL context)
 * - Numeric literals: 42, 3.14, -1, .5 → ?
 * - Boolean literals: TRUE, FALSE → ?
 * - NULL → ?
 * - Hex literals: 0x1A → ?
 *
 * Does NOT replace:
 * - Identifiers (column/table names)
 * - Keywords
 * - Operators
 */
export function sanitizeQuery(sql: string): string {
  return (
    sql
      // Single-quoted strings (handles escaped quotes)
      .replaceAll(/'(?:[^'\\]|\\.)*'/g, "?")
      // Numeric literals (integers, decimals, hex, scientific notation)
      .replaceAll(/\b0x[\da-fA-F]+\b/g, "?")
      .replaceAll(/\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b/g, "?")
      .replaceAll(/\B\.\d+(?:[eE][+-]?\d+)?\b/g, "?")
      // Boolean and NULL literals
      .replaceAll(/\b(?:TRUE|FALSE|NULL)\b/gi, "?")
  );
}

/**
 * Extract a table/namespace hint from a query for the span name.
 * Returns the first table name found after FROM, INTO, UPDATE, or TABLE keywords.
 */
export function extractTableName(sql: string): string | undefined {
  const match = sql.match(
    /\b(?:FROM|INTO|UPDATE|TABLE)\s+(?:`|"|')?(\w+)(?:`|"|')?/i,
  );
  return match?.[1];
}

/**
 * Build a query summary for the `db.query.summary` attribute.
 * Format: `{operation} {table}` truncated to 255 chars.
 */
export function buildQuerySummary(
  operationName: string | undefined,
  queryText: string,
): string | undefined {
  const table = extractTableName(queryText);
  if (operationName === undefined) {
    return undefined;
  }

  const summary =
    table === undefined ? operationName : `${operationName} ${table}`;

  if (summary.length > MAX_QUERY_SUMMARY_LENGTH) {
    return summary.slice(0, MAX_QUERY_SUMMARY_LENGTH);
  }
  return summary;
}

/**
 * Build span name per OTel DB semantic conventions:
 * 1. {db.query.summary} if available
 * 2. {db.operation.name} {db.namespace} if both available
 * 3. {db.operation.name} if no namespace
 * 4. {db.namespace} alone
 * 5. {db.system.name} as fallback
 */
export function buildSpanName(opts: {
  querySummary?: string;
  operationName?: string;
  namespace?: string;
  systemName: string;
}): string {
  if (opts.querySummary !== undefined) return opts.querySummary;
  if (opts.operationName !== undefined && opts.namespace !== undefined)
    return `${opts.operationName} ${opts.namespace}`;
  if (opts.operationName !== undefined) return opts.operationName;
  if (opts.namespace !== undefined) return opts.namespace;
  return opts.systemName;
}

/**
 * Map Bun.SQL adapter name to the OTel `db.system.name` value.
 */
export function getDbSystemName(adapter: string | undefined): string {
  switch (adapter) {
    case "postgres":
    case "postgresql":
      return "postgresql";
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case undefined:
      return "unknown";
    default:
      return adapter;
  }
}

/**
 * Extract database namespace (database name) from SQL instance options.
 */
export function getDbNamespace(
  options: Record<string, unknown>,
): string | undefined {
  if (typeof options["database"] === "string") return options["database"];
  if (typeof options["filename"] === "string") {
    const filename = options["filename"];
    return filename === ":memory:" ? ":memory:" : filename;
  }
  return undefined;
}

/**
 * Extract server address from SQL instance options.
 */
export function getServerAddress(
  options: Record<string, unknown>,
): string | undefined {
  if (typeof options["hostname"] === "string") return options["hostname"];
  if (typeof options["host"] === "string") return options["host"];
  return undefined;
}

/**
 * Extract server port from SQL instance options.
 */
export function getServerPort(
  options: Record<string, unknown>,
): number | undefined {
  if (typeof options["port"] === "number") return options["port"];
  return undefined;
}
