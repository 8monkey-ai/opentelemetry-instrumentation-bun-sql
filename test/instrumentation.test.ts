import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM_NAME,
  ATTR_ERROR_TYPE,
} from "@opentelemetry/semantic-conventions";
import { SQL } from "bun";

import { BunSqlInstrumentation } from "../src/instrumentation.js";
import { ATTR_DB_RESPONSE_RETURNED_ROWS } from "../src/semconv.js";
import type { BunSqlInstrumentationConfig } from "../src/types.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// Register globally for trace.getTracer() in requireParentSpan tests
provider.register();

let instrumentation: BunSqlInstrumentation;

function enableInstrumentation(config?: BunSqlInstrumentationConfig) {
  instrumentation = new BunSqlInstrumentation(config);
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
}

function createSql() {
  // require() at call time so we get the instrumentation-patched constructor
  // oxlint-disable-next-line no-unsafe-type-assertion
  const { SQL: PatchedSQL } = require("bun") as { SQL: typeof SQL };
  return new PatchedSQL({ adapter: "sqlite" });
}

function getSpans() {
  return exporter.getFinishedSpans();
}

function getQuerySpans(opName?: string) {
  return getSpans().filter((s) => {
    if (opName !== undefined) return s.attributes[ATTR_DB_OPERATION_NAME] === opName;
    const op = s.attributes[ATTR_DB_OPERATION_NAME];
    return typeof op === "string" && op !== "CLOSE" && op !== "RESERVE";
  });
}

describe("BunSqlInstrumentation", () => {
  beforeEach(() => {
    exporter.reset();
    enableInstrumentation();
  });
  afterEach(() => {
    instrumentation.disable();
  });

  describe("tagged template queries", () => {
    test("creates span for SELECT query", async () => {
      const sql = createSql();
      await sql`SELECT 1 as num`;
      await sql.close();

      const spans = getQuerySpans("SELECT");
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");
      expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("SELECT");
      expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe("SELECT 1 as num");
      expect(span.attributes[ATTR_DB_NAMESPACE]).toBe(":memory:");
    });

    test("creates span with parameterized query text", async () => {
      const sql = createSql();
      await sql`CREATE TABLE param_test(id INTEGER PRIMARY KEY, name TEXT)`;
      await sql`INSERT INTO param_test(name) VALUES(${"alice"})`;
      await sql`SELECT * FROM param_test WHERE name = ${"alice"}`;
      await sql.close();

      const selectSpans = getQuerySpans("SELECT");
      expect(selectSpans.length).toBe(1);
      expect(selectSpans[0]!.attributes[ATTR_DB_QUERY_TEXT]).toBe(
        "SELECT * FROM param_test WHERE name = $1",
      );
    });

    test("sets db.response.returned_rows", async () => {
      const sql = createSql();
      await sql`CREATE TABLE rows_test(id INTEGER PRIMARY KEY, val TEXT)`;
      await sql`INSERT INTO rows_test(val) VALUES(${"a"})`;
      await sql`INSERT INTO rows_test(val) VALUES(${"b"})`;
      await sql`INSERT INTO rows_test(val) VALUES(${"c"})`;
      const result = await sql<unknown[]>`SELECT * FROM rows_test`;
      await sql.close();

      expect(result.length).toBe(3);

      const selectSpans = getQuerySpans("SELECT");
      expect(selectSpans.length).toBe(1);
      expect(selectSpans[0]!.attributes[ATTR_DB_RESPONSE_RETURNED_ROWS]).toBe(3);
    });

    test("supports .values() chaining", async () => {
      const sql = createSql();
      const result = await sql<unknown[]>`SELECT 1 as a, 2 as b`.values();
      await sql.close();

      expect(result[0]).toEqual([1, 2]);
      const selectSpans = getQuerySpans("SELECT");
      expect(selectSpans.length).toBe(1);
    });
  });

  describe("unsafe queries", () => {
    test("creates span for unsafe query", async () => {
      const sql = createSql();
      await sql.unsafe("SELECT 1 as num");
      await sql.close();

      const selectSpans = getQuerySpans("SELECT");
      expect(selectSpans.length).toBe(1);

      const span = selectSpans[0]!;
      expect(span.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");
      expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("SELECT");
      expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe("SELECT ? as num");
    });

    test("sanitizes string literals by default", async () => {
      const sql = createSql();
      await sql.unsafe("SELECT * FROM sqlite_master WHERE type = 'table'");
      await sql.close();

      const selectSpans = getQuerySpans("SELECT");
      expect(selectSpans[0]!.attributes[ATTR_DB_QUERY_TEXT]).toBe(
        "SELECT * FROM sqlite_master WHERE type = ?",
      );
    });
  });

  describe("error handling", () => {
    test("records errors on span", async () => {
      const sql = createSql();
      try {
        await sql`SELECT * FROM nonexistent_table_xyz`;
      } catch {
        // Expected
      }
      await sql.close();

      const errorSpan = getSpans().find((s) => s.status.code === SpanStatusCode.ERROR);
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.attributes[ATTR_ERROR_TYPE]).toBe("SQLiteError");
      expect(errorSpan!.events.length).toBeGreaterThan(0);
    });
  });

  describe("transactions", () => {
    test("instruments queries inside transactions", async () => {
      const sql = createSql();
      await sql`CREATE TABLE tx_test(id INTEGER PRIMARY KEY, val TEXT)`;

      await sql.begin(async (tx) => {
        await tx`INSERT INTO tx_test(val) VALUES(${"hello"})`;
      });
      await sql.close();

      const insertSpan = getSpans().find((s) => s.attributes[ATTR_DB_OPERATION_NAME] === "INSERT");
      expect(insertSpan).toBeDefined();
    });

    test("instruments queries inside failed transactions", async () => {
      const sql = createSql();
      await sql`CREATE TABLE tx_err(id INTEGER PRIMARY KEY, val TEXT)`;

      try {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO tx_err(val) VALUES(${"hello"})`;
          throw new Error("deliberate rollback");
        });
      } catch {
        // Expected
      }
      await sql.close();

      const insertSpan = getSpans().find((s) => s.attributes[ATTR_DB_OPERATION_NAME] === "INSERT");
      expect(insertSpan).toBeDefined();
    });

    test("creates spans for nested savepoints", async () => {
      const sql = createSql();
      await sql`CREATE TABLE sp_test(id INTEGER PRIMARY KEY, val TEXT)`;

      await sql.begin(async (tx) => {
        await tx`INSERT INTO sp_test(val) VALUES(${"outer"})`;
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO sp_test(val) VALUES(${"inner"})`;
        });
      });
      await sql.close();

      const insertSpans = getQuerySpans("INSERT");
      expect(insertSpans.length).toBe(2);
    });
  });

  describe("connection management", () => {
    test("creates span for close", async () => {
      const sql = createSql();
      await sql`SELECT 1`;
      await sql.close();

      const closeSpan = getSpans().find((s) => s.attributes[ATTR_DB_OPERATION_NAME] === "CLOSE");
      expect(closeSpan).toBeDefined();
      expect(closeSpan!.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");
    });
  });
});

