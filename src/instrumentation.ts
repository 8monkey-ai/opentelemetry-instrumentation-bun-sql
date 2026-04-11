import {
	type Attributes,
	type Context,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	context,
	trace,
} from "@opentelemetry/api";

import type { SqlInstance, SqlOptions, SqlResultArray } from "./internal-types.js";
import {
	ATTR_DB_NAMESPACE,
	ATTR_DB_OPERATION_NAME,
	ATTR_DB_QUERY_PARAMETER_PREFIX,
	ATTR_DB_QUERY_SUMMARY,
	ATTR_DB_QUERY_TEXT,
	ATTR_DB_RESPONSE_RETURNED_ROWS,
	ATTR_DB_RESPONSE_STATUS_CODE,
	ATTR_DB_SYSTEM_NAME,
	ATTR_ERROR_TYPE,
	ATTR_NETWORK_PEER_ADDRESS,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	INSTRUMENTATION_NAME,
} from "./semconv.js";
import type { BunSqlInstrumentationConfig, DbSystemName, QueryInfo, ResponseInfo } from "./types.js";
import {
	buildParameterizedQuery,
	buildQuerySummary,
	buildSpanName,
	buildSqlComment,
	detectDbSystem,
	extractNamespace,
	extractOperationName,
	extractServerAddress,
	extractServerPort,
	extractTableName,
	formatTraceparent,
	sanitizeQuery,
} from "./utils.js";

const DEFAULT_CONFIG: Required<
	Pick<
		BunSqlInstrumentationConfig,
		| "enabled"
		| "enhancedDatabaseReporting"
		| "requireParentSpan"
		| "ignoreConnectionSpans"
		| "addSqlCommenterComment"
		| "sanitizeNonParameterizedQueries"
	>
> = {
	enabled: true,
	enhancedDatabaseReporting: false,
	requireParentSpan: false,
	ignoreConnectionSpans: false,
	addSqlCommenterComment: false,
	sanitizeNonParameterizedQueries: true,
};

// Symbol to mark an instance as already instrumented
const INSTRUMENTED = Symbol.for("bun-sql-instrumented");

// Symbol to access the underlying raw SQL instance from a proxy
const RAW_SQL = Symbol.for("bun-sql-raw");

type ThenCallback = ((value: unknown) => unknown) | null | undefined;

export class BunSqlInstrumentation {
	private _config: BunSqlInstrumentationConfig;
	private _version: string;

	constructor(config?: BunSqlInstrumentationConfig) {
		this._config = { ...DEFAULT_CONFIG, ...config };
		this._version = "0.1.0";
	}

	get config(): BunSqlInstrumentationConfig {
		return this._config;
	}

