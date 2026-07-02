import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CUE_DISMISS_MS,
	type CueVerb,
	currentCue,
	resetEntityCueStore,
	showEntityCue,
	verbForMutationKind,
} from "@/store/entityCue";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	resetEntityCueStore();
	vi.useRealTimers();
});

describe("verbForMutationKind", () => {
	const cases: Array<[string, CueVerb]> = [
		["create_todo", "Created"],
		["create_person", "Created"],
		["create_project", "Created"],
		["create_media", "Created"],
		["create_journal_entry", "Created"],
		["delete_todo", "Deleted"],
		["delete_person", "Deleted"],
		["delete_project", "Deleted"],
		["delete_media", "Deleted"],
		["delete_journal_entry", "Deleted"],
		["update_todo", "Saved"],
		["update_person", "Saved"],
		["update_project", "Saved"],
		["update_media", "Saved"],
		["update_journal_entry", "Saved"],
		["mark_project_reviewed", "Saved"],
		["reference_existing_entity_from_journal_entry", "Saved"],
	];

	it.each(cases)("maps %s -> %s", (kind, verb) => {
		expect(verbForMutationKind(kind)).toBe(verb);
	});
});

describe("showEntityCue", () => {
	it("sets the slot then auto-dismisses after CUE_DISMISS_MS", async () => {
		expect(CUE_DISMISS_MS).toBe(2500);
		showEntityCue("Saved");
		expect(currentCue()?.verb).toBe("Saved");

		await vi.advanceTimersByTimeAsync(CUE_DISMISS_MS);
		expect(currentCue()).toBeNull();
	});

	it("is latest-wins: a second show clears the prior timer and replaces the slot", async () => {
		showEntityCue("Created");
		const first = currentCue();
		expect(first?.verb).toBe("Created");

		await vi.advanceTimersByTimeAsync(1000);
		showEntityCue("Deleted");
		const second = currentCue();
		expect(second?.verb).toBe("Deleted");
		// Fresh key so the live region re-announces.
		expect(second?.key).toBeGreaterThan(first?.key ?? 0);

		// 1000 + 1600 = 2600 since the first show (past its original 2500 deadline),
		// but only 1600 since the second show: the first timer was cleared, didn't fire.
		await vi.advanceTimersByTimeAsync(1600);
		expect(currentCue()?.verb).toBe("Deleted");

		// 1600 + 1000 = 2600 since the second show: now past the second's fresh deadline.
		await vi.advanceTimersByTimeAsync(1000);
		expect(currentCue()).toBeNull();
	});

	it("gives each show a distinct key so a repeat verb re-announces", () => {
		showEntityCue("Saved");
		const a = currentCue()?.key;
		showEntityCue("Saved");
		const b = currentCue()?.key;
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(b).not.toBe(a);
	});
});

describe("resetEntityCueStore", () => {
	it("clears the slot and the pending timer (no resurrection, no error)", async () => {
		showEntityCue("Saved");
		expect(currentCue()?.verb).toBe("Saved");

		resetEntityCueStore();
		expect(currentCue()).toBeNull();

		// Advancing must not resurrect the cleared cue or throw.
		await vi.advanceTimersByTimeAsync(CUE_DISMISS_MS * 2);
		expect(currentCue()).toBeNull();
	});
});