describe("BunSqlInstrumentation config options", () => {
  beforeEach(() => {
    exporter.reset();
  });
  afterEach(() => {
    instrumentation.disable();
  });

  test("requireParentSpan suppresses orphan spans", async () => {
    enableInstrumentation({ requireParentSpan: true });

    const sql = createSql();
    await sql`SELECT 1`;
    await sql.close();

    expect(getSpans().length).toBe(0);
  });

  test("requireParentSpan creates spans with parent", async () => {
    enableInstrumentation({ requireParentSpan: true });

    const sql = createSql();
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("parent", async (parentSpan) => {
      await sql`SELECT 1`;
      parentSpan.end();
    });
    await sql.close();

    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans.length).toBe(1);
  });

  test("ignoreConnectionSpans suppresses close spans", async () => {
    enableInstrumentation({ ignoreConnectionSpans: true });

    const sql = createSql();
    await sql`SELECT 1`;
    await sql.close();

    const closeSpan = getSpans().find((s) => s.attributes[ATTR_DB_OPERATION_NAME] === "CLOSE");
    expect(closeSpan).toBeUndefined();

    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans.length).toBe(1);
  });

  test("enhancedDatabaseReporting includes parameters", async () => {
    enableInstrumentation({ enhancedDatabaseReporting: true });

    const sql = createSql();
    await sql`SELECT ${"hello"} as val`;
    await sql.close();

    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans.length).toBe(1);
    expect(selectSpans[0]!.attributes["db.query.parameter.0"]).toBe("hello");
  });

  test("maskStatement: false preserves raw text", async () => {
    enableInstrumentation({ maskStatement: false });

    const sql = createSql();
    await sql.unsafe("SELECT * FROM sqlite_master WHERE type = 'table'");
    await sql.close();

    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans[0]!.attributes[ATTR_DB_QUERY_TEXT]).toBe(
      "SELECT * FROM sqlite_master WHERE type = 'table'",
    );
  });

  test("requestHook is called before query", async () => {
    let hookCalled = false;
    enableInstrumentation({
      requestHook: (span, info) => {
        hookCalled = true;
        span.setAttribute("custom.query", info.query);
      },
    });

    const sql = createSql();
    await sql`SELECT 1 as num`;
    await sql.close();

    expect(hookCalled).toBe(true);
    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans[0]!.attributes["custom.query"]).toBe("SELECT 1 as num");
  });

  test("responseHook is called after query", async () => {
    let capturedRowCount: number | undefined;
    enableInstrumentation({
      responseHook: (_span, info) => {
        capturedRowCount = info.rowCount;
      },
    });

    const sql = createSql();
    await sql`SELECT 1 as num`;
    await sql.close();

    expect(capturedRowCount).toBe(1);
  });

  test("maskStatementHook customizes masking", async () => {
    enableInstrumentation({
      maskStatementHook: (query) => query.replaceAll("secret", "[REDACTED]"),
    });

    const sql = createSql();
    await sql.unsafe("SELECT 'secret' as val");
    await sql.close();

    const selectSpans = getQuerySpans("SELECT");
    expect(selectSpans[0]!.attributes[ATTR_DB_QUERY_TEXT]).toContain("[REDACTED]");
  });
});
