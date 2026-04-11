import type { Span } from "@opentelemetry/api";
import type { InstrumentationConfig } from "@opentelemetry/instrumentation";

export interface QueryInfo {
  query: string;
  operation?: string;
  params?: unknown[];
}

export interface ResponseInfo {
  rowCount: number;
  data?: unknown;
}

export type RequestHook = (span: Span, info: QueryInfo) => void;
export type ResponseHook = (span: Span, info: ResponseInfo) => void;
export type SanitizationHook = (query: string) => string;

export interface BunSqlInstrumentationConfig extends InstrumentationConfig {
  /** Attach query parameters and result data to spans. Default: false */
  enhancedDatabaseReporting?: boolean;
  /** Only create spans when a parent span exists. Default: false */
  requireParentSpan?: boolean;
  /** Suppress connection-level spans (reserve/release/close). Default: false */
  ignoreConnectionSpans?: boolean;
  /** Add SQL commenter traceparent comments to queries. Default: false */
  addSqlCommenterComment?: boolean;
  /** Sanitize non-parameterized queries (sql.unsafe, sql.file) by default. Default: true */
  sanitizeNonParameterizedQueries?: boolean;
  /** Custom sanitization function for query text. Default: replace literals with ? */
  sanitizationHook?: SanitizationHook;
  /** Customize span attributes before query execution */
  requestHook?: RequestHook;
  /** Customize span attributes from query response */
  responseHook?: ResponseHook;
}
