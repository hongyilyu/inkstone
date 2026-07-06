//! The schema-parity self-locks (moved whole from the old protocol.rs tail;
//! `include_str!` paths gained one `../` because this file sits one directory
//! deeper). Declared `#[cfg(test)]` from `protocol/mod.rs`.

/// Non-payload wire-message parity fixtures (the contract-test leg ADR-0009 was
/// originally written about, finished as-built). The agent-proposable
/// *payloads* are gated by `propose_workspace_mutation.rs`'s schema-vs-schema
/// fixtures; this module gates the ~31 plain serde wire structs INSTANCE-based:
/// Core serializes one canonical instance per Serialize-capable message to a
/// committed fixture (ground truth — the exact bytes the real serde path emits),
/// and the `@inkstone/contract` TS gate decodes + re-encodes that fixture against
/// the hand-authored Effect Schema. A field added/omitted/mistyped on EITHER side
/// turns the TS gate red against the one shared artifact.
///
/// Deserialize-only params (the 13 `*Params`, `WorkerStdout`, `NodeDecision`) are
/// the OTHER half (grilling Q2): Core never serializes them in production, so
/// their fixtures are HAND-AUTHORED canonical wire JSON committed under
/// `fixtures/structs/authored/`. This module's `authored_fixtures_parse` self-lock
/// asserts each one round-trips through the Rust `Deserialize` (the producer-side
/// check); the TS gate decodes them against the Effect Schema (the consumer side).
///
/// Like the payload gate, the emitter MUST live inline in `src/` (not
/// `crates/core/tests/`): `crates/core` is binary-only, so these `pub(crate)`
/// types are unreachable from an integration-test crate. The self-lock embeds the
/// committed fixtures via `include_str!` (compile-time) to dodge a disk-read race
/// with the concurrent writer test.
#[cfg(test)]
mod parity_fixtures {
    use crate::protocol::*;
    use std::path::Path;

    // Shared id constants — identical spelling to the values baked into the
    // committed fixtures, so the round-trip comparison is exact.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";
    const UUID_B: &str = "0190d3c1-0000-7000-8000-000000000002";
    const UUID_RUN: &str = "0190d3c1-0000-7000-8000-000000000003";

