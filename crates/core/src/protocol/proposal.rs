//! `proposal/*` wire types (get, decide, notifications) and the resolved-plan
//! review shapes (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// `proposal/get` params (ADR-0025): the parked Run whose pending Proposal to
/// fetch.
#[derive(Debug, Deserialize)]
pub struct ProposalGetParams {
    pub run_id: uuid::Uuid,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JournalEntryBodyNode {
    Text { text: String },
    EntityRef { ref_id: String },
}

#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentJournalEntry {
    pub entity_id: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub body: Vec<JournalEntryBodyNode>,
}

/// The stored Person surfaced for an `update_person` Proposal's Current section
/// (mirror of [`ProposalReviewCurrentJournalEntry`], lamplit-desk-alignment).
/// Carries exactly the fields the create/update renderer displays — `name` plus
/// optional `note`/`aliases` — so the Client renders Current row-for-row against
/// the Proposed payload, making an omitted (thus removed, ADR-0033) field visible
/// before accept. Non-identity fields are `skip_serializing_if = None`.
#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentPerson {
    pub entity_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// The stored Project surfaced for an `update_project` Proposal's Current section
/// (sibling of [`ProposalReviewCurrentPerson`]). Carries `name` plus optional
/// `outcome`/`status`/`note`.
#[derive(Debug, Serialize)]
pub struct ProposalReviewCurrentProject {
    pub entity_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProposalReviewContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_journal_entry: Option<ProposalReviewCurrentJournalEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_person: Option<ProposalReviewCurrentPerson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_project: Option<ProposalReviewCurrentProject>,
}

/// One node of an `apply_intent_graph` proposal's resolved plan (ADR-0042),
/// computed READ-ONLY at `proposal/get` so the Client renders create/reuse/
/// ambiguous badges without re-resolving. Mirrors the TS `ResolvedNode`. A flat
/// shape (not a tagged union) keyed by `disposition`: `entity_id` is present only
/// for `reuse`, `candidates` only for `ambiguous` — both skipped otherwise. This
/// is ADVISORY: Core re-resolves authoritatively at decide, so a node that is
/// `reuse` here but raced to deleted by decide-time is fine (decide handles it).
#[derive(Debug, Serialize)]
pub struct ResolvedNode {
    pub handle: String,
    pub r#type: String,
    pub disposition: String,
    pub label: String,
    /// The reused entity's id — present only when `disposition == "reuse"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    /// The competing exact matches — present only when `disposition == "ambiguous"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<ResolvedNodeCandidate>>,
    /// Advisory near-matches (ADR-0042 near-match amendment) — present only on a
    /// `create` node that token-overlaps (subset/superset) an accepted same-type
    /// entity. NEVER authority: the apply path stays exact-only. The Client uses a
    /// single near-match to default the node to reuse-that-entity via the per-node
    /// `entity_id` override; 2+ are surfaced advisorily (the picker, #181).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub near_matches: Option<Vec<ResolvedNodeCandidate>>,
}

/// One competing exact match for an `ambiguous` [`ResolvedNode`] (ADR-0042).
#[derive(Debug, Serialize)]
pub struct ResolvedNodeCandidate {
    pub entity_id: String,
    pub label: String,
}

/// `proposal/get` result (ADR-0025): the Run's pending Proposal. `payload` is
/// opaque and mutation-specific; `rationale` may be `null`; `review_context` is
/// optional display-only context for review surfaces. `resolved_plan` is the
/// per-node create/reuse/ambiguous plan for an `apply_intent_graph` proposal only
/// (ADR-0042) — `None` (omitted) for non-graph proposal kinds.
#[derive(Debug, Serialize)]
pub struct ProposalGetResult {
    pub proposal_id: String,
    pub run_id: String,
    pub mutation_kind: String,
    pub payload: serde_json::Value,
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_context: Option<ProposalReviewContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_plan: Option<Vec<ResolvedNode>>,
    pub status: String,
}

