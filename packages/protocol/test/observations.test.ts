import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	ObservationQueryParams,
	ObservationQueryResult,
	ObservationRecordParams,
	ObservationRecordResult,
	ObservationUpdateParams,
	ObservationUpdateResult,
} from "../src/index.js";

describe("ObservationRecordParams", () => {
	const wire = {
		observations: [
			{
				schema_key: "bodyweight",
				occurred_at: "2026-06-01T07:30:00",
				ended_at: "2026-06-01T07:35:00",
				values: { kg: 72.4 },
				note: "after morning run",
			},
			{
				schema_key: "bodyweight",
				occurred_at: "2026-06-02T07:30:00",
				values: { kg: 72.1 },
			},
		],
		evidence: {
			journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
		},
	};

	it("decodes a batch with evidence and encodes back unchanged", () => {
		const decoded = S.decodeUnknownSync(ObservationRecordParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationRecordParams)(decoded)).toEqual(wire);
	});

	it("decodes the bare optional shape", () => {
		const bare = {
			observations: [
				{
					schema_key: "bodyweight",
					occurred_at: "2026-06-01T07:30:00",
					values: { kg: 72.4 },
				},
			],
		};
		expect(S.decodeUnknownSync(ObservationRecordParams)(bare)).toEqual(bare);
	});

	it("rejects a missing observations array", () => {
		expect(() => S.decodeUnknownSync(ObservationRecordParams)({})).toThrow();
	});

	it("rejects an empty observations array", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationRecordParams)({ observations: [] }),
		).toThrow();
	});

	it("rejects invalid evidence and exact-shape drift", () => {
		const decodeStrict = S.decodeUnknownSync(ObservationRecordParams, {
			onExcessProperty: "error",
		});
		const draft = {
			schema_key: "bodyweight",
			occurred_at: "2026-06-01T07:30:00",
			values: { kg: 72.4 },
		};
		expect(() =>
			decodeStrict({
				observations: [draft],
				evidence: {},
			}),
		).toThrow();
		expect(() =>
			decodeStrict({
				observations: [draft],
				evidence: null,
			}),
		).toThrow();
		expect(() =>
			decodeStrict({
				observations: [draft],
				evidence: {
					journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
					message_id: "0190d3c1-0000-7000-8000-000000000002",
				},
			}),
		).toThrow();
		expect(() =>
			decodeStrict({
				observations: [{ ...draft, occurred_at: "2026-06-01" }],
			}),
		).toThrow();
		expect(() =>
			decodeStrict({
				observations: [{ ...draft, unit: "kg" }],
			}),
		).toThrow();
		expect(() =>
			decodeStrict({
				observations: [draft],
				unexpected_field: true,
			}),
		).toThrow();
	});
});

describe("ObservationRecordResult", () => {
	it("decodes ids and encodes back unchanged", () => {
		const wire = {
			observation_ids: [
				"0190d3c1-0000-7000-8000-000000000001",
				"0190d3c1-0000-7000-8000-000000000002",
			],
		};
		const decoded = S.decodeUnknownSync(ObservationRecordResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationRecordResult)(decoded)).toEqual(wire);
	});
});

describe("ObservationUpdateParams", () => {
	it("decodes a source-free replacement observation", () => {
		const wire = {
			observation_id: "0190d3c1-0000-7000-8000-000000000001",
			observation: {
				occurred_at: "2026-06-03T07:30:00",
				ended_at: "2026-06-03T07:35:00",
				values: { kg: 71.8 },
				note: "corrected",
			},
		};
		const decoded = S.decodeUnknownSync(ObservationUpdateParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationUpdateParams)(decoded)).toEqual(wire);
	});

	it("decodes the bare optional shape", () => {
		const bare = {
			observation_id: "0190d3c1-0000-7000-8000-000000000001",
			observation: {
				occurred_at: "2026-06-03T07:30:00",
				values: { kg: 71.8 },
			},
		};
		expect(S.decodeUnknownSync(ObservationUpdateParams)(bare)).toEqual(bare);
	});

	it("rejects malformed observation ids", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationUpdateParams)({
				observation_id: "not-a-uuid",
				observation: {
					occurred_at: "2026-06-03T07:30:00",
					values: { kg: 71.8 },
				},
			}),
		).toThrow();
	});

	it("rejects a stray schema_key on the replacement observation", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationUpdateParams, {
				onExcessProperty: "error",
			})({
				observation_id: "0190d3c1-0000-7000-8000-000000000001",
				observation: {
					schema_key: "bodyweight",
					occurred_at: "2026-06-03T07:30:00",
					values: { kg: 71.8 },
				},
			}),
		).toThrow();
	});

	it("rejects evidence on the replacement observation", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationUpdateParams, {
				onExcessProperty: "error",
			})({
				observation_id: "0190d3c1-0000-7000-8000-000000000001",
				observation: {
					occurred_at: "2026-06-03T07:30:00",
					values: { kg: 71.8 },
					evidence: {
						message_id: "0190d3c1-0000-7000-8000-000000000002",
					},
				},
			}),
		).toThrow();
	});
});

