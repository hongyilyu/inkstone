import type {
	EntityBacklinksResult,
	EntityMutateParams,
	EntityMutateResult,
	JournalEntryRescanResult,
} from "@inkstone/protocol";
import {
	type WsClientService,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { renderWithCore } from "@test/test-utils/renderWithCore";
import { journalEntryRow } from "@test/test-utils/rows";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityDetail } from "@/components/library/EntityDetail";
import {
	formatDateTime,
	formatDay,
	type JournalEntry,
	type LibraryItem,
	type Person,
	type Project,
} from "@/lib/libraryItems";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

// Match a humanized date badge locale-independently: the label is literal, the
// date is derived from the SAME `formatDay` the component uses (so an en-US or a
// fr-FR ICU runner both pass). Escapes the formatter's output (it can contain
// regex-special characters like a comma).
function dayBadge(label: string, iso: string): RegExp {
	const day = formatDay(iso).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${label}${day}`);
}

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigate,
	};
});

afterEach(() => {
	cleanup();
	navigate.mockReset();
});

// Stub verbs for the Core harness: `entityMutate` and `getBacklinks` run the
// supplied handlers; other un-stubbed request verbs die, while the harness
// serves empty entity/run-event reads. `getBacklinks` defaults to a DYING read
// so a test that doesn't seed backlinks lands on the `degraded` branch, where the
// inspector simply omits "Mentioned in" (it has no client fallback, ADR-0050 §7).
// Tests that prove the Core path override it with real rows.
function makeOverrides(
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
	getBacklinks: (
		entityId: string,
	) => Effect.Effect<EntityBacklinksResult, WsError> = () =>
		Effect.die("backlinks not exercised in this test"),
	rescanJournalEntry: (
		jeId: string,
	) => Effect.Effect<JournalEntryRescanResult, WsError> = () =>
		Effect.die("rescan not exercised in this test"),
): Partial<WsClientService> {
	return { getBacklinks, entityMutate, rescanJournalEntry };
}

// Build an `EntityBacklinksResult` for the Core-sourced inspector. Rows are wire
// `EntityRow`s (snake_case `data` + `created_at`/`updated_at` + ride-along
// `refs`), the same shape Core emits and `entityCodec` parses.
function backlinks(
	result: Partial<EntityBacklinksResult>,
): EntityBacklinksResult {
	return { mentioned_in: [], ...result };
}

let backlinkRowSeq = 0;
/** A fresh row id so two `jeBacklinkRow` calls never collide. */
function nextBacklinkSeq(): number {
	backlinkRowSeq += 1;
	return backlinkRowSeq;
}

/** A wire JE `EntityRow` whose `text` is its whole body — the title `RelatedRow`
 * shows for a "Mentioned in" row (`libraryItemTitle` of a text-only entry is its
 * body text). Core returns the JE that references the entity; the body text is what
 * the inspector renders. */
function jeBacklinkRow(
	text: string,
	id = `je_bl_${nextBacklinkSeq()}`,
): EntityBacklinksResult["mentioned_in"][number] {
	return journalEntryRow(
		id,
		[{ type: "text", text }],
		{ occurred_at: "2026-06-10T10:30:00" },
		{ created_at: 1000, updated_at: 1000 },
	);
}

/** Render EntityDetail inside the runtime + QueryClient its edit/delete writes need. */
function renderDetail(
	ui: React.ReactElement,
	overrides: Partial<WsClientService> = makeOverrides(),
) {
	return renderWithCore(ui, { overrides });
}

const ada: Person = {
	id: "person_ada",
	kind: "person",
	name: "Ada Lovelace",
	note: "Current canonical name",
	createdAt: "fixture",
	recency: 2,
};

function journal(body: JournalEntry["body"]): JournalEntry {
	return {
		id: "journal_1",
		kind: "journal_entry",
		occurredAt: "2026-06-10T10:30:00",
		body,
		createdAt: "fixture",
		recency: 1,
	};
}

describe("EntityDetail Journal Entry body", () => {
	it("humanizes the Occurred at timestamp instead of leaking the raw ISO", () => {
		const entry = journal([{ type: "text", text: "Bought milk." }]);
		entry.occurredAt = "2026-06-19T14:30:00";
		renderDetail(<EntityDetail entity={entry} allEntities={[]} />);

		const occurred = screen.getByText("Occurred at")
			.nextElementSibling as HTMLElement;
		expect(occurred).not.toHaveTextContent("2026-06-19T14:30:00");
		expect(occurred.textContent).not.toContain("T");
		expect(occurred.textContent).not.toMatch(/:\d{2}:\d{2}/);
		expect(occurred).toHaveTextContent("19");
		// The exact humanized form, derived from the same formatter the component
		// uses — locale-independent (en-US "Jun 19, 2026, 2:30 PM", fr-FR differs).
		expect(occurred).toHaveTextContent(formatDateTime("2026-06-19T14:30:00"));
	});

	it("renders text-only Journal Entries normally", () => {
		renderDetail(
			<EntityDetail
				entity={journal([{ type: "text", text: "Bought milk." }])}
				allEntities={[]}
			/>,
		);

		expect(screen.getAllByText("Bought milk.")).toHaveLength(2);
	});

	it("renders mixed text and inline ref chips in order", () => {
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
					{ type: "text", text: " at school." },
				])}
				allEntities={[ada]}
			/>,
		);

		const body = screen.getByText("Body").nextElementSibling as HTMLElement;
		expect(body).toHaveTextContent("Met Ada Lovelace at school.");
		expect(
			within(body).getByRole("button", {
				name: "Ada Lovelace",
			}),
		).toBeInTheDocument();
	});

	it("falls back to label_snapshot when the target is not loaded", () => {
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: "missing_person",
						targetKind: "person",
						labelSnapshot: "Ada snapshot",
					},
				])}
				allEntities={[]}
			/>,
		);

		expect(screen.getByText("Ada snapshot")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Ada snapshot" }),
		).not.toBeInTheDocument();
	});

	it("opens a resolvable ref in the Library detail rail", async () => {
		const user = userEvent.setup();
		renderDetail(
			<EntityDetail
				entity={journal([
					{ type: "text", text: "Met " },
					{
						type: "entity_ref",
						refId: "ref_1",
						targetEntityId: ada.id,
						targetKind: "person",
						targetTitle: "Stale Ada",
						labelSnapshot: "Ada",
					},
				])}
				allEntities={[ada]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));

		expect(navigate).toHaveBeenCalledWith({
			to: "/library/$kind",
			params: { kind: "people" },
			search: { id: "person_ada" },
		});
	});
});

// ── Slice 8: GTD detail projections ──────────────────────────────────────────

const person = (
	id: string,
	name: string,
	extra: Partial<Person> = {},
): Person => ({
	id,
	kind: "person",
	name,
	recency: 1,
	createdAt: "fixture",
	...extra,
});

const project = (
	id: string,
	name: string,
	extra: Partial<Project> = {},
): Project => ({
	id,
	kind: "project",
	name,
	status: "active",
	recency: 1,
	createdAt: "fixture",
	...extra,
});

describe("EntityDetail Person projection", () => {
	it("shows aliases and the note", () => {
		const alice = person("p_alice", "Alice", {
			aliases: ["Allie", "A."],
			note: "Handles the daycare transition.",
		});

		renderDetail(<EntityDetail entity={alice} allEntities={[alice]} />);

		expect(screen.getByText(/Allie, A\./)).toBeInTheDocument();
		expect(
			screen.getByText("Handles the daycare transition."),
		).toBeInTheDocument();
	});

	it("shows 'Mentioned in' journal entries the Core read returns", async () => {
		const alice = person("p_alice", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeOverrides(undefined, () =>
				Effect.succeed(
					backlinks({
						mentioned_in: [jeBacklinkRow("Met Alice about daycare.")],
					}),
				),
			),
		);

		// The "Mentioned in" section is sourced from `entity/backlinks`, not a scan
		// of `allEntities` (ADR-0050) — so it appears on arrival of the async read.
		expect(
			await screen.findByText("Met Alice about daycare."),
		).toBeInTheDocument();
		expect(screen.getByText(/Mentioned in/)).toBeInTheDocument();
	});
});

describe("EntityDetail Project projection", () => {
	it("shows note and review state", () => {
		const proj = project("pr_1", "Daycare move", {
			note: "Provider switch by August.",
			nextReviewAt: "2026-06-21T20:00:00",
			lastReviewedAt: "2026-06-14T20:00:00",
		});

		renderDetail(<EntityDetail entity={proj} allEntities={[proj]} />);

		expect(screen.getByText("Provider switch by August.")).toBeInTheDocument();
		expect(
			screen.getByText(dayBadge("Next review ", "2026-06-21T20:00:00")),
		).toBeInTheDocument();
		expect(
			screen.getByText(dayBadge("last reviewed ", "2026-06-14T20:00:00")),
		).toBeInTheDocument();
	});
});

// ── Core-sourced backlinks (ADR-0050) ────────────────────────────────────────

describe("EntityDetail Core-sourced backlinks", () => {
	it("renders 'Mentioned in' from the Core read for Person and Project", async () => {
		const subjects: { entity: LibraryItem; text: string }[] = [
			{ entity: person("p_x", "Person X"), text: "Mentions the person." },
			{ entity: project("pr_x", "Project X"), text: "Mentions the project." },
		];
		for (const { entity, text } of subjects) {
			renderDetail(
				<EntityDetail entity={entity} allEntities={[entity]} />,
				makeOverrides(undefined, () =>
					Effect.succeed(backlinks({ mentioned_in: [jeBacklinkRow(text)] })),
				),
			);
			expect(await screen.findByText(text)).toBeInTheDocument();
			expect(screen.getByText(/Mentioned in/)).toBeInTheDocument();
			cleanup();
		}
	});

	it("shows 'Mentioned in' on a Project (the section it never rendered before)", async () => {
		const proj = project("pr_bug", "Lead Ads testing");
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeOverrides(undefined, () =>
				Effect.succeed(
					backlinks({
						mentioned_in: [jeBacklinkRow("Kicked off Lead Ads.")],
					}),
				),
			),
		);

		expect(await screen.findByText("Kicked off Lead Ads.")).toBeInTheDocument();
		expect(screen.getByText(/Mentioned in/)).toBeInTheDocument();
	});

	it("counts the mentions on the section header (Mentioned in · N)", async () => {
		const alice = person("p_count", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeOverrides(undefined, () =>
				Effect.succeed(
					backlinks({
						mentioned_in: [
							jeBacklinkRow("First mention."),
							jeBacklinkRow("Second mention."),
						],
					}),
				),
			),
		);

		expect(await screen.findByText("First mention.")).toBeInTheDocument();
		expect(screen.getByText(/Mentioned in · 2/)).toBeInTheDocument();
	});

	it("omits Mentioned-in on a Person read error (no client fallback)", async () => {
		const alice = person("p_err", "Alice", { note: "Still renders." });
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeOverrides(undefined, () =>
				Effect.fail(new WsRequestError({ reason: "core unreachable" })),
			),
		);

		// The Person's own fields still render; only the Core-sourced section drops.
		expect(await screen.findByText("Still renders.")).toBeInTheDocument();
		// Mentioned-in has no client fallback, so it is simply absent on error.
		expect(screen.queryByText(/Mentioned in/)).not.toBeInTheDocument();
	});

	it("omits Mentioned-in on a Project read error (a distinct body path)", async () => {
		// ProjectBody is a DISTINCT path from PersonBody, so cover its degraded
		// branch independently — a regression that rendered an empty "Mentioned in"
		// header on a failed Project read can't hide behind the Person test.
		const proj = project("pr_perr", "Daycare move", {
			note: "Provider switch by August.",
		});
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeOverrides(undefined, () =>
				Effect.fail(new WsRequestError({ reason: "core unreachable" })),
			),
		);

		expect(
			await screen.findByText("Provider switch by August."),
		).toBeInTheDocument();
		expect(screen.queryByText(/Mentioned in/)).not.toBeInTheDocument();
	});
});

describe("EntityDetail Person delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const alice = person("p_del", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeOverrides((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete person/i }));
		expect(screen.getByText(/delete this person\?/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{ mutation_kind: "delete_person", payload: { entity_id: alice.id } },
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: ".", search: {} }),
		);
	});

	it("can cancel the delete confirm without writing", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const alice = person("p_keep", "Alice");
		renderDetail(
			<EntityDetail entity={alice} allEntities={[alice]} />,
			makeOverrides((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete person/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(screen.queryByText(/delete this person\?/i)).not.toBeInTheDocument();
		expect(seen).toHaveLength(0);
	});
});

describe("EntityDetail Project delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const proj = project("pr_del", "Daycare move");
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeOverrides((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete project/i }));
		expect(screen.getByText(/delete this project\?/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{ mutation_kind: "delete_project", payload: { entity_id: proj.id } },
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				to: ".",
				search: {},
			}),
		);
	});

	it("can cancel the delete confirm without writing", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const proj = project("pr_keep", "Daycare move");
		renderDetail(
			<EntityDetail entity={proj} allEntities={[proj]} />,
			makeOverrides((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		await user.click(screen.getByRole("button", { name: /delete project/i }));
		await user.click(screen.getByRole("button", { name: /cancel/i }));

		expect(
			screen.queryByText(/delete this project\?/i),
		).not.toBeInTheDocument();
		expect(seen).toHaveLength(0);
	});
});

describe("EntityDetail Journal Entry delete", () => {
	it("confirms inline, deletes, and clears the rail selection", async () => {
		const user = userEvent.setup();
		const seen: EntityMutateParams[] = [];
		const entry = journal([{ type: "text", text: "Stale note." }]);
		renderDetail(
			<EntityDetail entity={entry} allEntities={[entry]} />,
			makeOverrides((params) => {
				seen.push(params);
				return Effect.succeed({});
			}),
		);

		// First click reveals the inline confirm, not a dialog.
		await user.click(
			screen.getByRole("button", { name: /delete journal entry/i }),
		);
		expect(
			screen.getByText(/delete this journal entry\?/i),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^delete$/i }));

		await waitFor(() =>
			expect(seen).toEqual([
				{
					mutation_kind: "delete_journal_entry",
					payload: { entity_id: entry.id },
				},
			]),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({ to: ".", search: {} }),
		);
	});
});

// ── Journal Entry rescan (ADR-0042) ──────────────────────────────────────────

describe("EntityDetail Journal Entry rescan", () => {
	it("shows a 'Scan again' control on a Journal Entry detail", () => {
		const entry = journal([{ type: "text", text: "Met Alice about daycare." }]);
		renderDetail(<EntityDetail entity={entry} allEntities={[entry]} />);

		expect(
			screen.getByRole("button", { name: /scan again/i }),
		).toBeInTheDocument();
	});

	it("does not show 'Scan again' on a non-Journal-Entry detail", () => {
		const subject = person("p_norescan", "Alice");
		renderDetail(<EntityDetail entity={subject} allEntities={[subject]} />);

		expect(
			screen.queryByRole("button", { name: /scan again/i }),
		).not.toBeInTheDocument();
	});

	it("rescans with the JE id and navigates to the returned thread", async () => {
		const user = userEvent.setup();
		const seen: string[] = [];
		const entry = journal([{ type: "text", text: "Met Alice about daycare." }]);
		renderDetail(
			<EntityDetail entity={entry} allEntities={[entry]} />,
			makeOverrides(undefined, undefined, (jeId) => {
				seen.push(jeId);
				return Effect.succeed({
					run_id: "run_rescan_1",
					thread_id: "thr_rescan_1",
				});
			}),
		);

		await user.click(screen.getByRole("button", { name: /scan again/i }));

		await waitFor(() => expect(seen).toEqual([entry.id]));
		// On success the user is taken to the origin Thread to watch the run +
		// see the proposal card (ADR-0042).
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				to: "/thread/$threadId",
				params: { threadId: "thr_rescan_1" },
			}),
		);
	});
});

// ── Captured-from provenance footer (ADR-0030) ───────────────────────────────

describe("EntityDetail Captured from", () => {
	it("links a Thread-sourced Entity back to its originating chat (no capturing message)", async () => {
		const user = userEvent.setup();
		const subject = person("p_msg", "Alice", {
			source: {
				kind: "thread",
				threadId: "thr_1",
				threadTitle: "Morning brain dump",
			},
		});
		renderDetail(<EntityDetail entity={subject} allEntities={[subject]} />);

		await user.click(
			screen.getByRole("button", { name: /Morning brain dump/ }),
		);

		// No capturing message id → plain thread-open, no anchor (empty search omits
		// the optional focusedMessageId param, #184).
		expect(navigate).toHaveBeenCalledWith({
			to: "/thread/$threadId",
			params: { threadId: "thr_1" },
			search: {},
		});
		// `toHaveBeenCalledWith({ search: {} })` can't tell `{}` from
		// `{ focusedMessageId: undefined }` (vitest deep-equality), so assert the key
		// is genuinely ABSENT — this is what reds a regression to an always-set
		// `search: { focusedMessageId }` that emits `undefined` when there's no id.
		const noAnchorArg = navigate.mock.calls[0][0] as { search: object };
		expect(noAnchorArg.search).not.toHaveProperty("focusedMessageId");
	});

	it("deep-links to the capturing message when the source carries one (#184)", async () => {
		const user = userEvent.setup();
		const subject = person("p_msg", "Alice", {
			source: {
				kind: "thread",
				threadId: "thr_1",
				threadTitle: "Morning brain dump",
				messageId: "msg_1",
			},
		});
		renderDetail(<EntityDetail entity={subject} allEntities={[subject]} />);

		await user.click(
			screen.getByRole("button", { name: /Morning brain dump/ }),
		);

		// Carries the capturing message id → land on that exact message via the
		// existing scroll/highlight/strip machinery (ADR-0042, #138/#169).
		expect(navigate).toHaveBeenCalledWith({
			to: "/thread/$threadId",
			params: { threadId: "thr_1" },
			search: { focusedMessageId: "msg_1" },
		});
	});

	it("renders no footer for a Journal-Entry-sourced Entity (its origin surfaces under 'Mentioned in', ADR-0050)", () => {
		// The legacy JE-anchored-create footer branch is retired: a graph/JE-sourced
		// Entity surfaces its relationship canonically under "Mentioned in", not the
		// footer. Even with the source entry loaded, no "Captured from" line renders.
		const entry: JournalEntry = {
			id: "je_1",
			kind: "journal_entry",
			occurredAt: "2026-06-10T10:30:00",
			body: [{ type: "text", text: "Standup notes" }],
			createdAt: "fixture",
			recency: 1,
		};
		const subject = person("p_je", "Alice", {
			source: { kind: "journal_entry", journalEntryId: "je_1" },
		});
		renderDetail(
			<EntityDetail entity={subject} allEntities={[subject, entry]} />,
		);

		expect(screen.queryByText(/Captured from/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Standup notes/ })).toBeNull();
	});

	it("renders no footer for a user-authored Entity (no source)", () => {
		const subject = person("p_user", "Hand-made", {
			createdAt: "Jun 14",
		});
		renderDetail(<EntityDetail entity={subject} allEntities={[subject]} />);

		// A user-authored Entity has no provenance, so the footer is absent
		// entirely — no "Captured from" header, no origin line.
		expect(screen.queryByText(/Captured from/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Created in Library/)).not.toBeInTheDocument();
	});

	it("renders no footer for a Journal-Entry source whose entry is gone (cascade-deleted)", () => {
		const subject = person("p_orphan", "Orphaned", {
			source: { kind: "journal_entry", journalEntryId: "missing_je" },
		});
		// A Journal-Entry source never renders the footer (ADR-0050), whether or not
		// the entry is still loaded.
		renderDetail(<EntityDetail entity={subject} allEntities={[subject]} />);

		expect(screen.queryByText(/Captured from/)).not.toBeInTheDocument();
	});
});
