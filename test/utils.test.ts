/* oxlint-disable
  typescript-eslint/no-unsafe-type-assertion,
  typescript-eslint/no-unsafe-assignment,
  typescript-eslint/no-unsafe-call,
  typescript-eslint/no-unsafe-member-access,
  unicorn/no-useless-undefined
  ---
  Test file with Bun test framework types.
*/
import { describe, expect, it } from "bun:test";
import {
  buildParameterizedQuery,
  buildQuerySummary,
  buildSpanName,
  defaultSanitizeQuery,
  extractOperationName,
  extractTableName,
  getConnectionAttributes,
  getDbSystemName,
  getErrorAttributes,
  getQueryAttributes,
} from "../src/utils";

describe("getDbSystemName", () => {
  it("returns postgresql for postgres adapter", () => {
    expect(getDbSystemName("postgres")).toBe("postgresql");
    expect(getDbSystemName("postgresql")).toBe("postgresql");
  });

  it("returns mysql for mysql/mariadb adapter", () => {
    expect(getDbSystemName("mysql")).toBe("mysql");
    expect(getDbSystemName("mariadb")).toBe("mysql");
  });

  it("returns sqlite for sqlite adapter", () => {
    expect(getDbSystemName("sqlite")).toBe("sqlite");
  });

  it("defaults to postgresql for unknown adapter", () => {
    expect(getDbSystemName("unknown")).toBe("postgresql");
  });
});

describe("extractOperationName", () => {
  it("extracts SELECT", () => {
    expect(extractOperationName("SELECT * FROM users")).toBe("SELECT");
  });

  it("extracts INSERT", () => {
    expect(extractOperationName("INSERT INTO users (name) VALUES ($1)")).toBe(
      "INSERT",
    );
  });

  it("extracts UPDATE", () => {
    expect(extractOperationName("UPDATE users SET name = $1")).toBe("UPDATE");
  });

  it("extracts DELETE", () => {
    expect(extractOperationName("DELETE FROM users WHERE id = $1")).toBe(
      "DELETE",
    );
  });

  it("handles leading whitespace", () => {
    expect(extractOperationName("  SELECT * FROM users")).toBe("SELECT");
  });

  it("is case-insensitive", () => {
    expect(extractOperationName("select * from users")).toBe("SELECT");
  });

  it("returns undefined for unknown operations", () => {
    expect(extractOperationName("FOOBAR something")).toBeUndefined();
  });

  it("extracts BEGIN", () => {
    expect(extractOperationName("BEGIN")).toBe("BEGIN");
  });

  it("extracts COMMIT", () => {
    expect(extractOperationName("COMMIT")).toBe("COMMIT");
  });

  it("extracts ROLLBACK", () => {
    expect(extractOperationName("ROLLBACK")).toBe("ROLLBACK");
  });
});

describe("extractTableName", () => {
  it("extracts table from SELECT ... FROM", () => {
    expect(extractTableName("SELECT * FROM users WHERE id = 1")).toBe("users");
  });

  it("extracts table from INSERT INTO", () => {
    expect(
      extractTableName("INSERT INTO users (name) VALUES ('test')"),
    ).toBe("users");
  });

  it("extracts table from UPDATE", () => {
    expect(extractTableName("UPDATE users SET name = 'test'")).toBe("users");
  });

  it("extracts table from DELETE FROM", () => {
    expect(extractTableName("DELETE FROM users WHERE id = 1")).toBe("users");
  });

  it("returns undefined when no table can be extracted", () => {
    expect(extractTableName("BEGIN")).toBeUndefined();
    expect(extractTableName("COMMIT")).toBeUndefined();
  });
});

describe("buildQuerySummary", () => {
  it("combines operation and table", () => {
    expect(buildQuerySummary("SELECT", "users")).toBe("SELECT users");
  });

  it("returns operation alone", () => {
    expect(buildQuerySummary("BEGIN", undefined)).toBe("BEGIN");
  });

  it("returns table alone", () => {
    expect(buildQuerySummary(undefined, "users")).toBe("users");
  });

  it("returns undefined when both are undefined", () => {
    expect(buildQuerySummary(undefined, undefined)).toBeUndefined();
  });

  it("truncates to 255 characters", () => {
    const longTable = "a".repeat(300);
    const result = buildQuerySummary("SELECT", longTable);
    expect(result?.length).toBe(255);
  });
});

describe("buildSpanName", () => {
  it("uses query summary when available", () => {
    expect(buildSpanName("SELECT", "users", "mydb", "postgresql")).toBe(
      "SELECT users",
    );
  });

  it("uses query summary (operation only) when available", () => {
    // buildQuerySummary("BEGIN", undefined) = "BEGIN", so summary takes priority
    expect(buildSpanName("BEGIN", undefined, "mydb", "postgresql")).toBe(
      "BEGIN",
    );
  });

  it("uses namespace alone when no operation or table", () => {
    expect(buildSpanName(undefined, undefined, "mydb", "postgresql")).toBe(
      "mydb",
    );
  });

  it("falls back to db system name", () => {
    expect(
      buildSpanName(undefined, undefined, undefined, "postgresql"),
    ).toBe("postgresql");
  });
});

