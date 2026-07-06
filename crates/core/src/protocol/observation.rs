//! `observation/*` wire types (record, update, query, get_history)
//! (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// One draft observation in `observation/record` params (ADR-0053). `values` is
/// schema-specific opaque JSON; Core validates it against the observation schema
/// registry before storage.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationRecordDraft {
    pub schema_key: String,
    pub occurred_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    #[serde(default)]
    pub note: Option<String>,
}

/// Optional evidence attached to a direct `observation/record` batch. Both
/// fields are strings at the wire layer; Core validates identifiers when the RPC
/// handler maps this shape into the observation module.
#[derive(Debug, Deserialize)]
pub struct ObservationEvidence {
    #[serde(default)]
    pub journal_entry_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
}

/// `observation/record` params (ADR-0053): direct user-authored observation
/// drafts plus optional shared evidence for the batch.
#[derive(Debug, Deserialize)]
pub struct ObservationRecordParams {
    pub observations: Vec<ObservationRecordDraft>,
    #[serde(default)]
    pub evidence: Option<ObservationEvidence>,
}

/// `observation/record` result: ids of the created observations, in input order.
#[derive(Debug, Serialize)]
pub struct ObservationRecordResult {
    pub observation_ids: Vec<String>,
}

/// The mutable fact fields of an `observation/update` replacement (#256). Unlike
/// [`ObservationRecordDraft`], this carries NO `schema_key`: the schema is
/// single-sourced from the stored row, so a stray `schema_key` (or any other
/// unknown field) is hard-rejected by `deny_unknown_fields`. `values` are
/// validated against the stored row's schema by Core, not the wire payload.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationUpdateDraft {
    pub occurred_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    #[serde(default)]
    pub note: Option<String>,
}

/// `observation/update` params: the target Observation id plus a source-free
/// replacement draft. Provenance stays immutable; corrections only change the
/// current fact fields and append `observation_revisions`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationUpdateParams {
    pub observation_id: uuid::Uuid,
    pub observation: ObservationUpdateDraft,
}

/// `observation/update` result: the canonical id of the updated Observation.
#[derive(Debug, Serialize)]
pub struct ObservationUpdateResult {
    pub observation_id: String,
}

/// `observation/query` params (ADR-0053): optional schema, time, evidence
/// source, related Entity, and limit filters. `related_entity_id` filters
/// schema-specific Observation relation fields such as `habit.checkin.habit_id`;
/// it is distinct from `source_entity_id`, which filters provenance evidence.
#[derive(Debug, Default, Deserialize)]
pub struct ObservationQueryParams {
    #[serde(default)]
    pub schema_keys: Option<Vec<String>>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub source_entity_id: Option<String>,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub related_entity_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One observation source surfaced in `observation/query` results.
#[derive(Debug, Serialize)]
pub struct ObservationSourceView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    pub relation: String,
}

/// One row in an `observation/query` result. Nullable fields serialize as
/// explicit `null` so the Client can distinguish "known absent" from omitted
/// request fields.
#[derive(Debug, Serialize)]
pub struct ObservationRow {
    pub id: String,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    pub note: Option<String>,
    pub source: Option<ObservationSourceView>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `observation/query` result: matched observations, newest-first by Core query
/// behavior once the handler is wired.
#[derive(Debug, Serialize)]
pub struct ObservationQueryResult {
    pub observations: Vec<ObservationRow>,
}

/// `observation/get_history` params (ADR-0053): the Observation whose correction
/// history to read. `observation_id` is UUID-checked by Core.
#[derive(Debug, Deserialize)]
pub struct ObservationGetHistoryParams {
    pub observation_id: String,
}

/// One revision in an `observation/get_history` result (`observation_revisions`),
/// `seq`-ordered ascending. Like `ObservationRow`, nullable fields serialize as
/// explicit `null` so the Client can distinguish known-absent from omitted.
/// `proposal_id` names the Proposal a correction came from, `null` for user edits.
#[derive(Debug, Serialize)]
pub struct ObservationRevisionView {
    pub seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub occurred_at: String,
    pub ended_at: Option<String>,
    pub values: serde_json::Value,
    pub note: Option<String>,
    pub proposal_id: Option<String>,
    pub created_at: i64,
}

/// `observation/get_history` result: the full revision chain `ORDER BY seq ASC`.
/// Empty for an unknown observation_id (no error).
#[derive(Debug, Serialize)]
pub struct ObservationGetHistoryResult {
    pub revisions: Vec<ObservationRevisionView>,
}

/// Mirror tests: lock the Rust serde shapes to the canonical snake_case wire
/// JSON the TS `Schema` definitions in `packages/protocol` produce (ADR-0009).
/// Each test asserts agreement in the type's available direction; a renamed
/// field or changed type fails the matching test. This is the reconciliation
/// point that guards against TS/Rust divergence.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";

