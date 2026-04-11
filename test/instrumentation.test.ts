import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "bun:test";

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
} from "../src/semconv.ts";
import { createSql, exporter, getSpan, getSpans } from "./helpers.ts";

afterEach(() => {
	exporter.reset();
});

// ─── Tagged Template Queries ─────────────────────────────────────────────────

describe("tagged template queries", () => {
	test("creates a span for a simple query", async () => {
		const { sql } = createSql();

		const result = await sql`SELECT 1 as num`;

		expect(result).toEqual([{ num: 1 }]);

		const span = getSpan();
		expect(span.name).toBe("SELECT :memory:");
		expect(span.kind).toBe(SpanKind.CLIENT);
		expect(span.status.code).toBe(SpanStatusCode.OK);
		expect(span.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("SELECT");
		expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe("SELECT 1 as num");
		expect(span.attributes[ATTR_DB_NAMESPACE]).toBe(":memory:");

		sql.close();
	});

	test("creates a span with parameterized query text", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)`;
		exporter.reset();

		const name = "Alice";
		const age = 30;
		await sql`INSERT INTO users (name, age) VALUES (${name}, ${age})`;

		const span = getSpan();
		expect(span.name).toBe("INSERT users");
		expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe(
			"INSERT INTO users (name, age) VALUES ($1, $2)",
		);
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("INSERT");
		expect(span.attributes[ATTR_DB_QUERY_SUMMARY]).toBe("INSERT users");

		sql.close();
	});

	test("captures query summary for SELECT with table", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT)`;
		await sql`INSERT INTO products (title) VALUES (${"Widget"})`;
		exporter.reset();

		await sql`SELECT * FROM products WHERE id = ${1}`;

		const span = getSpan();
		expect(span.name).toBe("SELECT products");
		expect(span.attributes[ATTR_DB_QUERY_SUMMARY]).toBe("SELECT products");

		sql.close();
	});

	test("does not capture parameters by default", async () => {
		const { sql } = createSql();

		const value = "test";
		await sql`SELECT ${value} as x`;

		const span = getSpan();
		expect(span.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]).toBeUndefined();

		sql.close();
	});

	test("captures parameters with enhancedDatabaseReporting", async () => {
		const { sql } = createSql({ enhancedDatabaseReporting: true });

		const value = "test";
		await sql`SELECT ${value} as x`;

		const span = getSpan();
		expect(span.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]).toBe("test");

		sql.close();
	});
});

// ─── Unsafe Queries ──────────────────────────────────────────────────────────

describe("unsafe queries", () => {
	test("creates a span for unsafe query", async () => {
		const { sql } = createSql();

		const result = await sql.unsafe("SELECT 1 as num");

		expect(result).toEqual([{ num: 1 }]);

		const span = getSpan();
		expect(span.name).toBe("SELECT :memory:");
		expect(span.kind).toBe(SpanKind.CLIENT);
		expect(span.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");

		sql.close();
	});

	test("sanitizes non-parameterized queries by default", async () => {
		const { sql } = createSql();

		await sql.unsafe("SELECT * FROM sqlite_master WHERE name = 'test' AND type = 'table'");

		const span = getSpan();
		expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe(
			"SELECT * FROM sqlite_master WHERE name = ? AND type = ?",
		);

		sql.close();
	});

	test("does not sanitize when disabled", async () => {
		const { sql } = createSql({ sanitizeNonParameterizedQueries: false });

		await sql.unsafe("SELECT * FROM sqlite_master WHERE name = 'test'");

		const span = getSpan();
		expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe(
			"SELECT * FROM sqlite_master WHERE name = 'test'",
		);

		sql.close();
	});

	test("uses custom sanitization hook", async () => {
		const { sql } = createSql({
			sanitizationHook: (query) => query.replaceAll(/\b\d+\b/g, "REDACTED"),
		});

		await sql.unsafe("SELECT 42 as num");

		const span = getSpan();
		expect(span.attributes[ATTR_DB_QUERY_TEXT]).toBe("SELECT REDACTED as num");

		sql.close();
	});

	test("captures parameters with enhancedDatabaseReporting", async () => {
		const { sql } = createSql({ enhancedDatabaseReporting: true });

		await sql.unsafe("SELECT ? as x", ["hello"]);

		const span = getSpan();
		expect(span.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]).toBe("hello");

		sql.close();
	});
});

// ─── Error Handling ──────────────────────────────────────────────────────────

describe("error handling", () => {
	test("records error on failed tagged template query", async () => {
		const { sql } = createSql();

		try {
			await sql`SELECT * FROM nonexistent_table`;
		} catch {
			// expected
		}

		const span = getSpan();
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.attributes[ATTR_ERROR_TYPE]).toBe("SQLiteError");
		expect(span.attributes[ATTR_DB_RESPONSE_STATUS_CODE]).toBe("SQLITE_ERROR");
		expect(span.events.length).toBeGreaterThan(0);
		expect(span.events[0]?.name).toBe("exception");

		sql.close();
	});

	test("records error on failed unsafe query", async () => {
		const { sql } = createSql();

		try {
			await sql.unsafe("INVALID SQL SYNTAX HERE !!!");
		} catch {
			// expected
		}

		const span = getSpan();
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.attributes[ATTR_ERROR_TYPE]).toBe("SQLiteError");

		sql.close();
	});
});

