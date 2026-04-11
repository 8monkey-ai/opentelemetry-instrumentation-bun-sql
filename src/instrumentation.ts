/* oxlint-disable
  typescript-eslint/no-unsafe-type-assertion,
  typescript-eslint/no-unsafe-assignment,
  typescript-eslint/no-unsafe-return,
  typescript-eslint/no-unsafe-argument,
  typescript-eslint/no-base-to-string,
  typescript-eslint/no-unnecessary-boolean-literal-compare
  ---
  Instrumentation code wraps dynamically-typed Bun runtime APIs (SQL instances
  are callable functions with arbitrary method signatures). Safe type narrowing
  is not feasible here — the `any` boundary is at Bun's own API surface.
  The boolean-literal-compare rule is disabled because `_patched` uses `declare`
  (no runtime initializer) so it can be `undefined` on first access.
*/
import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import {
  InstrumentationBase,
  safeExecuteInTheMiddle,
} from "@opentelemetry/instrumentation";
import { addSqlCommenterComment } from "@opentelemetry/sql-common";
import type { BunSqlInstrumentationConfig } from "./types.js";
import {
  buildParameterizedQuery,
  buildSpanName,
  defaultSanitizeQuery,
  extractOperationName,
  extractTableName,
  getConnectionAttributes,
  getErrorAttributes,
  getQueryAttributes,
  type ConnectionInfo,
} from "./utils.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

// Bun provides require() globally — declare for TypeScript compilation without bun types
declare const require: (module: string) => Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type SqlConstructor = new (...args: any[]) => any;
type SqlInstance = ((...args: any[]) => any) & Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const INSTRUMENTED_MARKER = Symbol.for(
  "@8monkey/opentelemetry-instrumentation-bun-sql",
);

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
export class BunSqlInstrumentation extends InstrumentationBase<BunSqlInstrumentationConfig> {
  // Using `declare` to avoid ES2022 class field initializers, which run AFTER
  // super() and would overwrite values set during InstrumentationBase's
  // constructor call to enable().
  private declare _originalSQL: SqlConstructor | undefined;
  private declare _patched: boolean;

  constructor(config: BunSqlInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  protected override init(): undefined {
    return undefined;
  }

  override enable(): void {
    if (this._patched === true) {
      return;
    }

    try {
      const bunModule = require("bun");
      const OrigSQL = bunModule["SQL"] as SqlConstructor | undefined;

      if (OrigSQL === undefined) {
        this._diag.warn(
          "Bun.SQL not found — instrumentation cannot be applied",
        );
        return;
      }

      // Check if already instrumented by another instance
      if (INSTRUMENTED_MARKER in OrigSQL) {
        this._patched = true;
        return;
      }

      this._originalSQL = OrigSQL;

      const wrapInstance = this._wrapSqlInstance.bind(this);

      const PatchedSQL = function (
        this: unknown,
        ...args: unknown[]
      ): SqlInstance {
        const instance = new OrigSQL(...args) as SqlInstance;
        return wrapInstance(instance);
      } as unknown as SqlConstructor;

      PatchedSQL.prototype = OrigSQL.prototype;
      Object.defineProperty(PatchedSQL, "name", { value: OrigSQL.name });
      Object.defineProperty(PatchedSQL, INSTRUMENTED_MARKER, { value: true });

      bunModule["SQL"] = PatchedSQL;
      this._patched = true;
      this._diag.debug("Bun.SQL instrumentation enabled");
    } catch (e) {
      this._diag.error("Failed to enable Bun.SQL instrumentation", e);
    }
  }

  override disable(): void {
    if (this._patched !== true || this._originalSQL === undefined) {
      return;
    }

    try {
      const bunModule = require("bun");
      bunModule["SQL"] = this._originalSQL;
      this._originalSQL = undefined;
      this._patched = false;
      this._diag.debug("Bun.SQL instrumentation disabled");
    } catch (e) {
      this._diag.error("Failed to disable Bun.SQL instrumentation", e);
    }
  }

  private _getConnectionInfo(instance: SqlInstance): ConnectionInfo {
    const options = (instance["options"] ?? {}) as Record<string, unknown>;
    return {
      adapter: typeof options["adapter"] === "string" ? options["adapter"] : "postgres",
      hostname: typeof options["hostname"] === "string" ? options["hostname"] : undefined,
      port: typeof options["port"] === "number" ? options["port"] : undefined,
      database: typeof options["database"] === "string" ? options["database"] : undefined,
      filename: typeof options["filename"] === "string" ? options["filename"] : undefined,
    };
  }

  private _wrapSqlInstance(instance: SqlInstance): SqlInstance {
    const handleTaggedTemplate = this._handleTaggedTemplate.bind(this);
    const wrapMethod = this._getMethodWrapper(instance);
    const connectionInfo = this._getConnectionInfo(instance);

    return new Proxy(instance, {
      apply(_target, _thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        return handleTaggedTemplate(instance, args, connectionInfo);
      },
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        if (typeof prop === "symbol" || typeof value !== "function") {
          return value;
        }

        return wrapMethod(prop, value, connectionInfo);
      },
    });
  }

