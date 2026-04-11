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

// Character classification helpers (using char codes for performance)
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isWordChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 // _
  );
}

/**
 * Sanitize a non-parameterized query by replacing literal values with `?`.
 * Uses a single-pass character scanner — no regex.
 * Matches the scope of mysql2's default masking (integers and quoted strings).
 *
 * Replaces:
 * - Single-quoted strings: 'hello' → ?
 * - Integer literals: 42 → ?
 *
 * Does NOT replace:
 * - Identifiers (column/table names)
 * - Keywords
 * - Operators
 */
export function sanitizeQuery(sql: string): string {
  const len = sql.length;
  let result = "";
  let i = 0;

  while (i < len) {
    const ch = sql.charCodeAt(i);

    // Single-quoted string: 'value' → ?
    if (ch === 39) {
      // '
      i++;
      while (i < len) {
        const c = sql.charCodeAt(i);
        if (c === 92) {
          // backslash escape
          i += 2;
        } else if (c === 39) {
          // closing '
          i++;
          break;
        } else {
          i++;
        }
      }
      result += "?";
      continue;
    }

    // Identifiers and keywords (start with letter or _)
    if (isWordChar(ch) && !isDigit(ch)) {
      const start = i;
      i++;
      while (i < len && isWordChar(sql.charCodeAt(i))) i++;
      result += sql.slice(start, i);
      continue;
    }

    // Integer literals → ?
    if (isDigit(ch)) {
      i++;
      while (i < len && isDigit(sql.charCodeAt(i))) i++;
      result += "?";
      continue;
    }

    // Default: pass through
    result += sql[i];
    i++;
  }

  return result;
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
