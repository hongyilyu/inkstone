import { WsRequestError } from "@inkstone/ui-sdk";
import { describe, expect, it } from "vitest";
import {
	CONNECTION_SEND_FAILURE,
	connectionFailureCopy,
	PROVIDER_NOT_CONNECTED_SEND_FAILURE,
} from "@/lib/connectionFailureCopy.js";

describe("connectionFailureCopy", () => {
	it("returns the connection copy when the send failed with reason connection_lost", () => {
		expect(
			connectionFailureCopy(new WsRequestError({ reason: "connection_lost" })),
		).toBe(CONNECTION_SEND_FAILURE);
	});

	it("returns the connection copy when the send failed with reason send_failed", () => {
		expect(
			connectionFailureCopy(new WsRequestError({ reason: "send_failed" })),
		).toBe(CONNECTION_SEND_FAILURE);
	});

	it("returns null for a non-connection WsRequestError reason (caller uses the generic copy)", () => {
		expect(
			connectionFailureCopy(new WsRequestError({ reason: "decode_failed" })),
		).toBeNull();
	});

	it("returns the provider-not-connected copy for a -32004 WsRequestError (ADR-0062)", () => {
		// Core rejects a send whose resolved model's provider has no credential with
		// code -32004; the SDK preserves it on `code`, so the copy branches on the
		// code (not the message text).
		expect(
			connectionFailureCopy(
				new WsRequestError({
					reason: "openai-codex is not configured",
					code: -32004,
				}),
			),
		).toBe(PROVIDER_NOT_CONNECTED_SEND_FAILURE);
	});

	it("never surfaces the raw provider message as the -32004 copy", () => {
		const copy = connectionFailureCopy(
			new WsRequestError({
				reason: "openai-codex is not configured",
				code: -32004,
			}),
		);
		expect(copy).not.toContain("openai-codex");
	});

	it("returns null for a plain Error", () => {
		expect(connectionFailureCopy(new Error("x"))).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(connectionFailureCopy(undefined)).toBeNull();
	});

	it("returns null for a FiberFailure-shaped object lacking the WsRequestError tag", () => {
		// A leaked Effect wrapper duck-types as { _tag: "Die" | ... } / no reason —
		// the guard must reject anything whose `_tag` isn't exactly "WsRequestError".
		expect(
			connectionFailureCopy({ _tag: "Die", reason: "connection_lost" }),
		).toBeNull();
	});

	it("never surfaces the raw reason token as the copy (BookmarkEditor precedent)", () => {
		const copy = connectionFailureCopy(
			new WsRequestError({ reason: "connection_lost" }),
		);
		expect(copy).not.toContain("connection_lost");
	});
});
