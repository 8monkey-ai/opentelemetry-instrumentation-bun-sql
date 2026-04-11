import { describe, expect, test } from "bun:test";

import {
  buildParameterizedQuery,
  buildSpanName,
  extractOperationName,
  getDbNamespace,
  getDbSystemName,
  getServerAddress,
  getServerPort,
  sanitizeQuery,
} from "../src/utils.js";

describe("extractOperationName", () => {
  test("extracts SELECT", () => {
    expect(extractOperationName("SELECT * FROM users")).toBe("SELECT");
  });

  test("extracts INSERT", () => {
    expect(extractOperationName("INSERT INTO users (name) VALUES ($1)")).toBe(
      "INSERT",
    );
  });

  test("extracts UPDATE", () => {
    expect(extractOperationName("UPDATE users SET name = $1")).toBe("UPDATE");
  });

  test("extracts DELETE", () => {
    expect(extractOperationName("DELETE FROM users WHERE id = $1")).toBe(
      "DELETE",
    );
  });

  test("extracts CREATE", () => {
    expect(extractOperationName("CREATE TABLE users (id INT)")).toBe("CREATE");
  });

  test("extracts BEGIN", () => {
    expect(extractOperationName("BEGIN")).toBe("BEGIN");
  });

  test("handles leading whitespace", () => {
    expect(extractOperationName("  \n  SELECT 1")).toBe("SELECT");
  });

  test("is case-insensitive", () => {
    expect(extractOperationName("select * from users")).toBe("SELECT");
  });

  test("returns first word for any operation", () => {
    expect(extractOperationName("FOOBAR something")).toBe("FOOBAR");
  });

  test("returns undefined for empty string", () => {
    expect(extractOperationName("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only", () => {
    expect(extractOperationName("   ")).toBeUndefined();
  });

  test("handles trailing semicolon", () => {
    expect(extractOperationName("BEGIN;")).toBe("BEGIN");
  });
});

describe("buildParameterizedQuery", () => {
  test("builds simple query without parameters", () => {
    const strings = Object.assign(["SELECT 1"], {
      raw: ["SELECT 1"],
    }) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe("SELECT 1");
  });

  test("builds query with one parameter", () => {
    const strings = Object.assign(["SELECT * FROM users WHERE id = ", ""], {
      raw: ["SELECT * FROM users WHERE id = ", ""],
    }) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe(
      "SELECT * FROM users WHERE id = $1",
    );
  });

  test("builds query with multiple parameters", () => {
    const strings = Object.assign(
      ["INSERT INTO users (name, age) VALUES (", ", ", ")"],
      {
        raw: ["INSERT INTO users (name, age) VALUES (", ", ", ")"],
      },
    ) as TemplateStringsArray;
    expect(buildParameterizedQuery(strings)).toBe(
      "INSERT INTO users (name, age) VALUES ($1, $2)",
    );
  });
});

describe("sanitizeQuery", () => {
  test("replaces single-quoted strings", () => {
    expect(sanitizeQuery("SELECT * FROM users WHERE name = 'alice'")).toBe(
      "SELECT * FROM users WHERE name = ?",
    );
  });

  test("replaces escaped quotes in strings", () => {
    expect(sanitizeQuery("SELECT * WHERE name = 'it\\'s'")).toBe(
      "SELECT * WHERE name = ?",
    );
  });

  test("replaces integer literals", () => {
    expect(sanitizeQuery("SELECT * FROM users WHERE id = 42")).toBe(
      "SELECT * FROM users WHERE id = ?",
    );
  });

  test("replaces integer part of decimal literals", () => {
    expect(sanitizeQuery("SELECT * WHERE price > 3.14")).toBe(
      "SELECT * WHERE price > ?.?",
    );
  });

  test("preserves identifiers and keywords", () => {
    expect(sanitizeQuery("SELECT name, age FROM users")).toBe(
      "SELECT name, age FROM users",
    );
  });

  test("handles multiple replacements", () => {
    expect(
      sanitizeQuery(
        "SELECT * FROM users WHERE name = 'alice' AND age = 30",
      ),
    ).toBe("SELECT * FROM users WHERE name = ? AND age = ?");
  });

  test("preserves qualified names with dots", () => {
    expect(sanitizeQuery("SELECT schema.table FROM t")).toBe(
      "SELECT schema.table FROM t",
    );
  });
});

describe("buildSpanName", () => {
  test("uses operation + namespace", () => {
    expect(
      buildSpanName({
        operationName: "SELECT",
        namespace: "mydb",
        systemName: "postgresql",
      }),
    ).toBe("SELECT mydb");
  });

  test("uses operation alone when no namespace", () => {
    expect(
      buildSpanName({
        operationName: "SELECT",
        systemName: "postgresql",
      }),
    ).toBe("SELECT");
  });

  test("uses namespace alone when no operation", () => {
    expect(
      buildSpanName({
        namespace: "mydb",
        systemName: "postgresql",
      }),
    ).toBe("mydb");
  });

  test("falls back to systemName", () => {
    expect(
      buildSpanName({
        systemName: "postgresql",
      }),
    ).toBe("postgresql");
  });
});

describe("getDbSystemName", () => {
  test("maps postgres to postgresql", () => {
    expect(getDbSystemName("postgres")).toBe("postgresql");
  });

  test("maps postgresql to postgresql", () => {
    expect(getDbSystemName("postgresql")).toBe("postgresql");
  });

  test("maps mysql", () => {
    expect(getDbSystemName("mysql")).toBe("mysql");
  });

  test("maps sqlite", () => {
    expect(getDbSystemName("sqlite")).toBe("sqlite");
  });

  test("returns unknown for undefined", () => {
    const noAdapter: string | undefined = undefined;
    expect(getDbSystemName(noAdapter)).toBe("unknown");
  });

  test("passes through unrecognized adapters", () => {
    expect(getDbSystemName("cockroachdb")).toBe("cockroachdb");
  });
});

describe("getDbNamespace", () => {
  test("returns database name", () => {
    expect(getDbNamespace({ database: "mydb" })).toBe("mydb");
  });

  test("returns filename for sqlite", () => {
    expect(getDbNamespace({ filename: "/tmp/test.db" })).toBe("/tmp/test.db");
  });

  test("returns :memory: for in-memory sqlite", () => {
    expect(getDbNamespace({ filename: ":memory:" })).toBe(":memory:");
  });

  test("returns undefined when no database info", () => {
    expect(getDbNamespace({})).toBeUndefined();
  });
});

describe("getServerAddress", () => {
  test("returns hostname", () => {
    expect(getServerAddress({ hostname: "db.example.com" })).toBe(
      "db.example.com",
    );
  });

  test("returns host", () => {
    expect(getServerAddress({ host: "localhost" })).toBe("localhost");
  });

  test("prefers hostname over host", () => {
    expect(
      getServerAddress({ hostname: "db.example.com", host: "localhost" }),
    ).toBe("db.example.com");
  });

  test("returns undefined when no host info", () => {
    expect(getServerAddress({})).toBeUndefined();
  });
});

describe("getServerPort", () => {
  test("returns port number", () => {
    expect(getServerPort({ port: 5432 })).toBe(5432);
  });

  test("returns undefined when no port", () => {
    expect(getServerPort({})).toBeUndefined();
  });
});
