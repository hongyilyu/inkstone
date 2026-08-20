// The TickTick write-state wire union (ticktick-writes W-A4). Its two numeric
// fields mirror Rust `i64`s, so the schema must REJECT fractional values — a
// float would decode client-side and then fail (or silently truncate) at Core.

import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import { TickTickWriteState } from "../src/ticktick.js";

const decode = S.decodeUnknownEither(TickTickWriteState);

describe("TickTickWriteState", () => {
	it("accepts every variant's canonical shape", () => {
		for (const value of [
			{ state: "proposed", stale_connection: true },
			{ state: "executing", deadline_at: 1_755_600_035_000 },
			{ state: "created", task_id: "tt-1" },
			{ state: "created" },
			{ state: "failed", http_status: 401 },
			{ state: "failed" },
			{ state: "unknown" },
		]) {
			expect(decode(value)._tag, JSON.stringify(value)).toBe("Right");
		}
	});

	it("rejects fractional i64 fields", () => {
		expect(decode({ state: "executing", deadline_at: 1.5 })._tag).toBe("Left");
		expect(decode({ state: "failed", http_status: 401.5 })._tag).toBe("Left");
	});

	it("rejects a missing discriminator field and an unknown state", () => {
		expect(decode({ state: "executing" })._tag).toBe("Left");
		expect(decode({ state: "proposed" })._tag).toBe("Left");
		expect(decode({ state: "settled" })._tag).toBe("Left");
	});
});
