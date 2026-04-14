import { context, type Histogram, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InstrumentationBase, safeExecuteInTheMiddle } from "@opentelemetry/instrumentation";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_RESPONSE_STATUS_CODE,
  ATTR_DB_SYSTEM_NAME,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "@opentelemetry/semantic-conventions";
import { addSqlCommenterComment } from "@opentelemetry/sql-common";
import type { SQL, TransactionSQL } from "bun";

import { ATTR_DB_QUERY_PARAMETER_PREFIX, ATTR_DB_RESPONSE_RETURNED_ROWS } from "./semconv.js";
import type { BunSqlInstrumentationConfig } from "./types.js";
import {
  buildParameterizedQuery,
  buildSpanName,
  extractOperationName,
  getDbNamespace,
  getDbSystemName,
  getServerAddress,
  getServerPort,
  sanitizeQuery,
} from "./utils.js";
import { VERSION } from "./version.js";

const INSTRUMENTATION_NAME = "@8monkey/opentelemetry-instrumentation-bun-sql";

// Symbol to mark instances we've already wrapped
const WRAPPED = Symbol.for("bun-sql-otel-wrapped");

interface InstanceContext {
  systemName: string;
  namespace: string | undefined;
  serverAddress: string | undefined;
  serverPort: number | undefined;
}

const CHAINING_METHODS = new Set(["values", "raw", "simple", "execute"]);

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function buildCtxAttributes(
  ctx: InstanceContext,
  extra?: Record<string, string | number>,
): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    [ATTR_DB_SYSTEM_NAME]: ctx.systemName,
    ...extra,
  };
  if (ctx.namespace !== undefined) attrs[ATTR_DB_NAMESPACE] = ctx.namespace;
  if (ctx.serverAddress !== undefined) attrs[ATTR_SERVER_ADDRESS] = ctx.serverAddress;
  if (ctx.serverPort !== undefined) attrs[ATTR_SERVER_PORT] = ctx.serverPort;
  return attrs;
}

export class BunSqlInstrumentation extends InstrumentationBase {
  // These fields are intentionally NOT class field initializers.
  // InstrumentationBase.constructor calls enable() before subclass field
  // initializers run, which would overwrite state set during enable().
  declare private _originalSQL: (new (...args: unknown[]) => SQL) | null;
  declare private _originalSqlSingleton: SQL | null;
  declare private _patched: boolean;
  declare private _histogram: Histogram | null;

  constructor(config?: BunSqlInstrumentationConfig) {
    super(INSTRUMENTATION_NAME, VERSION, config ?? {});
    // Only initialize if not already set by enable() called from super()
    this._originalSQL ??= null;
    this._originalSqlSingleton ??= null;
    this._patched ??= false;
    this._histogram ??= null;
  }

  override getConfig(): BunSqlInstrumentationConfig {
    return {
      maskStatement: true,
      ...super.getConfig(),
    };
  }

  init(): [] {
    // Bun built-in modules are not intercepted by Node.js module hooks.
    // Patching is done directly in enable()/disable().
    return [];
  }

  override enable(): void {
    if (this._patched) return;

    const bunModule = this._getBunModule();
    if (bunModule === undefined) return;

    try {
      if (bunModule.SQL !== undefined && bunModule.SQL !== null) {
        // oxlint-disable-next-line no-unsafe-type-assertion
        const OrigSQL = bunModule.SQL as new (...args: unknown[]) => SQL;
        this._originalSQL = OrigSQL;
        const wrapInstance = this._wrapInstance.bind(this);

        // Wrap the SQL constructor so new instances are automatically instrumented
        const wrappedSQL = function SQL(this: unknown, ...args: unknown[]): SQL {
          const instance = new OrigSQL(...args);
          return wrapInstance(instance);
        };

        // Preserve static properties
        for (const key of ["prototype", "MySQLError", "PostgresError", "SQLError", "SQLiteError"]) {
          const desc = Object.getOwnPropertyDescriptor(OrigSQL, key);
          if (desc !== undefined) {
            Object.defineProperty(wrappedSQL, key, desc);
          }
        }

        bunModule.SQL = wrappedSQL;
      }

      // Also wrap the default `sql` singleton if present
      const sqlVal = bunModule.sql;
      if (sqlVal !== undefined && sqlVal !== null && Reflect.get(sqlVal, WRAPPED) !== true) {
        this._originalSqlSingleton = sqlVal;
        bunModule.sql = this._wrapInstance(sqlVal);
      }

      this._patched = true;
      this._diag.debug("Bun.SQL instrumentation enabled");
    } catch (e) {
      if (this._originalSQL !== null) bunModule.SQL = this._originalSQL;
      if (this._originalSqlSingleton !== null) bunModule.sql = this._originalSqlSingleton;
      this._originalSQL = this._originalSqlSingleton = null;
      this._patched = false;
      this._diag.error("Failed to enable Bun.SQL instrumentation", e);
    }
  }

