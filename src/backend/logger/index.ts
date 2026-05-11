import { als, getActiveContext, type SpanContext } from "./als";

export interface Sink {
	write(line: string): void;
}

export type Level = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<Level, number> = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

let sink: Sink | null = null;

export function setSink(s: Sink | null): void {
	sink = s;
}

interface State {
	threshold: Level;
}

function ts(): string {
	return new Date().toISOString();
}

function formatFields(fields: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		const str = typeof v === "string" ? v : String(v);
		const needsQuote = /[\s"=]/.test(str);
		parts.push(`${k}=${needsQuote ? JSON.stringify(str) : str}`);
	}
	return parts.join(" ");
}

class Logger {
	private state: State;
	private namespace: string;
	private bound: Record<string, unknown>;

	constructor(
		state: State,
		namespace: string,
		bound: Record<string, unknown> = {},
	) {
		this.state = state;
		this.namespace = namespace;
		this.bound = bound;
	}

	setLevel(level: Level): void {
		this.state.threshold = level;
	}

	child(name: string, fields?: Record<string, unknown>): Logger {
		const ns = this.namespace ? `${this.namespace}>${name}` : name;
		const merged = fields ? { ...this.bound, ...fields } : this.bound;
		return new Logger(this.state, ns, merged);
	}

	private emit(
		level: Exclude<Level, "silent">,
		msg: string,
		extra?: unknown,
	): void {
		if (ORDER[level] > ORDER[this.state.threshold]) return;
		const upper = level.toUpperCase();
		// Merge active span context (if any) under explicit bindings so
		// span fields carry through automatically but explicit child(...)
		// bindings on this logger still take precedence.
		const active = getActiveContext();
		const ambient = active?.fields ?? {};
		const ambientNs = active?.namespace ?? "";
		const composedNs =
			ambientNs && this.namespace
				? `${ambientNs}>${this.namespace}`
				: ambientNs || this.namespace;
		const ns = composedNs ? `[${composedNs}] ` : "";
		if (extra instanceof Error) {
			const baseFields = { ...ambient, ...this.bound };
			const boundStr = formatFields(baseFields);
			const tail = boundStr ? ` ${boundStr}` : "";
			sink?.write(
				`${ts()} ${upper} ${ns}${msg} ${extra.name}: ${extra.message}${tail}`,
			);
			if (extra.stack) sink?.write(extra.stack);
			return;
		}
		const merged = {
			...ambient,
			...this.bound,
			...((extra as Record<string, unknown>) ?? {}),
		};
		const fieldStr = formatFields(merged);
		const trail = fieldStr ? ` ${fieldStr}` : "";
		sink?.write(`${ts()} ${upper} ${ns}${msg}${trail}`);
	}

	/**
	 * Snapshot the active span context and re-establish it whenever the
	 * returned function is invoked. Use this around event-emitter
	 * listener callbacks so a listener registered inside a span keeps
	 * the span's fields when fired from outside the span's async context.
	 *
	 * Gotcha: native `EventEmitter` invokes listeners synchronously in
	 * the emitter's async context, not the registration's. Wrapping the
	 * listener with `bind()` is the standard fix.
	 */
	bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
		const snapshot = getActiveContext();
		if (!snapshot) return fn;
		return ((...args: unknown[]) => als.run(snapshot, () => fn(...args))) as F;
	}

	async span<T>(
		name: string,
		fields: Record<string, unknown>,
		fn: () => Promise<T>,
	): Promise<T> {
		// Compose the new span on top of the parent (active) context so
		// nested spans carry parent fields and the namespace stacks with
		// `>` separators. Mirrors how child() does it for non-span
		// loggers.
		const parent = getActiveContext();
		const parentNs = parent?.namespace ?? "";
		const composedNs = this.namespace
			? parentNs
				? `${parentNs}>${this.namespace}>${name}`
				: `${this.namespace}>${name}`
			: parentNs
				? `${parentNs}>${name}`
				: name;
		const composedFields = {
			...(parent?.fields ?? {}),
			...this.bound,
			...fields,
		};
		const ctx: SpanContext = {
			namespace: composedNs,
			fields: composedFields,
		};
		return als.run(ctx, async () => {
			// Inside the run, the ambient ctx supplies namespace+fields;
			// emit "enter"/"exit" through the root logger so the active
			// span context is the sole source of those bindings.
			logger.debug("enter");
			const start = Date.now();
			try {
				const value = await fn();
				const dur = Date.now() - start;
				logger.debug("exit ok", { dur: `${dur}ms` });
				return value;
			} catch (err) {
				const dur = Date.now() - start;
				logger.warn(
					"exit err",
					err instanceof Error ? err : new Error(String(err)),
				);
				logger.debug("dur", { dur: `${dur}ms` });
				throw err;
			}
		});
	}

	error(msg: string, extra?: unknown): void {
		this.emit("error", msg, extra);
	}
	warn(msg: string, extra?: unknown): void {
		this.emit("warn", msg, extra);
	}
	info(msg: string, extra?: unknown): void {
		this.emit("info", msg, extra);
	}
	debug(msg: string, extra?: unknown): void {
		this.emit("debug", msg, extra);
	}
}

const rootState: State = { threshold: "warn" };
export const logger = new Logger(rootState, "", {});

/**
 * Wire the file sink and the level threshold from environment. Call
 * once at process start (from `src/index.tsx`). Tests do not call this;
 * they install a memory sink directly via `setSink(...)`.
 *
 * `INKSTONE_LOG` ∈ {silent,error,warn,info,debug}; default `warn`.
 * `INKSTONE_LOG_FILE` overrides the path.
 */
export async function initLogger(): Promise<void> {
	const level = parseLevel(process.env.INKSTONE_LOG) ?? "warn";
	logger.setLevel(level);
	if (level === "silent") return;
	const path =
		process.env.INKSTONE_LOG_FILE ?? (await defaultLogPath().catch(() => null));
	if (!path) return;
	const { fileSink } = await import("./sink");
	setSink(fileSink(path));
}

function parseLevel(s: string | undefined): Level | undefined {
	if (!s) return undefined;
	if (s in ORDER) return s as Level;
	return undefined;
}

async function defaultLogPath(): Promise<string> {
	const { STATE_DIR } = await import("../persistence/paths");
	const { join } = await import("node:path");
	return join(STATE_DIR, "logs", "inkstone.log");
}