  private _getMethodWrapper(
    target: SqlInstance,
  ): (
    prop: string,
    value: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ) => unknown {
    const makeUnsafeWrapper = this._makeUnsafeWrapper.bind(this);
    const makeFileWrapper = this._makeFileWrapper.bind(this);
    const makeBeginWrapper = this._makeBeginWrapper.bind(this);
    const makeBeginDistributedWrapper =
      this._makeBeginDistributedWrapper.bind(this);
    const makeSimpleOperationWrapper =
      this._makeSimpleOperationWrapper.bind(this);
    const makeReserveWrapper = this._makeReserveWrapper.bind(this);
    const makeCloseWrapper = this._makeCloseWrapper.bind(this);

    return (
      prop: string,
      value: (...args: unknown[]) => unknown,
      connectionInfo: ConnectionInfo,
    ) => {
      switch (prop) {
        case "unsafe":
          return makeUnsafeWrapper(target, value, connectionInfo);
        case "file":
          return makeFileWrapper(target, value, connectionInfo);
        case "begin":
        case "transaction":
          return makeBeginWrapper(target, value, connectionInfo);
        case "beginDistributed":
        case "distributed":
          return makeBeginDistributedWrapper(target, value, connectionInfo);
        case "commitDistributed":
          return makeSimpleOperationWrapper(
            target,
            value,
            connectionInfo,
            "COMMIT",
          );
        case "rollbackDistributed":
          return makeSimpleOperationWrapper(
            target,
            value,
            connectionInfo,
            "ROLLBACK",
          );
        case "reserve":
          return makeReserveWrapper(target, value, connectionInfo);
        case "close":
        case "end":
          return makeCloseWrapper(target, value, connectionInfo);
        default:
          return value;
      }
    };
  }

  private _shouldCreateSpan(): boolean {
    const config = this.getConfig();
    if (config.requireParentSpan === true) {
      const parentSpan = trace.getSpan(context.active());
      if (parentSpan === undefined) {
        return false;
      }
    }
    return true;
  }

