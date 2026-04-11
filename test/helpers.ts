import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SQL } from "bun";

import { BunSqlInstrumentation } from "../src/instrumentation.ts";
import type { BunSqlInstrumentationConfig } from "../src/types.ts";

// Shared OTel test infrastructure — initialized once across all test files
export const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register({ contextManager: new AsyncLocalStorageContextManager() });

export function getSpans(): ReadableSpan[] {
	return exporter.getFinishedSpans();
}

export function getSpan(index = 0): ReadableSpan {
	const spans = getSpans();
	const span = spans[index];
	if (!span) {
		throw new Error(`No span at index ${String(index)}. Total spans: ${String(spans.length)}`);
	}
	return span;
}

export interface TestSql {
	sql: ReturnType<BunSqlInstrumentation["instrument"]>;
	instrumentation: BunSqlInstrumentation;
	rawSql: InstanceType<typeof SQL>;
}

export function createSql(config?: BunSqlInstrumentationConfig): TestSql {
	const instrumentation = new BunSqlInstrumentation(config);
	const rawSql = new SQL({ url: "sqlite://:memory:" });
	return {
		sql: instrumentation.instrument(rawSql),
		instrumentation,
		rawSql,
	};
}