describe("defaultSanitizeQuery", () => {
  it("replaces string literals", () => {
    expect(
      defaultSanitizeQuery("SELECT * FROM users WHERE name = 'Alice'"),
    ).toBe("SELECT * FROM users WHERE name = ?");
  });

  it("replaces numeric literals", () => {
    expect(
      defaultSanitizeQuery("SELECT * FROM users WHERE id = 42"),
    ).toBe("SELECT * FROM users WHERE id = ?");
  });

  it("replaces decimal literals", () => {
    expect(
      defaultSanitizeQuery("SELECT * FROM items WHERE price > 19.99"),
    ).toBe("SELECT * FROM items WHERE price > ?");
  });

  it("collapses IN lists", () => {
    expect(
      defaultSanitizeQuery(
        "SELECT * FROM users WHERE id IN ('a', 'b', 'c')",
      ),
    ).toBe("SELECT * FROM users WHERE id IN (?)");
  });

  it("handles escaped quotes", () => {
    expect(
      defaultSanitizeQuery("SELECT * FROM users WHERE name = 'O\\'Brien'"),
    ).toBe("SELECT * FROM users WHERE name = ?");
  });
});

describe("getConnectionAttributes", () => {
  it("sets postgresql attributes", () => {
    const attrs = getConnectionAttributes({
      adapter: "postgres",
      hostname: "localhost",
      port: 5432,
      database: "mydb",
    });
    expect(attrs["db.system.name"]).toBe("postgresql");
    expect(attrs["db.namespace"]).toBe("mydb");
    expect(attrs["server.address"]).toBe("localhost");
    expect(attrs["server.port"]).toBe(5432);
  });

  it("sets sqlite attributes", () => {
    const attrs = getConnectionAttributes({
      adapter: "sqlite",
      filename: "/tmp/test.db",
    });
    expect(attrs["db.system.name"]).toBe("sqlite");
    expect(attrs["db.namespace"]).toBe("/tmp/test.db");
    expect(attrs["server.address"]).toBeUndefined();
  });

  it("skips :memory: for sqlite namespace", () => {
    const attrs = getConnectionAttributes({
      adapter: "sqlite",
      filename: ":memory:",
    });
    expect(attrs["db.namespace"]).toBeUndefined();
  });

  it("sets mysql attributes", () => {
    const attrs = getConnectionAttributes({
      adapter: "mysql",
      hostname: "db.example.com",
      port: 3306,
      database: "shop",
    });
    expect(attrs["db.system.name"]).toBe("mysql");
    expect(attrs["db.namespace"]).toBe("shop");
    expect(attrs["server.address"]).toBe("db.example.com");
    expect(attrs["server.port"]).toBe(3306);
  });
});

describe("getQueryAttributes", () => {
  it("includes operation name", () => {
    const attrs = getQueryAttributes("SELECT * FROM users", "SELECT", "users", false);
    expect(attrs["db.operation.name"]).toBe("SELECT");
    expect(attrs["db.query.summary"]).toBe("SELECT users");
    expect(attrs["db.query.text"]).toBeUndefined();
  });

  it("includes query text when requested", () => {
    const attrs = getQueryAttributes("SELECT * FROM users", "SELECT", "users", true);
    expect(attrs["db.query.text"]).toBe("SELECT * FROM users");
  });
});

describe("getErrorAttributes", () => {
  it("extracts error type and code", () => {
    const error = new Error("test");
    Object.assign(error, { code: "42P01" });
    const attrs = getErrorAttributes(error);
    expect(attrs["error.type"]).toBe("Error");
    expect(attrs["db.response.status_code"]).toBe("42P01");
  });

  it("handles errors without code", () => {
    const error = new Error("test");
    const attrs = getErrorAttributes(error);
    expect(attrs["error.type"]).toBe("Error");
    expect(attrs["db.response.status_code"]).toBeUndefined();
  });

  it("handles non-Error values", () => {
    const attrs = getErrorAttributes("string error");
    expect(attrs["error.type"]).toBeUndefined();
  });
});

describe("buildParameterizedQuery", () => {
  it("builds parameterized query from template strings", () => {
    const strings = Object.assign(["SELECT * FROM users WHERE id = ", ""], {
      raw: ["SELECT * FROM users WHERE id = ", ""],
    }) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe(
      "SELECT * FROM users WHERE id = $1",
    );
  });

  it("handles multiple parameters", () => {
    const strings = Object.assign(
      ["SELECT * FROM users WHERE id = ", " AND name = ", ""],
      {
        raw: ["SELECT * FROM users WHERE id = ", " AND name = ", ""],
      },
    ) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe(
      "SELECT * FROM users WHERE id = $1 AND name = $2",
    );
  });

  it("handles no parameters", () => {
    const strings = Object.assign(["SELECT 1"], {
      raw: ["SELECT 1"],
    }) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe("SELECT 1");
  });
});