  private _handleTaggedTemplate(
    target: SqlInstance,
    args: [TemplateStringsArray, ...unknown[]],
    connectionInfo: ConnectionInfo,
  ): unknown {
    if (!this._shouldCreateSpan()) {
      return Reflect.apply(target, undefined, args);
    }

    const strings = args[0];
    const values = args.slice(1);
    const queryText = buildParameterizedQuery(strings);
    const operation = extractOperationName(queryText);
    const tableName = extractTableName(queryText);
    const connAttrs = getConnectionAttributes(connectionInfo);
    const dbSystemName = String(connAttrs["db.system.name"] ?? "");
    const namespace =
      typeof connAttrs["db.namespace"] === "string"
        ? connAttrs["db.namespace"]
        : undefined;
    const spanName = buildSpanName(
      operation,
      tableName,
      namespace,
      dbSystemName,
    );

    const queryAttrs = getQueryAttributes(queryText, operation, tableName, true);
    const attributes: Attributes = { ...connAttrs, ...queryAttrs };

    this._addParameterAttributes(attributes, values);

    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes,
    });

    this._callRequestHook(span, queryText, operation, values);

    const config = this.getConfig();
    const queryPromise = Reflect.apply(target, undefined, args) as Promise<unknown>;
    return this._wrapQueryPromise(queryPromise, span, config);
  }

  private _makeUnsafeWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const getConfig = this.getConfig.bind(this);
    const addParameterAttributes = this._addParameterAttributes.bind(this);
    const callRequestHook = this._callRequestHook.bind(this);
    const wrapQueryPromise = this._wrapQueryPromise.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      if (!shouldCreateSpan()) {
        return original.apply(target, args);
      }

      const queryText = String(args[0] ?? "");
      const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
      const config = getConfig();

      const shouldSanitize = config.sanitizeNonParameterizedQueries !== false;
      const displayQuery = shouldSanitize
        ? (config.sanitizationHook ?? defaultSanitizeQuery)(queryText)
        : queryText;

      const operation = extractOperationName(queryText);
      const tableName = extractTableName(queryText);
      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const namespace =
        typeof connAttrs["db.namespace"] === "string"
          ? connAttrs["db.namespace"]
          : undefined;
      const spanName = buildSpanName(
        operation,
        tableName,
        namespace,
        dbSystemName,
      );

      const queryAttrs = getQueryAttributes(
        displayQuery,
        operation,
        tableName,
        true,
      );
      const attributes: Attributes = { ...connAttrs, ...queryAttrs };

      if (params !== undefined) {
        addParameterAttributes(attributes, params);
      }

      if (config.addSqlCommenterComment === true) {
        const currentSpan = trace.getSpan(context.active());
        if (currentSpan !== undefined) {
          args[0] = addSqlCommenterComment(currentSpan, queryText);
        }
      }

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      callRequestHook(span, displayQuery, operation, params);

      const queryPromise = original.apply(target, args) as Promise<unknown>;
      return wrapQueryPromise(queryPromise, span, config);
    };
  }

  private _makeFileWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const getConfig = this.getConfig.bind(this);
    const addParameterAttributes = this._addParameterAttributes.bind(this);
    const callRequestHook = this._callRequestHook.bind(this);
    const wrapQueryPromise = this._wrapQueryPromise.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      if (!shouldCreateSpan()) {
        return original.apply(target, args);
      }

      const filename = String(args[0] ?? "");
      const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
      const config = getConfig();

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const namespace =
        typeof connAttrs["db.namespace"] === "string"
          ? connAttrs["db.namespace"]
          : undefined;
      const spanName = buildSpanName(
        undefined,
        undefined,
        namespace,
        dbSystemName,
      );

      const attributes: Attributes = {
        ...connAttrs,
        "db.query.text": `file:${filename}`,
      };

      if (params !== undefined) {
        addParameterAttributes(attributes, params);
      }

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      callRequestHook(span, `file:${filename}`, undefined, params);

      const queryPromise = original.apply(target, args) as Promise<unknown>;
      return wrapQueryPromise(queryPromise, span, config);
    };
  }

  private _makeBeginWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const wrapSqlInstance = this._wrapSqlInstance.bind(this);
    const wrapTransactionPromise = this._wrapTransactionPromise.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      if (!shouldCreateSpan()) {
        return original.apply(target, args);
      }

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const namespace =
        typeof connAttrs["db.namespace"] === "string"
          ? connAttrs["db.namespace"]
          : undefined;
      const spanName = buildSpanName(
        "BEGIN",
        undefined,
        namespace,
        dbSystemName,
      );

      const attributes: Attributes = {
        ...connAttrs,
        "db.operation.name": "BEGIN",
      };

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      // Find the callback — it can be the first or second argument
      let callbackIndex = -1;
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === "function") {
          callbackIndex = i;
          break;
        }
      }

      if (callbackIndex >= 0) {
        const originalCallback = args[callbackIndex] as (
          tx: SqlInstance,
        ) => Promise<unknown>;

        args[callbackIndex] = (tx: SqlInstance) => {
          const wrappedTx = wrapSqlInstance(tx);
          const txContext = trace.setSpan(context.active(), span);
          return context.with(txContext, () => originalCallback(wrappedTx));
        };
      }

      const resultPromise = original.apply(target, args) as Promise<unknown>;
      return wrapTransactionPromise(resultPromise, span);
    };
  }

  private _makeBeginDistributedWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const wrapSqlInstance = this._wrapSqlInstance.bind(this);
    const wrapTransactionPromise = this._wrapTransactionPromise.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      if (!shouldCreateSpan()) {
        return original.apply(target, args);
      }

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const namespace =
        typeof connAttrs["db.namespace"] === "string"
          ? connAttrs["db.namespace"]
          : undefined;
      const spanName = buildSpanName(
        "BEGIN",
        undefined,
        namespace,
        dbSystemName,
      );

      const attributes: Attributes = {
        ...connAttrs,
        "db.operation.name": "BEGIN",
      };

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      // beginDistributed(name, callback) — callback is last arg
      const callbackIndex = args.length - 1;
      if (callbackIndex >= 0 && typeof args[callbackIndex] === "function") {
        const originalCallback = args[callbackIndex] as (
          tx: SqlInstance,
        ) => Promise<unknown>;

        args[callbackIndex] = (tx: SqlInstance) => {
          const wrappedTx = wrapSqlInstance(tx);
          const txContext = trace.setSpan(context.active(), span);
          return context.with(txContext, () => originalCallback(wrappedTx));
        };
      }

      const resultPromise = original.apply(target, args) as Promise<unknown>;
      return wrapTransactionPromise(resultPromise, span);
    };
  }

  private _makeSimpleOperationWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
    operationName: string,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const wrapTransactionPromise = this._wrapTransactionPromise.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      if (!shouldCreateSpan()) {
        return original.apply(target, args);
      }

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const namespace =
        typeof connAttrs["db.namespace"] === "string"
          ? connAttrs["db.namespace"]
          : undefined;
      const spanName = buildSpanName(
        operationName,
        undefined,
        namespace,
        dbSystemName,
      );

      const attributes: Attributes = {
        ...connAttrs,
        "db.operation.name": operationName,
      };

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes,
      });

      const resultPromise = original.apply(target, args) as Promise<unknown>;
      return wrapTransactionPromise(resultPromise, span);
    };
  }

  private _makeReserveWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const getConfig = this.getConfig.bind(this);
    const wrapReservedConnection =
      this._wrapReservedConnection.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      const config = getConfig();
      if (
        config.ignoreConnectionSpans === true ||
        !shouldCreateSpan()
      ) {
        const resultPromise = original.apply(target, args) as Promise<SqlInstance>;
        return resultPromise.then((reserved: SqlInstance) =>
          wrapReservedConnection(reserved, connectionInfo),
        );
      }

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const spanName = `${dbSystemName} reserve`;

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: connAttrs,
      });

      const resultPromise = original.apply(target, args) as Promise<SqlInstance>;
      return resultPromise.then(
        (reserved: SqlInstance) => {
          span.end();
          return wrapReservedConnection(reserved, connectionInfo);
        },
        (error: unknown) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              error instanceof Error ? error.message : String(error),
          });
          if (error instanceof Error) {
            span.recordException(error);
          }
          span.end();
          throw error;
        },
      );
    };
  }

  private _wrapReservedConnection(
    reserved: SqlInstance,
    connectionInfo: ConnectionInfo,
  ): SqlInstance {
    const wrapped = this._wrapSqlInstance(reserved);

    const originalRelease = reserved["release"];
    if (typeof originalRelease === "function") {
      const shouldCreateSpan = this._shouldCreateSpan.bind(this);
      const getConfig = this.getConfig.bind(this);
      const startSpan = this.tracer.startSpan.bind(this.tracer);

      Object.defineProperty(wrapped, "release", {
        value: (...args: unknown[]) => {
          const config = getConfig();
          if (
            config.ignoreConnectionSpans === true ||
            !shouldCreateSpan()
          ) {
            return (originalRelease as (...a: unknown[]) => unknown).apply(
              reserved,
              args,
            );
          }

          const connAttrs = getConnectionAttributes(connectionInfo);
          const dbSystemName = String(connAttrs["db.system.name"] ?? "");
          const spanName = `${dbSystemName} release`;

          const span = startSpan(spanName, {
            kind: SpanKind.CLIENT,
            attributes: connAttrs,
          });

          try {
            const result = (
              originalRelease as (...a: unknown[]) => unknown
            ).apply(reserved, args);
            span.end();
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
              span.recordException(error);
            }
            span.end();
            throw error;
          }
        },
        writable: true,
        configurable: true,
      });
    }

    return wrapped;
  }

  private _makeCloseWrapper(
    target: SqlInstance,
    original: (...args: unknown[]) => unknown,
    connectionInfo: ConnectionInfo,
  ): (...args: unknown[]) => unknown {
    const shouldCreateSpan = this._shouldCreateSpan.bind(this);
    const getConfig = this.getConfig.bind(this);
    const startSpan = this.tracer.startSpan.bind(this.tracer);

    return (...args: unknown[]) => {
      const config = getConfig();
      if (
        config.ignoreConnectionSpans === true ||
        !shouldCreateSpan()
      ) {
        return original.apply(target, args);
      }

      const connAttrs = getConnectionAttributes(connectionInfo);
      const dbSystemName = String(connAttrs["db.system.name"] ?? "");
      const spanName = `${dbSystemName} close`;

      const span = startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: connAttrs,
      });

      const result = original.apply(target, args);
      if (result instanceof Promise) {
        return result.then(
          (val: unknown) => {
            span.end();
            return val;
          },
          (error: unknown) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
              span.recordException(error);
            }
            span.end();
            throw error;
          },
        );
      }
      span.end();
      return result;
    };
  }

  private _wrapQueryPromise(
    queryPromise: Promise<unknown>,
    span: Span,
    config: BunSqlInstrumentationConfig,
  ): Promise<unknown> {
    const callResponseHook = this._callResponseHook.bind(this);
    return queryPromise.then(
      (result: unknown) => {
        if (config.enhancedDatabaseReporting === true && Array.isArray(result)) {
          span.setAttribute("db.response.returned_rows", result.length);
        }
        callResponseHook(span, result);
        span.end();
        return result;
      },
      (error: unknown) => {
        const errorAttrs = getErrorAttributes(error);
        span.setAttributes(errorAttrs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        span.end();
        throw error;
      },
    );
  }

  private _wrapTransactionPromise(
    promise: Promise<unknown>,
    span: Span,
  ): Promise<unknown> {
    return promise.then(
      (result: unknown) => {
        span.end();
        return result;
      },
      (error: unknown) => {
        const errorAttrs = getErrorAttributes(error);
        span.setAttributes(errorAttrs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        span.end();
        throw error;
      },
    );
  }

  private _addParameterAttributes(
    attributes: Attributes,
    params: unknown[],
  ): void {
    const config = this.getConfig();
    if (config.enhancedDatabaseReporting !== true) {
      return;
    }

    for (let i = 0; i < params.length; i++) {
      const val = params[i];
      if (val !== undefined && val !== null) {
        attributes[`db.query.parameter.${String(i)}`] =
          typeof val === "string" || typeof val === "number" || typeof val === "boolean"
            ? String(val)
            : JSON.stringify(val);
      }
    }
  }

  private _callRequestHook(
    span: Span,
    query: string,
    operation: string | undefined,
    params?: unknown[],
  ): void {
    const config = this.getConfig();
    if (config.requestHook === undefined) {
      return;
    }

    const hook = config.requestHook;
    safeExecuteInTheMiddle(
      () => {
        hook(span, { query, operation, params });
      },
      (e) => {
        if (e !== undefined) {
          this._diag.error("requestHook error", e);
        }
      },
      true,
    );
  }

  private _callResponseHook(span: Span, data: unknown): void {
    const config = this.getConfig();
    if (config.responseHook === undefined) {
      return;
    }

    const rowCount = Array.isArray(data) ? data.length : 0;
    const hook = config.responseHook;

    safeExecuteInTheMiddle(
      () => {
        hook(span, {
          rowCount,
          data: config.enhancedDatabaseReporting === true ? data : undefined,
        });
      },
      (e) => {
        if (e !== undefined) {
          this._diag.error("responseHook error", e);
        }
      },
      true,
    );
  }
}
