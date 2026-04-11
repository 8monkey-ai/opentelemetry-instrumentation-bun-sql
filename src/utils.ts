import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM_NAME,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  DB_SYSTEM_NAME_VALUE_MYSQL,
  DB_SYSTEM_NAME_VALUE_POSTGRESQL,
} from "@opentelemetry/semantic-conventions";
import { DB_SYSTEM_NAME_VALUE_SQLITE } from "./semconv.js";

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
  "PREPARE",
  "EXECUTE",
  "EXPLAIN",
  "SET",
  "SHOW",
  "GRANT",
  "REVOKE",
  "WITH",
  "MERGE",
  "REPLACE",
  "UPSERT",
  "PRAGMA",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
]);

export function getDbSystemName(
  adapter: string,
): "postgresql" | "mysql" | "sqlite" {
  switch (adapter) {
    case "postgres":
    case "postgresql":
      return DB_SYSTEM_NAME_VALUE_POSTGRESQL;
    case "mysql":
    case "mariadb":
      return DB_SYSTEM_NAME_VALUE_MYSQL;
    case "sqlite":
      return DB_SYSTEM_NAME_VALUE_SQLITE;
    default:
      return DB_SYSTEM_NAME_VALUE_POSTGRESQL;
  }
}

export function extractOperationName(query: string): string | undefined {
  const trimmed = query.trimStart();
  const indexOfFirstSpace = trimmed.indexOf(" ");
  const firstWord =
    indexOfFirstSpace === -1 ? trimmed : trimmed.slice(0, indexOfFirstSpace);
  const upper = firstWord.toUpperCase();
  if (SQL_OPERATIONS.has(upper)) {
    return upper;
  }
  return undefined;
}

export function extractTableName(query: string): string | undefined {
  const normalized = query.trimStart().replaceAll(/\s+/g, " ");
  const upper = normalized.toUpperCase();

  // SELECT ... FROM <table>
  const fromIndex = upper.indexOf(" FROM ");
  if (fromIndex !== -1) {
    return extractIdentifier(normalized, fromIndex + 6);
  }

  // INSERT INTO <table>
  const intoIndex = upper.indexOf("INSERT INTO ");
  if (intoIndex !== -1) {
    return extractIdentifier(normalized, intoIndex + 12);
  }

  // UPDATE <table>
  const updateIndex = upper.indexOf("UPDATE ");
  if (updateIndex !== -1) {
    return extractIdentifier(normalized, updateIndex + 7);
  }

  // DELETE FROM <table>
  const deleteFromIndex = upper.indexOf("DELETE FROM ");
  if (deleteFromIndex !== -1) {
    return extractIdentifier(normalized, deleteFromIndex + 12);
  }

  return undefined;
}

function extractIdentifier(query: string, startIndex: number): string {
  const rest = query.slice(startIndex).trimStart();
  const match = /^[^\s(,;]+/.exec(rest);
  if (match !== null) {
    return match[0];
  }
  return rest;
}

export function buildQuerySummary(
  operation: string | undefined,
  tableName: string | undefined,
): string | undefined {
  if (operation === undefined && tableName === undefined) {
    return undefined;
  }
  const summary = [operation, tableName].filter(Boolean).join(" ");
  if (summary.length > MAX_QUERY_SUMMARY_LENGTH) {
    return summary.slice(0, MAX_QUERY_SUMMARY_LENGTH);
  }
  return summary;
}

/**
 * Build the span name following the OTel DB semantic conventions priority:
 * 1. {db.query.summary} if available
 * 2. {db.operation.name} {db.namespace}
 * 3. {db.namespace} alone
 * 4. {db.system.name} as fallback
 */
export function buildSpanName(
  operation: string | undefined,
  tableName: string | undefined,
  namespace: string | undefined,
  dbSystemName: string,
): string {
  const summary = buildQuerySummary(operation, tableName);
  if (summary !== undefined) {
    return summary;
  }
  if (operation !== undefined && namespace !== undefined) {
    return `${operation} ${namespace}`;
  }
  if (namespace !== undefined) {
    return namespace;
  }
  return dbSystemName;
}

/**
 * Default sanitization: replace string literals, numeric literals, and placeholder values
 * with '?' placeholder, following the OTel semconv recommendation.
 */
export function defaultSanitizeQuery(query: string): string {
  return (
    query
      // Replace string literals (single-quoted, handling escaped quotes)
      .replaceAll(/'(?:[^'\\]|\\.)*'/g, "?")
      // Replace numeric literals (integers and decimals, not part of identifiers)
      .replaceAll(/\b\d+(?:\.\d+)?\b/g, "?")
      // Collapse IN(...) lists to single placeholder
      .replaceAll(/IN\s*\(\s*(?:\?\s*,\s*)*\?\s*\)/gi, "IN (?)")
  );
}

export interface ConnectionInfo {
  adapter: string;
  hostname?: string;
  port?: number;
  database?: string;
  filename?: string;
}

export function getConnectionAttributes(
  connectionInfo: ConnectionInfo,
): Attributes {
  const dbSystemName = getDbSystemName(connectionInfo.adapter);
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM_NAME]: dbSystemName,
  };

  if (dbSystemName === "sqlite") {
    if (
      connectionInfo.filename !== undefined &&
      connectionInfo.filename !== ":memory:"
    ) {
      attrs[ATTR_DB_NAMESPACE] = connectionInfo.filename;
    }
  } else {
    if (connectionInfo.database !== undefined) {
      attrs[ATTR_DB_NAMESPACE] = connectionInfo.database;
    }
    if (connectionInfo.hostname !== undefined) {
      attrs[ATTR_SERVER_ADDRESS] = connectionInfo.hostname;
    }
    if (connectionInfo.port !== undefined) {
      attrs[ATTR_SERVER_PORT] = connectionInfo.port;
    }
  }

  return attrs;
}

export function getQueryAttributes(
  query: string,
  operation: string | undefined,
  tableName: string | undefined,
  includeQueryText: boolean,
): Attributes {
  const attrs: Attributes = {};

  if (operation !== undefined) {
    attrs[ATTR_DB_OPERATION_NAME] = operation;
  }

  const summary = buildQuerySummary(operation, tableName);
  if (summary !== undefined) {
    attrs[ATTR_DB_QUERY_SUMMARY] = summary;
  }

  if (includeQueryText) {
    attrs[ATTR_DB_QUERY_TEXT] = query;
  }

  return attrs;
}

export function getErrorAttributes(error: unknown): Attributes {
  const attrs: Attributes = {};
  if (error instanceof Error) {
    attrs[ATTR_ERROR_TYPE] = error.constructor.name;
    if ("code" in error && typeof error.code === "string") {
      attrs["db.response.status_code"] = error.code;
    }
  }
  return attrs;
}

/**
 * Build parameterized query text from tagged template literals.
 * Converts template strings into a parameterized query like:
 * "SELECT * FROM users WHERE id = $1 AND name = $2"
 */
export function buildParameterizedQuery(
  strings: TemplateStringsArray,
): string {
  let query = "";
  for (let i = 0; i < strings.length; i++) {
    query += strings[i];
    if (i < strings.length - 1) {
      query += `$${String(i + 1)}`;
    }
  }
  return query;
}