/// One per-node decision in an `apply_intent_graph` decision vector (ADR-0042),
/// mirroring the TS `NodeDecision`. Keyed by the graph-local `handle`; `decision`
/// is `accept`|`reject`; an accept may carry an `entity_id` override (collapse a
/// reuse/ambiguous node to that id) OR `edited_fields` (correct a CREATE node's
/// content before it is minted) — mutually exclusive per node, accept-only, both
/// enforced by Core in [`crate::decide`]/[`crate::db::apply_intent_graph_proposal`].
#[derive(Debug, Clone, Deserialize)]
pub struct NodeDecision {
    pub handle: String,
    pub decision: String,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub edited_fields: Option<serde_json::Value>,
}

/// `proposal/decide` params (ADR-0025): the user's Decision on a pending
/// Proposal. `decision` is accept|reject|edit; `edited_payload` carries edits
/// for `edit`. `decision_idempotency_key` makes a retried decide safe — a repeat
/// with the same key returns the prior result without re-applying (ADR-0014).
///
/// `decisions` is the per-node vector for `apply_intent_graph` only (ADR-0042):
/// non-graph kinds keep the scalar `decision`/`edited_payload`; the
/// graph reconciles its stored nodes against this vector (reject-cascade,
/// entity_id override, edited_fields). Absent/empty = accept everything (a
/// missing per-node entry defaults to accept).
#[derive(Debug, Deserialize)]
pub struct ProposalDecideParams {
    pub proposal_id: uuid::Uuid,
    pub decision: String,
    #[serde(default)]
    #[allow(dead_code)] // consumed by `edit`; accept ignores it
    pub edited_payload: Option<serde_json::Value>,
    #[serde(default)]
    pub decisions: Option<Vec<NodeDecision>>,
    #[serde(default)]
    pub decision_idempotency_key: Option<String>,
}

/// `proposal/decide` result (ADR-0025): the post-decision `status`
/// (`accepted`|`rejected`) and, for an accept/edit that created an Entity, its
/// `entity_id` (omitted for a reject).
#[derive(Debug, Serialize)]
pub struct ProposalDecideResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

/// `proposal/pending` Notification (ADR-0025): pushed to a Run's subscribers the
/// moment it parks, so an attached chat surface shows the review card without
/// polling.
#[derive(Debug, Serialize)]
pub struct ProposalPendingNotification {
    pub run_id: String,
    pub proposal_id: String,
}

