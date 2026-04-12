/**
 * Extract the SQL operation name (SELECT, INSERT, etc.) from a query string.
 * Returns the first word uppercased, matching the approach used by pg and mysql2 adapters.
 */
export function extractOperationName(sql: string): string | undefined {
  const trimmed = sql.trimStart();
  if (trimmed.length === 0) return undefined;

  const spaceIdx = trimmed.indexOf(" ");
  let firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  if (firstWord.endsWith(";")) firstWord = firstWord.slice(0, -1);
  if (firstWord.length === 0) return undefined;
  return firstWord.toUpperCase();
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
 * Matches the scope of mysql2's default masking (integers and single-quoted strings).
 *
 * Replaces:
 * - Single-quoted strings: 'hello' → ?
 * - Integer literals: 42 → ?
 *
 * Does NOT replace:
 * - Double-quoted identifiers ("table_name") — these are identifiers in PostgreSQL/SQLite
 * - Keywords
 * - Operators
 */
export function sanitizeQuery(sql: string): string {
  return sql.replaceAll(/\b\d+\b/g, "?").replaceAll(/'(?:\\.|''|[^'])*'/g, "?");
}

/**
 * Build span name per OTel DB semantic conventions:
 * 1. {db.operation.name} {db.namespace} if both available
 * 2. {db.operation.name} if no namespace
 * 3. {db.namespace} alone
 * 4. {db.system.name} as fallback
 */
export function buildSpanName(opts: {
  operationName?: string;
  namespace?: string;
  systemName: string;
}): string {
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
export function getDbNamespace(options: Record<string, unknown>): string | undefined {
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
export function getServerAddress(options: Record<string, unknown>): string | undefined {
  if (typeof options["hostname"] === "string") return options["hostname"];
  if (typeof options["host"] === "string") return options["host"];
  return undefined;
}

/**
 * Extract server port from SQL instance options.
 */
export function getServerPort(options: Record<string, unknown>): number | undefined {
  if (typeof options["port"] === "number") return options["port"];
  return undefined;
}
