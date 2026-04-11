import type { InstrumentationConfig } from "@opentelemetry/instrumentation";
import type { Span } from "@opentelemetry/api";

export interface BunSqlRequestHookInformation {
  /** The SQL query text (parameterized for tagged templates, raw for unsafe). */
  query: string;
  /** The SQL operation name (SELECT, INSERT, etc.). */
  operation?: string;
  /** Query parameter values (only present for tagged template queries). */
  params?: unknown[];
}

export interface BunSqlResponseHookInformation {
  /** Number of rows returned. */
  rowCount?: number;
  /** The command type (SELECT, INSERT, etc.). */
  command?: string;
  /** Raw query result data. */
  data?: unknown;
}

export type BunSqlInstrumentationExecutionRequestHook = (
  span: Span,
  info: BunSqlRequestHookInformation,
) => void;

export type BunSqlInstrumentationExecutionResponseHook = (
  span: Span,
  info: BunSqlResponseHookInformation,
) => void;

export interface BunSqlInstrumentationConfig extends InstrumentationConfig {
  /**
   * Attach query parameters and result data to spans.
   * Parameters are Opt-In per OTel DB semconv.
   * @default false
   */
  enhancedDatabaseReporting?: boolean;

  /**
   * Only create spans when a parent span exists in the current context.
   * Useful for reducing noise in high-throughput systems.
   * @default false
   */
  requireParentSpan?: boolean;

  /**
   * Suppress connection-level spans (reserve/release/close).
   * @default false
   */
  ignoreConnectionSpans?: boolean;

  /**
   * Mask non-parameterized queries (sql.unsafe(), sql.file()) by
   * replacing literal values with `?` placeholders.
   * Per OTel semconv, non-parameterized queries SHOULD be masked by default.
   * @default true
   */
  maskStatement?: boolean;

  /**
   * Custom masking function for non-parameterized queries.
   * Only used when `maskStatement` is true.
   * @default Replaces string/numeric/boolean literals with `?`
   */
  maskStatementHook?: (query: string) => string;

  /**
   * Add SQL commenter traceparent comments to queries.
   * Per OTel semconv, SHOULD NOT be enabled by default.
   * @default false
   */
  addSqlCommenterComment?: boolean;

  /**
   * Hook called before query execution to customize span attributes.
   */
  requestHook?: BunSqlInstrumentationExecutionRequestHook;

  /**
   * Hook called after query execution to customize span attributes from response.
   */
  responseHook?: BunSqlInstrumentationExecutionResponseHook;
}
