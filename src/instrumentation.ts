import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InstrumentationBase,
  safeExecuteInTheMiddle,
} from "@opentelemetry/instrumentation";
import { addSqlCommenterComment } from "@opentelemetry/sql-common";
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

import type { SQL, TransactionSQL } from "bun";
import {
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_RESPONSE_RETURNED_ROWS,
} from "./semconv.js";
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
  if (ctx.serverAddress !== undefined)
    attrs[ATTR_SERVER_ADDRESS] = ctx.serverAddress;
  if (ctx.serverPort !== undefined) attrs[ATTR_SERVER_PORT] = ctx.serverPort;
  return attrs;
}

export class BunSqlInstrumentation extends InstrumentationBase {
  // These fields are intentionally NOT class field initializers.
  // InstrumentationBase.constructor calls enable() before subclass field
  // initializers run, which would overwrite state set during enable().
  declare private _originalSQL:
    | (new (...args: unknown[]) => SQL)
    | null;
  declare private _originalSqlSingleton: SQL | null;
  declare private _patched: boolean;

  constructor(config?: BunSqlInstrumentationConfig) {
    super(INSTRUMENTATION_NAME, VERSION, config ?? {});
    // Only initialize if not already set by enable() called from super()
    this._originalSQL ??= null;
    this._originalSqlSingleton ??= null;
    this._patched ??= false;
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

    try {
      const bunModule = this._getBunModule();
      if (bunModule === undefined) return;

      if (bunModule.SQL !== undefined && bunModule.SQL !== null) {
        const OrigSQL = bunModule.SQL as new (
          ...args: unknown[]
        ) => SQL;
        this._originalSQL = OrigSQL;
        const wrapInstance = this._wrapInstance.bind(this);

        // Wrap the SQL constructor so new instances are automatically instrumented
        const wrappedSQL = function SQL(
          this: unknown,
          ...args: unknown[]
        ): SQL {
          const instance = new OrigSQL(...args);
          return wrapInstance(instance);
        };

        // Preserve static properties
        for (const key of [
          "prototype",
          "MySQLError",
          "PostgresError",
          "SQLError",
          "SQLiteError",
        ]) {
          const desc = Object.getOwnPropertyDescriptor(OrigSQL, key);
          if (desc !== undefined) {
            Object.defineProperty(wrappedSQL, key, desc);
          }
        }

        bunModule.SQL = wrappedSQL;
      }

      // Also wrap the default `sql` singleton if present
      const sqlVal = bunModule.sql;
      if (
        sqlVal !== undefined &&
        sqlVal !== null &&
        (!isRecord(sqlVal) ||
          (sqlVal as Record<string | symbol, unknown>)[WRAPPED] !== true)
      ) {
        this._originalSqlSingleton = sqlVal as SQL;
        bunModule.sql = this._wrapInstance(sqlVal as SQL);
      }

      this._patched = true;
      this._diag.debug("Bun.SQL instrumentation enabled");
    } catch (e) {
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

      this._patched = false;
      this._diag.debug("Bun.SQL instrumentation disabled");
    } catch (e) {
      this._diag.error("Failed to disable Bun.SQL instrumentation", e);
    }
  }

