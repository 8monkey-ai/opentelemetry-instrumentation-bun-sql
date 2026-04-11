/* oxlint-disable
  typescript-eslint/no-unsafe-type-assertion,
  typescript-eslint/no-unsafe-assignment,
  typescript-eslint/no-unsafe-call,
  typescript-eslint/no-unsafe-member-access
  ---
  Shared test setup for instrumentation tests.
*/
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BunSqlInstrumentation } from "../src/instrumentation";

export const exporter = new InMemorySpanExporter();
export const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

export const instrumentation = new BunSqlInstrumentation();
instrumentation.setTracerProvider(provider);

export const { SQL } = require("bun") as { SQL: new (...args: any[]) => any };

export function getSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

export function getParentSpanId(span: ReadableSpan): string | undefined {
  return (span as any).parentSpanContext?.spanId as string | undefined;
}
