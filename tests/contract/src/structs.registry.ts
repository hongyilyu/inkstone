// The non-payload struct-parity registry. Unlike the 14-payload `schemas`
// registry (which the Web codec consumes at RUNTIME and lives in
// `@inkstone/protocol`), this one is TEST-ONLY: it maps each committed fixture to
// the hand-authored Effect Schema both languages must satisfy, and lives here in
// the contract test package.
//
// Two fixture sources, by serde direction (the grilling Q2 decision):
//   - "emitted"  — Core serializes a canonical instance through its real serde
//     path (ground truth). Machine-generated; CI regenerates + `git diff`s them.
//   - "authored" — a Deserialize-only param Core never serializes in production.
//     The fixture is hand-authored canonical wire JSON (the exact shape Web
//     sends); Rust `from_str` is the producer-side check, TS decode the consumer.
//
// One fixture = one wire-message PERMUTATION. A tagged union contributes one
// fixture per variant (all decoding against the one union schema). A struct with
// optional fields contributes a maximal fixture (every optional populated) plus a
// `.bare`/`.omitted` companion (the None branch) — see the Q3 maximal-instance
// convention. Leaf sub-structs are covered TRANSITIVELY inside their parent's
// fixture; they never appear here standalone (they never cross the wire alone).

import {
	EntityListParams,
	EntityMutateParams,
	MessageSearchParams,
	PostMessageParams,
	PostMessageResult,
	ProposalDecideParams,
	ProposalGetParams,
	ProviderLoginStartParams,
	RunCancelParams,
	RunGetHistoryParams,
	SettingsSetParams,
	SubscribeParams,
	ThreadCreateParams,
	ThreadGetParams,
} from "@inkstone/protocol";
import type { Schema as S } from "effect";

export type FixtureDir = "emitted" | "authored";

export interface FixtureEntry {
	/** The wire message this fixture exercises — the unit the completeness lock
	 * counts. Multiple fixtures (union variants, maximal/bare pairs) share one
	 * message name. */
	readonly message: string;
	/** Filename within the `<dir>` directory (e.g. `post_message_result.json`). */
	readonly file: string;
	/** The Effect Schema both sides must agree on; the fixture decodes against it
	 * and (for round-trip) re-encodes back to itself. `AnyNoContext` =
	 * `Schema<any, any, never>` — the no-requirements form `decodeUnknownSync` /
	 * `encodeUnknownSync` accept (a context-bearing schema can't be run sync). All
	 * protocol schemas are context-free, so this is exact, not a widening. */
	readonly schema: S.Schema.AnyNoContext;
	/** Which `fixtures/structs/<dir>/` the file lives in. */
	readonly dir: FixtureDir;
}

/** Every committed non-payload fixture, paired with its schema + source dir.
 * Grows one slice at a time until all 31 wire messages are covered. */
export const fixtures: readonly FixtureEntry[] = [
	// ── slice 1: one per source-direction, to exercise the harness end-to-end ──
	{
		message: "PostMessageResult",
		file: "post_message_result.json",
		schema: PostMessageResult,
		dir: "emitted",
	},
	{
		message: "SubscribeParams",
		file: "subscribe_params.json",
		schema: SubscribeParams,
		dir: "authored",
	},

	// ── slice 2: the 13 Deserialize-only params (hand-authored wire JSON) ──
	// Params Core never serializes in production, so the fixture is the exact
	// shape Web sends. Rust `from_str` is the producer-side check (Core accepts
	// it); TS decode is the consumer side. UUID-typed Rust fields require valid
	// UUID strings even though TS types them `S.String`. Optional-bearing params
	// get a `.bare` companion exercising the omitted branch.
	{
		message: "PostMessageParams",
		file: "post_message_params.json",
		schema: PostMessageParams,
		dir: "authored",
	},
	{
		message: "RunCancelParams",
		file: "run_cancel_params.json",
		schema: RunCancelParams,
		dir: "authored",
	},
	{
		message: "ProposalGetParams",
		file: "proposal_get_params.json",
		schema: ProposalGetParams,
		dir: "authored",
	},
	// ProposalDecideParams: maximal (graph accept, all 4 per-node decision forms),
	// the scalar `edit` path, and the bare single-entity accept.
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.edit.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	{
		message: "ProposalDecideParams",
		file: "proposal_decide_params.bare.json",
		schema: ProposalDecideParams,
		dir: "authored",
	},
	{
		message: "ThreadCreateParams",
		file: "thread_create_params.json",
		schema: ThreadCreateParams,
		dir: "authored",
	},
	// RunGetHistoryParams: maximal (limit present) + bare (omitted).
	{
		message: "RunGetHistoryParams",
		file: "run_get_history_params.json",
		schema: RunGetHistoryParams,
		dir: "authored",
	},
	{
		message: "RunGetHistoryParams",
		file: "run_get_history_params.bare.json",
		schema: RunGetHistoryParams,
		dir: "authored",
	},
	{
		message: "EntityListParams",
		file: "entity_list_params.json",
		schema: EntityListParams,
		dir: "authored",
	},
	{
		message: "EntityMutateParams",
		file: "entity_mutate_params.json",
		schema: EntityMutateParams,
		dir: "authored",
	},
	{
		message: "MessageSearchParams",
		file: "message_search_params.json",
		schema: MessageSearchParams,
		dir: "authored",
	},
	{
		message: "ThreadGetParams",
		file: "thread_get_params.json",
		schema: ThreadGetParams,
		dir: "authored",
	},
	{
		message: "ProviderLoginStartParams",
		file: "provider_login_start_params.json",
		schema: ProviderLoginStartParams,
		dir: "authored",
	},
	// SettingsSetParams: maximal (both fields) + bare (both omitted).
	{
		message: "SettingsSetParams",
		file: "settings_set_params.json",
		schema: SettingsSetParams,
		dir: "authored",
	},
	{
		message: "SettingsSetParams",
		file: "settings_set_params.bare.json",
		schema: SettingsSetParams,
		dir: "authored",
	},
];

/** The hand-maintained canonical set of in-scope wire messages (grilling Q5: 31
 * at completion; grows per slice). The completeness lock pins this equal to the
 * distinct `message` values in {@link fixtures}, so a message can't be covered
 * without being declared, nor declared without a fixture. */
export const CANONICAL_MESSAGES: readonly string[] = [
	// slice 1
	"PostMessageResult",
	"SubscribeParams",
	// slice 2 — the 13 params (12 new + SubscribeParams above = 13 total)
	"PostMessageParams",
	"RunCancelParams",
	"ProposalGetParams",
	"ProposalDecideParams",
	"ThreadCreateParams",
	"RunGetHistoryParams",
	"EntityListParams",
	"EntityMutateParams",
	"MessageSearchParams",
	"ThreadGetParams",
	"ProviderLoginStartParams",
	"SettingsSetParams",
];

/** Expected fixture count per tagged-union message (grilling Q10). A union must
 * contribute exactly one fixture per wire variant; a dropped variant fixture reds
 * the completeness lock. Populated as unions are added (slices 3–4). */
export const UNION_VARIANTS: Readonly<Record<string, number>> = {
	// RunEvent: 5, WorkerStdout: 4, ManifestMessage: 3, ToolOutcome: 2,
	// JournalEntryBodyNode: 2, ToolCallStatus: 3  — added in slices 3–4.
};