    #[test]
    fn observation_record_params_decodes_batch_and_evidence() {
        let wire = json!({
            "observations": [
                {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-01T07:30:00",
                    "ended_at": "2026-06-01T07:35:00",
                    "values": { "kg": 72.4 },
                    "note": "after morning run"
                },
                {
                    "schema_key": "bodyweight",
                    "occurred_at": "2026-06-02T07:30:00",
                    "values": { "kg": 72.1 }
                }
            ],
            "evidence": {
                "journal_entry_id": UUID_A
            }
        });
        let p: ObservationRecordParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.observations.len(), 2);
        assert_eq!(
            p.observations[0].ended_at.as_deref(),
            Some("2026-06-01T07:35:00")
        );
        assert_eq!(p.observations[0].values["kg"], json!(72.4));
        assert_eq!(p.observations[0].note.as_deref(), Some("after morning run"));
        assert!(p.observations[1].ended_at.is_none());
        let evidence = p.evidence.expect("evidence present");
        assert_eq!(evidence.journal_entry_id.as_deref(), Some(UUID_A));
        assert_eq!(evidence.message_id, None);
    }

    #[test]
    fn observation_update_params_decodes_source_free_replacement() {
        let wire = json!({
            "observation_id": UUID_A,
            "observation": {
                "occurred_at": "2026-06-03T07:30:00",
                "ended_at": "2026-06-03T07:35:00",
                "values": { "kg": 71.8 },
                "note": "corrected"
            }
        });
        let p: ObservationUpdateParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.observation_id.to_string(), UUID_A);
        assert_eq!(p.observation.ended_at.as_deref(), Some("2026-06-03T07:35:00"));
        assert_eq!(p.observation.values["kg"], json!(71.8));
        assert_eq!(p.observation.note.as_deref(), Some("corrected"));
    }

    #[test]
    fn observation_update_params_rejects_malformed_observation_id() {
        let wire = json!({
            "observation_id": "not-a-uuid",
            "observation": {
                "occurred_at": "2026-06-03T07:30:00",
                "values": { "kg": 71.8 }
            }
        });
        assert!(serde_json::from_value::<ObservationUpdateParams>(wire).is_err());
    }

    #[test]
    fn observation_query_params_decodes_omitted_filters() {
        let p: ObservationQueryParams = serde_json::from_value(json!({})).unwrap();
        assert!(p.schema_keys.is_none());
        assert!(p.from.is_none());
        assert!(p.to.is_none());
        assert!(p.source_entity_id.is_none());
        assert!(p.source_message_id.is_none());
        assert!(p.related_entity_id.is_none());
        assert!(p.limit.is_none());
    }

    #[test]
    fn observation_results_encode_expected_shapes() {
        let record = ObservationRecordResult {
            observation_ids: vec![UUID_A.to_string(), UUID_B.to_string()],
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            json!({ "observation_ids": [UUID_A, UUID_B] }),
        );
        let update = ObservationUpdateResult {
            observation_id: UUID_A.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&update).unwrap(),
            json!({ "observation_id": UUID_A }),
        );

        let query = ObservationQueryResult {
            observations: vec![ObservationRow {
                id: UUID_A.to_string(),
                schema_key: "bodyweight".to_string(),
                schema_version: 1,
                occurred_at: "2026-06-01T07:30:00".to_string(),
                ended_at: None,
                values: json!({ "kg": 72.4 }),
                note: None,
                source: None,
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_000,
            }],
        };
        let row = &serde_json::to_value(&query).unwrap()["observations"][0];
        assert_eq!(row["ended_at"], json!(null));
        assert_eq!(row["note"], json!(null));
        assert_eq!(row["source"], json!(null));
    }
}