/// `proposal/changed` Notification (ADR-0025): pushed when a pending Proposal is
/// decided; `status` is `accepted`|`rejected`.
#[derive(Debug, Serialize)]
pub struct ProposalChangedNotification {
    pub run_id: String,
    pub proposal_id: String,
    pub status: String,
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
    fn proposal_get_params_decodes_run_id() {
        let wire = json!({ "run_id": UUID_A });
        let p: ProposalGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.run_id.to_string(), UUID_A);
    }

    #[test]
    fn proposal_get_result_encodes_full_shape() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "create_journal_entry".to_string(),
            payload: json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
            rationale: Some("because".to_string()),
            review_context: None,
            resolved_plan: None,
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "proposal_id": UUID_B,
                "run_id": UUID_A,
                "mutation_kind": "create_journal_entry",
                "payload": {
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Bought milk." }]
                },
                "rationale": "because",
                "status": "pending"
            }),
        );
    }

    #[test]
    fn proposal_get_result_encodes_null_rationale() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "create_journal_entry".to_string(),
            payload: json!({}),
            rationale: None,
            review_context: None,
            resolved_plan: None,
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["rationale"], json!(null));
        // `resolved_plan` omitted (None) for a non-graph kind.
        assert!(v.get("resolved_plan").is_none());
    }

    #[test]
    fn proposal_get_result_encodes_review_context() {
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "update_journal_entry".to_string(),
            payload: json!({
                "entity_id": UUID_B,
                "occurred_at": "2026-06-10T11:00:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            }),
            rationale: Some("because".to_string()),
            review_context: Some(ProposalReviewContext {
                current_journal_entry: Some(ProposalReviewCurrentJournalEntry {
                    entity_id: UUID_B.to_string(),
                    occurred_at: "2026-06-10T10:30:00".to_string(),
                    ended_at: Some("2026-06-10T10:45:00".to_string()),
                    body: vec![
                        JournalEntryBodyNode::Text {
                            text: "Bought ".to_string(),
                        },
                        JournalEntryBodyNode::EntityRef {
                            ref_id: UUID_A.to_string(),
                        },
                        JournalEntryBodyNode::Text {
                            text: ".".to_string(),
                        },
                    ],
                }),
                current_person: None,
                current_project: None,
            }),
            resolved_plan: None,
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "proposal_id": UUID_B,
                "run_id": UUID_A,
                "mutation_kind": "update_journal_entry",
                "payload": {
                    "entity_id": UUID_B,
                    "occurred_at": "2026-06-10T11:00:00",
                    "body": [{ "type": "text", "text": "Bought oat milk." }]
                },
                "rationale": "because",
                "review_context": {
                    "current_journal_entry": {
                        "entity_id": UUID_B,
                        "occurred_at": "2026-06-10T10:30:00",
                        "ended_at": "2026-06-10T10:45:00",
                        "body": [
                            { "type": "text", "text": "Bought " },
                            { "type": "entity_ref", "ref_id": UUID_A },
                            { "type": "text", "text": "." }
                        ]
                    }
                },
                "status": "pending"
            }),
        );
    }

    #[test]
    fn proposal_get_result_encodes_current_person_review_context() {
        // lamplit-desk-alignment: an `update_person` proposal/get carries the
        // CURRENT stored Person as `review_context.current_person`, so the Client
        // renders Current-vs-Proposed and the user sees a field the proposed
        // full-document REPLACE drops (here `note`, present in current but absent
        // from the proposed payload — ADR-0016, ADR-0033). Identity is `entity_id`
        // to match the sibling Current structs.
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "update_person".to_string(),
            payload: json!({ "entity_id": UUID_B, "name": "Alice Renamed" }),
            rationale: Some("the user renamed Alice".to_string()),
            review_context: Some(ProposalReviewContext {
                current_journal_entry: None,
                current_person: Some(ProposalReviewCurrentPerson {
                    entity_id: UUID_B.to_string(),
                    name: "Alice".to_string(),
                    note: Some("daycare coordinator".to_string()),
                    aliases: Some(vec!["Al".to_string()]),
                }),
                current_project: None,
            }),
            resolved_plan: None,
            status: "pending".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap()["review_context"],
            json!({
                "current_person": {
                    "entity_id": UUID_B,
                    "name": "Alice",
                    "note": "daycare coordinator",
                    "aliases": ["Al"]
                }
            }),
        );
    }

    #[test]
    fn proposal_review_current_structs_omit_absent_optionals() {
        // Each Current struct's non-identity fields are `skip_serializing_if`
        // (mirroring the TS `S.optional`): an absent optional drops from the wire,
        // so a Person with no note/aliases serializes to just `entity_id`+`name`.
        let person = serde_json::to_value(ProposalReviewCurrentPerson {
            entity_id: UUID_A.to_string(),
            name: "Bob".to_string(),
            note: None,
            aliases: None,
        })
        .unwrap();
        assert_eq!(person, json!({ "entity_id": UUID_A, "name": "Bob" }));

        let project = serde_json::to_value(ProposalReviewCurrentProject {
            entity_id: UUID_A.to_string(),
            name: "Ship API v2".to_string(),
            outcome: None,
            status: Some("active".to_string()),
            note: None,
        })
        .unwrap();
        assert_eq!(
            project,
            json!({ "entity_id": UUID_A, "name": "Ship API v2", "status": "active" }),
        );
    }

    #[test]
    fn proposal_get_result_encodes_resolved_plan() {
        // The `apply_intent_graph` resolved plan (ADR-0042): a flat per-node shape
        // keyed by disposition — `create` carries only the label; `reuse` adds
        // `entity_id`; `ambiguous` adds `candidates`. `entity_id`/`candidates` are
        // omitted on the dispositions that do not carry them.
        let r = ProposalGetResult {
            proposal_id: UUID_B.to_string(),
            run_id: UUID_A.to_string(),
            mutation_kind: "apply_intent_graph".to_string(),
            payload: json!({}),
            rationale: None,
            review_context: None,
            resolved_plan: Some(vec![
                ResolvedNode {
                    handle: "@rodeo".to_string(),
                    r#type: "todo".to_string(),
                    disposition: "create".to_string(),
                    label: "Figure out the Rodeo side".to_string(),
                    entity_id: None,
                    candidates: None,
                    // A create node MAY carry advisory near_matches (ADR-0042 amendment).
                    near_matches: Some(vec![ResolvedNodeCandidate {
                        entity_id: UUID_A.to_string(),
                        label: "Figure out Rodeo".to_string(),
                    }]),
                },
                ResolvedNode {
                    handle: "@leadads".to_string(),
                    r#type: "project".to_string(),
                    disposition: "reuse".to_string(),
                    label: "Lead Ads".to_string(),
                    entity_id: Some(UUID_A.to_string()),
                    candidates: None,
                    near_matches: None,
                },
                ResolvedNode {
                    handle: "@morris".to_string(),
                    r#type: "person".to_string(),
                    disposition: "ambiguous".to_string(),
                    label: "Morris".to_string(),
                    entity_id: None,
                    candidates: Some(vec![
                        ResolvedNodeCandidate {
                            entity_id: UUID_A.to_string(),
                            label: "Morris".to_string(),
                        },
                        ResolvedNodeCandidate {
                            entity_id: UUID_B.to_string(),
                            label: "Morris".to_string(),
                        },
                    ]),
                    near_matches: None,
                },
            ]),
            status: "pending".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        let plan = v["resolved_plan"].as_array().expect("resolved_plan array");
        assert_eq!(plan.len(), 3);
        // create node: label only, no entity_id / candidates keys — but its advisory
        // near_matches DO serialize (ADR-0042 amendment).
        assert_eq!(plan[0]["disposition"], "create");
        assert_eq!(plan[0]["type"], "todo");
        assert!(plan[0].get("entity_id").is_none());
        assert!(plan[0].get("candidates").is_none());
        assert_eq!(plan[0]["near_matches"].as_array().unwrap().len(), 1);
        assert_eq!(plan[0]["near_matches"][0]["entity_id"], UUID_A);
        // reuse node: carries entity_id, no candidates, no near_matches.
        assert_eq!(plan[1]["disposition"], "reuse");
        assert_eq!(plan[1]["entity_id"], UUID_A);
        assert!(plan[1].get("candidates").is_none());
        assert!(plan[1].get("near_matches").is_none());
        // ambiguous node: carries candidates, no entity_id, no near_matches.
        assert_eq!(plan[2]["disposition"], "ambiguous");
        assert!(plan[2].get("entity_id").is_none());
        assert_eq!(plan[2]["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(plan[2]["candidates"][0]["entity_id"], UUID_A);
        assert!(plan[2].get("near_matches").is_none());
    }

    #[test]
    fn proposal_decide_params_decodes_accept_with_key() {
        let wire = json!({
            "proposal_id": UUID_B,
            "decision": "accept",
            "decision_idempotency_key": "k1"
        });
        let p: ProposalDecideParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.proposal_id.to_string(), UUID_B);
        assert_eq!(p.decision, "accept");
        assert_eq!(p.decision_idempotency_key.as_deref(), Some("k1"));
        assert!(p.edited_payload.is_none());
    }

    #[test]
    fn proposal_decide_params_decodes_bare_accept_and_edit() {
        let bare: ProposalDecideParams =
            serde_json::from_value(json!({ "proposal_id": UUID_B, "decision": "accept" })).unwrap();
        assert_eq!(bare.decision_idempotency_key, None);
        assert!(bare.edited_payload.is_none());

        let edit: ProposalDecideParams = serde_json::from_value(json!({
            "proposal_id": UUID_B,
            "decision": "edit",
            "edited_payload": {
                "occurred_at": "2026-06-10T10:35:00",
                "body": [{ "type": "text", "text": "Bought oat milk." }]
            }
        }))
        .unwrap();
        assert_eq!(edit.decision, "edit");
        assert_eq!(
            edit.edited_payload.unwrap()["body"][0]["text"],
            json!("Bought oat milk.")
        );
    }

    #[test]
    fn proposal_decide_params_decodes_decisions_vector() {
        // The `apply_intent_graph` shape (ADR-0042): a vector of per-node
        // decisions keyed by handle, mirroring the TS `NodeDecision`. A plain
        // accept node, a reject node, an `entity_id` override, and an
        // `edited_fields` correction — the four per-node forms.
        let wire = json!({
            "proposal_id": UUID_B,
            "decision": "accept",
            "decisions": [
                { "handle": "@je", "decision": "accept" },
                { "handle": "@leadads", "decision": "reject" },
                { "handle": "@morris", "decision": "accept", "entity_id": UUID_A },
                { "handle": "@rodeo", "decision": "accept", "edited_fields": { "title": "Fixed" } }
            ],
            "decision_idempotency_key": "k-graph"
        });
        let p: ProposalDecideParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.decision, "accept");
        assert_eq!(p.decision_idempotency_key.as_deref(), Some("k-graph"));
        let decisions = p.decisions.expect("decisions vector present");
        assert_eq!(decisions.len(), 4);

        assert_eq!(decisions[0].handle, "@je");
        assert_eq!(decisions[0].decision, "accept");
        assert!(decisions[0].entity_id.is_none());
        assert!(decisions[0].edited_fields.is_none());

        assert_eq!(decisions[1].handle, "@leadads");
        assert_eq!(decisions[1].decision, "reject");

        assert_eq!(decisions[2].handle, "@morris");
        assert_eq!(decisions[2].entity_id.as_deref(), Some(UUID_A));

        assert_eq!(decisions[3].handle, "@rodeo");
        assert_eq!(
            decisions[3].edited_fields.as_ref().unwrap()["title"],
            json!("Fixed")
        );
    }

    #[test]
    fn proposal_decide_params_omits_decisions_when_absent() {
        // Non-graph proposal kinds send no `decisions` vector; absent decodes
        // to `None` (the graph cascade treats a missing vector as accept-all).
        let bare: ProposalDecideParams =
            serde_json::from_value(json!({ "proposal_id": UUID_B, "decision": "accept" })).unwrap();
        assert!(bare.decisions.is_none());
    }

    #[test]
    fn proposal_decide_result_encodes_accepted_with_entity_id() {
        let r = ProposalDecideResult {
            status: "accepted".to_string(),
            entity_id: Some(UUID_A.to_string()),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "status": "accepted", "entity_id": UUID_A }),
        );
    }

    #[test]
    fn proposal_decide_result_omits_entity_id_when_none() {
        let r = ProposalDecideResult {
            status: "rejected".to_string(),
            entity_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({ "status": "rejected" }));
        assert!(v.get("entity_id").is_none());
    }

    #[test]
    fn proposal_pending_notification_encodes_run_id_and_proposal_id() {
        let n = ProposalPendingNotification {
            run_id: UUID_A.to_string(),
            proposal_id: UUID_B.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "run_id": UUID_A, "proposal_id": UUID_B }),
        );
    }

    #[test]
    fn proposal_changed_notification_encodes_full_shape() {
        for status in ["accepted", "rejected"] {
            let n = ProposalChangedNotification {
                run_id: UUID_A.to_string(),
                proposal_id: UUID_B.to_string(),
                status: status.to_string(),
            };
            assert_eq!(
                serde_json::to_value(&n).unwrap(),
                json!({ "run_id": UUID_A, "proposal_id": UUID_B, "status": status }),
            );
        }
    }
}
