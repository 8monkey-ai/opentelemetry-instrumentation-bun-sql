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
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  SQL,
  exporter,
  getParentSpanId,
  getSpans,
  instrumentation,
} from "./setup";

describe("BunSqlInstrumentation with PostgreSQL (PGlite)", () => {
  let db: InstanceType<typeof PGlite>;
  let server: InstanceType<typeof PGLiteSocketServer>;
  let sql: any;
  const port = 15433;

  beforeAll(async () => {
    db = await PGlite.create();
    server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
    await server.start();

    sql = new SQL(`postgres://127.0.0.1:${String(port)}`);

    // Create test table
    await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT)`;

    // Clear spans generated during setup
    exporter.reset();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await sql.close();
    await server.stop();
    await db.close();
  });

  describe("query operations", () => {
    it("creates spans with postgresql system name", async () => {
      await sql`SELECT 1 as val`;
      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes["db.system.name"]).toBe("postgresql");
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
    });

    it("sets server address and port", async () => {
      await sql`SELECT 1 as val`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["server.address"]).toBe("127.0.0.1");
      expect(span.attributes["server.port"]).toBe(port);
    });

    it("instruments INSERT queries", async () => {
      await sql`INSERT INTO users (name, email) VALUES (${"Alice"}, ${"alice@example.com"})`;
      const spans = getSpans();
      expect(spans.length).toBe(1);

      const span = spans[0]!;
      expect(span.attributes["db.operation.name"]).toBe("INSERT");
      expect(span.name).toBe("INSERT users");
      expect(span.attributes["db.query.summary"]).toBe("INSERT users");
    });

    it("instruments SELECT with table name", async () => {
      await sql`SELECT * FROM users WHERE name = ${"Alice"}`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
      expect(span.name).toBe("SELECT users");
    });

    it("instruments UPDATE queries", async () => {
      await sql`UPDATE users SET email = ${"alice@test.com"} WHERE name = ${"Alice"}`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.operation.name"]).toBe("UPDATE");
      expect(span.name).toBe("UPDATE users");
    });

    it("instruments DELETE queries", async () => {
      await sql`DELETE FROM users WHERE name = ${"nonexistent"}`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.operation.name"]).toBe("DELETE");
      expect(span.name).toBe("DELETE users");
    });
  });

  describe("unsafe queries", () => {
    it("sanitizes non-parameterized queries", async () => {
      await sql.unsafe("SELECT * FROM users WHERE name = 'Bob'");
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.query.text"]).toBe(
        "SELECT * FROM users WHERE name = ?",
      );
    });

    it("captures operation and table from unsafe queries", async () => {
      await sql.unsafe("SELECT * FROM users LIMIT 10");
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.operation.name"]).toBe("SELECT");
      expect(span.name).toBe("SELECT users");
    });
  });

  describe("transactions", () => {
    it("instruments transactions with context propagation", async () => {
      await sql.begin(async (tx: any) => {
        await tx`INSERT INTO users (name, email) VALUES (${"Bob"}, ${"bob@example.com"})`;
        await tx`SELECT * FROM users WHERE name = ${"Bob"}`;
      });

      const spans = getSpans();
      const beginSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "BEGIN",
      );
      const insertSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "INSERT",
      );
      const selectSpan = spans.find(
        (s) => s.attributes["db.operation.name"] === "SELECT",
      );

      expect(beginSpan).toBeDefined();
      expect(insertSpan).toBeDefined();
      expect(selectSpan).toBeDefined();

      // Both queries should be children of the BEGIN span
      expect(getParentSpanId(insertSpan!)).toBe(
        beginSpan!.spanContext().spanId,
      );
      expect(getParentSpanId(selectSpan!)).toBe(
        beginSpan!.spanContext().spanId,
      );
    });

    it("records error on transaction rollback", async () => {
      try {
        await sql.begin(async () => {
          throw new Error("Intentional rollback");
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
    it("records error for invalid SQL", async () => {
      try {
        await sql`SELECT * FROM completely_nonexistent_table`;
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

  describe("enhanced reporting", () => {
    it("includes query parameters when enabled", async () => {
      instrumentation.setConfig({ enhancedDatabaseReporting: true });

      await sql`SELECT * FROM users WHERE name = ${"Alice"} AND email = ${"alice@test.com"}`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.query.parameter.0"]).toBe("Alice");
      expect(span.attributes["db.query.parameter.1"]).toBe("alice@test.com");

      instrumentation.setConfig({});
    });

    it("includes returned rows count when enabled", async () => {
      instrumentation.setConfig({ enhancedDatabaseReporting: true });

      await sql`SELECT * FROM users`;
      const spans = getSpans();
      const span = spans[0]!;
      expect(span.attributes["db.response.returned_rows"]).toBeGreaterThanOrEqual(0);

      instrumentation.setConfig({});
    });
  });
});
