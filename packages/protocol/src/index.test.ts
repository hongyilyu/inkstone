import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	PostMessageParams,
	PostMessageResult,
	RunEvent,
	WorkerInbound,
	WorkerOutbound,
} from "./index.js";

describe("PostMessageParams", () => {
	it("decodes a valid prompt", () => {
		expect(S.decodeUnknownSync(PostMessageParams)({ prompt: "hi" })).toEqual({
			prompt: "hi",
		});
	});

	it("rejects a missing prompt", () => {
		expect(() => S.decodeUnknownSync(PostMessageParams)({})).toThrow();
	});

	it("rejects a non-string prompt", () => {
		expect(() =>
			S.decodeUnknownSync(PostMessageParams)({ prompt: 42 }),
		).toThrow();
	});
});

describe("PostMessageResult", () => {
	it("decodes a valid run_id without renaming the wire field", () => {
		const wire = { run_id: "01900000-0000-7000-8000-000000000000" };
		expect(S.decodeUnknownSync(PostMessageResult)(wire)).toEqual(wire);
	});

	it("encodes back to the same snake_case wire shape", () => {
		const decoded = S.decodeUnknownSync(PostMessageResult)({
			run_id: "01900000-0000-7000-8000-000000000000",
		});
		expect(S.encodeSync(PostMessageResult)(decoded)).toEqual({
			run_id: "01900000-0000-7000-8000-000000000000",
		});
	});

	it("rejects a missing run_id", () => {
		expect(() => S.decodeUnknownSync(PostMessageResult)({})).toThrow();
	});
});

describe("RunEvent", () => {
	it("decodes a text_delta variant", () => {
		const event = { kind: "text_delta", delta: "echo: hi" };
		expect(S.decodeUnknownSync(RunEvent)(event)).toEqual(event);
	});

	it("decodes a done variant", () => {
		expect(S.decodeUnknownSync(RunEvent)({ kind: "done" })).toEqual({
			kind: "done",
		});
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "unknown" }),
		).toThrow();
	});

	it("rejects a text_delta missing its delta field", () => {
		expect(() =>
			S.decodeUnknownSync(RunEvent)({ kind: "text_delta" }),
		).toThrow();
	});
});

describe("WorkerInbound", () => {
	it("decodes a worker stdin frame", () => {
		expect(S.decodeUnknownSync(WorkerInbound)({ prompt: "hi" })).toEqual({
			prompt: "hi",
		});
	});

	it("rejects a missing prompt", () => {
		expect(() => S.decodeUnknownSync(WorkerInbound)({})).toThrow();
	});
});

describe("WorkerOutbound", () => {
	it("aliases RunEvent and accepts text_delta", () => {
		expect(
			S.decodeUnknownSync(WorkerOutbound)({
				kind: "text_delta",
				delta: "echo: hi",
			}),
		).toEqual({ kind: "text_delta", delta: "echo: hi" });
	});

	it("aliases RunEvent and accepts done", () => {
		expect(S.decodeUnknownSync(WorkerOutbound)({ kind: "done" })).toEqual({
			kind: "done",
		});
	});
});
