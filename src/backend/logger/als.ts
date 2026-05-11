import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
	namespace: string;
	fields: Record<string, unknown>;
}

export const als = new AsyncLocalStorage<SpanContext>();

export function getActiveContext(): SpanContext | undefined {
	return als.getStore();
}