// ─── Configuration ───────────────────────────────────────────────────────────

describe("configuration", () => {
	test("does not create spans when disabled", async () => {
		const { sql } = createSql({ enabled: false });

		await sql`SELECT 1 as num`;

		expect(getSpans()).toHaveLength(0);

		sql.close();
	});

	test("requireParentSpan suppresses orphan spans", async () => {
		const { sql } = createSql({ requireParentSpan: true });

		// No parent span active
		await sql`SELECT 1 as num`;

		expect(getSpans()).toHaveLength(0);

		sql.close();
	});

	test("requireParentSpan allows spans with explicit parent context", async () => {
		const { sql } = createSql({ requireParentSpan: true });

		const tracer = trace.getTracer("test");
		const parentSpan = tracer.startSpan("parent");
		const parentCtx = trace.setSpan(context.active(), parentSpan);

		// Run the query within the parent span's context
		await context.with(parentCtx, () => sql`SELECT 1 as num`);
		parentSpan.end();

		const spans = getSpans();
		// Should have parent span + query span
		expect(spans.length).toBeGreaterThanOrEqual(2);

		sql.close();
	});

	test("requestHook is called before query execution", async () => {
		let hookCalled = false;
		let hookQuery = "";

		const { sql } = createSql({
			requestHook: (_span, info) => {
				hookCalled = true;
				hookQuery = info.query;
			},
		});

		await sql`SELECT 1 as num`;

		expect(hookCalled).toBe(true);
		expect(hookQuery).toBe("SELECT 1 as num");

		sql.close();
	});

	test("responseHook is called after query execution", async () => {
		let hookCalled = false;
		let hookRowCount = -1;

		const { sql } = createSql({
			responseHook: (_span, info) => {
				hookCalled = true;
				hookRowCount = info.rowCount;
			},
		});

		await sql`SELECT 1 as num`;

		expect(hookCalled).toBe(true);
		expect(hookRowCount).toBe(1);

		sql.close();
	});

	test("responseHook includes command info", async () => {
		let hookCommand = "";

		const { sql } = createSql({
			responseHook: (_span, info) => {
				hookCommand = info.command ?? "";
			},
		});

		await sql`SELECT 1 as num`;

		expect(hookCommand).toBe("SELECT");

		sql.close();
	});

	test("enhancedDatabaseReporting captures returned rows count", async () => {
		const { sql } = createSql({ enhancedDatabaseReporting: true });

		await sql`SELECT 1 as a UNION ALL SELECT 2 as a`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_RESPONSE_RETURNED_ROWS]).toBe(2);

		sql.close();
	});

	test("hook errors do not break query execution", async () => {
		const { sql } = createSql({
			requestHook: () => {
				throw new Error("hook error");
			},
			responseHook: () => {
				throw new Error("hook error");
			},
		});

		const result = await sql`SELECT 1 as num`;
		expect(result).toEqual([{ num: 1 }]);

		sql.close();
	});
});

// ─── Connection Attributes ───────────────────────────────────────────────────

describe("connection attributes", () => {
	test("sets db.system.name to sqlite for sqlite URLs", async () => {
		const { sql } = createSql();

		await sql`SELECT 1 as num`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");

		sql.close();
	});

	test("sets db.namespace for sqlite", async () => {
		const { sql } = createSql();

		await sql`SELECT 1 as num`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_NAMESPACE]).toBe(":memory:");

		sql.close();
	});
});

// ─── Double Instrumentation Guard ────────────────────────────────────────────

describe("double instrumentation guard", () => {
	test("does not double-wrap an already instrumented instance", async () => {
		const { sql, instrumentation } = createSql();

		const sql2 = instrumentation.instrument(sql);

		// Should be the same proxy
		expect(sql).toBe(sql2);

		await sql`SELECT 1 as num`;

		// Should only have one span, not two
		expect(getSpans()).toHaveLength(1);

		sql.close();
	});
});

// ─── Multiple Query Types ────────────────────────────────────────────────────

describe("multiple query operations", () => {
	test("instruments CREATE TABLE", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE IF NOT EXISTS test_ops (id INTEGER PRIMARY KEY, val TEXT)`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("CREATE");

		sql.close();
	});

	test("instruments INSERT", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE test_insert (id INTEGER PRIMARY KEY, val TEXT)`;
		exporter.reset();

		await sql`INSERT INTO test_insert (val) VALUES (${"hello"})`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("INSERT");
		expect(span.name).toBe("INSERT test_insert");

		sql.close();
	});

	test("instruments UPDATE", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE test_update (id INTEGER PRIMARY KEY, val TEXT)`;
		await sql`INSERT INTO test_update (val) VALUES (${"hello"})`;
		exporter.reset();

		await sql`UPDATE test_update SET val = ${"world"} WHERE id = ${1}`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("UPDATE");
		expect(span.name).toBe("UPDATE test_update");

		sql.close();
	});

	test("instruments DELETE", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE test_delete (id INTEGER PRIMARY KEY, val TEXT)`;
		await sql`INSERT INTO test_delete (val) VALUES (${"hello"})`;
		exporter.reset();

		await sql`DELETE FROM test_delete WHERE id = ${1}`;

		const span = getSpan();
		expect(span.attributes[ATTR_DB_OPERATION_NAME]).toBe("DELETE");
		expect(span.name).toBe("DELETE test_delete");

		sql.close();
	});
});
