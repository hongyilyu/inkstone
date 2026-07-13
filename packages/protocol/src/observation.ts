// observation/* wire schemas (record, update, query, get_history)
// (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

import { observationUpdateParams, recordObservations } from "./payloads.js";

export const ObservationRecordParams = recordObservations;

export type ObservationRecordParams = S.Schema.Type<
	typeof ObservationRecordParams
>;

export const ObservationRecordResult = S.Struct({
	observation_ids: S.Array(S.String),
});

export type ObservationRecordResult = S.Schema.Type<
	typeof ObservationRecordResult
>;

export const ObservationUpdateParams = observationUpdateParams;

export type ObservationUpdateParams = S.Schema.Type<
	typeof ObservationUpdateParams
>;

export const ObservationUpdateResult = S.Struct({
	observation_id: S.String,
});

export type ObservationUpdateResult = S.Schema.Type<
	typeof ObservationUpdateResult
>;

export const ObservationQueryParams = S.Struct({
	schema_keys: S.optional(S.Array(S.String)),
	from: S.optional(S.String),
	to: S.optional(S.String),
	source_entity_id: S.optional(S.String),
	source_message_id: S.optional(S.String),
	related_entity_id: S.optional(S.String),
	limit: S.optional(S.Number),
});

export type ObservationQueryParams = S.Schema.Type<
	typeof ObservationQueryParams
>;

export const ObservationSourceView = S.Struct({
	source_entity_id: S.optional(S.String),
	source_message_id: S.optional(S.String),
	relation: S.Literal("created_from", "evidenced_by"),
});

export type ObservationSourceView = S.Schema.Type<typeof ObservationSourceView>;

export const ObservationRow = S.Struct({
	id: S.String,
	schema_key: S.String,
	schema_version: S.Number,
	occurred_at: S.String,
	ended_at: S.NullOr(S.String),
	values: S.Unknown,
	note: S.NullOr(S.String),
	source: S.NullOr(ObservationSourceView),
	created_at: S.Number,
	updated_at: S.Number,
});

export type ObservationRow = S.Schema.Type<typeof ObservationRow>;

export const ObservationQueryResult = S.Struct({
	observations: S.Array(ObservationRow),
});

export type ObservationQueryResult = S.Schema.Type<
	typeof ObservationQueryResult
>;

export const ObservationGetHistoryParams = S.Struct({
	observation_id: S.String,
});

export type ObservationGetHistoryParams = S.Schema.Type<
	typeof ObservationGetHistoryParams
>;

export const ObservationRevisionView = S.Struct({
	seq: S.Number,
	schema_key: S.String,
	schema_version: S.Number,
	occurred_at: S.String,
	ended_at: S.NullOr(S.String),
	values: S.Unknown,
	note: S.NullOr(S.String),
	proposal_id: S.NullOr(S.String),
	created_at: S.Number,
});

export type ObservationRevisionView = S.Schema.Type<
	typeof ObservationRevisionView
>;

export const ObservationGetHistoryResult = S.Struct({
	revisions: S.Array(ObservationRevisionView),
});

export type ObservationGetHistoryResult = S.Schema.Type<
	typeof ObservationGetHistoryResult
>;