	setConfig(config: BunSqlInstrumentationConfig): void {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	private get _tracer(): Tracer {
		return trace.getTracer(INSTRUMENTATION_NAME, this._version);
	}

	/**
	 * Instrument a Bun.SQL instance. Returns a Proxy that intercepts
	 * all query methods and tagged template calls to create OTel spans.
	 *
	 * Usage:
	 * ```typescript
	 * import { SQL } from "bun";
	 * import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";
	 *
	 * const instrumentation = new BunSqlInstrumentation();
	 * const sql = instrumentation.instrument(new SQL("sqlite://:memory:"));
	 * ```
	 */
	instrument(sql: SqlInstance): SqlInstance {
		// Avoid double-instrumentation
		if ((sql as unknown as Record<symbol, unknown>)[INSTRUMENTED]) {
			return sql;
		}

		const options = sql.options as SqlOptions;
		const dbSystem = detectDbSystem(options);
		const connAttrs = this._buildConnectionAttributes(options, dbSystem);

		const proxy = new Proxy(sql, {
			apply: (_target, _thisArg, args: unknown[]) => {
				return this._instrumentTaggedTemplate(sql, args, dbSystem, connAttrs);
			},
			get: (target, prop, receiver) => {
				if (prop === INSTRUMENTED) return true;
				if (prop === RAW_SQL) return target;

				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;

				switch (prop) {
					case "unsafe":
						return this._wrapUnsafe(sql, value, dbSystem, connAttrs);
					case "file":
						return this._wrapFile(sql, value, dbSystem, connAttrs);
					case "begin":
						return this._wrapBegin(sql, value, dbSystem, connAttrs);
					case "beginDistributed":
						return this._wrapBeginDistributed(sql, value, dbSystem, connAttrs);
					case "commitDistributed":
						return this._wrapCommitDistributed(sql, value, dbSystem, connAttrs);
					case "rollbackDistributed":
						return this._wrapRollbackDistributed(sql, value, dbSystem, connAttrs);
					case "reserve":
						return this._wrapReserve(sql, value, dbSystem, connAttrs);
					case "close":
					case "end":
						return this._wrapClose(sql, value, dbSystem, connAttrs);
					default:
						return value.bind(target);
				}
			},
		}) as SqlInstance;

		return proxy;
	}

	private _instrumentTaggedTemplate(
		sql: SqlInstance,
		args: unknown[],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): unknown {
		if (!this._shouldCreateSpan()) {
			return Reflect.apply(sql, sql, args);
		}

		const strings = args[0] as TemplateStringsArray;
		const values = args.slice(1);

		const queryText = buildParameterizedQuery(strings, values.length);
		const operation = extractOperationName(queryText);
		const table = extractTableName(queryText);
		const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
		const spanName = buildSpanName(dbSystem, operation, table, namespace);

		const attributes: Attributes = {
			...connAttrs,
			[ATTR_DB_QUERY_TEXT]: queryText,
		};

		if (operation) {
			attributes[ATTR_DB_OPERATION_NAME] = operation;
		}

		const summary = buildQuerySummary(queryText);
		if (summary) {
			attributes[ATTR_DB_QUERY_SUMMARY] = summary;
		}

		if (this._config.enhancedDatabaseReporting) {
			for (let i = 0; i < values.length; i++) {
				attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${String(i)}`] = String(values[i]);
			}
		}

		const span = this._tracer.startSpan(spanName, {
			kind: SpanKind.CLIENT,
			attributes,
		});

		this._callRequestHook(span, queryText, operation, values);

		let callArgs = args;
		if (this._config.addSqlCommenterComment) {
			callArgs = this._appendSqlComment(span, strings, values);
		}

		const ctx = trace.setSpan(context.active(), span);
		const query = context.with(ctx, () => Reflect.apply(sql, sql, callArgs));

		return this._wrapQueryResult(query, span);
	}

	private _wrapUnsafe(
		sql: SqlInstance,
		original: SqlInstance["unsafe"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["unsafe"] {
		return (query: string, params?: unknown[]) => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, query, params);
			}

			const shouldSanitize = this._config.sanitizeNonParameterizedQueries !== false;
			const displayQuery = shouldSanitize
				? (this._config.sanitizationHook?.(query) ?? sanitizeQuery(query))
				: query;

			const operation = extractOperationName(query);
			const table = extractTableName(query);
			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, operation, table, namespace);

			const attributes: Attributes = {
				...connAttrs,
				[ATTR_DB_QUERY_TEXT]: displayQuery,
			};

			if (operation) {
				attributes[ATTR_DB_OPERATION_NAME] = operation;
			}

			const summary = buildQuerySummary(displayQuery);
			if (summary) {
				attributes[ATTR_DB_QUERY_SUMMARY] = summary;
			}

			if (this._config.enhancedDatabaseReporting && params) {
				for (let i = 0; i < params.length; i++) {
					attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${String(i)}`] = String(params[i]);
				}
			}

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes,
			});

			this._callRequestHook(span, displayQuery, operation, params);

			let finalQuery = query;
			if (this._config.addSqlCommenterComment) {
				const spanContext = span.spanContext();
				const traceparent = formatTraceparent(
					spanContext.traceId,
					spanContext.spanId,
					spanContext.traceFlags,
				);
				finalQuery = `${query} ${buildSqlComment(traceparent)}`;
			}

			const ctx = trace.setSpan(context.active(), span);
			const result = context.with(ctx, () => original.call(sql, finalQuery, params));

			return this._wrapQueryResult(result, span);
		};
	}

	private _wrapFile(
		sql: SqlInstance,
		original: SqlInstance["file"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["file"] {
		return (path: string, params?: unknown[]) => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, path, params);
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, undefined, undefined, namespace);

			const attributes: Attributes = {
				...connAttrs,
				[ATTR_DB_QUERY_TEXT]: `FILE: ${path}`,
			};

			if (this._config.enhancedDatabaseReporting && params) {
				for (let i = 0; i < params.length; i++) {
					attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${String(i)}`] = String(params[i]);
				}
			}

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes,
			});

			this._callRequestHook(span, `FILE: ${path}`, undefined, params);

			const ctx = trace.setSpan(context.active(), span);
			const result = context.with(ctx, () => original.call(sql, path, params));

			return this._wrapQueryResult(result, span);
		};
	}

	private _wrapBegin(
		sql: SqlInstance,
		original: SqlInstance["begin"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["begin"] {
		return <T>(fn: (tx: SqlInstance) => Promise<T>): Promise<T> => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, fn) as Promise<T>;
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "BEGIN", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "BEGIN",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				(original.call(sql, (tx: SqlInstance) => {
					const instrumentedTx = this._instrumentTransaction(tx, dbSystem, connAttrs, ctx);
					return fn(instrumentedTx);
				}) as Promise<T>)
					.then((result) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return result;
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _wrapBeginDistributed(
		sql: SqlInstance,
		original: SqlInstance["beginDistributed"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["beginDistributed"] {
		return <T>(id: string, fn: (tx: SqlInstance) => Promise<T>): Promise<T> => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, id, fn) as Promise<T>;
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "BEGIN DISTRIBUTED", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "BEGIN DISTRIBUTED",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				(original.call(sql, id, (tx: SqlInstance) => {
					const instrumentedTx = this._instrumentTransaction(tx, dbSystem, connAttrs, ctx);
					return fn(instrumentedTx);
				}) as Promise<T>)
					.then((result) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return result;
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _wrapCommitDistributed(
		sql: SqlInstance,
		original: SqlInstance["commitDistributed"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["commitDistributed"] {
		return (id: string): Promise<void> => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, id);
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "COMMIT DISTRIBUTED", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "COMMIT DISTRIBUTED",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				original
					.call(sql, id)
					.then((result: void) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return result;
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _wrapRollbackDistributed(
		sql: SqlInstance,
		original: SqlInstance["rollbackDistributed"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["rollbackDistributed"] {
		return (id: string): Promise<void> => {
			if (!this._shouldCreateSpan()) {
				return original.call(sql, id);
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "ROLLBACK DISTRIBUTED", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "ROLLBACK DISTRIBUTED",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				original
					.call(sql, id)
					.then((result: void) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return result;
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _wrapReserve(
		sql: SqlInstance,
		original: SqlInstance["reserve"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["reserve"] {
		return (): Promise<SqlInstance> => {
			if (!this._shouldCreateSpan() || this._config.ignoreConnectionSpans) {
				return original.call(sql).then((reserved: SqlInstance) => this.instrument(reserved));
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "RESERVE", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "RESERVE",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				original
					.call(sql)
					.then((reserved: SqlInstance) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return this.instrument(reserved);
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _wrapClose(
		sql: SqlInstance,
		original: SqlInstance["close"],
		dbSystem: DbSystemName,
		connAttrs: Attributes,
	): SqlInstance["close"] {
		return (): Promise<void> => {
			if (!this._shouldCreateSpan() || this._config.ignoreConnectionSpans) {
				return original.call(sql);
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "CLOSE", undefined, namespace);

			const span = this._tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: {
					...connAttrs,
					[ATTR_DB_OPERATION_NAME]: "CLOSE",
				},
			});

			const ctx = trace.setSpan(context.active(), span);

			return context.with(ctx, () =>
				original
					.call(sql)
					.then(() => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	private _instrumentTransaction(
		tx: SqlInstance,
		dbSystem: DbSystemName,
		connAttrs: Attributes,
		parentCtx: Context,
	): SqlInstance {
		return new Proxy(tx, {
			apply: (_target, _thisArg, args: unknown[]) => {
				return context.with(parentCtx, () =>
					this._instrumentTaggedTemplate(tx, args, dbSystem, connAttrs),
				);
			},
			get: (target, prop, receiver) => {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;

				if (prop === "unsafe") {
					return this._wrapUnsafe(tx, value as SqlInstance["unsafe"], dbSystem, connAttrs);
				}

				if (prop === "savepoint") {
					return this._wrapSavepoint(
						tx,
						value as (...args: unknown[]) => unknown,
						dbSystem,
						connAttrs,
						parentCtx,
					);
				}

				return value.bind(target);
			},
		}) as SqlInstance;
	}

	private _wrapSavepoint(
		tx: SqlInstance,
		original: (...args: unknown[]) => unknown,
		dbSystem: DbSystemName,
		connAttrs: Attributes,
		parentCtx: Context,
	): <T>(fn: (tx: SqlInstance) => Promise<T>) => Promise<T> {
		return <T>(fn: (innerTx: SqlInstance) => Promise<T>): Promise<T> => {
			if (!this._shouldCreateSpan()) {
				return original.call(tx, fn) as Promise<T>;
			}

			const namespace = connAttrs[ATTR_DB_NAMESPACE] as string | undefined;
			const spanName = buildSpanName(dbSystem, "SAVEPOINT", undefined, namespace);

			const span = this._tracer.startSpan(
				spanName,
				{
					kind: SpanKind.CLIENT,
					attributes: {
						...connAttrs,
						[ATTR_DB_OPERATION_NAME]: "SAVEPOINT",
					},
				},
				parentCtx,
			);

			const savepointCtx = trace.setSpan(parentCtx, span);

			return context.with(savepointCtx, () =>
				(original.call(tx, (innerTx: SqlInstance) => {
					const instrumentedInner = this._instrumentTransaction(
						innerTx,
						dbSystem,
						connAttrs,
						savepointCtx,
					);
					return fn(instrumentedInner);
				}) as Promise<T>)
					.then((result) => {
						span.setStatus({ code: SpanStatusCode.OK });
						span.end();
						return result;
					})
					.catch((error: unknown) => {
						this._recordError(span, error);
						span.end();
						throw error;
					}),
			);
		};
	}

	/**
	 * Wrap a query result (Promise-like) to capture span lifecycle.
	 * Intercepts .then() so the span ends when the query is awaited.
	 */
	private _wrapQueryResult<T>(query: T, span: Span): T {
		if (query === null || query === undefined || typeof query !== "object") {
			span.end();
			return query;
		}

		const queryObj = query as Record<string, unknown>;

		const originalThen = queryObj["then"] as ((...args: unknown[]) => unknown) | undefined;
		if (typeof originalThen !== "function") {
			return query;
		}

		const handleSuccess = (result: unknown): void => this._handleQuerySuccess(span, result);
		const handleError = (error: unknown): void => {
			this._recordError(span, error);
			span.end();
		};

		// Override .then() to intercept query resolution
		Object.defineProperty(queryObj, "then", {
			value: (onFulfilled?: ThenCallback, onRejected?: ThenCallback) =>
				originalThen.call(
					queryObj,
					(result: unknown) => {
						handleSuccess(result);
						return onFulfilled ? onFulfilled(result) : result;
					},
					(error: unknown) => {
						handleError(error);
						if (onRejected) return onRejected(error);
						throw error;
					},
				),
			writable: true,
			configurable: true,
		});

		return query;
	}

	private _handleQuerySuccess(span: Span, result: unknown): void {
		if (result !== null && result !== undefined && typeof result === "object") {
			const sqlResult = result as Partial<SqlResultArray>;

			if (this._config.enhancedDatabaseReporting && sqlResult.count !== undefined) {
				span.setAttribute(ATTR_DB_RESPONSE_RETURNED_ROWS, sqlResult.count);
			}

			if (this._config.responseHook) {
				const responseInfo: ResponseInfo = {
					rowCount: sqlResult.count ?? 0,
					command: sqlResult.command,
					data: this._config.enhancedDatabaseReporting ? result : undefined,
				};
				try {
					this._config.responseHook(span, responseInfo);
				} catch {
					// Swallow hook errors to avoid breaking the query
				}
			}
		}

		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
	}

	private _recordError(span: Span, error: unknown): void {
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: error instanceof Error ? error.message : String(error),
		});

		if (error instanceof Error) {
			span.recordException(error);
			span.setAttribute(ATTR_ERROR_TYPE, error.constructor.name);

			// Capture database-specific error attributes
			const dbError = error as unknown as Record<string, unknown>;
			if (dbError["code"] !== undefined) {
				span.setAttribute(ATTR_DB_RESPONSE_STATUS_CODE, String(dbError["code"]));
			}
		}
	}

	private _buildConnectionAttributes(
		options: SqlOptions,
		dbSystem: DbSystemName,
	): Attributes {
		const attrs: Attributes = {
			[ATTR_DB_SYSTEM_NAME]: dbSystem,
		};

		const namespace = extractNamespace(options);
		if (namespace) {
			attrs[ATTR_DB_NAMESPACE] = namespace;
		}

		const serverAddress = extractServerAddress(options);
		if (serverAddress) {
			attrs[ATTR_SERVER_ADDRESS] = serverAddress;
			attrs[ATTR_NETWORK_PEER_ADDRESS] = serverAddress;
		}

		const serverPort = extractServerPort(options, dbSystem);
		if (serverPort !== undefined) {
			attrs[ATTR_SERVER_PORT] = serverPort;
		}

		return attrs;
	}

	private _shouldCreateSpan(): boolean {
		if (this._config.enabled === false) return false;

		if (this._config.requireParentSpan) {
			const activeSpan = trace.getActiveSpan();
			if (!activeSpan) return false;
		}

		return true;
	}

	private _callRequestHook(
		span: Span,
		query: string,
		operation?: string,
		params?: unknown[],
	): void {
		if (this._config.requestHook) {
			const queryInfo: QueryInfo = { query, operation, params };
			try {
				this._config.requestHook(span, queryInfo);
			} catch {
				// Swallow hook errors to avoid breaking the query
			}
		}
	}

	private _appendSqlComment(
		span: Span,
		strings: TemplateStringsArray,
		values: unknown[],
	): unknown[] {
		const spanContext = span.spanContext();
		const traceparent = formatTraceparent(
			spanContext.traceId,
			spanContext.spanId,
			spanContext.traceFlags,
		);
		const comment = buildSqlComment(traceparent);
		const modifiedStrings = [...strings] as string[] & { raw: string[] };
		modifiedStrings[modifiedStrings.length - 1] =
			`${modifiedStrings[modifiedStrings.length - 1]!} ${comment}`;
		modifiedStrings.raw = [...strings.raw];
		modifiedStrings.raw[modifiedStrings.raw.length - 1] =
			`${modifiedStrings.raw[modifiedStrings.raw.length - 1]!} ${comment}`;
		return [modifiedStrings, ...values];
	}
}
