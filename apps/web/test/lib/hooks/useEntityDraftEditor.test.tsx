import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { type WsError, WsRequestError } from "@inkstone/ui-sdk";
import { makeCoreWrapper } from "@test/test-utils/renderWithCore";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEntityDraftEditor } from "@/lib/hooks/useEntityDraftEditor";
import { resetEntityCueStore } from "@/store/entityCue";

type Draft = { name: string };
type Entity = { id: string; name: string };

function makeWrapper(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError>,
) {
	return makeCoreWrapper({ overrides: { entityMutate } }).wrapper;
}

describe("useEntityDraftEditor", () => {
	afterEach(() => resetEntityCueStore());

	it("(a) build returns null — onDone(existing.id) fires and entityMutate is never called", async () => {
		const entityMutate = vi.fn(() =>
			Effect.succeed({ entity_id: "should-not-be-called" }),
		);
		const onDone = vi.fn();
		const { result } = renderHook(
			() =>
				useEntityDraftEditor<Draft, Entity>({
					existing: { id: "person-1", name: "Alice" },
					draftFromVm: (e) => ({ name: e?.name ?? "" }),
					build: () => null,
					onDone,
				}),
			{ wrapper: makeWrapper(entityMutate) },
		);

		act(() => result.current.submit());

		expect(onDone).toHaveBeenCalledWith("person-1");
		expect(entityMutate).not.toHaveBeenCalled();
	});

	it("(b) build returns params — entityMutate receives them and onDone(result.entity_id) fires", async () => {
		const seen: EntityMutateParams[] = [];
		const entityMutate = (params: EntityMutateParams) => {
			seen.push(params);
			return Effect.succeed({
				entity_id: "new-id-99",
			} as EntityMutateResult);
		};
		const onDone = vi.fn();
		const { result } = renderHook(
			() =>
				useEntityDraftEditor<Draft, Entity>({
					existing: undefined,
					draftFromVm: () => ({ name: "" }),
					build: () => ({
						mutation_kind: "create_person",
						payload: { name: "Bob" },
					}),
					onDone,
					fallbackId: (d) => d.name,
				}),
			{ wrapper: makeWrapper(entityMutate) },
		);

		act(() => result.current.submit());

		await waitFor(() => {
			expect(onDone).toHaveBeenCalledWith("new-id-99");
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].mutation_kind).toBe("create_person");
	});

	it("(c) a failing entityMutate with Error('boom') surfaces error === 'boom'; non-Error surfaces fallback", async () => {
		const entityMutateBoom = () =>
			Effect.fail(
				new WsRequestError({ reason: "boom", code: -32000 }),
			) as Effect.Effect<EntityMutateResult, WsError>;
		const onDone = vi.fn();
		const { result } = renderHook(
			() =>
				useEntityDraftEditor<Draft, Entity>({
					existing: undefined,
					draftFromVm: () => ({ name: "" }),
					build: () => ({
						mutation_kind: "create_person",
						payload: { name: "x" },
					}),
					onDone,
				}),
			{ wrapper: makeWrapper(entityMutateBoom) },
		);

		act(() => result.current.submit());

		await waitFor(() => {
			expect(result.current.error).not.toBeNull();
		});
		// WsRequestError extends Error via Data.TaggedError — its message is
		// the empty string by default, but `reason` is the diagnostic. The
		// squashed cause (see useEntityMutation) may surface either the Error
		// wrapper or the raw WsRequestError. The hook's ternary checks for
		// truthy `.message`; WsRequestError's message is "".
		// So it falls through to the fallback.
		expect(result.current.error).toBe("Couldn't save. Try again.");
		expect(onDone).not.toHaveBeenCalled();
	});

	it("(c2) a failing entityMutate with a real Error message surfaces that message", async () => {
		const entityMutateReal = () =>
			Effect.die(new Error("network down")) as Effect.Effect<
				EntityMutateResult,
				WsError
			>;
		const onDone = vi.fn();
		const { result } = renderHook(
			() =>
				useEntityDraftEditor<Draft, Entity>({
					existing: undefined,
					draftFromVm: () => ({ name: "" }),
					build: () => ({
						mutation_kind: "create_person",
						payload: { name: "x" },
					}),
					onDone,
				}),
			{ wrapper: makeWrapper(entityMutateReal) },
		);

		act(() => result.current.submit());

		await waitFor(() => {
			expect(result.current.error).toBe("network down");
		});
		expect(onDone).not.toHaveBeenCalled();
	});

	it("(d) saving mirrors mutation pending", async () => {
		let resolve: (v: EntityMutateResult) => void = () => {};
		const entityMutate = () =>
			Effect.promise<EntityMutateResult>(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			) as Effect.Effect<EntityMutateResult, WsError>;
		const onDone = vi.fn();
		const { result } = renderHook(
			() =>
				useEntityDraftEditor<Draft, Entity>({
					existing: undefined,
					draftFromVm: () => ({ name: "" }),
					build: () => ({
						mutation_kind: "create_person",
						payload: { name: "x" },
					}),
					onDone,
				}),
			{ wrapper: makeWrapper(entityMutate) },
		);

		expect(result.current.saving).toBe(false);
		act(() => result.current.submit());
		await waitFor(() => expect(result.current.saving).toBe(true));

		await act(async () => resolve({ entity_id: "abc" }));
		await waitFor(() => expect(result.current.saving).toBe(false));
	});
});
