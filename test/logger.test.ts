/**
 * Tracing-style logger — built incrementally via TDD vertical slices.
 * One test per behavior, in the order the cycles were written. Each
 * section ends at a feature-complete RED→GREEN cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger, type Sink, setSink } from "@backend/logger";

interface MemorySink extends Sink {
	lines: string[];
}

function memorySink(): MemorySink {
	const lines: string[] = [];
	return {
		write: (line) => {
			lines.push(line);
		},
		lines,
	};
}

let mem: MemorySink;

beforeEach(() => {
	mem = memorySink();
	setSink(mem);
	logger.setLevel("debug");
});

afterEach(() => {
	setSink(null);
});

describe("logger — cycle 1: minimal warn → sink", () => {
	test("log.warn writes one WARN line containing the message", () => {
		logger.warn("hello");
		expect(mem.lines).toHaveLength(1);
		expect(mem.lines[0]).toContain("WARN");
		expect(mem.lines[0]).toContain("hello");
	});

	test("every line starts with an ISO-8601 UTC timestamp", () => {
		logger.warn("hi");
		expect(mem.lines[0]).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /,
		);
	});
});

describe("logger — cycle 3: child namespace", () => {
	test("child(name) emits [name] in the line", () => {
		const log = logger.child("kiro");
		log.error("boom");
		expect(mem.lines).toHaveLength(1);
		expect(mem.lines[0]).toContain("[kiro]");
		expect(mem.lines[0]).toContain("boom");
	});

	test("nested child concatenates with > separator", () => {
		const log = logger.child("a").child("b");
		log.warn("x");
		expect(mem.lines[0]).toContain("[a>b]");
	});

	test("child inherits the root threshold", () => {
		logger.setLevel("warn");
		const log = logger.child("k");
		log.info("suppressed");
		log.warn("kept");
		expect(mem.lines).toHaveLength(1);
		expect(mem.lines[0]).toContain("kept");
	});
});

describe("logger — cycle 4: Error 2nd arg", () => {
	test("error name and message land on the main line", () => {
		const e = new Error("boom!");
		e.name = "TypeError";
		logger.warn("op failed", e);
		expect(mem.lines.join("\n")).toContain("TypeError");
		expect(mem.lines.join("\n")).toContain("boom!");
	});

	test("stack lands on a continuation line", () => {
		const e = new Error("oops");
		logger.warn("op failed", e);
		// Two lines minimum: the main line and at least one stack frame.
		expect(mem.lines.length).toBeGreaterThanOrEqual(2);
		// Continuation line should reference the test file in the stack.
		expect(mem.lines.slice(1).join("\n")).toContain("logger.test.ts");
	});

	test("non-Error 2nd arg is treated as fields, not error", () => {
		logger.warn("hi", { a: 1 });
		expect(mem.lines).toHaveLength(1);
		expect(mem.lines[0]).not.toContain("Error");
	});
});

describe("logger — cycle 5: fields object", () => {
	test("flat fields render as k=v pairs", () => {
		logger.warn("hi", { a: 1, b: "two" });
		expect(mem.lines[0]).toContain("a=1");
		expect(mem.lines[0]).toContain("b=two");
	});

	test("string with whitespace is quoted", () => {
		logger.warn("hi", { msg: "a b c" });
		expect(mem.lines[0]).toContain('msg="a b c"');
	});

	test("undefined values are skipped", () => {
		logger.warn("hi", { a: 1, b: undefined });
		expect(mem.lines[0]).not.toContain("b=");
	});
});

describe("logger — cycle 6: child fields merge", () => {
	test("child(name, fields) prefixes every event with bound fields", () => {
		const log = logger.child("kiro", { region: "us-west-2" });
		log.warn("hi");
		expect(mem.lines[0]).toContain("region=us-west-2");
	});

	test("nested children merge bound fields left-to-right", () => {
		const log = logger.child("a", { x: 1 }).child("b", { y: 2 });
		log.warn("m");
		expect(mem.lines[0]).toContain("[a>b]");
		expect(mem.lines[0]).toContain("x=1");
		expect(mem.lines[0]).toContain("y=2");
	});

	test("call-site fields override bound fields with the same key", () => {
		const log = logger.child("k", { region: "us-west-2" });
		log.warn("hi", { region: "eu-central-1" });
		expect(mem.lines[0]).toContain("region=eu-central-1");
		expect(mem.lines[0]).not.toContain("us-west-2");
	});
});

describe("logger — cycle 7: span happy path", () => {
	test("span emits enter + exit ok and returns the value", async () => {
		logger.setLevel("debug");
		const ret = await logger.span("dispatch", { agent: "kiro" }, async () => {
			return 42;
		});
		expect(ret).toBe(42);
		const joined = mem.lines.join("\n");
		expect(joined).toContain("enter");
		expect(joined).toContain("exit ok");
		expect(joined).toContain("dispatch");
	});

	test("span exit ok carries non-zero duration", async () => {
		logger.setLevel("debug");
		await logger.span("slow", {}, async () => {
			await new Promise((r) => setTimeout(r, 5));
		});
		const exit = mem.lines.find((l) => l.includes("exit ok"));
		expect(exit).toBeDefined();
		expect(exit).toMatch(/dur=\d+ms/);
	});
});

describe("logger — cycle 8: span error path", () => {
	test("span emits exit err and rethrows the original error", async () => {
		logger.setLevel("debug");
		const boom = new Error("boom");
		await expect(
			logger.span("op", { x: 1 }, async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		const joined = mem.lines.join("\n");
		expect(joined).toContain("enter");
		expect(joined).toContain("exit err");
		expect(joined).toContain("boom");
	});
});

describe("logger — cycle 9: ALS auto-inheritance inside span", () => {
	test("logger.warn called inside the span body inherits span fields", async () => {
		logger.setLevel("debug");
		await logger.span("dispatch", { agent: "kiro" }, async () => {
			logger.warn("inner");
		});
		const inner = mem.lines.find(
			(l) => l.includes("inner") && !l.includes("enter"),
		);
		expect(inner).toBeDefined();
		expect(inner).toContain("agent=kiro");
	});

	test("inner child(name, fields) merges with span fields", async () => {
		logger.setLevel("debug");
		await logger.span("op", { sessionId: "abc" }, async () => {
			const inner = logger.child("tool", { name: "read" });
			inner.warn("called");
		});
		const inner = mem.lines.find(
			(l) => l.includes("called") && !l.includes("enter"),
		);
		expect(inner).toBeDefined();
		expect(inner).toContain("sessionId=abc");
		expect(inner).toContain("name=read");
		expect(inner).toContain("[op>tool]");
	});
});

describe("logger — cycle 10: ALS survives await", () => {
	test("logger.warn after an awaited Promise still inherits span fields", async () => {
		logger.setLevel("debug");
		await logger.span("op", { x: 1 }, async () => {
			await Promise.resolve();
			logger.warn("after-await");
		});
		const line = mem.lines.find((l) => l.includes("after-await"));
		expect(line).toContain("x=1");
	});
});

describe("logger — cycle 11: ALS survives setTimeout(0)", () => {
	test("logger.warn after setTimeout(0) still inherits span fields", async () => {
		logger.setLevel("debug");
		await logger.span("op", { x: 1 }, async () => {
			await new Promise<void>((r) => setTimeout(r, 0));
			logger.warn("after-timeout");
		});
		const line = mem.lines.find((l) => l.includes("after-timeout"));
		expect(line).toContain("x=1");
	});
});

describe("logger — cycle 12: ALS across EventEmitter via bind()", () => {
	test("listener invoked synchronously inherits span when wrapped via bind()", async () => {
		const { EventEmitter } = await import("node:events");
		logger.setLevel("debug");
		const emitter = new EventEmitter();
		await logger.span("router", { sessionId: "p" }, async () => {
			emitter.on(
				"go",
				logger.bind(() => {
					logger.warn("listener fired");
				}),
			);
			emitter.emit("go");
		});
		const fired = mem.lines.find((l) => l.includes("listener fired"));
		expect(fired).toContain("sessionId=p");
		expect(fired).toContain("[router]");
	});

	test("without bind(), listener emitted from outside the span loses fields (gotcha)", async () => {
		const { EventEmitter } = await import("node:events");
		logger.setLevel("debug");
		const emitter = new EventEmitter();
		// Register the listener inside the span (so subscribe-time has
		// span context) but emit outside the span (so emit-time does
		// not). Native EventEmitter calls listeners synchronously in the
		// emit-time async context — without bind(), span fields are
		// lost. Documents the failure mode bind() exists to fix.
		await logger.span("inner", { x: 1 }, async () => {
			emitter.on("go", () => {
				logger.warn("unbound");
			});
		});
		emitter.emit("go");
		const fired = mem.lines.find((l) => l.includes("unbound"));
		expect(fired).toBeDefined();
		expect(fired).not.toContain("x=1");
	});
});

describe("logger — cycle 13: file sink", () => {
	test("file sink appends a line for every event, then closes cleanly", async () => {
		const { fileSink } = await import("@backend/logger/sink");
		const { mkdtempSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const dir = mkdtempSync(join(tmpdir(), "inkstone-log-"));
		const path = join(dir, "test.log");
		const sk = fileSink(path);
		setSink(sk);
		try {
			logger.setLevel("debug");
			logger.warn("alpha");
			logger.warn("beta");
		} finally {
			await sk.close();
			setSink(null);
		}
		const content = readFileSync(path, "utf8");
		expect(content).toContain("alpha");
		expect(content).toContain("beta");
		// Each event ends with \n
		const lines = content.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBe(2);
	});
});

describe("logger — cycle 2: level filtering", () => {
	test("info is suppressed when threshold is warn", () => {
		logger.setLevel("warn");
		logger.info("noise");
		logger.warn("signal");
		expect(mem.lines).toHaveLength(1);
		expect(mem.lines[0]).toContain("signal");
	});

	test("silent suppresses every level", () => {
		logger.setLevel("silent");
		logger.error("nope");
		logger.warn("nope");
		logger.info("nope");
		logger.debug("nope");
		expect(mem.lines).toHaveLength(0);
	});

	test("debug emits everything at-or-above debug", () => {
		logger.setLevel("debug");
		logger.error("e");
		logger.warn("w");
		logger.info("i");
		logger.debug("d");
		expect(mem.lines).toHaveLength(4);
	});
});
