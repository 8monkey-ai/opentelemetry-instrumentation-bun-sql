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
 * Uses indexOf+slice instead of regex for the common (no-comment) path.
 */
export function extractOperationName(sql: string): string | undefined {
  const trimmed = sql.trimStart();
  if (trimmed.length === 0) return undefined;

  // Fast-path: skip comment stripping unless the query starts with one
  let cleaned = trimmed;
  const first = trimmed.charCodeAt(0);
  if (first === 45 /* - */ || first === 47 /* / */) {
    cleaned = trimmed
      .replace(/^--[^\n]*\n\s*/, "")
      .replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  }

  const spaceIdx = cleaned.indexOf(" ");
  let firstWord = spaceIdx === -1 ? cleaned : cleaned.slice(0, spaceIdx);
  if (firstWord.endsWith(";")) firstWord = firstWord.slice(0, -1);
  const op = firstWord.toUpperCase();
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

// Character classification helpers (using char codes for performance)
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isWordStart(c: number): boolean {
  return isAlpha(c) || c === 95; // letter or _
}

function isWordChar(c: number): boolean {
  return isAlpha(c) || isDigit(c) || c === 95;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/**
 * Try to consume a scientific notation suffix (e.g., e+10, E-3).
 * Returns the new index after the exponent, or the original index if none found.
 */
function tryConsumeExponent(sql: string, len: number, j: number): number {
  if (
    j < len &&
    (sql.charCodeAt(j) === 101 || sql.charCodeAt(j) === 69) // e or E
  ) {
    let k = j + 1;
    if (k < len && (sql.charCodeAt(k) === 43 || sql.charCodeAt(k) === 45))
      k++; // + or -
    if (k < len && isDigit(sql.charCodeAt(k))) {
      j = k + 1;
      while (j < len && isDigit(sql.charCodeAt(j))) j++;
    }
  }
  return j;
}

/**
 * Sanitize a non-parameterized query by replacing literal values with `?`.
 * Uses a single-pass character scanner — no regex.
 *
 * Replaces:
 * - Single-quoted strings: 'hello' → ?
 * - Numeric literals: 42, 3.14, .5, 1e10, 0xFF → ?
 * - Boolean literals: TRUE, FALSE → ?
 * - NULL → ?
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
    if (isWordStart(ch)) {
      const start = i;
      i++;
      while (i < len && isWordChar(sql.charCodeAt(i))) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE" || upper === "NULL") {
        result += "?";
      } else {
        result += word;
      }
      continue;
    }

    // Numeric literals
    if (isDigit(ch)) {
      // Hex: 0xFF
      if (
        ch === 48 &&
        i + 1 < len &&
        (sql.charCodeAt(i + 1) === 120 || sql.charCodeAt(i + 1) === 88) // x or X
      ) {
        let j = i + 2;
        while (j < len && isHexDigit(sql.charCodeAt(j))) j++;
        result += "?";
        i = j;
        continue;
      }
      // Integer/decimal with optional exponent
      let j = i;
      while (j < len && isDigit(sql.charCodeAt(j))) j++;
      if (j < len && sql.charCodeAt(j) === 46) {
        // decimal point
        j++;
        while (j < len && isDigit(sql.charCodeAt(j))) j++;
      }
      i = tryConsumeExponent(sql, len, j);
      result += "?";
      continue;
    }

    // Bare decimal: .5, .123e4
    if (
      ch === 46 && // .
      i + 1 < len &&
      isDigit(sql.charCodeAt(i + 1)) &&
      (i === 0 || !isWordChar(sql.charCodeAt(i - 1)))
    ) {
      let j = i + 1;
      while (j < len && isDigit(sql.charCodeAt(j))) j++;
      i = tryConsumeExponent(sql, len, j);
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
