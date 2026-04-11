import { describe, expect, test } from "bun:test";

import {
	buildParameterizedQuery,
	buildQuerySummary,
	buildSpanName,
	detectDbSystem,
	extractNamespace,
	extractOperationName,
	extractServerAddress,
	extractServerPort,
	extractTableName,
	sanitizeQuery,
} from "../src/utils.ts";

describe("extractOperationName", () => {
	test("extracts SELECT", () => {
		expect(extractOperationName("SELECT * FROM users")).toBe("SELECT");
	});

	test("extracts INSERT", () => {
		expect(extractOperationName("INSERT INTO users (name) VALUES ('test')")).toBe("INSERT");
	});

	test("extracts UPDATE", () => {
		expect(extractOperationName("UPDATE users SET name = 'test'")).toBe("UPDATE");
	});

	test("extracts DELETE", () => {
		expect(extractOperationName("DELETE FROM users WHERE id = 1")).toBe("DELETE");
	});

	test("extracts CREATE", () => {
		expect(extractOperationName("CREATE TABLE users (id INT)")).toBe("CREATE");
	});

	test("extracts BEGIN", () => {
		expect(extractOperationName("BEGIN")).toBe("BEGIN");
	});

	test("extracts COMMIT", () => {
		expect(extractOperationName("COMMIT")).toBe("COMMIT");
	});

	test("extracts ROLLBACK", () => {
		expect(extractOperationName("ROLLBACK")).toBe("ROLLBACK");
	});

	test("handles leading whitespace", () => {
		expect(extractOperationName("  SELECT 1")).toBe("SELECT");
	});

	test("is case-insensitive", () => {
		expect(extractOperationName("select * from users")).toBe("SELECT");
	});

	test("returns undefined for unrecognized", () => {
		expect(extractOperationName("VACUUM")).toBeUndefined();
	});

	test("extracts WITH (CTE)", () => {
		expect(extractOperationName("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe("WITH");
	});
});

describe("extractTableName", () => {
	test("extracts from SELECT ... FROM", () => {
		expect(extractTableName("SELECT * FROM users")).toBe("users");
	});

	test("extracts from INSERT INTO", () => {
		expect(extractTableName("INSERT INTO orders (item) VALUES ('x')")).toBe("orders");
	});

	test("extracts from UPDATE", () => {
		expect(extractTableName("UPDATE products SET price = 10")).toBe("products");
	});

	test("extracts from DELETE FROM", () => {
		expect(extractTableName("DELETE FROM sessions WHERE expired = true")).toBe("sessions");
	});

	test("extracts from CREATE TABLE", () => {
		expect(extractTableName("CREATE TABLE new_table (id INT)")).toBe("new_table");
	});

	test("handles quoted table names", () => {
		expect(extractTableName('SELECT * FROM "my_table"')).toBe("my_table");
	});

	test("returns undefined for simple statements", () => {
		expect(extractTableName("BEGIN")).toBeUndefined();
	});
});

describe("buildSpanName", () => {
	test("priority 1: operation + table", () => {
		expect(buildSpanName("postgresql", "SELECT", "users")).toBe("SELECT users");
	});

	test("priority 2: operation + namespace", () => {
		expect(buildSpanName("postgresql", "SELECT", undefined, "mydb")).toBe("SELECT mydb");
	});

	test("priority 3: namespace alone", () => {
		expect(buildSpanName("postgresql", undefined, undefined, "mydb")).toBe("mydb");
	});

	test("priority 4: db.system.name fallback", () => {
		expect(buildSpanName("postgresql")).toBe("postgresql");
	});

	test("truncates to 255 characters", () => {
		const longTable = "a".repeat(300);
		const result = buildSpanName("postgresql", "SELECT", longTable);
		expect(result.length).toBe(255);
	});
});

describe("sanitizeQuery", () => {
	test("replaces string literals", () => {
		expect(sanitizeQuery("SELECT * FROM users WHERE name = 'Alice'")).toBe(
			"SELECT * FROM users WHERE name = ?",
		);
	});

	test("replaces numeric literals", () => {
		expect(sanitizeQuery("SELECT * FROM users WHERE id = 42")).toBe(
			"SELECT * FROM users WHERE id = ?",
		);
	});

	test("replaces boolean literals", () => {
		expect(sanitizeQuery("SELECT * FROM users WHERE active = TRUE")).toBe(
			"SELECT * FROM users WHERE active = ?",
		);
	});

	test("replaces NULL", () => {
		expect(sanitizeQuery("SELECT * FROM users WHERE email IS NULL")).toBe(
			"SELECT * FROM users WHERE email IS ?",
		);
	});

	test("replaces multiple literals", () => {
		expect(
			sanitizeQuery("SELECT * FROM users WHERE name = 'Alice' AND age > 30"),
		).toBe("SELECT * FROM users WHERE name = ? AND age > ?");
	});

	test("preserves parameterized placeholders", () => {
		expect(sanitizeQuery("SELECT * FROM users WHERE id = $1")).toBe(
			"SELECT * FROM users WHERE id = $?",
		);
	});
});

describe("buildParameterizedQuery", () => {
	test("builds query from template parts", () => {
		const strings = ["SELECT * FROM users WHERE id = ", " AND name = ", ""];
		expect(buildParameterizedQuery(strings, 2)).toBe(
			"SELECT * FROM users WHERE id = $1 AND name = $2",
		);
	});

	test("handles no parameters", () => {
		const strings = ["SELECT 1 as num"];
		expect(buildParameterizedQuery(strings, 0)).toBe("SELECT 1 as num");
	});

	test("handles single parameter", () => {
		const strings = ["SELECT ", " as val"];
		expect(buildParameterizedQuery(strings, 1)).toBe("SELECT $1 as val");
	});
});

describe("buildQuerySummary", () => {
	test("returns operation + table for DML", () => {
		expect(buildQuerySummary("SELECT * FROM users WHERE id = $1")).toBe("SELECT users");
	});

	test("returns operation alone when no table", () => {
		expect(buildQuerySummary("BEGIN")).toBe("BEGIN");
	});

	test("returns undefined for unrecognized", () => {
		expect(buildQuerySummary("VACUUM")).toBeUndefined();
	});
});

describe("detectDbSystem", () => {
	test("detects postgresql from adapter", () => {
		expect(detectDbSystem({ adapter: "postgres" })).toBe("postgresql");
	});

	test("detects postgresql from URL", () => {
		expect(detectDbSystem({ url: "postgres://localhost/mydb" })).toBe("postgresql");
	});

	test("detects mysql from adapter", () => {
		expect(detectDbSystem({ adapter: "mysql" })).toBe("mysql");
	});

	test("detects mysql from URL", () => {
		expect(detectDbSystem({ url: "mysql://localhost/mydb" })).toBe("mysql");
	});

	test("detects sqlite from adapter", () => {
		expect(detectDbSystem({ adapter: "sqlite" })).toBe("sqlite");
	});

	test("detects sqlite from URL", () => {
		expect(detectDbSystem({ url: "sqlite://:memory:" })).toBe("sqlite");
	});

	test("defaults to postgresql", () => {
		expect(detectDbSystem({})).toBe("postgresql");
	});
});

describe("extractNamespace", () => {
	test("extracts database name", () => {
		expect(extractNamespace({ database: "mydb" })).toBe("mydb");
	});

	test("extracts filename for sqlite", () => {
		expect(extractNamespace({ filename: ":memory:" })).toBe(":memory:");
	});

	test("prefers database over filename", () => {
		expect(extractNamespace({ database: "mydb", filename: ":memory:" })).toBe("mydb");
	});

	test("returns undefined when neither set", () => {
		expect(extractNamespace({})).toBeUndefined();
	});
});

describe("extractServerAddress", () => {
	test("extracts hostname", () => {
		expect(extractServerAddress({ hostname: "db.example.com" })).toBe("db.example.com");
	});

	test("extracts host as fallback", () => {
		expect(extractServerAddress({ host: "localhost" })).toBe("localhost");
	});

	test("prefers hostname over host", () => {
		expect(extractServerAddress({ hostname: "primary", host: "secondary" })).toBe("primary");
	});
});

describe("extractServerPort", () => {
	test("returns port when non-default for postgresql", () => {
		expect(extractServerPort({ port: 5433 }, "postgresql")).toBe(5433);
	});

	test("returns undefined for default postgresql port", () => {
		expect(extractServerPort({ port: 5432 }, "postgresql")).toBeUndefined();
	});

	test("returns port when non-default for mysql", () => {
		expect(extractServerPort({ port: 3307 }, "mysql")).toBe(3307);
	});

	test("returns undefined for default mysql port", () => {
		expect(extractServerPort({ port: 3306 }, "mysql")).toBeUndefined();
	});
});
