import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "bun:test";

import {
	ATTR_DB_OPERATION_NAME,
	ATTR_DB_SYSTEM_NAME,
} from "../src/semconv.ts";
import { createSql, exporter, getSpans } from "./helpers.ts";

afterEach(() => {
	exporter.reset();
});

// ─── Transactions ────────────────────────────────────────────────────────────

describe("transactions", () => {
	test("creates a span for begin/commit", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE tx_test (id INTEGER PRIMARY KEY, name TEXT)`;
		exporter.reset();

		await sql.begin(async (tx) => {
			await tx`INSERT INTO tx_test (name) VALUES (${"Alice"})`;
			await tx`INSERT INTO tx_test (name) VALUES (${"Bob"})`;
		});

		const spans = getSpans();

		// Should have: BEGIN span + 2 INSERT spans
		expect(spans.length).toBeGreaterThanOrEqual(3);

		// Find the BEGIN span
		const beginSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "BEGIN",
		);
		expect(beginSpan).toBeDefined();
		expect(beginSpan!.kind).toBe(SpanKind.CLIENT);
		expect(beginSpan!.status.code).toBe(SpanStatusCode.OK);

		// Find INSERT spans
		const insertSpans = spans.filter(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "INSERT",
		);
		expect(insertSpans).toHaveLength(2);

		// Verify INSERT spans are children of BEGIN span
		for (const insertSpan of insertSpans) {
			expect(insertSpan.parentSpanId).toBe(beginSpan!.spanContext().spanId);
		}

		sql.close();
	});

	test("records error and auto-rollback on transaction failure", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE tx_fail (id INTEGER PRIMARY KEY, name TEXT)`;
		exporter.reset();

		try {
			await sql.begin(async (tx) => {
				await tx`INSERT INTO tx_fail (name) VALUES (${"Alice"})`;
				throw new Error("simulated failure");
			});
		} catch {
			// expected
		}

		const spans = getSpans();

		// Find the BEGIN span - should be in error state
		const beginSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "BEGIN",
		);
		expect(beginSpan).toBeDefined();
		expect(beginSpan!.status.code).toBe(SpanStatusCode.ERROR);

		sql.close();
	});

	test("instruments queries within transactions using unsafe", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE tx_unsafe (id INTEGER PRIMARY KEY, val TEXT)`;
		exporter.reset();

		await sql.begin(async (tx) => {
			await tx.unsafe("INSERT INTO tx_unsafe (val) VALUES ('test')");
		});

		const spans = getSpans();

		const insertSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "INSERT",
		);
		expect(insertSpan).toBeDefined();
		expect(insertSpan!.attributes[ATTR_DB_SYSTEM_NAME]).toBe("sqlite");

		sql.close();
	});

	test("transaction queries maintain correct parent-child hierarchy", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE tx_hierarchy (id INTEGER PRIMARY KEY, val INTEGER)`;
		exporter.reset();

		await sql.begin(async (tx) => {
			await tx`INSERT INTO tx_hierarchy (val) VALUES (${1})`;
			await tx`SELECT * FROM tx_hierarchy`;
		});

		const spans = getSpans();
		const beginSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "BEGIN",
		);
		expect(beginSpan).toBeDefined();

		const childSpans = spans.filter(
			(s) => s.parentSpanId === beginSpan!.spanContext().spanId,
		);

		expect(childSpans.length).toBe(2);

		sql.close();
	});
});

// ─── Savepoints ──────────────────────────────────────────────────────────────

describe("savepoints", () => {
	test("creates spans for savepoint operations", async () => {
		const { sql } = createSql();

		await sql`CREATE TABLE sp_test (id INTEGER PRIMARY KEY, name TEXT)`;
		exporter.reset();

		await sql.begin(async (tx) => {
			await tx`INSERT INTO sp_test (name) VALUES (${"outer"})`;

			await tx.savepoint(async (sp) => {
				await sp`INSERT INTO sp_test (name) VALUES (${"inner"})`;
			});
		});

		const spans = getSpans();

		// Should have: BEGIN, INSERT (outer), SAVEPOINT, INSERT (inner)
		const beginSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "BEGIN",
		);
		const savepointSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "SAVEPOINT",
		);

		expect(beginSpan).toBeDefined();
		expect(savepointSpan).toBeDefined();

		// SAVEPOINT should be child of BEGIN
		expect(savepointSpan!.parentSpanId).toBe(beginSpan!.spanContext().spanId);

		// Inner INSERT should be child of SAVEPOINT
		const innerInsert = spans.find(
			(s) =>
				s.attributes[ATTR_DB_OPERATION_NAME] === "INSERT" &&
				s.parentSpanId === savepointSpan!.spanContext().spanId,
		);
		expect(innerInsert).toBeDefined();

		sql.close();
	});
});

// ─── Connection Management ───────────────────────────────────────────────────

describe("connection management", () => {
	test("creates span for close", async () => {
		const { sql } = createSql();

		await sql`SELECT 1 as num`;
		exporter.reset();

		await sql.close();

		const spans = getSpans();
		const closeSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "CLOSE",
		);
		expect(closeSpan).toBeDefined();
		expect(closeSpan!.kind).toBe(SpanKind.CLIENT);
	});

	test("ignoreConnectionSpans suppresses close span", async () => {
		const { sql } = createSql({ ignoreConnectionSpans: true });

		await sql`SELECT 1 as num`;
		exporter.reset();

		await sql.close();

		const spans = getSpans();
		const closeSpan = spans.find(
			(s) => s.attributes[ATTR_DB_OPERATION_NAME] === "CLOSE",
		);
		expect(closeSpan).toBeUndefined();
	});
});
