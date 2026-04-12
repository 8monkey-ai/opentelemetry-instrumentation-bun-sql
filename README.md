# OpenTelemetry Bun.SQL Instrumentation

OpenTelemetry instrumentation for [Bun.SQL](https://bun.sh/docs/api/sql), the built-in database client in Bun supporting PostgreSQL, MySQL, and SQLite.

## Installation

```bash
bun add @8monkey/opentelemetry-instrumentation-bun-sql
```

## Supported Versions

- Bun >= 1.2

## Usage

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";

// 1. Register instrumentation before creating any SQL instances.
//    Bun built-ins bypass Node.js module hooks, so the instrumentation patches
//    require("bun").SQL at enable time — instances created before this are not traced.
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
provider.register();

registerInstrumentations({
  instrumentations: [new BunSqlInstrumentation()],
});

// 2. Create instances via require("bun"), not `import { SQL } from "bun"`.
//    Static import bindings are resolved at module load time (before step 1 runs)
//    and therefore always capture the original, unpatched constructor.
const sql = new (require("bun") as typeof Bun).SQL({ adapter: "sqlite" });

await sql`SELECT 1`;
await sql.close();
```

## Semantic Conventions

This instrumentation follows the [OpenTelemetry Database Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/database/).

### Attributes

| Attribute                   | Description                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `db.system.name`            | Database system: `postgresql`, `mysql`, or `sqlite`                                   |
| `db.operation.name`         | SQL operation: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, etc.                           |
| `db.query.text`             | The SQL query text (parameterized for tagged templates, sanitized for unsafe queries) |
| `db.namespace`              | Database name or SQLite filename                                                      |
| `db.response.returned_rows` | Number of rows returned                                                               |
| `server.address`            | Server hostname (PostgreSQL/MySQL)                                                    |
| `server.port`               | Server port (PostgreSQL/MySQL)                                                        |
| `error.type`                | Error class name (e.g., `SQLiteError`, `PostgresError`)                               |
| `db.response.status_code`   | Database-specific error code                                                          |

### Span names

Span names follow the OTel convention priority:

1. `{db.operation.name} {db.namespace}` (e.g., `SELECT mydb`)
2. `{db.operation.name}` (e.g., `SELECT`)
3. `{db.namespace}` (e.g., `mydb`)
4. `{db.system.name}` (e.g., `postgresql`)

## Configuration

| Option                      | Type                        | Default         | Description                                                                                        |
| --------------------------- | --------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `requireParentSpan`         | `boolean`                   | `false`         | Only create spans when a parent span exists in context                                             |
| `enhancedDatabaseReporting` | `boolean`                   | `false`         | Include query parameters (`db.query.parameter.<n>`) and result data in spans                       |
| `ignoreConnectionSpans`     | `boolean`                   | `false`         | Suppress spans for `CLOSE` and `RESERVE` operations                                                |
| `maskStatement`             | `boolean`                   | `true`          | Replace integer literals and quoted strings with `?` in non-parameterized queries (`sql.unsafe()`) |
| `maskStatementHook`         | `(query: string) => string` | Built-in masker | Custom masking function for non-parameterized queries                                              |
| `addSqlCommenterComment`    | `boolean`                   | `false`         | Append SQL commenter traceparent comments to queries                                               |
| `requestHook`               | `(span, info) => void`      | -               | Called before query execution to customize span attributes                                         |
| `responseHook`              | `(span, info) => void`      | -               | Called after query execution with response metadata                                                |

### Example with hooks

```typescript
import type {
  BunSqlRequestHookInformation,
  BunSqlResponseHookInformation,
} from "@8monkey/opentelemetry-instrumentation-bun-sql";

new BunSqlInstrumentation({
  requestHook: (span, info: BunSqlRequestHookInformation) => {
    span.setAttribute("custom.query", info.query);
  },
  responseHook: (span, info: BunSqlResponseHookInformation) => {
    if (info.rowCount !== undefined) {
      span.setAttribute("custom.row_count", info.rowCount);
    }
  },
});
```

## What gets instrumented

- **Tagged template queries**: `` sql`SELECT * FROM users WHERE id = ${id}` ``
- **Unsafe queries**: `sql.unsafe("SELECT * FROM users")`
- **Queries inside transactions**: queries run inside `sql.begin(tx => ...)`, `tx.savepoint(sp => ...)`, etc. are individually traced; no span is emitted for the transaction boundary itself
- **Connection management**: `sql.close()`, `sql.reserve()`
- **Chaining methods**: `.values()`, `.raw()`, `.simple()`, `.execute()`

### Query text handling

| Query type                                 | `db.query.text` behavior                                   |
| ------------------------------------------ | ---------------------------------------------------------- |
| Tagged template                            | Parameterized: `SELECT * FROM users WHERE id = $1`         |
| `sql.unsafe()`                             | Sanitized by default: `SELECT * FROM users WHERE name = ?` |
| `sql.unsafe()` with `maskStatement: false` | Raw text preserved                                         |
