/**
 * PostgreSQL adapter tests.
 *
 * Uses Bun.SQL with adapter: "postgres" to validate PostgreSQL-specific
 * instrumentation (db.system.name, error types, server attributes).
 *
 * PGlite (@electric-sql/pglite) is used as a standalone embedded PostgreSQL
 * to validate that our query parsing utilities handle PostgreSQL queries
 * correctly.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM_NAME,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "@opentelemetry/semantic-conventions";
import { PGlite } from "@electric-sql/pglite";

import { BunSqlInstrumentation } from "../src/instrumentation.js";
import {
  buildParameterizedQuery,
  buildQuerySummary,
  extractOperationName,
  getDbSystemName,
} from "../src/utils.js";

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let instrumentation: BunSqlInstrumentation;

function createPostgresSql() {
  const bun = require("bun") as {
    SQL: new (opts: Record<string, unknown>) => unknown;
  };
  if (bun.SQL === undefined) {
    throw new Error("SQL not found");
  }
  return new bun.SQL({
    adapter: "postgres",
    hostname: "localhost",
    port: 5432,
    database: "test_db",
  });
}

describe("PostgreSQL adapter detection", () => {
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
  });
  beforeEach(() => {
    exporter.reset();
    instrumentation = new BunSqlInstrumentation();
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  });
  afterEach(() => {
    instrumentation.disable();
  });

  test("maps postgres adapter to postgresql system name", () => {
    expect(getDbSystemName("postgres")).toBe("postgresql");
    expect(getDbSystemName("postgresql")).toBe("postgresql");
  });

  test("sets db.system.name to postgresql for postgres adapter", async () => {
    const sql = createPostgresSql() as ReturnType<typeof Function>;
    try {
      await sql`SELECT 1`;
    } catch {
      // Expected: connection failure
    }
    await (sql as { close: () => Promise<void> }).close();

    const spans = exporter.getFinishedSpans();
    const querySpan = spans.find(
      (s) => s.attributes[ATTR_DB_OPERATION_NAME] === "SELECT",
    );
    expect(querySpan).toBeDefined();
    expect(querySpan!.attributes[ATTR_DB_SYSTEM_NAME]).toBe("postgresql");
  });

  test("captures server address and port for postgres", async () => {
    const sql = createPostgresSql() as ReturnType<typeof Function>;
    try {
      await sql`SELECT 1`;
    } catch {
      // Expected
    }
    await (sql as { close: () => Promise<void> }).close();

    const spans = exporter.getFinishedSpans();
    const querySpan = spans.find(
      (s) => s.attributes[ATTR_DB_OPERATION_NAME] === "SELECT",
    );
    expect(querySpan).toBeDefined();
    expect(querySpan!.attributes[ATTR_SERVER_ADDRESS]).toBe("localhost");
    expect(querySpan!.attributes[ATTR_SERVER_PORT]).toBe(5432);
    expect(querySpan!.attributes[ATTR_DB_NAMESPACE]).toBe("test_db");
  });

  test("records PostgresError on connection failure", async () => {
    const sql = createPostgresSql() as ReturnType<typeof Function>;
    try {
      await sql`SELECT 1`;
    } catch {
      // Expected
    }
    await (sql as { close: () => Promise<void> }).close();

    const spans = exporter.getFinishedSpans();
    const errorSpan = spans.find(
      (s) => s.status.code === SpanStatusCode.ERROR,
    );
    expect(errorSpan).toBeDefined();
    expect(errorSpan!.attributes[ATTR_ERROR_TYPE]).toBe("PostgresError");
  });

  test("records PostgresError attributes for unsafe queries", async () => {
    const sql = createPostgresSql() as {
      unsafe: (q: string) => Promise<unknown>;
      close: () => Promise<void>;
    };
    try {
      await sql.unsafe("SELECT 1");
    } catch {
      // Expected
    }
    await sql.close();

    const spans = exporter.getFinishedSpans();
    const errorSpan = spans.find(
      (s) => s.status.code === SpanStatusCode.ERROR,
    );
    expect(errorSpan).toBeDefined();
    expect(errorSpan!.attributes[ATTR_DB_SYSTEM_NAME]).toBe("postgresql");
  });

  test("instruments postgres transactions with error handling", async () => {
    const sql = createPostgresSql() as {
      begin: (
        cb: (tx: ReturnType<typeof Function>) => Promise<void>,
      ) => Promise<void>;
      close: () => Promise<void>;
    };
    try {
      await sql.begin(async (tx: ReturnType<typeof Function>) => {
        await tx`SELECT 1`;
      });
    } catch {
      // Expected: connection failure
    }
    await sql.close();

    const spans = exporter.getFinishedSpans();
    const beginSpan = spans.find(
      (s) => s.attributes[ATTR_DB_OPERATION_NAME] === "BEGIN",
    );
    expect(beginSpan).toBeDefined();
    expect(beginSpan!.attributes[ATTR_DB_SYSTEM_NAME]).toBe("postgresql");
  });
});

describe("PGlite query compatibility", () => {
  let pg: PGlite;

  beforeEach(() => {
    pg = new PGlite();
  });
  afterEach(async () => {
    await pg.close();
  });

  test("extractOperationName handles PostgreSQL DDL", async () => {
    const result = await pg.query(
      "CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT)",
    );
    expect(result.affectedRows).toBe(0);
    expect(
      extractOperationName("CREATE TABLE test_users (id SERIAL PRIMARY KEY)"),
    ).toBe("CREATE");
  });

  test("extractOperationName handles PostgreSQL INSERT RETURNING", async () => {
    await pg.query(
      "CREATE TABLE pglite_test (id SERIAL PRIMARY KEY, name TEXT)",
    );
    const result = await pg.query(
      "INSERT INTO pglite_test (name) VALUES ('alice') RETURNING id, name",
    );
    expect(result.rows.length).toBe(1);
    expect(
      extractOperationName(
        "INSERT INTO pglite_test (name) VALUES ($1) RETURNING id, name",
      ),
    ).toBe("INSERT");
  });

  test("buildParameterizedQuery creates PostgreSQL-style parameters", () => {
    const strings = Object.assign(
      ["SELECT * FROM users WHERE name = ", " AND age > ", ""],
      { raw: ["SELECT * FROM users WHERE name = ", " AND age > ", ""] },
    ) as TemplateStringsArray;

    const query = buildParameterizedQuery(strings);
    expect(query).toBe("SELECT * FROM users WHERE name = $1 AND age > $2");

    expect(extractOperationName(query)).toBe("SELECT");
    expect(buildQuerySummary("SELECT", query)).toBe("SELECT users");
  });

  test("handles PostgreSQL CTE queries", async () => {
    await pg.query(
      "CREATE TABLE cte_test (id SERIAL PRIMARY KEY, parent_id INT, name TEXT)",
    );
    await pg.query(
      "INSERT INTO cte_test (parent_id, name) VALUES (NULL, 'root'), (1, 'child')",
    );

    const cteQuery = `
      WITH RECURSIVE tree AS (
        SELECT id, parent_id, name FROM cte_test WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.parent_id, c.name FROM cte_test c JOIN tree t ON c.parent_id = t.id
      )
      SELECT * FROM tree
    `;
    const result = await pg.query(cteQuery);
    expect(result.rows.length).toBe(2);

    // WITH is not in the SQL operations set — extractOperationName returns undefined
    expect(extractOperationName(cteQuery.trim())).toBeUndefined();
  });
});
