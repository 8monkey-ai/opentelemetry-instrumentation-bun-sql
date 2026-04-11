# OpenTelemetry Bun.SQL Instrumentation

[![NPM Published Version][npm-img]][npm-url]
[![Apache License][license-image]][license-image]

OpenTelemetry instrumentation for [Bun.SQL](https://bun.sh/docs/api/sql), the built-in database client in Bun supporting PostgreSQL, MySQL, and SQLite.

## Installation

```bash
bun add @8monkey/opentelemetry-instrumentation-bun-sql
```

## Supported Versions

- Bun >= 1.2

## Usage

```typescript
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

registerInstrumentations({
  instrumentations: [new BunSqlInstrumentation()],
});
```

### With a full trace pipeline

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

registerInstrumentations({
  instrumentations: [new BunSqlInstrumentation()],
});

// Now all Bun.SQL queries are automatically traced
const sql = new Bun.SQL({ adapter: "sqlite" });
await sql`SELECT 1`;
await sql.close();
```

## Semantic Conventions

This instrumentation follows the [OpenTelemetry Database Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/database/).

### Attributes

| Attribute | Description |
|---|---|
| `db.system.name` | Database system: `postgresql`, `mysql`, or `sqlite` |
| `db.operation.name` | SQL operation: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, etc. |
| `db.query.text` | The SQL query text (parameterized for tagged templates, sanitized for unsafe queries) |
| `db.query.summary` | Short summary: `{operation} {table}` |
| `db.namespace` | Database name or SQLite filename |
| `db.response.returned_rows` | Number of rows returned |
| `server.address` | Server hostname (PostgreSQL/MySQL) |
| `server.port` | Server port (PostgreSQL/MySQL) |
| `error.type` | Error class name (e.g., `SQLiteError`, `PostgresError`) |
| `db.response.status_code` | Database-specific error code |

### Span names

Span names follow the OTel convention priority:

1. `{db.query.summary}` (e.g., `SELECT users`)
2. `{db.operation.name} {db.namespace}` (e.g., `SELECT mydb`)
3. `{db.operation.name}` (e.g., `SELECT`)
4. `{db.namespace}` (e.g., `mydb`)
5. `{db.system.name}` (e.g., `postgresql`)

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `requireParentSpan` | `boolean` | `false` | Only create spans when a parent span exists in context |
| `enhancedDatabaseReporting` | `boolean` | `false` | Include query parameters (`db.query.parameter.<n>`) and result data in spans |
| `ignoreConnectionSpans` | `boolean` | `false` | Suppress spans for `CLOSE` and `RESERVE` operations |
| `maskStatement` | `boolean` | `true` | Replace literal values with `?` in non-parameterized queries (`sql.unsafe()`) |
| `maskStatementHook` | `(query: string) => string` | Built-in masker | Custom masking function for non-parameterized queries |
| `addSqlCommenterComment` | `boolean` | `false` | Append SQL commenter traceparent comments to queries |
| `requestHook` | `(span, info) => void` | - | Called before query execution to customize span attributes |
| `responseHook` | `(span, info) => void` | - | Called after query execution with response metadata |

### Example with hooks

```typescript
new BunSqlInstrumentation({
  requestHook: (span, info) => {
    span.setAttribute("custom.query", info.query);
  },
  responseHook: (span, info) => {
    if (info.rowCount !== undefined) {
      span.setAttribute("custom.row_count", info.rowCount);
    }
  },
});
```

## What gets instrumented

- **Tagged template queries**: `` sql`SELECT * FROM users WHERE id = ${id}` ``
- **Unsafe queries**: `sql.unsafe("SELECT * FROM users")`
- **Transactions**: `sql.begin(tx => ...)`, including nested savepoints
- **Connection management**: `sql.close()`, `sql.reserve()`
- **Chaining methods**: `.values()`, `.raw()`, `.simple()`, `.execute()`

### Query text handling

| Query type | `db.query.text` behavior |
|---|---|
| Tagged template | Parameterized: `SELECT * FROM users WHERE id = $1` |
| `sql.unsafe()` | Sanitized by default: `SELECT * FROM users WHERE name = ?` |
| `sql.unsafe()` with `maskStatement: false` | Raw text preserved |

## License

Apache-2.0

[npm-url]: https://www.npmjs.com/package/@8monkey/opentelemetry-instrumentation-bun-sql
[npm-img]: https://badge.fury.io/js/%408monkey%2Fopentelemetry-instrumentation-bun-sql.svg
[license-url]: https://github.com/8monkey-ai/opentelemetry-instrumentation-bun-sql/blob/main/LICENSE
[license-image]: https://img.shields.io/badge/license-Apache_2.0-green.svg?style=flat