    /// The Serialize-capable messages Core EMITS as fixtures. Each entry is
    /// `(filename, serialized-JSON)`: the writer dumps the JSON to
    /// `fixtures/structs/emitted/<filename>`, and the self-lock re-dumps the same
    /// instance and asserts it equals the committed bytes. ONE source of truth for
    /// both halves — the writer can never drift from what the lock checks.
    ///
    /// Each instance is serialized through the REAL serde path, so the fixture is
    /// ground-truth wire bytes. A struct with optional / `skip_serializing_if`
    /// fields gets a maximal entry (every optional populated, so the gate
    /// exercises those fields) plus a `.bare`/`.omitted` companion (the None /
    /// empty branch). Leaf sub-structs (`ThreadSummary`, `EntityRow`,
    /// `MessageView`, `ModelInfo`, …) are covered TRANSITIVELY inside their
    /// wrapper result here.
    fn emitted_fixtures() -> Vec<(&'static str, String)> {
        let pretty = |v: serde_json::Value| {
            let mut s = serde_json::to_string_pretty(&v).expect("fixture serializes");
            s.push('\n');
            s
        };
        // Each entry serializes one instance through the real serde path.
        macro_rules! fx {
            ($file:literal, $val:expr) => {
                (
                    $file,
                    pretty(serde_json::to_value(&$val).expect(concat!($file, " serializes"))),
                )
            };
        }

        vec![
            // ── run/subscribe, run/cancel ──
            fx!(
                "subscribe_result.json",
                SubscribeResult {
                    run_id: UUID_RUN.to_string(),
                    status: "parked".to_string(),
                }
            ),
            fx!(
                "run_cancel_result.json",
                RunCancelResult {
                    outcome: "accepted".to_string(),
                }
            ),
            fx!(
                "run_retry_result.json",
                RunRetryResult {
                    outcome: "accepted".to_string(),
                }
            ),
            // ── proposal/* results + notifications ──
            // ProposalGetResult maximal: rationale + review_context + resolved_plan
            // all present (covers ResolvedNode create/reuse/ambiguous + near_matches,
            // ResolvedNodeCandidate, ProposalReviewContext, ProposalReviewCurrentJournalEntry,
            // JournalEntryBodyNode both variants — all transitively).
            fx!(
                "proposal_get_result.json",
                ProposalGetResult {
                    proposal_id: UUID_B.to_string(),
                    run_id: UUID_RUN.to_string(),
                    mutation_kind: "apply_intent_graph".to_string(),
                    payload: serde_json::json!({}),
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
                            ],
                        }),
                        current_person: None,
                        current_project: None,
                    }),
                    resolved_plan: Some(vec![
                        ResolvedNode {
                            handle: "@rodeo".to_string(),
                            r#type: "todo".to_string(),
                            disposition: "create".to_string(),
                            label: "Figure out the Rodeo side".to_string(),
                            entity_id: None,
                            candidates: None,
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
                            candidates: Some(vec![ResolvedNodeCandidate {
                                entity_id: UUID_B.to_string(),
                                label: "Morris".to_string(),
                            }]),
                            near_matches: None,
                        },
                    ]),
                    status: "pending".to_string(),
                }
            ),
            // ProposalGetResult bare: a single-entity kind — rationale null, no
            // review_context, no resolved_plan (omitted).
            fx!(
                "proposal_get_result.bare.json",
                ProposalGetResult {
                    proposal_id: UUID_B.to_string(),
                    run_id: UUID_RUN.to_string(),
                    mutation_kind: "create_journal_entry".to_string(),
                    payload: serde_json::json!({}),
                    rationale: None,
                    review_context: None,
                    resolved_plan: None,
                    status: "pending".to_string(),
                }
            ),
            fx!(
                "proposal_decide_result.json",
                ProposalDecideResult {
                    status: "accepted".to_string(),
                    entity_id: Some(UUID_A.to_string()),
                }
            ),
            fx!(
                "proposal_decide_result.bare.json",
                ProposalDecideResult {
                    status: "rejected".to_string(),
                    entity_id: None,
                }
            ),
            fx!(
                "proposal_pending_notification.json",
                ProposalPendingNotification {
                    run_id: UUID_RUN.to_string(),
                    proposal_id: UUID_B.to_string(),
                }
            ),
            fx!(
                "proposal_changed_notification.json",
                ProposalChangedNotification {
                    run_id: UUID_RUN.to_string(),
                    proposal_id: UUID_B.to_string(),
                    status: "accepted".to_string(),
                }
            ),
            fx!(
                "thread_titled_notification.json",
                ThreadTitledNotification {
                    thread_id: UUID_A.to_string(),
                    title: "Budget planning for Q3".to_string(),
                }
            ),
            fx!(
                "provider_connected_notification.json",
                ProviderConnectedNotification {
                    provider: "openai-codex".to_string(),
                }
            ),
            // ── run/post_message, thread/create, thread/list ──
            fx!(
                "post_message_result.json",
                PostMessageResult {
                    run_id: UUID_RUN.to_string(),
                }
            ),
            fx!(
                "thread_create_result.json",
                ThreadCreateResult {
                    thread_id: UUID_A.to_string(),
                    run_id: UUID_RUN.to_string(),
                }
            ),
            fx!(
                "thread_list_result.json",
                ThreadListResult {
                    threads: vec![ThreadSummary {
                        id: UUID_A.to_string(),
                        title: "Morning brain dump".to_string(),
                        last_activity_at: 1_700_000_000_000,
                    }],
                }
            ),
            // thread/list_archived (ADR-0052): the inverse list, reusing
            // ThreadListResult. A distinct id/title so it can't be mistaken for
            // the active fixture above.
            fx!(
                "thread_list_result.archived.json",
                ThreadListResult {
                    threads: vec![ThreadSummary {
                        id: UUID_B.to_string(),
                        title: "Archived plans".to_string(),
                        last_activity_at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── thread/rename, thread/archive, thread/unarchive (ADR-0052) ──
            // The shared ack echoing the affected thread_id.
            fx!(
                "thread_mutate_result.json",
                ThreadMutateResult {
                    thread_id: UUID_A.to_string(),
                }
            ),
            // ── run/get_history ──
            fx!(
                "run_history_result.json",
                RunHistoryResult {
                    runs: vec![RunHistoryItem {
                        run_id: UUID_RUN.to_string(),
                        thread_id: UUID_A.to_string(),
                        title: "Morning brain dump".to_string(),
                        kind: "proposal_decided".to_string(),
                        at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── recurrence/preview (continuing + ended companion) ──
            // Maximal: the series continues, both dates present.
            fx!(
                "recurrence_preview_result.json",
                RecurrencePreviewResult {
                    ended: false,
                    defer_at: Some("2026-07-08T00:00:00".to_string()),
                    due_at: Some("2026-07-15T00:00:00".to_string()),
                }
            ),
            // Ended: no successor — both dates omitted (skip_serializing_if None).
            fx!(
                "recurrence_preview_result.ended.json",
                RecurrencePreviewResult {
                    ended: true,
                    defer_at: None,
                    due_at: None,
                }
            ),
            // ── observation/* (ADR-0053) ──
            fx!(
                "observation_record_result.json",
                ObservationRecordResult {
                    observation_ids: vec![UUID_A.to_string(), UUID_B.to_string()],
                }
            ),
            fx!(
                "observation_update_result.json",
                ObservationUpdateResult {
                    observation_id: UUID_A.to_string(),
                }
            ),
            // Maximal row: nullable fields populated, opaque values present, and
            // an entity source using the created_from relation.
            fx!(
                "observation_query_result.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_A.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-01T07:30:00".to_string(),
                        ended_at: Some("2026-06-01T07:35:00".to_string()),
                        values: serde_json::json!({ "kg": 72.4 }),
                        note: Some("after morning run".to_string()),
                        source: Some(ObservationSourceView {
                            source_entity_id: Some(UUID_B.to_string()),
                            source_message_id: None,
                            relation: "created_from".to_string(),
                        }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                    }],
                }
            ),
            // Message-source companion: exercises source_message_id without
            // violating observation_sources' exactly-one source invariant.
            fx!(
                "observation_query_result.message_source.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_A.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-01T07:30:00".to_string(),
                        ended_at: Some("2026-06-01T07:35:00".to_string()),
                        values: serde_json::json!({ "kg": 72.4 }),
                        note: Some("after morning run".to_string()),
                        source: Some(ObservationSourceView {
                            source_entity_id: None,
                            source_message_id: Some(UUID_RUN.to_string()),
                            relation: "evidenced_by".to_string(),
                        }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                    }],
                }
            ),
            // Bare row: nullable result fields are explicit nulls, not omitted.
            fx!(
                "observation_query_result.bare.json",
                ObservationQueryResult {
                    observations: vec![ObservationRow {
                        id: UUID_B.to_string(),
                        schema_key: "bodyweight".to_string(),
                        schema_version: 1,
                        occurred_at: "2026-06-02T07:30:00".to_string(),
                        ended_at: None,
                        values: serde_json::json!({ "kg": 72.1 }),
                        note: None,
                        source: None,
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                    }],
                }
            ),
            // observation/get_history: a maximal seq-1 revision (every Option
            // populated, incl. proposal_id) plus a seq-2 user-correction revision
            // whose ended_at/note/proposal_id are explicit nulls — the null-branch
            // serialization is the risk this fixture pins.
            fx!(
                "observation_get_history_result.json",
                ObservationGetHistoryResult {
                    revisions: vec![
                        ObservationRevisionView {
                            seq: 1,
                            schema_key: "bodyweight".to_string(),
                            schema_version: 1,
                            occurred_at: "2026-06-01T07:30:00".to_string(),
                            ended_at: Some("2026-06-01T07:35:00".to_string()),
                            values: serde_json::json!({ "kg": 72.4 }),
                            note: Some("after morning run".to_string()),
                            proposal_id: Some(UUID_B.to_string()),
                            created_at: 1_700_000_000_000,
                        },
                        ObservationRevisionView {
                            seq: 2,
                            schema_key: "bodyweight".to_string(),
                            schema_version: 1,
                            occurred_at: "2026-06-02T07:35:00".to_string(),
                            ended_at: None,
                            values: serde_json::json!({ "kg": 71.8 }),
                            note: None,
                            proposal_id: None,
                            created_at: 1_700_000_000_001,
                        },
                    ],
                }
            ),
            // ── entity/list (EntityRow maximal + bare, transitively) ──
            // Maximal row: refs + person_refs + source all present (covers
            // ResolvedEntityRef with its optionals, TodoPersonRefView, EntitySourceView
            // message-source branch).
            fx!(
                "entity_list_result.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Buy milk" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![ResolvedEntityRef {
                            id: UUID_B.to_string(),
                            source_entity_id: UUID_A.to_string(),
                            target_entity_id: UUID_RUN.to_string(),
                            target_entity_type: "project".to_string(),
                            target_title: Some("Lead Ads".to_string()),
                            label_snapshot: Some("Lead Ads".to_string()),
                        }],
                        person_refs: vec![TodoPersonRefView {
                            person_id: UUID_B.to_string(),
                            role: "waiting_on".to_string(),
                        }],
                        source: Some(EntitySourceView {
                            thread_id: Some(UUID_A.to_string()),
                            thread_title: Some("Morning brain dump".to_string()),
                            message_id: Some(UUID_RUN.to_string()),
                            journal_entry_id: None,
                        }),
                    }],
                }
            ),
            // Bare row: no refs, no person_refs, no source — all omitted
            // (skip_serializing_if Vec::is_empty / Option::is_none). The
            // EntitySourceView journal-entry branch is covered here? No — covered by
            // a dedicated entry below to exercise that exactly-one-kind branch.
            fx!(
                "entity_list_result.bare.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "media".to_string(),
                        // Mirror a migrated bookmark (0001_initial.sql backfills
                        // medium='link', state='done') so the bare-row sample matches
                        // the documented migration shape (ADR-0059).
                        data: serde_json::json!({ "title": "Docs", "medium": "link", "state": "done" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                        refs: vec![],
                        person_refs: vec![],
                        source: None,
                    }],
                }
            ),
            // EntitySourceView journal-entry branch (the other exactly-one-kind arm):
            // a row whose source carries only journal_entry_id.
            fx!(
                "entity_list_result.je_source.json",
                EntityListResult {
                    entities: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Email Alice" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_000,
                        refs: vec![],
                        person_refs: vec![],
                        source: Some(EntitySourceView {
                            thread_id: None,
                            thread_title: None,
                            message_id: None,
                            journal_entry_id: Some(UUID_B.to_string()),
                        }),
                    }],
                }
            ),
            // ── entity/backlinks (ADR-0050) ──
            // Maximal result: mentioned_in carries a journal_entry EntityRow with
            // non-empty refs (a ResolvedEntityRef incl. its optionals) + a message
            // source (EntitySourceView), mirroring the entity_list_result.json
            // maximal row so EntityRow coverage carries; linked_todos carries a todo
            // EntityRow with non-empty person_refs. Both arrays always present.
            fx!(
                "entity_backlinks_result.json",
                EntityBacklinksResult {
                    mentioned_in: vec![EntityRow {
                        id: UUID_A.to_string(),
                        r#type: "journal_entry".to_string(),
                        data: serde_json::json!({ "title": "Morning brain dump" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![ResolvedEntityRef {
                            id: UUID_B.to_string(),
                            source_entity_id: UUID_A.to_string(),
                            target_entity_id: UUID_RUN.to_string(),
                            target_entity_type: "project".to_string(),
                            target_title: Some("Lead Ads".to_string()),
                            label_snapshot: Some("Lead Ads".to_string()),
                        }],
                        person_refs: vec![],
                        source: Some(EntitySourceView {
                            thread_id: Some(UUID_A.to_string()),
                            thread_title: Some("Morning brain dump".to_string()),
                            message_id: Some(UUID_RUN.to_string()),
                            journal_entry_id: None,
                        }),
                    }],
                    linked_todos: vec![EntityRow {
                        id: UUID_B.to_string(),
                        r#type: "todo".to_string(),
                        data: serde_json::json!({ "title": "Buy milk" }),
                        created_at: 1_700_000_000_000,
                        updated_at: 1_700_000_000_001,
                        refs: vec![],
                        person_refs: vec![TodoPersonRefView {
                            person_id: UUID_A.to_string(),
                            role: "waiting_on".to_string(),
                        }],
                        source: None,
                    }],
                }
            ),
            // ── entity/mutate ──
            fx!(
                "entity_mutate_result.json",
                EntityMutateResult {
                    entity_id: Some(UUID_A.to_string()),
                }
            ),
            fx!(
                "entity_mutate_result.bare.json",
                EntityMutateResult { entity_id: None }
            ),
            // ── journal_entry/rescan (ADR-0042) ──
            fx!(
                "journal_entry_rescan_result.json",
                JournalEntryRescanResult {
                    run_id: UUID_RUN.to_string(),
                    thread_id: UUID_B.to_string(),
                }
            ),
            // ── message/search ──
            fx!(
                "message_search_result.json",
                MessageSearchResult {
                    hits: vec![MessageHit {
                        message_id: UUID_A.to_string(),
                        thread_id: UUID_B.to_string(),
                        run_id: UUID_RUN.to_string(),
                        role: "assistant".to_string(),
                        snippet: "…daycare schedule…".to_string(),
                        thread_title: "Planning".to_string(),
                        created_at: 1_700_000_000_000,
                    }],
                }
            ),
            // ── thread/get (MessageView maximal + bare, transitively) ──
            // Maximal: an assistant turn whose ORDERED segments are the screenshot
            // order (ADR-0045) — two tool_call segments (one with arg, one without —
            // covers Segment::ToolCall optional arg), then the decided proposal
            // segment (Segment::Proposal), then a reasoning segment (Segment::Reasoning,
            // ADR-0045 reasoning amendment), then the reply text (Segment::Text). All
            // four Segment variants are thus covered transitively here.
            fx!(
                "thread_get_result.json",
                ThreadGetResult {
                    thread_id: UUID_A.to_string(),
                    title: "Morning brain dump".to_string(),
                    messages: vec![MessageView {
                        id: UUID_B.to_string(),
                        role: "assistant".to_string(),
                        status: "complete".to_string(),
                        run_id: UUID_RUN.to_string(),
                        segments: vec![
                            Segment::ToolCall {
                                name: "search_entities".to_string(),
                                status: "completed".to_string(),
                                arg: Some("Lev".to_string()),
                            },
                            Segment::ToolCall {
                                name: "read_thread".to_string(),
                                status: "completed".to_string(),
                                arg: None,
                            },
                            Segment::Proposal {
                                proposal_id: UUID_A.to_string(),
                                mutation_kind: "apply_intent_graph".to_string(),
                                status: "accepted".to_string(),
                                // The anchor Entity the accepted apply created/updated
                                // (ADR-0044 entity_id amendment) — the decided card
                                // names + deep-links it. Omitted when absent (S.optional).
                                entity_id: Some(UUID_B.to_string()),
                            },
                            Segment::Reasoning {
                                text: "Checking the journal schema…".to_string(),
                                duration_ms: Some(1500),
                            },
                            Segment::Text {
                                text: "Logged.".to_string(),
                            },
                        ],
                    }],
                }
            ),
            // Bare: a user turn — a single text segment.
            fx!(
                "thread_get_result.bare.json",
                ThreadGetResult {
                    thread_id: UUID_A.to_string(),
                    title: "Morning brain dump".to_string(),
                    messages: vec![MessageView {
                        id: UUID_B.to_string(),
                        role: "user".to_string(),
                        status: "complete".to_string(),
                        run_id: UUID_RUN.to_string(),
                        segments: vec![Segment::Text {
                            text: "I bought milk.".to_string(),
                        }],
                    }],
                }
            ),
            // ── provider/status, provider/login_start ──
            // provider/status enumerates BOTH known providers (ADR-0062): the
            // OAuth codex (connected) and the key-configurable openrouter
            // (disconnected), covering both `connected` values.
            fx!(
                "provider_status_result.json",
                ProviderStatusResult {
                    providers: vec![
                        ProviderStatus {
                            id: "openai-codex".to_string(),
                            connected: true,
                            auth_kind: crate::providers::AuthKind::Oauth,
                        },
                        ProviderStatus {
                            id: "openrouter".to_string(),
                            connected: false,
                            auth_kind: crate::providers::AuthKind::ApiKey,
                        },
                    ],
                }
            ),
            fx!(
                "provider_login_start_result.json",
                ProviderLoginStartResult {
                    authorize_url: "https://auth.openai.com/oauth/authorize?x=1".to_string(),
                }
            ),
            // ── model/catalog ──
            fx!(
                "model_catalog_result.json",
                ModelCatalogResult {
                    providers: vec![ProviderModels {
                        id: "openai-codex".to_string(),
                        label: "OpenAI".to_string(),
                        models: vec![ModelInfo {
                            id: "gpt-5.5".to_string(),
                            name: "GPT-5.5".to_string(),
                            reasoning: true,
                            input: vec!["text".to_string(), "image".to_string()],
                        }],
                    }],
                }
            ),
            // ── settings/* (model present + null branch) ──
            fx!(
                "settings_result.json",
                SettingsResult {
                    provider: "openai-codex".to_string(),
                    model: Some("gpt-5.5".to_string()),
                    effort: "high".to_string(),
                    enabled_models: vec!["gpt-5.4".to_string(), "gpt-5.5".to_string()],
                }
            ),
            fx!(
                "settings_result.bare.json",
                SettingsResult {
                    provider: "openai-codex".to_string(),
                    model: None,
                    effort: "off".to_string(),
                    // The unset/uncurated default: an empty enabled set (ADR-0024),
                    // NOT the materialized catalog — Core never bakes today's catalog
                    // into the response, so an uncurated user is not frozen out of
                    // models added later.
                    enabled_models: vec![],
                }
            ),
            // ── provider/test (ADR-0062): the liveness result, alive + dead. The
            // alive fixture omits `message` (skip_serializing_if None, matching the
            // TS S.optional); the dead fixture carries it. ──
            fx!(
                "provider_test_result.json",
                ProviderTestResult {
                    alive: true,
                    message: None,
                }
            ),
            fx!(
                "provider_test_result.dead.json",
                ProviderTestResult {
                    alive: false,
                    message: Some("provider rejected the request".to_string()),
                }
            ),
            // ── slice 4: worker↔core protocol (the surface ADR-0009 was written
            // about). RunEvent (ser+deser) emitted per variant; the tool_call
            // variant gets one fixture per ToolCallStatus value (started carries an
            // arg, completed/error omit it) so the closed status domain is locked. ──
            fx!(
                "run_event.text_delta.json",
                RunEvent::TextDelta {
                    delta: "Bought ".to_string(),
                }
            ),
            fx!(
                "run_event.tool_call.started.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_01".to_string(),
                    name: "search_entities".to_string(),
                    status: ToolCallStatus::Started,
                    arg: Some("Lev".to_string()),
                }
            ),
            fx!(
                "run_event.tool_call.completed.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_02".to_string(),
                    name: "read_thread".to_string(),
                    status: ToolCallStatus::Completed,
                    arg: None,
                }
            ),
            fx!(
                "run_event.tool_call.error.json",
                RunEvent::ToolCall {
                    tool_call_id: "tc_03".to_string(),
                    name: "read_thread".to_string(),
                    status: ToolCallStatus::Error,
                    arg: None,
                }
            ),
            fx!("run_event.done.json", RunEvent::Done),
            fx!("run_event.cancelled.json", RunEvent::Cancelled),
            fx!(
                "run_event.error.json",
                RunEvent::Error {
                    message: "boom".to_string(),
                }
            ),
            // reasoning_delta (ADR-0045 reasoning amendment, #202): the thinking
            // delta Core republishes from WorkerStdout::ReasoningDelta.
            fx!(
                "run_event.reasoning_delta.json",
                RunEvent::ReasoningDelta {
                    delta: "Checking the journal schema…".to_string(),
                }
            ),
            // ToolResult (ser-only, Core → Worker): the ok / err arms of the
            // untagged ToolOutcome union (covers AgentToolResult + ToolTextContent +
            // ToolErrorWire transitively).
            fx!(
                "tool_result.ok.json",
                ToolResult {
                    kind: "tool_result",
                    run_id: UUID_RUN.to_string(),
                    tool_call_id: "tc_01".to_string(),
                    outcome: ToolOutcome::Ok {
                        ok: AgentToolResult {
                            content: vec![ToolTextContent {
                                r#type: "text".to_string(),
                                text: "{\"messages\":[]}".to_string(),
                            }],
                            details: None,
                            terminate: None,
                        },
                    },
                }
            ),
            fx!(
                "tool_result.err.json",
                ToolResult {
                    kind: "tool_result",
                    run_id: UUID_RUN.to_string(),
                    tool_call_id: "tc_01".to_string(),
                    outcome: ToolOutcome::Err {
                        err: ToolErrorWire {
                            code: "tool_not_allowed".to_string(),
                            message: "no".to_string(),
                        },
                    },
                }
            ),
            // WorkerManifest (ser-only, borrowed-lifetime <'a> — owned literals live
            // to the serialize call inside `fx!`). Maximal: resume mode, all THREE
            // ManifestMessage variants (user / assistant-with-tool_calls /
            // tool_result), access_token present, a tool descriptor (covers
            // WorkflowManifest + CoreToolDescriptor + ManifestToolCall transitively).
            fx!(
                "worker_manifest.json",
                WorkerManifest {
                    run_id: UUID_RUN.parse().expect("valid uuid"),
                    workflow: WorkflowManifest {
                        name: "default",
                        version: "1.0.0",
                        provider: "openai-codex",
                        model: "gpt-5.5",
                        system_prompt: "hi",
                        thinking_level: "off",
                        tools: vec![CoreToolDescriptor {
                            name: "read_thread".to_string(),
                            description: "Read a thread".to_string(),
                            label: "Read thread".to_string(),
                            json_schema: serde_json::json!({ "type": "object" }),
                        }],
                    },
                    prompt: "",
                    messages: vec![
                        ManifestMessage::User { text: "earlier q" },
                        ManifestMessage::Assistant {
                            text: None,
                            tool_calls: Some(vec![ManifestToolCall {
                                id: "tc_1",
                                name: "propose_workspace_mutation",
                                arguments: serde_json::json!({ "mutation_kind": "create_journal_entry" }),
                            }]),
                        },
                        ManifestMessage::ToolResult {
                            tool_call_id: "tc_1",
                            content: "Accepted.",
                            is_error: None,
                        },
                    ],
                    mode: Some("resume"),
                    access_token: Some("tok_abc"),
                }
            ),
            // WorkerManifest bare: fresh start, empty history, no mode / token.
            fx!(
                "worker_manifest.bare.json",
                WorkerManifest {
                    run_id: UUID_RUN.parse().expect("valid uuid"),
                    workflow: WorkflowManifest {
                        name: "default",
                        version: "1.0.0",
                        provider: "faux",
                        model: "faux-1",
                        system_prompt: "hi",
                        thinking_level: "off",
                        tools: vec![],
                    },
                    prompt: "now",
                    messages: vec![],
                    mode: None,
                    access_token: None,
                }
            ),
        ]
    }

    /// Dump every emitted fixture to `tests/contract/fixtures/structs/emitted/`.
    /// Deterministic (serde sorts object keys; pretty-print + trailing newline), so
    /// CI re-runs it and `git diff --exit-code` is the staleness gate — exactly the
    /// payload gate's contract. CI regenerates ONLY this dir; `authored/` is
    /// hand-maintained and never regenerated.
    #[test]
    fn regenerate_struct_fixtures() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/contract/fixtures/structs/emitted");
        std::fs::create_dir_all(&dir).expect("create emitted fixtures dir");
        for (file, json) in emitted_fixtures() {
            let path = dir.join(file);
            std::fs::write(&path, json).unwrap_or_else(|e| panic!("write {path:?}: {e}"));
        }
    }

    /// Lift CI's `git diff --exit-code` into the test suite so `cargo test` ITSELF
    /// bites on a stale emitted fixture. The committed bytes are EMBEDDED via
    /// `include_str!` (compile-time, NOT a disk read): `regenerate_struct_fixtures`
    /// rewrites the same files and runs concurrently in this binary — a disk read
    /// would race the writer and tear. Both sides parse to `Value` before asserting
    /// (robust to trailing-newline / whitespace), naming the stale file on mismatch.
    #[test]
    fn emitted_fixtures_match_committed() {
        // (filename, committed bytes). `include_str!` resolves relative to this
        // source file (`crates/core/src/protocol.rs`): `../../../tests/contract/…`.
        macro_rules! committed {
            ($($file:literal),+ $(,)?) => {
                &[$((
                    $file,
                    include_str!(concat!(
                        "../../../../tests/contract/fixtures/structs/emitted/",
                        $file
                    )),
                )),+]
            };
        }
        let committed: &[(&str, &str)] = committed![
            "subscribe_result.json",
            "run_cancel_result.json",
            "run_retry_result.json",
            "proposal_get_result.json",
            "proposal_get_result.bare.json",
            "proposal_decide_result.json",
            "proposal_decide_result.bare.json",
            "proposal_pending_notification.json",
            "proposal_changed_notification.json",
            "thread_titled_notification.json",
            "provider_connected_notification.json",
            "post_message_result.json",
            "thread_create_result.json",
            "thread_list_result.json",
            "thread_list_result.archived.json",
            "thread_mutate_result.json",
            "run_history_result.json",
            "recurrence_preview_result.json",
            "recurrence_preview_result.ended.json",
            "observation_record_result.json",
            "observation_update_result.json",
            "observation_query_result.json",
            "observation_query_result.message_source.json",
            "observation_query_result.bare.json",
            "observation_get_history_result.json",
            "entity_list_result.json",
            "entity_list_result.bare.json",
            "entity_list_result.je_source.json",
            "entity_backlinks_result.json",
            "entity_mutate_result.json",
            "entity_mutate_result.bare.json",
            "journal_entry_rescan_result.json",
            "message_search_result.json",
            "thread_get_result.json",
            "thread_get_result.bare.json",
            "provider_status_result.json",
            "provider_login_start_result.json",
            "model_catalog_result.json",
            "settings_result.json",
            "settings_result.bare.json",
            "provider_test_result.json",
            "provider_test_result.dead.json",
            "run_event.text_delta.json",
            "run_event.tool_call.started.json",
            "run_event.tool_call.completed.json",
            "run_event.tool_call.error.json",
            "run_event.done.json",
            "run_event.cancelled.json",
            "run_event.error.json",
            "run_event.reasoning_delta.json",
            "tool_result.ok.json",
            "tool_result.err.json",
            "worker_manifest.json",
            "worker_manifest.bare.json",
        ];
        // The embedded table must cover exactly what the writer emits — neither can
        // gain or drop a fixture the other lacks.
        let emitted = emitted_fixtures();
        assert_eq!(
            committed.len(),
            emitted.len(),
            "the embedded fixture table must cover every emitted struct fixture"
        );
        for (file, fresh) in emitted {
            let raw = committed
                .iter()
                .find_map(|(f, raw)| (*f == file).then_some(*raw))
                .unwrap_or_else(|| panic!("embedded fixture table is missing {file}"));
            let committed_value: serde_json::Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("parse committed fixture {file}: {e}"));
            let fresh_value: serde_json::Value =
                serde_json::from_str(&fresh).expect("fresh fixture parses");
            assert_eq!(
                committed_value, fresh_value,
                "committed emitted fixture {file} is stale; run `cargo test regenerate_struct_fixtures` and commit tests/contract/fixtures/structs/emitted/{file}"
            );
        }
    }

    /// The hand-authored params self-lock (grilling Q2): each Deserialize-only
    /// param's committed fixture must round-trip through the Rust `Deserialize` —
    /// the producer-side half of the gate (Core is the consumer of params in
    /// production, so "Core accepts this shape" is the meaningful Rust check). The
    /// TS gate independently decodes the same file against the Effect Schema. The
    /// fixtures are NEVER regenerated — they are the canonical wire JSON Web sends,
    /// authored by hand. `include_str!` embeds them (no disk read needed; no
    /// concurrent writer for this dir, but kept consistent with the emitted lock).
    #[test]
    fn authored_fixtures_parse() {
        // Each authored param fixture must deserialize through its Rust type — the
        // producer-side half of the gate. A macro keeps each line to the type +
        // file it checks; the TS gate independently decodes the same files. UUID
        // fields are real UUIDs (Rust parses them) though TS types them `S.String`.
        macro_rules! parses {
            ($ty:ty, $file:literal) => {{
                let raw = include_str!(concat!(
                    "../../../../tests/contract/fixtures/structs/authored/",
                    $file
                ));
                let _parsed: $ty = serde_json::from_str(raw)
                    .unwrap_or_else(|e| panic!(concat!($file, " must deserialize: {}"), e));
            }};
        }

        parses!(SubscribeParams, "subscribe_params.json");
        parses!(PostMessageParams, "post_message_params.json");
        parses!(RunCancelParams, "run_cancel_params.json");
        parses!(RunRetryParams, "run_retry_params.json");
        parses!(ProposalGetParams, "proposal_get_params.json");
        parses!(ProposalDecideParams, "proposal_decide_params.json");
        parses!(ProposalDecideParams, "proposal_decide_params.edit.json");
        parses!(ProposalDecideParams, "proposal_decide_params.bare.json");
        parses!(ThreadCreateParams, "thread_create_params.json");
        parses!(RunGetHistoryParams, "run_get_history_params.json");
        parses!(RunGetHistoryParams, "run_get_history_params.bare.json");
        parses!(
            RecurrencePreviewParams,
            "recurrence_preview_params.json"
        );
        parses!(
            RecurrencePreviewParams,
            "recurrence_preview_params.bare.json"
        );
        parses!(ObservationRecordParams, "observation_record_params.json");
        parses!(
            ObservationRecordParams,
            "observation_record_params.bare.json"
        );
        parses!(ObservationUpdateParams, "observation_update_params.json");
        parses!(
            ObservationUpdateParams,
            "observation_update_params.bare.json"
        );
        parses!(ObservationQueryParams, "observation_query_params.json");
        parses!(
            ObservationQueryParams,
            "observation_query_params.message_source.json"
        );
        parses!(
            ObservationQueryParams,
            "observation_query_params.bare.json"
        );
        parses!(
            ObservationGetHistoryParams,
            "observation_get_history_params.json"
        );
        parses!(EntityListParams, "entity_list_params.json");
        parses!(EntityBacklinksParams, "entity_backlinks_params.json");
        parses!(EntityMutateParams, "entity_mutate_params.json");
        parses!(JournalEntryRescanParams, "journal_entry_rescan_params.json");
        parses!(MessageSearchParams, "message_search_params.json");
        parses!(ThreadGetParams, "thread_get_params.json");
        parses!(ThreadRenameParams, "thread_rename_params.json");
        parses!(ThreadArchiveParams, "thread_archive_params.json");
        parses!(ThreadUnarchiveParams, "thread_unarchive_params.json");
        parses!(ProviderLoginStartParams, "provider_login_start_params.json");
        parses!(ProviderConfigureParams, "provider_configure_params.json");
        parses!(ProviderTestParams, "provider_test_params.json");
        parses!(SettingsSetParams, "settings_set_params.json");
        parses!(SettingsSetParams, "settings_set_params.bare.json");

        // WorkerStdout (deser-only): the 5 variants Core reads off the Worker's
        // stdout. Hand-authored because Core never serializes them.
        parses!(WorkerStdout, "worker_stdout.text_delta.json");
        parses!(WorkerStdout, "worker_stdout.done.json");
        parses!(WorkerStdout, "worker_stdout.error.json");
        parses!(WorkerStdout, "worker_stdout.tool_request.json");
        parses!(WorkerStdout, "worker_stdout.reasoning_delta.json");

        // HelperLine (deser-only): the 3 variants Core reads off the Provider
        // Helper's stdout (ADR-0023). Hand-authored because Core never
        // serializes them.
        parses!(HelperLine, "provider_helper_line.authorize_url.json");
        parses!(HelperLine, "provider_helper_line.credentials.json");
        parses!(HelperLine, "provider_helper_line.error.json");

        // Spot-check the maximal ProposalDecideParams carries every per-node form,
        // so a future fixture edit can't silently drop the rich graph shape.
        let graph: ProposalDecideParams = serde_json::from_str(include_str!(
            "../../../../tests/contract/fixtures/structs/authored/proposal_decide_params.json"
        ))
        .unwrap();
        let decisions = graph.decisions.expect("maximal carries a decisions vector");
        assert_eq!(decisions.len(), 4, "all four per-node decision forms present");
    }
}
