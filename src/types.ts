import type { Span } from "@opentelemetry/api";

export type DbSystemName = "postgresql" | "mysql" | "sqlite";

export interface QueryInfo {
	query: string;
	operation?: string;
	params?: unknown[];
}

export interface ResponseInfo {
	rowCount: number;
	command?: string;
	data?: unknown;
}

export interface BunSqlInstrumentationConfig {
	/** Enable/disable instrumentation. Default: true */
	enabled?: boolean;

	/**
	 * Attach query parameters and result details to spans.
	 * Parameters are added as `db.query.parameter.<key>` attributes.
	 * Default: false (Opt-In per OTel semconv)
	 */
	enhancedDatabaseReporting?: boolean;

	/**
	 * Only create spans when a parent span exists in the current context.
	 * Useful for reducing noise in high-throughput applications.
	 * Default: false
	 */
	requireParentSpan?: boolean;

	/**
	 * Suppress spans for connection management operations (reserve/release/close).
	 * Default: false
	 */
	ignoreConnectionSpans?: boolean;

	/**
	 * Append SQL commenter traceparent comment to queries.
	 * SHOULD NOT be enabled by default per OTel semconv.
	 * Default: false
	 */
	addSqlCommenterComment?: boolean;

	/**
	 * Sanitize non-parameterized queries (e.g. sql.unsafe()) by replacing
	 * literal values with '?' placeholders. Parameterized queries (tagged
	 * templates) are already safe and captured as-is.
	 * Default: true (per OTel semconv recommendation)
	 */
	sanitizeNonParameterizedQueries?: boolean;

	/** Custom sanitization function for non-parameterized queries. */
	sanitizationHook?: (query: string) => string;

	/** Hook called before query execution to customize span attributes. */
	requestHook?: (span: Span, info: QueryInfo) => void;

	/** Hook called after query execution to customize span attributes from response. */
	responseHook?: (span: Span, info: ResponseInfo) => void;
}
