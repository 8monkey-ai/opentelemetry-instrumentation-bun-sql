# OpenTelemetry Bun.SQL Instrumentation

[![Apache License 2.0][license-image]][license-url]

OpenTelemetry instrumentation for [Bun.SQL](https://bun.sh/docs/api/sql), the built-in SQL client in [Bun](https://bun.sh) for PostgreSQL, MySQL, and SQLite.

## Supported Versions

- Bun >= 1.2

## Installation

```bash
bun add @8monkey/opentelemetry-instrumentation-bun-sql @opentelemetry/api
```

## Usage

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BunSqlInstrumentation } from "@8monkey/opentelemetry-instrumentation-bun-sql";

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter())],
});
provider.register();

registerInstrumentations({
  instrumentations: [new BunSqlInstrumentation()],
});

// Now use Bun.SQL as usual — all queries are traced automatically
const sql = new Bun.SQL("postgres://localhost:5432/mydb");
await sql`SELECT * FROM users WHERE id = ${1}`;
```

## Instrumented Operations

| Operation | Method |
| --- | --- |
| Tagged template queries | `` sql`SELECT ...` `` |
| Unsafe queries | `sql.unsafe("SELECT ...")` |
| File queries | `sql.file("query.sql")` |
| Transactions | `sql.begin(...)`, `sql.transaction(...)` |
| Distributed transactions | `sql.beginDistributed(...)`, `sql.distributed(...)` |
| Connection lifecycle | `sql.reserve()`, `sql.close()`, `sql.end()` |

## Semantic Conventions

This instrumentation follows the [OpenTelemetry Database Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/database/). Spans include these attributes:

| Attribute | Description |
| --- | --- |
| `db.system.name` | `postgresql`, `mysql`, or `sqlite` |
| `db.operation.name` | SQL operation (`SELECT`, `INSERT`, etc.) |
| `db.query.summary` | Short summary like `SELECT users` |
| `db.query.text` | Parameterized query text (e.g., `SELECT * FROM users WHERE id = $1`) |
| `db.namespace` | Database name or SQLite file path |
| `server.address` | Database server hostname |
| `server.port` | Database server port |
| `error.type` | Error class name on failure |
| `db.response.status_code` | Database error code on failure |

## Configuration

```typescript
new BunSqlInstrumentation({
  // Attach query parameters and row counts to spans (default: false)
  enhancedDatabaseReporting: true,

  // Only create spans when a parent span exists (default: false)
  requireParentSpan: false,

  // Suppress connection-level spans for reserve/release/close (default: false)
  ignoreConnectionSpans: false,

  // Sanitize non-parameterized queries by replacing literals with ? (default: true)
  sanitizeNonParameterizedQueries: true,

  // Custom sanitization function for query text
  sanitizationHook: (query) => query.replace(/secret/g, "***"),

  // Customize span attributes before query execution
  requestHook: (span, { query, operation, params }) => {
    span.setAttribute("custom.query.length", query.length);
  },

  // Customize span attributes from query response
  responseHook: (span, { rowCount, data }) => {
    span.setAttribute("custom.row_count", rowCount);
  },
});
```

### Config Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enhancedDatabaseReporting` | `boolean` | `false` | Include query parameters (`db.query.parameter.*`) and row counts (`db.response.returned_rows`) |
| `requireParentSpan` | `boolean` | `false` | Only create spans when a parent span is active |
| `ignoreConnectionSpans` | `boolean` | `false` | Skip spans for `reserve`, `release`, and `close` |
| `sanitizeNonParameterizedQueries` | `boolean` | `true` | Replace string and numeric literals with `?` in unsafe/file queries |
| `addSqlCommenterComment` | `boolean` | `false` | Append SQL commenter traceparent comment to queries |
| `sanitizationHook` | `(query: string) => string` | built-in | Custom function to sanitize query text |
| `requestHook` | `(span, info) => void` | - | Modify span attributes before query execution |
| `responseHook` | `(span, info) => void` | - | Modify span attributes after query execution |

## Query Text Handling

For **tagged template queries** (`` sql`SELECT * FROM users WHERE id = ${id}` ``), the query text is automatically parameterized as `SELECT * FROM users WHERE id = $1`. No sanitization is needed since values are never embedded in the query string.

For **unsafe/file queries** (`sql.unsafe("SELECT * FROM users WHERE name = 'Alice'")`), literals are replaced with `?` by default to avoid capturing sensitive data. Disable this with `sanitizeNonParameterizedQueries: false`.

## Transaction Context Propagation

Transactions automatically propagate OpenTelemetry context. Queries inside a transaction are children of the `BEGIN` span:

```
BEGIN                          (parent span)
  INSERT INTO users ...        (child span)
  SELECT * FROM users ...      (child span)
COMMIT                         (end of parent span)
```

## License

Apache 2.0 - See [LICENSE](LICENSE) for more information.

[license-image]: https://img.shields.io/badge/license-Apache_2.0-green.svg
[license-url]: https://github.com/8monkey-ai/opentelemetry-instrumentation-bun-sql/blob/main/LICENSE
