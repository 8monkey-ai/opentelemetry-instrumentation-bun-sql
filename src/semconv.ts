// Stable OTel Database Semantic Conventions
// https://opentelemetry.io/docs/specs/semconv/database/database-spans/

// Database attributes
export const ATTR_DB_SYSTEM_NAME = "db.system.name";
export const ATTR_DB_NAMESPACE = "db.namespace";
export const ATTR_DB_OPERATION_NAME = "db.operation.name";
export const ATTR_DB_QUERY_TEXT = "db.query.text";
export const ATTR_DB_QUERY_SUMMARY = "db.query.summary";
export const ATTR_DB_RESPONSE_STATUS_CODE = "db.response.status_code";
export const ATTR_DB_RESPONSE_RETURNED_ROWS = "db.response.returned_rows";
export const ATTR_DB_QUERY_PARAMETER_PREFIX = "db.query.parameter";

// Server attributes
export const ATTR_SERVER_ADDRESS = "server.address";
export const ATTR_SERVER_PORT = "server.port";

// Network attributes
export const ATTR_NETWORK_PEER_ADDRESS = "network.peer.address";
export const ATTR_NETWORK_PEER_PORT = "network.peer.port";

// Error attributes
export const ATTR_ERROR_TYPE = "error.type";

// DB system name values
export const DB_SYSTEM_POSTGRESQL = "postgresql";
export const DB_SYSTEM_MYSQL = "mysql";
export const DB_SYSTEM_SQLITE = "sqlite";

// Instrumentation identity
export const INSTRUMENTATION_NAME = "@8monkey/opentelemetry-instrumentation-bun-sql";

// Span name max length per semconv spec
export const SPAN_NAME_MAX_LENGTH = 255;