  private _getBunModule(): { SQL: unknown; sql: SQL | null | undefined } | undefined {
    try {
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
    if (
      (instance as unknown as Record<string | symbol, unknown>)[WRAPPED] ===
      true
    ) {
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
          case "file":
            return this._wrapFile(target.file.bind(target), ctx);
          case "begin":
          case "transaction":
            return (callback: (tx: SQL) => Promise<unknown>): Promise<unknown> =>
              target.begin((tx: SQL) => callback(this._wrapInstance(tx)));
          case "savepoint":
            return (callback: (tx: SQL) => Promise<unknown>): Promise<unknown> =>
              (target as TransactionSQL).savepoint((tx: SQL) =>
                callback(this._wrapInstance(tx)),
              );
          case "beginDistributed":
          case "distributed":
            return (
              id: string,
              callback: (tx: SQL) => Promise<unknown>,
            ): Promise<unknown> =>
              target.beginDistributed(id, (tx: SQL) =>
                callback(this._wrapInstance(tx)),
              );
          case "reserve":
            return this._wrapReserve(target.reserve.bind(target), ctx);
          case "close":
          case "end":
            return this._wrapClose(target.close.bind(target), ctx);
          default: {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value === "function") {
              return (value as (...args: never[]) => unknown).bind(target);
            }
            return value;
          }
        }
      },
    });
  }

  private _handleTaggedTemplate(
    instance: SQL,
    args: unknown[],
    ctx: InstanceContext,
  ): unknown {
    const config = this.getConfig();
    const strings = args[0] as TemplateStringsArray;
    const params = args.slice(1);

    const queryText = buildParameterizedQuery(strings);
    const operationName = extractOperationName(queryText);

    if (
      config.requireParentSpan === true &&
      trace.getSpan(context.active()) === undefined
    ) {
      return instance(strings, ...params);
    }

    const attributes = buildCtxAttributes(ctx);
    if (operationName !== undefined)
      attributes[ATTR_DB_OPERATION_NAME] = operationName;
    attributes[ATTR_DB_QUERY_TEXT] = queryText;

    if (config.enhancedDatabaseReporting === true) {
      for (let i = 0; i < params.length; i++) {
        attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${i}`] = String(
          params[i],
        );
      }
    }

    const spanName = buildSpanName({
      operationName,
      namespace: ctx.namespace,
      systemName: ctx.systemName,
    });

    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes,
    });

    this._callRequestHook(span, {
      query: queryText,
      operation: operationName,
      params: config.enhancedDatabaseReporting === true ? params : undefined,
    }, config);

    let queryArgs: unknown[];
    if (config.addSqlCommenterComment === true) {
      const commentedQuery = addSqlCommenterComment(span, queryText);
      // Reconstruct a synthetic TemplateStringsArray
      const syntheticStrings = [
        commentedQuery,
      ] as unknown as TemplateStringsArray;
      Object.defineProperty(syntheticStrings, "raw", {
        value: [commentedQuery],
      });
      queryArgs = [syntheticStrings];
    } else {
      queryArgs = [strings, ...params];
    }

    const queryResult = context.with(
      trace.setSpan(context.active(), span),
      () =>
        instance(
          ...(queryArgs as [TemplateStringsArray, ...unknown[]]),
        ),
    );

    return this._wrapQueryResult(queryResult, span, config);
  }

  private _wrapUnsafe(
    original: (query: string, params?: unknown[]) => unknown,
    ctx: InstanceContext,
  ): (query: string, params?: unknown[]) => unknown {
    return (query: string, params?: unknown[]): unknown => {
      const config = this.getConfig();

      if (
        config.requireParentSpan === true &&
        trace.getSpan(context.active()) === undefined
      ) {
        return original(query, params);
      }

      const operationName = extractOperationName(query);
      // Mask non-parameterized queries per OTel semconv
      const displayQuery =
        config.maskStatement === false
          ? query
          : (config.maskStatementHook ?? sanitizeQuery)(query);

      const attributes = buildCtxAttributes(ctx);
      if (operationName !== undefined)
        attributes[ATTR_DB_OPERATION_NAME] = operationName;
      attributes[ATTR_DB_QUERY_TEXT] = displayQuery;

      if (config.enhancedDatabaseReporting === true && params !== undefined) {
        for (let i = 0; i < params.length; i++) {
          attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.${i}`] = String(
            params[i],
          );
        }
      }

      const spanName = buildSpanName({
        operationName,
        namespace: ctx.namespace,
        systemName: ctx.systemName,
      });

      const span = this.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      this._callRequestHook(span, {
        query: displayQuery,
        operation: operationName,
        params: config.enhancedDatabaseReporting === true ? params : undefined,
      }, config);

      let finalQuery = query;
      if (config.addSqlCommenterComment === true) {
        finalQuery = addSqlCommenterComment(span, query);
      }

      const result = context.with(
        trace.setSpan(context.active(), span),
        () => original(finalQuery, params),
      );

      return this._wrapQueryResult(result, span, config);
    };
  }

  private _wrapFile(
    original: (path: string, params?: unknown[]) => unknown,
    ctx: InstanceContext,
  ): (path: string, params?: unknown[]) => unknown {
    return (path: string, params?: unknown[]): unknown => {
      const config = this.getConfig();

      if (
        config.requireParentSpan === true &&
        trace.getSpan(context.active()) === undefined
      ) {
        return original(path, params);
      }

      const attributes = buildCtxAttributes(ctx, {
        [ATTR_DB_QUERY_TEXT]: `FILE: ${path}`,
      });

      const spanName = buildSpanName({
        operationName: "FILE",
        namespace: ctx.namespace,
        systemName: ctx.systemName,
      });

      const span = this.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      const result = context.with(
        trace.setSpan(context.active(), span),
        () => original(path, params),
      );

      return this._wrapQueryResult(result, span, config);
    };
  }

  private _wrapReserve(
    original: () => Promise<SQL>,
    ctx: InstanceContext,
  ): () => Promise<SQL> {
    return (): Promise<SQL> => {
      const config = this.getConfig();

      if (config.ignoreConnectionSpans === true) {
        return original().then((reserved) => this._wrapInstance(reserved));
      }

      if (
        config.requireParentSpan === true &&
        trace.getSpan(context.active()) === undefined
      ) {
        return original().then((reserved) => this._wrapInstance(reserved));
      }

      const spanName = buildSpanName({
        operationName: "RESERVE",
        namespace: ctx.namespace,
        systemName: ctx.systemName,
      });

      const span = this.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: buildCtxAttributes(ctx, {
          [ATTR_DB_OPERATION_NAME]: "RESERVE",
        }),
      });

      return original().then(
        (reserved) => {
          span.end();
          return this._wrapInstance(reserved);
        },
        (error: Error) => {
          this._recordError(span, error);
          span.end();
          throw error;
        },
      );
    };
  }

  private _wrapClose(
    original: () => Promise<void>,
    ctx: InstanceContext,
  ): () => Promise<void> {
    return (): Promise<void> => {
      const config = this.getConfig();

      if (config.ignoreConnectionSpans === true) {
        return original();
      }

      if (
        config.requireParentSpan === true &&
        trace.getSpan(context.active()) === undefined
      ) {
        return original();
      }

      const spanName = buildSpanName({
        operationName: "CLOSE",
        namespace: ctx.namespace,
        systemName: ctx.systemName,
      });

      const span = this.tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: buildCtxAttributes(ctx, {
          [ATTR_DB_OPERATION_NAME]: "CLOSE",
        }),
      });

      return original().then(
        (result) => {
          span.end();
          return result;
        },
        (error: Error) => {
          this._recordError(span, error);
          span.end();
          throw error;
        },
      );
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
  ): unknown {
    if (
      typeof queryResult !== "object" ||
      queryResult === null ||
      !("then" in queryResult)
    ) {
      span.end();
      return queryResult;
    }

    const resultObj = queryResult as Record<string, unknown>;
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
          this._handleQuerySuccess(span, data, config);
          return onFulfilled === undefined ? data : onFulfilled(data);
        },
        (error: unknown) => {
          this._recordError(
            span,
            error instanceof Error ? error : new Error(String(error)),
          );
          span.end();
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
              const chainResult = (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
              return this._wrapQueryResult(chainResult, span, config);
            };
          }
          return value;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private _handleQuerySuccess(
    span: Span,
    data: unknown,
    config: BunSqlInstrumentationConfig,
  ): void {
    if (isRecord(data) && typeof data["count"] === "number") {
      span.setAttribute(ATTR_DB_RESPONSE_RETURNED_ROWS, data["count"]);
    }

    if (config.responseHook !== undefined) {
      const rowCount =
        isRecord(data) && typeof data["count"] === "number"
          ? data["count"]
          : undefined;
      const command =
        isRecord(data) && typeof data["command"] === "string"
          ? data["command"]
          : undefined;
      safeExecuteInTheMiddle(
        () =>
          config.responseHook!(span, {
            rowCount,
            command,
            data: config.enhancedDatabaseReporting === true ? data : undefined,
          }),
        (err) => {
          if (err) this._diag.error("Error in responseHook", err);
        },
        true,
      );
    }

    span.end();
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
        () => config.requestHook!(span, info),
        (err) => {
          if (err) this._diag.error("Error in requestHook", err);
        },
        true,
      );
    }
  }
}