describe("ObservationUpdateResult", () => {
	it("decodes the updated observation id", () => {
		const wire = {
			observation_id: "0190d3c1-0000-7000-8000-000000000001",
		};
		const decoded = S.decodeUnknownSync(ObservationUpdateResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationUpdateResult)(decoded)).toEqual(wire);
	});
});

describe("ObservationQueryParams", () => {
	it("decodes every optional filter and encodes back unchanged", () => {
		const wire = {
			schema_keys: ["bodyweight"],
			from: "2026-06-01T00:00:00",
			to: "2026-06-30T23:59:59",
			source_entity_id: "0190d3c1-0000-7000-8000-000000000002",
			related_entity_id: "0190d3c1-0000-7000-8000-000000000004",
			limit: 50,
		};
		const decoded = S.decodeUnknownSync(ObservationQueryParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryParams)(decoded)).toEqual(wire);
	});

	it("decodes a message-source filter", () => {
		const wire = {
			source_message_id: "0190d3c1-0000-7000-8000-000000000003",
		};
		const decoded = S.decodeUnknownSync(ObservationQueryParams)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryParams)(decoded)).toEqual(wire);
	});

	it("decodes an empty query", () => {
		expect(S.decodeUnknownSync(ObservationQueryParams)({})).toEqual({});
	});
});

describe("ObservationQueryResult", () => {
	const baseRow = {
		id: "0190d3c1-0000-7000-8000-000000000001",
		schema_key: "bodyweight",
		schema_version: 1,
		occurred_at: "2026-06-01T07:30:00",
		ended_at: "2026-06-01T07:35:00",
		values: { kg: 72.4 },
		note: "after morning run",
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_001,
	};

	const entitySourcedRow = {
		...baseRow,
		source: {
			source_entity_id: "0190d3c1-0000-7000-8000-000000000002",
			relation: "created_from",
		},
	};

	const messageSourcedRow = {
		...baseRow,
		source: {
			source_message_id: "0190d3c1-0000-7000-8000-000000000003",
			relation: "evidenced_by",
		},
	};

	it("decodes an entity-sourced observation row and encodes back unchanged", () => {
		const wire = { observations: [entitySourcedRow] };
		const decoded = S.decodeUnknownSync(ObservationQueryResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryResult)(decoded)).toEqual(wire);
	});

	it("decodes a message-sourced observation row and encodes back unchanged", () => {
		const wire = { observations: [messageSourcedRow] };
		const decoded = S.decodeUnknownSync(ObservationQueryResult)(wire);
		expect(decoded).toEqual(wire);
		expect(S.encodeSync(ObservationQueryResult)(decoded)).toEqual(wire);
	});

	it("requires explicit nulls for nullable row fields", () => {
		const wire = {
			observations: [
				{
					...entitySourcedRow,
					ended_at: null,
					note: null,
					source: null,
				},
			],
		};
		expect(S.decodeUnknownSync(ObservationQueryResult)(wire)).toEqual(wire);
	});

	it("rejects an unknown source relation", () => {
		expect(() =>
			S.decodeUnknownSync(ObservationQueryResult)({
				observations: [
					{
						...entitySourcedRow,
						source: { ...entitySourcedRow.source, relation: "quoted_in" },
					},
				],
			}),
		).toThrow();
	});
});
