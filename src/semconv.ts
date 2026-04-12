/**
 * Semantic convention attribute names not yet in @opentelemetry/semantic-conventions.
 */

/** Individual query parameter values (opt-in). Use as `db.query.parameter.<key>`. */
export const ATTR_DB_QUERY_PARAMETER_PREFIX = "db.query.parameter";

/** Number of rows returned by the query response. */
export const ATTR_DB_RESPONSE_RETURNED_ROWS = "db.response.returned_rows";

/** The database system name for SQLite (not yet a named constant in semconv). */
export const DB_SYSTEM_NAME_VALUE_SQLITE = "sqlite";
