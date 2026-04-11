/* oxlint-disable
  typescript-eslint/no-unsafe-type-assertion,
  typescript-eslint/no-unsafe-assignment,
  typescript-eslint/no-unsafe-call,
  typescript-eslint/no-unsafe-member-access,
  typescript-eslint/no-unsafe-argument,
  typescript-eslint/no-unsafe-return,
  eslint/require-await,
  unicorn/no-useless-undefined
  ---
  Test file: uses dynamically-typed SQL instances from Bun runtime.
*/
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  SQL,
  exporter,
  getParentSpanId,
  getSpans,
  instrumentation,
  provider,
} from "./setup";

describe("BunSqlInstrumentation with SQLite", () => {
  let sql: any;

  beforeAll(() => {
    sql = new SQL({ adapter: "sqlite" });
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(() => {
    sql.close();
  });

  describe("tagged template queries", () => {
    it("creates a span for SELECT", async () => {
      await sql`SELECT 1 as val`;
      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes["db.system.name"]).toBe("sqlite");
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
      // No template interpolation, so query text is the raw string
      expect(span.attributes["db.query.text"]).toBe("SELECT 1 as val");
    });

    it("creates a span with parameterized query text", async () => {
      const id = 42;
      await sql`SELECT * FROM sqlite_master WHERE type = ${"table"} AND name = ${String(id)}`;
      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.attributes["db.query.text"]).toBe(
        "SELECT * FROM sqlite_master WHERE type = $1 AND name = $2",
      );
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
    });

    it("sets span name based on query summary", async () => {
      await sql`SELECT * FROM sqlite_master`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.name).toBe("SELECT sqlite_master");
    });

    it("records correct result", async () => {
      const result = await sql`SELECT 1 as val, 2 as other`;
      expect(result[0]).toEqual({ val: 1, other: 2 });
    });
  });

  describe("unsafe queries", () => {
    it("creates a span for unsafe queries", async () => {
      await sql.unsafe("SELECT 1 as val");
      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.attributes["db.system.name"]).toBe("sqlite");
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
    });

    it("sanitizes non-parameterized queries by default", async () => {
      await sql.unsafe("SELECT * FROM sqlite_master WHERE name = 'test'");
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.query.text"]).toBe(
        "SELECT * FROM sqlite_master WHERE name = ?",
      );
    });
  });

  describe("transactions", () => {
    it("creates a BEGIN span for transactions", async () => {
      await sql.begin(async (tx: any) => {
        await tx`SELECT 1 as val`;
      });
      const spans = getSpans();

      expect(spans.length).toBeGreaterThanOrEqual(2);

      const beginSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "BEGIN",
      );
      expect(beginSpan).toBeDefined();
      expect(beginSpan!.kind).toBe(SpanKind.CLIENT);
    });

    it("propagates context through transactions", async () => {
      await sql.begin(async (tx: any) => {
        await tx`SELECT 1 as val`;
      });
      const spans = getSpans();

      const beginSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "BEGIN",
      );
      const selectSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "SELECT",
      );

      expect(beginSpan).toBeDefined();
      expect(selectSpan).toBeDefined();

      // SELECT should be a child of BEGIN (via parentSpanContext in SDK v2)
      const parentId = getParentSpanId(selectSpan!);
      expect(parentId).toBe(beginSpan!.spanContext().spanId);
    });

    it("records error on failed transaction", async () => {
      try {
        await sql.begin(async () => {
          throw new Error("Transaction failed");
        });
      } catch {
        // expected
      }

      const spans = getSpans();
      const beginSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "BEGIN",
      );
      expect(beginSpan).toBeDefined();
      expect(beginSpan!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe("error handling", () => {
    it("records error on failed query", async () => {
      try {
        await sql`SELECT * FROM nonexistent_table_xyz`;
      } catch {
        // expected
      }

      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["error.type"]).toBeDefined();
    });
  });

  describe("configuration", () => {
    it("includes parameter attributes with enhancedDatabaseReporting", async () => {
      instrumentation.setConfig({ enhancedDatabaseReporting: true });

      const val = 42;
      await sql`SELECT ${val} as val`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.query.parameter.0"]).toBe("42");

      instrumentation.setConfig({});
    });

    it("includes returned rows with enhancedDatabaseReporting", async () => {
      instrumentation.setConfig({ enhancedDatabaseReporting: true });

      await sql`SELECT 1 as val`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.response.returned_rows"]).toBe(1);

      instrumentation.setConfig({});
    });

    it("calls requestHook", async () => {
      let hookCalled = false;
      instrumentation.setConfig({
        requestHook: (span, info) => {
          hookCalled = true;
          span.setAttribute("custom.attr", "test");
          expect(info.query).toBeDefined();
        },
      });

      await sql`SELECT 1 as val`;
      expect(hookCalled).toBe(true);
      const span = getSpans()[0]!;
      expect(span.attributes["custom.attr"]).toBe("test");

      instrumentation.setConfig({});
    });

    it("calls responseHook", async () => {
      let hookCalled = false;
      instrumentation.setConfig({
        responseHook: (span, info) => {
          hookCalled = true;
          span.setAttribute("custom.rows", info.rowCount);
        },
      });

      await sql`SELECT 1 as val`;
      expect(hookCalled).toBe(true);
      const span = getSpans()[0]!;
      expect(span.attributes["custom.rows"]).toBe(1);

      instrumentation.setConfig({});
    });

    it("skips span creation with requireParentSpan when no parent", async () => {
      instrumentation.setConfig({ requireParentSpan: true });

      await sql`SELECT 1 as val`;
      const spans = getSpans();
      expect(spans.length).toBe(0);

      instrumentation.setConfig({});
    });

    it("creates span with requireParentSpan when parent exists", async () => {
      instrumentation.setConfig({ requireParentSpan: true });

      const tracer = provider.getTracer("test");
      await tracer.startActiveSpan("parent", async (parentSpan) => {
        await sql`SELECT 1 as val`;
        parentSpan.end();
      });

      const spans = getSpans();
      const selectSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "SELECT",
      );
      expect(selectSpan).toBeDefined();

      instrumentation.setConfig({});
    });
  });

  describe("close", () => {
    it("creates a span for close", async () => {
      const closeSql = new SQL({ adapter: "sqlite" });
      await closeSql.close();

      const spans = getSpans();
      const closeSpan = spans.find((s: any) => s.name === "sqlite close");
      expect(closeSpan).toBeDefined();
      expect(closeSpan!.kind).toBe(SpanKind.CLIENT);
    });

    it("suppresses close span with ignoreConnectionSpans", async () => {
      instrumentation.setConfig({ ignoreConnectionSpans: true });

      const closeSql = new SQL({ adapter: "sqlite" });
      await closeSql.close();

      const spans = getSpans();
      const closeSpan = spans.find((s: any) => s.name === "sqlite close");
      expect(closeSpan).toBeUndefined();

      instrumentation.setConfig({});
    });
  });

  describe("enable/disable", () => {
    it("stops instrumentation when disabled", async () => {
      instrumentation.disable();

      const { SQL: PlainSQL } = require("bun") as { SQL: new (...args: any[]) => any };
      const plainSql = new PlainSQL({ adapter: "sqlite" });
      await plainSql`SELECT 1 as val`;
      plainSql.close();

      const spans = getSpans();
      expect(spans.length).toBe(0);

      // Re-enable for subsequent tests
      instrumentation.enable();
    });
  });
});