  override disable(): void {
    if (!this._patched) return;

    try {
      const bunModule = this._getBunModule();
      if (bunModule === undefined) return;

      if (this._originalSQL !== null) {
        bunModule.SQL = this._originalSQL;
        this._originalSQL = null;
      }
      if (this._originalSqlSingleton !== null) {
        bunModule.sql = this._originalSqlSingleton;
        this._originalSqlSingleton = null;
      }

      this._histogram = null;
      this._patched = false;
      this._diag.debug("Bun.SQL instrumentation disabled");
    } catch (e) {
      this._diag.error("Failed to disable Bun.SQL instrumentation", e);
    }
  }

  private _getBunModule(): { SQL: unknown; sql: SQL | null | undefined } | undefined {
    try {
      // oxlint-disable-next-line no-unsafe-type-assertion
      return require("bun") as unknown as { SQL: unknown; sql: SQL | null | undefined };
    } catch {
      return undefined;
    }
  }

  /**
   * Wrap a Bun SQL instance with a Proxy to intercept tagged template calls
   * and method invocations.
   */
  _wrapInstance(instance: SQL): SQL {
    if (Reflect.get(instance, WRAPPED) === true) {
      return instance;
    }

    const options = instance.options;
    const optionsRecord = options as Record<string, unknown>;
    const ctx: InstanceContext = {
      systemName: getDbSystemName(options.adapter),
      namespace: getDbNamespace(optionsRecord),
      serverAddress: getServerAddress(optionsRecord),
      serverPort: getServerPort(optionsRecord),
    };

    return new Proxy(instance, {
      apply: (_target, _thisArg, args: unknown[]) =>
        this._handleTaggedTemplate(instance, args, ctx),

      get: (target, prop, receiver) => {
        if (prop === WRAPPED) return true;

        // Wrap known methods with typed access
        switch (prop) {
          case "unsafe":
            return this._wrapUnsafe(target.unsafe.bind(target), ctx);
          case "begin":
          case "transaction":
            return (callback: (tx: SQL) => Promise<unknown>): Promise<unknown> =>
              target.begin((tx: SQL) => callback(this._wrapInstance(tx)));
          case "savepoint":
            return (callback: (tx: SQL) => Promise<unknown>): Promise<unknown> =>
              // oxlint-disable-next-line no-unsafe-type-assertion
              (target as TransactionSQL).savepoint((tx: SQL) => callback(this._wrapInstance(tx)));
          case "beginDistributed":
          case "distributed":
            return (id: string, callback: (tx: SQL) => Promise<unknown>): Promise<unknown> =>
              target.beginDistributed(id, (tx: SQL) => callback(this._wrapInstance(tx)));
          case "reserve":
            return this._wrapConnOp("RESERVE", target.reserve.bind(target), ctx, (r) =>
              this._wrapInstance(r),
            );
          case "close":
          case "end":
            return this._wrapConnOp("CLOSE", target.close.bind(target), ctx, (r) => r);
          default: {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value === "function") {
              // oxlint-disable-next-line no-unsafe-return
              return value.bind(target);
            }
            return value;
          }
        }
      },
    });
  }

  private _handleTaggedTemplate(instance: SQL, args: unknown[], ctx: InstanceContext): unknown {
    const config = this.getConfig();
    // oxlint-disable-next-line no-unsafe-type-assertion
    const strings = args[0] as TemplateStringsArray;
    const params = args.slice(1);
    const queryText = buildParameterizedQuery(strings);
    const operationName = extractOperationName(queryText);

    if (config.requireParentSpan === true && trace.getSpan(context.active()) === undefined) {
      return instance(strings, ...params);
    }

    return this._execQuery(queryText, operationName, params, ctx, config, (span) => {
      let templateStrings = strings;

      if (config.addSqlCommenterComment === true) {
        const suffix = addSqlCommenterComment(span, queryText).slice(queryText.length);
        if (suffix !== "") {
          const last = strings.length - 1;
          const cooked = [...strings];
          const raw = [...strings.raw];
          cooked[last] += suffix;
          raw[last] += suffix;
          // oxlint-disable-next-line no-unsafe-type-assertion
          templateStrings = Object.assign(cooked, { raw }) as unknown as TemplateStringsArray;
        }
      }

      return instance(templateStrings, ...params);
    });
  }

  private _wrapUnsafe(
    original: (query: string, params?: unknown[]) => unknown,
    ctx: InstanceContext,
  ): (query: string, params?: unknown[]) => unknown {
    return (query: string, params?: unknown[]): unknown => {
      const config = this.getConfig();

      if (config.requireParentSpan === true && trace.getSpan(context.active()) === undefined) {
        return original(query, params);
      }

      const operationName = extractOperationName(query);
      // Mask non-parameterized queries per OTel semconv
      const queryText =
        config.maskStatement === false ? query : (config.maskStatementHook ?? sanitizeQuery)(query);

      return this._execQuery(queryText, operationName, params, ctx, config, (span) =>
        original(
          config.addSqlCommenterComment === true ? addSqlCommenterComment(span, query) : query,
          params,
        ),
      );
    };
  }

  private _execQuery(
    queryText: string,
    operationName: string | undefined,
    params: unknown[] | undefined,
    ctx: InstanceContext,
    config: BunSqlInstrumentationConfig,
    execute: (span: Span) => unknown,
  ): unknown {
    const attributes = buildCtxAttributes(ctx);
    if (operationName !== undefined) attributes[ATTR_DB_OPERATION_NAME] = operationName;
    attributes[ATTR_DB_QUERY_TEXT] = queryText;

    if (config.enhancedDatabaseReporting === true && params !== undefined) {
      for (let i = 0; i < params.length; i++) {
        attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${i}`] = String(params[i]);
      }
    }

    const startTime = performance.now();
    const recordDuration = (): void => {
      this._recordOperationDuration(startTime, ctx, operationName);
    };

    const span = this.tracer.startSpan(
      buildSpanName({ operationName, namespace: ctx.namespace, systemName: ctx.systemName }),
      { kind: SpanKind.CLIENT, attributes },
    );

    this._callRequestHook(
      span,
      {
        query: queryText,
        operation: operationName,
        params: config.enhancedDatabaseReporting === true ? params : undefined,
      },
      config,
    );

    try {
      const result = context.with(trace.setSpan(context.active(), span), () => execute(span));
      return this._wrapQueryResult(result, span, config, recordDuration);
    } catch (error) {
      this._recordError(span, error instanceof Error ? error : new Error(String(error)));
      span.end();
      recordDuration();
      throw error;
    }
  }

  private _wrapConnOp<TIn, TOut>(
    op: string,
    original: () => Promise<TIn>,
    ctx: InstanceContext,
    onSuccess: (r: TIn) => TOut,
  ): () => Promise<TOut> {
    return (): Promise<TOut> => {
      const config = this.getConfig();
      if (
        config.ignoreConnectionSpans === true ||
        (config.requireParentSpan === true && trace.getSpan(context.active()) === undefined)
      ) {
        return original().then(onSuccess);
      }
      const startTime = performance.now();
      const span = this.tracer.startSpan(
        buildSpanName({ operationName: op, namespace: ctx.namespace, systemName: ctx.systemName }),
        {
          kind: SpanKind.CLIENT,
          attributes: buildCtxAttributes(ctx, { [ATTR_DB_OPERATION_NAME]: op }),
        },
      );
      try {
        return original().then(
          (r: TIn): TOut => {
            span.end();
            this._recordOperationDuration(startTime, ctx, op);
            return onSuccess(r);
          },
          (e: Error) => {
            this._recordError(span, e);
            span.end();
            this._recordOperationDuration(startTime, ctx, op);
            throw e;
          },
        );
      } catch (e) {
        this._recordError(span, e instanceof Error ? e : new Error(String(e)));
        span.end();
        this._recordOperationDuration(startTime, ctx, op);
        throw e;
      }
    };
  }

  /**
   * Wrap a lazy query result (thenable) to intercept resolution/rejection
   * for span lifecycle management, while preserving chaining methods.
   * Uses a Proxy to intercept .then() and chaining methods without
   * directly mutating the result object.
   */
  private _wrapQueryResult(
    queryResult: unknown,
    span: Span,
    config: BunSqlInstrumentationConfig,
    onEnd: () => void,
  ): unknown {
    if (typeof queryResult !== "object" || queryResult === null || !("then" in queryResult)) {
      span.end();
      onEnd();
      return queryResult;
    }

    const resultObj = queryResult as Record<string, unknown>;
    // oxlint-disable-next-line no-unsafe-type-assertion
    const origThen = resultObj["then"] as (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise<unknown>;

    const wrappedThen = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ): Promise<unknown> =>
      origThen.call(
        resultObj,
        (data: unknown) => {
          this._handleQuerySuccess(span, data, config, onEnd);
          return onFulfilled === undefined ? data : onFulfilled(data);
        },
        (error: unknown) => {
          this._recordError(span, error instanceof Error ? error : new Error(String(error)));
          span.end();
          onEnd();
          if (onRejected !== undefined) return onRejected(error);
          throw error;
        },
      );

    // Use Proxy to intercept .then() and chaining methods
    return new Proxy(queryResult, {
      get: (target, prop, receiver) => {
        if (prop === "then") return wrappedThen;

        if (typeof prop === "string" && CHAINING_METHODS.has(prop)) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return (...args: unknown[]): unknown => {
              const chainResult: unknown = value.apply(target, args);
              return this._wrapQueryResult(chainResult, span, config, onEnd);
            };
          }
          return value;
        }
        // oxlint-disable-next-line no-unsafe-return
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private _handleQuerySuccess(
    span: Span,
    data: unknown,
    config: BunSqlInstrumentationConfig,
    onEnd: () => void,
  ): void {
    const record = isRecord(data) ? data : null;
    const rowCount =
        record !== null && typeof record["count"] === "number" ? record["count"] : undefined;
    if (rowCount !== undefined) span.setAttribute(ATTR_DB_RESPONSE_RETURNED_ROWS, rowCount);

    if (config.responseHook !== undefined) {
      const command =
        record !== null && typeof record["command"] === "string" ? record["command"] : undefined;

      safeExecuteInTheMiddle(
        () => {
          config.responseHook!(span, {
            rowCount,
            command,
            data: config.enhancedDatabaseReporting === true ? data : undefined,
          });
        },
        (err) => {
          if (err) this._diag.error("Error in responseHook", err);
        },
        true,
      );
    }

    span.end();
    onEnd();
  }

  private _recordOperationDuration(
    startTime: number,
    ctx: InstanceContext,
    operationName: string | undefined,
  ): void {
    this._histogram ??= this.meter.createHistogram("db.client.operation.duration", {
      unit: "s",
      description: "Duration of database client operations",
    });
    const durationS = (performance.now() - startTime) / 1000;
    const attributes: Record<string, string | number> = {
      [ATTR_DB_SYSTEM_NAME]: ctx.systemName,
    };
    if (operationName !== undefined) attributes[ATTR_DB_OPERATION_NAME] = operationName;
    if (ctx.serverAddress !== undefined) attributes[ATTR_SERVER_ADDRESS] = ctx.serverAddress;
    if (ctx.serverPort !== undefined) attributes[ATTR_SERVER_PORT] = ctx.serverPort;
    this._histogram.record(durationS, attributes);
  }

  private _recordError(span: Span, error: Error): void {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);
    span.setAttribute(ATTR_ERROR_TYPE, error.constructor.name);

    // Capture database-specific error codes
    if ("code" in error && typeof error.code === "string") {
      span.setAttribute(ATTR_DB_RESPONSE_STATUS_CODE, error.code);
    } else if ("errno" in error && typeof error.errno === "number") {
      span.setAttribute(ATTR_DB_RESPONSE_STATUS_CODE, String(error.errno));
    }
  }

  private _callRequestHook(
    span: Span,
    info: { query: string; operation?: string; params?: unknown[] },
    config: BunSqlInstrumentationConfig,
  ): void {
    if (config.requestHook !== undefined) {
      safeExecuteInTheMiddle(
        () => {
          config.requestHook!(span, info);
        },
        (err) => {
          if (err) this._diag.error("Error in requestHook", err);
        },
        true,
      );
    }
  }
}
