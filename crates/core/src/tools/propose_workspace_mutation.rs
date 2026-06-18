//! The `propose_workspace_mutation` tool (ADR-0016, ADR-0025). A Proposal is a
//! Tool Request whose Tool Result is a user Decision, so it has no `execute`:
//! Core persists a pending Proposal, parks the Run, and resumes on Decision.

use serde_json::{Map, Value};

use crate::mutation::ProposableMutation;
use crate::protocol::CoreToolDescriptor;

pub const NAME: &str = "propose_workspace_mutation";
const DESCRIPTION: &str = "Propose a Workspace mutation for user review: capture a journal-worthy lived event or reflection as a Journal Entry, or extract People/Projects/Todos from an already-accepted Journal Entry. Do not create a Journal Entry for a bare reminder, task, or future obligation the user only wants remembered.";
const LABEL: &str = "Propose Workspace mutation";

/// The agent tool descriptor (ADR-0018): a top-level `oneOf` over the 14
/// agent-proposable mutation kinds (ADR-0036, ADR-0042), each variant binding its
/// `mutation_kind` discriminant to the payload schema its
/// [`crate::mutation::MutationKind::payload_spec`] emits — the SAME single source
/// the validators derive from. The 4 user-only kinds (the bookmarks +
/// `mark_project_reviewed`) are validated but deliberately absent from this
/// surface. Inlined Draft-07 (no `$ref`/`definitions`): ADR-0018 wants inlined
/// schemas because Anthropic rejects `$ref`.
pub fn descriptor() -> CoreToolDescriptor {
    let variants = ProposableMutation::ALL
        .iter()
        .map(|proposable| {
            let kind = proposable.kind();
            serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "mutation_kind": { "type": "string", "enum": [kind.as_wire()] },
                    "payload": kind.payload_spec().json_schema(),
                    // The model-attached, nullable explanation stored on the
                    // proposal row (read from the row, not the payload).
                    "rationale": { "type": ["string", "null"], "default": null },
                },
                "required": ["mutation_kind", "payload"],
            })
        })
        .collect::<Vec<_>>();

    let mut schema = Map::new();
    schema.insert("title".to_string(), Value::String("Input".to_string()));
    schema.insert(
        "description".to_string(),
        Value::String(
            "Wire arguments: `mutation_kind` names the mutation; `payload` is its body, validated by Core on Decision."
                .to_string(),
        ),
    );
    schema.insert("oneOf".to_string(), Value::Array(variants));

    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: Value::Object(schema),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dump each agent-proposable kind's `payload` JSON-Schema to a committed
    /// fixture under `tests/contract/fixtures/<wire_kind>.json` — the
    /// schema-of-record the `@inkstone/contract` parity gate diffs the
    /// hand-authored Effect Schemas against (slice 1 of `schema-parity-gate`).
    ///
    /// This MUST live inline in `src/` (not `crates/core/tests/`): `crates/core`
    /// is binary-only (no `lib.rs`), so the `pub(crate)` entry point
    /// `kind().payload_spec().json_schema()` is unreachable from an integration
    /// test crate. The fixture body is EXACTLY the `payload` schema — the same
    /// expression [`descriptor`] binds — NOT the `{mutation_kind, payload,
    /// rationale}` envelope.
    ///
    /// It writes ALL 14 fixtures — the TS parity test (`tests/contract`)
    /// asserts every one against its committed fixture. The output is
    /// deterministic (`serde_json` sorts object keys; pretty-print + trailing
    /// newline), so CI re-runs it and `git diff --exit-code` is the staleness
    /// gate.
    #[test]
    fn regenerate_schema_fixtures() {
        let fixtures_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/contract/fixtures");
        std::fs::create_dir_all(&fixtures_dir).expect("create fixtures dir");

        for proposable in ProposableMutation::ALL {
            let kind = proposable.kind();
            let schema = kind.payload_spec().json_schema();
            let mut json = serde_json::to_string_pretty(&schema).expect("schema serializes");
            json.push('\n');
            let path = fixtures_dir.join(format!("{}.json", kind.as_wire()));
            std::fs::write(&path, json).unwrap_or_else(|e| panic!("write {path:?}: {e}"));
        }
    }

    /// Lift CI's `git diff --exit-code tests/contract/fixtures/` into the test
    /// suite so `cargo test` ITSELF bites on stale fixtures. A dev who changes a
    /// `PayloadSpec` but forgets to re-run [`regenerate_schema_fixtures`] + commit
    /// would otherwise see green locally (the generator always passes) and only
    /// trip CI.
    ///
    /// The committed fixtures are EMBEDDED via `include_str!` (compile-time), not
    /// read from disk at runtime: [`regenerate_schema_fixtures`] is a sibling
    /// `#[test]` that REWRITES the same files, and the two run concurrently in
    /// this binary — a disk read would race the writer and tear (empty/partial
    /// file). The embedded bytes are the committed-at-build-time fixture, immune
    /// to that race. Both sides parse to `serde_json::Value` (robust to
    /// trailing-newline / whitespace) before asserting equality, naming the stale
    /// wire kind on mismatch. READ-ONLY: it never touches the filesystem.
    #[test]
    fn fixtures_match_committed() {
        // (wire kind, committed fixture bytes). `include_str!` resolves relative
        // to this source file: `../../../../tests/contract/fixtures/`.
        let committed: &[(&str, &str)] = &[
            (
                "create_journal_entry",
                include_str!("../../../../tests/contract/fixtures/create_journal_entry.json"),
            ),
            (
                "update_journal_entry",
                include_str!("../../../../tests/contract/fixtures/update_journal_entry.json"),
            ),
            (
                "delete_journal_entry",
                include_str!("../../../../tests/contract/fixtures/delete_journal_entry.json"),
            ),
            (
                "reference_existing_entity_from_journal_entry",
                include_str!(
                    "../../../../tests/contract/fixtures/reference_existing_entity_from_journal_entry.json"
                ),
            ),
            (
                "create_person",
                include_str!("../../../../tests/contract/fixtures/create_person.json"),
            ),
            (
                "update_person",
                include_str!("../../../../tests/contract/fixtures/update_person.json"),
            ),
            (
                "delete_person",
                include_str!("../../../../tests/contract/fixtures/delete_person.json"),
            ),
            (
                "create_project",
                include_str!("../../../../tests/contract/fixtures/create_project.json"),
            ),
            (
                "update_project",
                include_str!("../../../../tests/contract/fixtures/update_project.json"),
            ),
            (
                "delete_project",
                include_str!("../../../../tests/contract/fixtures/delete_project.json"),
            ),
            (
                "create_todo",
                include_str!("../../../../tests/contract/fixtures/create_todo.json"),
            ),
            (
                "update_todo",
                include_str!("../../../../tests/contract/fixtures/update_todo.json"),
            ),
            (
                "delete_todo",
                include_str!("../../../../tests/contract/fixtures/delete_todo.json"),
            ),
            (
                "apply_intent_graph",
                include_str!("../../../../tests/contract/fixtures/apply_intent_graph.json"),
            ),
        ];
        // The embedded table must cover exactly the proposable kinds — neither
        // side can gain or drop a kind the other lacks.
        assert_eq!(
            committed.len(),
            ProposableMutation::ALL.len(),
            "the embedded fixture table must cover every proposable kind"
        );

        for proposable in ProposableMutation::ALL {
            let kind = proposable.kind();
            let wire = kind.as_wire();
            let fresh = kind.payload_spec().json_schema();
            let raw = committed
                .iter()
                .find_map(|(k, raw)| (*k == wire).then_some(*raw))
                .unwrap_or_else(|| panic!("embedded fixture table is missing {wire}"));
            let committed_value: Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("parse committed fixture {wire}.json: {e}"));
            assert_eq!(
                committed_value, fresh,
                "committed fixture for {wire} is stale; run `cargo test regenerate_schema_fixtures` and commit tests/contract/fixtures/{wire}.json"
            );
        }
    }

    fn property_schema<'a>(schema: &'a Value, property: &str) -> Option<&'a Value> {
        match schema {
            Value::Object(obj) => {
                if let Some(properties) = obj.get("properties").and_then(Value::as_object) {
                    if let Some(property_schema) = properties.get(property) {
                        return Some(property_schema);
                    }
                }
                obj.values()
                    .find_map(|child| property_schema(child, property))
            }
            Value::Array(items) => items
                .iter()
                .find_map(|child| property_schema(child, property)),
            _ => None,
        }
    }

    fn mentions_null(schema: &Value) -> bool {
        match schema {
            Value::String(s) => s == "null",
            Value::Array(items) => items.iter().any(mentions_null),
            Value::Object(obj) => obj.values().any(mentions_null),
            _ => false,
        }
    }

    #[test]
    fn descriptor_has_name_and_object_schema() {
        let d = descriptor();
        assert_eq!(d.name, "propose_workspace_mutation");
        assert_eq!(d.label, "Propose Workspace mutation");
        assert!(
            d.json_schema["oneOf"].is_array(),
            "schema binds mutation_kind at the top level, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema.to_string().contains("create_journal_entry"),
            "schema exposes the closed mutation_kind set, got {}",
            d.json_schema
        );
        assert!(
            d.json_schema
                .to_string()
                .contains("reference_existing_entity_from_journal_entry"),
            "schema exposes the reference mutation kind, got {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_describes_create_journal_entry_payload() {
        let d = descriptor();
        let schema = d.json_schema.to_string();
        assert!(
            schema.contains("occurred_at"),
            "schema must tell the worker to emit occurred_at, got {}",
            d.json_schema
        );
        assert!(
            schema.contains("YYYY-MM-DDTHH:MM:SS"),
            "schema must tell the worker to emit a full local timestamp, got {}",
            d.json_schema
        );
        assert!(
            schema.contains("minItems"),
            "schema must require at least one body text node, got {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_disallows_null_ended_at() {
        let d = descriptor();
        let ended_at = property_schema(&d.json_schema, "ended_at")
            .expect("schema describes ended_at when present");
        assert!(
            !mentions_null(ended_at),
            "ended_at may be omitted, but must not be nullable: {ended_at}"
        );
    }

    #[test]
    fn descriptor_supports_extraction_but_excludes_bare_reminders_from_journal_entries() {
        let description = descriptor().description.to_lowercase();
        // Journal Entry capture is still gated on journal-worthy material, and a
        // bare reminder/task must not become a Journal Entry…
        assert!(
            description.contains("journal-worthy")
                && description.contains("reminder")
                && description.contains("do not create a journal entry"),
            "tool description must keep bare reminders out of Journal Entry creation, got {description:?}"
        );
        // …but Todo (and Person/Project) extraction from an accepted Journal Entry
        // is now a supported path, so the descriptor must not blanket-prohibit todos.
        assert!(
            description.contains("extract") && description.contains("todos"),
            "tool description must advertise People/Projects/Todos extraction, got {description:?}"
        );
    }

    fn top_level_variant<'a>(schema: &'a Value, kind: &str) -> Option<&'a Value> {
        schema
            .get("oneOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|variant| {
                variant["properties"]["mutation_kind"]["enum"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value == kind))
            })
    }

    fn payload_schema<'a>(schema: &'a Value, variant: &'a Value) -> &'a Value {
        let payload = &variant["properties"]["payload"];
        let Some(reference) = payload.get("$ref").and_then(Value::as_str) else {
            return payload;
        };
        let Some(definition_name) = reference.strip_prefix("#/definitions/") else {
            panic!("payload ref must target a local definition: {reference}");
        };
        &schema["definitions"][definition_name]
    }

    fn resolve_ref<'a>(schema: &'a Value, value: &'a Value) -> &'a Value {
        let Some(reference) = value.get("$ref").and_then(Value::as_str) else {
            return value;
        };
        let Some(definition_name) = reference.strip_prefix("#/definitions/") else {
            panic!("schema ref must target a local definition: {reference}");
        };
        &schema["definitions"][definition_name]
    }

    fn body_item_schema<'a>(schema: &'a Value, payload: &'a Value) -> &'a Value {
        resolve_ref(schema, &payload["properties"]["body"]["items"])
    }

    fn schema_tree_contains(schema: &Value, value: &Value, needle: &str) -> bool {
        match value {
            Value::String(text) => text == needle,
            Value::Array(items) => items
                .iter()
                .any(|item| schema_tree_contains(schema, item, needle)),
            Value::Object(obj) => {
                if value.get("$ref").is_some() {
                    return schema_tree_contains(schema, resolve_ref(schema, value), needle);
                }
                obj.values()
                    .any(|item| schema_tree_contains(schema, item, needle))
            }
            _ => false,
        }
    }

    fn reference_payload_schema(schema: &Value) -> &Value {
        let reference = top_level_variant(schema, "reference_existing_entity_from_journal_entry")
            .unwrap_or_else(|| {
                panic!(
                    "schema must bind reference_existing_entity_from_journal_entry at top level: {}",
                    schema
                )
            });
        payload_schema(schema, reference)
    }

    #[test]
    fn descriptor_binds_entity_target_only_for_update_and_delete() {
        let d = descriptor();

        let create =
            top_level_variant(&d.json_schema, "create_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind create_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let update =
            top_level_variant(&d.json_schema, "update_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind update_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let delete =
            top_level_variant(&d.json_schema, "delete_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind delete_journal_entry at top level: {}",
                    d.json_schema
                )
            });

        let create_required = payload_schema(&d.json_schema, create)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "create payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            !create_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "create_journal_entry payload must remain valid without entity_id: {}",
            d.json_schema
        );

        let update_required = payload_schema(&d.json_schema, update)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "update payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            update_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "update_journal_entry payload must require entity_id: {}",
            d.json_schema
        );

        let delete_required = payload_schema(&d.json_schema, delete)["required"]
            .as_array()
            .unwrap_or_else(|| {
                panic!(
                    "delete payload must declare required fields: {}",
                    d.json_schema
                )
            });
        assert!(
            delete_required
                .iter()
                .any(|field| field.as_str() == Some("entity_id")),
            "delete_journal_entry payload must require entity_id: {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_keeps_create_text_only_but_allows_update_and_reference_entity_refs() {
        let d = descriptor();

        let create =
            top_level_variant(&d.json_schema, "create_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind create_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let update =
            top_level_variant(&d.json_schema, "update_journal_entry").unwrap_or_else(|| {
                panic!(
                    "schema must bind update_journal_entry at top level: {}",
                    d.json_schema
                )
            });
        let reference = top_level_variant(
            &d.json_schema,
            "reference_existing_entity_from_journal_entry",
        )
        .unwrap_or_else(|| {
            panic!(
                "schema must bind reference_existing_entity_from_journal_entry at top level: {}",
                d.json_schema
            )
        });

        let create_body = body_item_schema(&d.json_schema, payload_schema(&d.json_schema, create));
        let update_body = body_item_schema(&d.json_schema, payload_schema(&d.json_schema, update));
        let reference_payload = payload_schema(&d.json_schema, reference);
        let reference_body = body_item_schema(&d.json_schema, reference_payload);

        assert!(
            !schema_tree_contains(&d.json_schema, create_body, "entity_ref"),
            "create_journal_entry body must stay text-only: {}",
            d.json_schema
        );
        assert!(
            schema_tree_contains(&d.json_schema, update_body, "entity_ref"),
            "update_journal_entry body must allow entity_ref nodes: {}",
            d.json_schema
        );
        assert!(
            schema_tree_contains(&d.json_schema, reference_body, "entity_ref"),
            "reference_existing_entity_from_journal_entry body must allow an entity_ref placeholder: {}",
            d.json_schema
        );
        let required = reference_payload["required"].as_array().unwrap_or_else(|| {
            panic!(
                "reference payload must declare required fields: {}",
                d.json_schema
            )
        });
        assert!(
            required
                .iter()
                .any(|field| field.as_str() == Some("source_entity_id"))
                && required
                    .iter()
                    .any(|field| field.as_str() == Some("target_entity_id")),
            "reference payload must require source and target ids: {}",
            d.json_schema
        );
    }

    #[test]
    fn create_person_and_create_todo_payloads_validate_against_their_kind() {
        // The wire payload is opaque `Value` validated by `entities::validate`
        // (the dead `Input` enum that once deserialized these is gone). This is
        // the equivalent guard: a representative create_person / create_todo
        // envelope validates against its kind through the single-source spec.
        use crate::mutation::MutationKind;
        let je = "00000000-0000-4000-8000-000000000000";

        crate::entities::validate(
            MutationKind::CreatePerson,
            &serde_json::json!({ "name": "Alice", "source_journal_entry_id": je }),
        )
        .expect("create_person payload validates");

        crate::entities::validate(
            MutationKind::CreateTodo,
            &serde_json::json!({
                "todo": { "title": "Email Alice" },
                "person_refs": [{ "person_id": "p1", "role": "related" }],
                "source_journal_entry_id": je
            }),
        )
        .expect("create_todo payload validates");
    }

    #[test]
    fn create_todo_with_full_recurrence_validates_against_its_kind() {
        // A `create_todo` envelope whose `todo` carries a full recurrence rule
        // (interval, unit, anchor, plus an `end` condition) alongside its `due_at`
        // anchor validates against CreateTodo (ADR-0037 slimmed by ADR-0039).
        use crate::mutation::MutationKind;
        crate::entities::validate(
            MutationKind::CreateTodo,
            &serde_json::json!({
                "todo": {
                    "title": "Weekly review",
                    "due_at": "2026-06-15T09:00:00",
                    "recurrence": {
                        "interval": 1,
                        "unit": "week",
                        "anchor": "due_at",
                        "end": { "after_count": 10 }
                    }
                }
            }),
        )
        .expect("create_todo payload with recurrence validates");
    }

    #[test]
    fn descriptor_binds_all_nine_gtd_mutation_kinds() {
        let d = descriptor();
        for kind in [
            "create_person",
            "update_person",
            "delete_person",
            "create_project",
            "update_project",
            "delete_project",
            "create_todo",
            "update_todo",
            "delete_todo",
        ] {
            assert!(
                top_level_variant(&d.json_schema, kind).is_some(),
                "schema must bind {kind} at top level: {}",
                d.json_schema
            );
        }
    }

    /// The two surfaces that must list the same 14 agent-proposable kinds — the
    /// wire schema generated from `Input`, and `ProposableMutation` (the taxonomy
    /// that carries render_accept/supports_edit/…) — cannot silently drift. Every
    /// `ProposableMutation::ALL` variant binds a top-level schema variant AND
    /// round-trips through `from_wire` + `try_into`; and the schema has EXACTLY 14
    /// top-level variants, so neither side can gain a kind the other lacks.
    #[test]
    fn input_schema_and_proposable_mutation_agree() {
        use crate::mutation::{MutationKind, ProposableMutation};

        let d = descriptor();
        let variants = d.json_schema["oneOf"]
            .as_array()
            .expect("schema binds mutation_kind via a top-level oneOf");
        assert_eq!(
            variants.len(),
            ProposableMutation::ALL.len(),
            "schema must expose exactly the {} agent-proposable kinds, got {}: {}",
            ProposableMutation::ALL.len(),
            variants.len(),
            d.json_schema
        );

        for proposable in ProposableMutation::ALL {
            let wire = proposable.kind().as_wire();
            assert!(
                top_level_variant(&d.json_schema, wire).is_some(),
                "Input schema is missing proposable kind {wire}: {}",
                d.json_schema
            );
            // The wire string round-trips back to the SAME proposable kind.
            let parsed = MutationKind::from_wire(wire).expect("proposable kind parses");
            assert_eq!(
                ProposableMutation::try_from(parsed).ok(),
                Some(proposable),
                "{wire} must round-trip to its ProposableMutation"
            );
        }
    }

    /// Walk the whole schema tree asserting NO node carries a `$ref` — Anthropic
    /// rejects refs, so every variant (incl. the deeply-nested intent-graph
    /// entity/link/body unions) must be inlined.
    fn has_ref(value: &Value) -> bool {
        match value {
            Value::Object(obj) => {
                obj.contains_key("$ref") || obj.values().any(has_ref)
            }
            Value::Array(items) => items.iter().any(has_ref),
            _ => false,
        }
    }

    #[test]
    fn descriptor_advertises_apply_intent_graph_inlined() {
        let d = descriptor();
        let variant = top_level_variant(&d.json_schema, "apply_intent_graph")
            .unwrap_or_else(|| panic!("schema must bind apply_intent_graph: {}", d.json_schema));
        let payload = payload_schema(&d.json_schema, variant);

        // The graph payload requires `entities` (>= 1) and `links`; `journal_entry`
        // is optional (absent for direct multi-entity capture).
        let required = payload["required"].as_array().unwrap_or_else(|| {
            panic!("apply_intent_graph payload declares required fields: {}", d.json_schema)
        });
        assert!(
            required.iter().any(|f| f.as_str() == Some("entities"))
                && required.iter().any(|f| f.as_str() == Some("links")),
            "apply_intent_graph must require entities + links: {payload}"
        );
        assert!(
            !required.iter().any(|f| f.as_str() == Some("journal_entry")),
            "journal_entry is optional (absent for direct multi-entity capture): {payload}"
        );

        // entities is an array with minItems:1 over a oneOf of person/project/todo
        // nodes; the node shape carries handle + type + optional existing_id.
        let entities = &payload["properties"]["entities"];
        assert_eq!(
            entities["minItems"],
            serde_json::json!(1),
            "entities must require at least one node: {entities}"
        );
        let entity_variants = entities["items"]["oneOf"].as_array().unwrap_or_else(|| {
            panic!("entities items must be a oneOf union of typed nodes: {entities}")
        });
        assert_eq!(entity_variants.len(), 3, "person/project/todo entity nodes: {entities}");
        let schema_text = d.json_schema.to_string();
        for needle in ["handle", "existing_id", "todo_project", "todo_person", "journal_ref"] {
            assert!(
                schema_text.contains(needle),
                "apply_intent_graph schema advertises {needle}: {}",
                d.json_schema
            );
        }

        // links is a oneOf of the three link kinds.
        let link_variants = payload["properties"]["links"]["items"]["oneOf"]
            .as_array()
            .unwrap_or_else(|| panic!("links items must be a oneOf of link kinds: {payload}"));
        assert_eq!(link_variants.len(), 3, "todo_project/todo_person/journal_ref: {payload}");
    }

    /// The advertised graph schema must carry NO `$ref` anywhere (Anthropic
    /// rejects refs) — pinned over the whole emitted descriptor.
    #[test]
    fn descriptor_intent_graph_has_no_ref() {
        let d = descriptor();
        assert!(
            !has_ref(&d.json_schema),
            "the descriptor schema must be fully inlined (no $ref): {}",
            d.json_schema
        );
    }

    /// A hand-built intent-graph payload is ACCEPTED by the advertised schema
    /// (not merely round-tripped): the payload's `entities`/`links`/`journal_entry`
    /// validate against the kind's `payload_spec().check`.
    #[test]
    fn apply_intent_graph_payload_is_accepted_by_advertised_schema() {
        use crate::mutation::MutationKind;
        let graph = serde_json::json!({
            "journal_entry": {
                "handle": "@je",
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Talked to " },
                    { "type": "entity_ref", "target": "@morris" }
                ]
            },
            "entities": [
                { "handle": "@morris", "type": "person", "name": "Morris" },
                {
                    "handle": "@leadads",
                    "type": "project",
                    "name": "Lead Ads",
                    "existing_id": "00000000-0000-4000-8000-000000000000"
                },
                { "handle": "@rodeo", "type": "todo", "title": "Figure out the Rodeo side" }
            ],
            "links": [
                { "kind": "todo_project", "from": "@rodeo", "to": "@leadads" },
                { "kind": "todo_person", "from": "@rodeo", "to": "@morris", "role": "related" },
                { "kind": "journal_ref", "from": "@je", "to": "@morris" }
            ]
        });
        MutationKind::ApplyIntentGraph
            .payload_spec()
            .check(&graph)
            .expect("the advertised intent-graph schema accepts a well-formed graph");
    }

    /// A direct multi-entity capture (no `journal_entry`, no journal_ref) is also
    /// accepted — the journal_entry node is optional.
    #[test]
    fn apply_intent_graph_direct_capture_is_accepted() {
        use crate::mutation::MutationKind;
        let graph = serde_json::json!({
            "entities": [
                { "handle": "@alice", "type": "person", "name": "Alice" },
                { "handle": "@email", "type": "todo", "title": "Email Alice" }
            ],
            "links": [
                { "kind": "todo_person", "from": "@email", "to": "@alice", "role": "waiting_on" }
            ]
        });
        MutationKind::ApplyIntentGraph
            .payload_spec()
            .check(&graph)
            .expect("a direct-capture graph (no journal_entry) is accepted");
    }

    #[test]
    fn descriptor_create_todo_requires_title_and_allows_envelope_and_source() {
        let d = descriptor();
        let create_todo = top_level_variant(&d.json_schema, "create_todo")
            .unwrap_or_else(|| panic!("schema must bind create_todo: {}", d.json_schema));
        let payload = payload_schema(&d.json_schema, create_todo);

        // The envelope requires `todo` and the nested TodoData requires `title`.
        let required = payload["required"].as_array().unwrap_or_else(|| {
            panic!(
                "create_todo payload declares required fields: {}",
                d.json_schema
            )
        });
        assert!(
            required.iter().any(|f| f.as_str() == Some("todo")),
            "create_todo envelope must require `todo`: {}",
            d.json_schema
        );
        let todo = resolve_ref(&d.json_schema, &payload["properties"]["todo"]);
        let todo_required = todo["required"]
            .as_array()
            .unwrap_or_else(|| panic!("TodoData declares required fields: {}", d.json_schema));
        assert!(
            todo_required.iter().any(|f| f.as_str() == Some("title")),
            "TodoData must require `title`: {}",
            d.json_schema
        );

        // The envelope allows person_refs and source_journal_entry_id but does not
        // require them.
        assert!(
            payload["properties"]["person_refs"].is_object(),
            "create_todo envelope must allow person_refs: {}",
            d.json_schema
        );
        assert!(
            payload["properties"]["source_journal_entry_id"].is_object(),
            "create_todo envelope must allow source_journal_entry_id: {}",
            d.json_schema
        );
        assert!(
            !required.iter().any(|f| matches!(
                f.as_str(),
                Some("person_refs") | Some("source_journal_entry_id")
            )),
            "person_refs and source_journal_entry_id are optional: {}",
            d.json_schema
        );
    }

    #[test]
    fn descriptor_update_todo_requires_todo_id() {
        let d = descriptor();
        let update_todo = top_level_variant(&d.json_schema, "update_todo")
            .unwrap_or_else(|| panic!("schema must bind update_todo: {}", d.json_schema));
        let payload = payload_schema(&d.json_schema, update_todo);
        let required = payload["required"].as_array().unwrap_or_else(|| {
            panic!(
                "update_todo payload declares required fields: {}",
                d.json_schema
            )
        });
        assert!(
            required.iter().any(|f| f.as_str() == Some("todo_id")),
            "update_todo must require todo_id: {}",
            d.json_schema
        );
        assert!(
            !required.iter().any(|f| f.as_str() == Some("entity_id")),
            "update_todo targets todo_id, not entity_id: {}",
            d.json_schema
        );
    }

    fn payload_requires<'a>(schema: &'a Value, kind: &str) -> Vec<String> {
        let variant = top_level_variant(schema, kind)
            .unwrap_or_else(|| panic!("schema must bind {kind}: {schema}"));
        payload_schema(schema, variant)["required"]
            .as_array()
            .unwrap_or_else(|| panic!("{kind} payload declares required fields: {schema}"))
            .iter()
            .filter_map(|f| f.as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn descriptor_creates_require_name_updates_and_deletes_require_target() {
        let d = descriptor();

        for kind in ["create_person", "create_project"] {
            let required = payload_requires(&d.json_schema, kind);
            assert!(
                required.iter().any(|f| f == "name"),
                "{kind} must require name: {required:?}"
            );
            assert!(
                !required.iter().any(|f| f == "entity_id"),
                "{kind} must not require entity_id: {required:?}"
            );
        }

        for kind in ["update_person", "update_project"] {
            let required = payload_requires(&d.json_schema, kind);
            assert!(
                required.iter().any(|f| f == "entity_id"),
                "{kind} must require entity_id: {required:?}"
            );
            assert!(
                required.iter().any(|f| f == "name"),
                "{kind} carries the entity data, which still requires name: {required:?}"
            );
        }

        for kind in ["delete_person", "delete_project", "delete_todo"] {
            let required = payload_requires(&d.json_schema, kind);
            assert!(
                required.iter().any(|f| f == "entity_id"),
                "{kind} must require entity_id: {required:?}"
            );
        }
    }

    fn collect_property_schemas<'a>(schema: &'a Value, property: &str, out: &mut Vec<&'a Value>) {
        match schema {
            Value::Object(obj) => {
                if let Some(properties) = obj.get("properties").and_then(Value::as_object) {
                    if let Some(property_schema) = properties.get(property) {
                        out.push(property_schema);
                    }
                }
                for child in obj.values() {
                    collect_property_schemas(child, property, out);
                }
            }
            Value::Array(items) => {
                for child in items {
                    collect_property_schemas(child, property, out);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn descriptor_disallows_null_for_new_optional_fields() {
        let d = descriptor();
        // Every optional GTD field the model should OMIT rather than send as null
        // must be non-nullable in the emitted schema (mirrors ended_at).
        for property in [
            "title",
            "note",
            "outcome",
            "aliases",
            "status",
            "project_id",
            "person_refs",
            "role",
            "source_journal_entry_id",
            "review_every",
            "todo",
            "set_person_refs",
            "add_person_refs",
            "remove_person_ids",
            "defer_at",
            "due_at",
            "completed_at",
            "dropped_at",
            "next_review_at",
            "last_reviewed_at",
            "end",
            "until",
            "after_count",
        ] {
            let mut occurrences = Vec::new();
            collect_property_schemas(&d.json_schema, property, &mut occurrences);
            assert!(
                !occurrences.is_empty(),
                "schema must describe {property} somewhere: {}",
                d.json_schema
            );
            for occurrence in occurrences {
                assert!(
                    !mentions_null(occurrence),
                    "{property} may be omitted, but must not be nullable: {occurrence}"
                );
            }
        }
    }

    #[test]
    fn descriptor_constrains_reference_payload_ids_and_label_snapshot() {
        let d = descriptor();
        let reference_payload = reference_payload_schema(&d.json_schema);

        for field in ["source_entity_id", "target_entity_id"] {
            let property = &reference_payload["properties"][field];
            assert_eq!(
                property["minLength"],
                serde_json::json!(36),
                "{field} must be exactly UUID-length: {}",
                d.json_schema
            );
            assert_eq!(
                property["maxLength"],
                serde_json::json!(36),
                "{field} must be exactly UUID-length: {}",
                d.json_schema
            );
            assert!(
                property["pattern"]
                    .as_str()
                    .is_some_and(|pattern| pattern.contains("[0-9a-fA-F]{8}")),
                "{field} must carry a UUID pattern: {}",
                d.json_schema
            );
        }

        let label_snapshot = &reference_payload["properties"]["label_snapshot"];
        assert_eq!(
            label_snapshot["minLength"],
            serde_json::json!(1),
            "label_snapshot must be non-empty when present: {}",
            d.json_schema
        );
        assert!(
            !mentions_null(label_snapshot),
            "label_snapshot may be omitted, but must not be nullable: {label_snapshot}"
        );
    }

    /// The per-FIELD half of the drift guard #152's `input_schema_and_proposable_
    /// mutation_agree` (the per-KIND set) does not cover (card 2): each kind's
    /// emitted payload property set + `required` array trace to its
    /// [`crate::mutation::MutationKind::payload_spec`], and — critically — the
    /// schema/validator DIVERGENCES that no other test pins are nailed here, so
    /// single-sourcing cannot silently change the wire contract:
    /// - `entity_id`/`todo_id` advertise BARE (no `pattern`) though the validator
    ///   UUID-checks them; the reference/source ids advertise the full UUID pattern.
    /// - `aliases`/`tags`/`remove_person_ids` advertise PLAIN string items (no
    ///   `minLength`) though the validator requires each non-empty.
    /// - only the Journal-Entry `body` array carries `minItems`; `person_refs`,
    ///   `aliases`, `tags` do not.
    #[test]
    fn schema_fields_and_divergences_trace_to_the_spec() {
        let d = descriptor();

        // Per-kind property KEY SET + required, asserted against an INDEPENDENT
        // literal expectation (not the spec's own json_schema output — that would
        // be tautological). A spec change to a kind's field set fails here.
        let sorted = |schema: &Value, key: &str| -> Vec<String> {
            let mut names: Vec<String> = match key {
                "properties" => schema["properties"]
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default(),
                _ => schema[key]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            names.sort();
            names
        };
        // (wire, sorted property names, sorted required names).
        let expectations: &[(&str, &[&str], &[&str])] = &[
            (
                "create_person",
                &["aliases", "name", "note", "source_journal_entry_id"],
                &["name"],
            ),
            (
                "update_person",
                &["aliases", "entity_id", "name", "note"],
                &["entity_id", "name"],
            ),
            (
                "create_project",
                &[
                    "completed_at",
                    "defer_at",
                    "dropped_at",
                    "due_at",
                    "last_reviewed_at",
                    "name",
                    "next_review_at",
                    "note",
                    "outcome",
                    "review_every",
                    "source_journal_entry_id",
                    "status",
                ],
                &["name"],
            ),
            (
                "update_project",
                &[
                    "completed_at",
                    "defer_at",
                    "dropped_at",
                    "due_at",
                    "entity_id",
                    "last_reviewed_at",
                    "name",
                    "next_review_at",
                    "note",
                    "outcome",
                    "review_every",
                    "status",
                ],
                &["entity_id", "name"],
            ),
            (
                "create_todo",
                &["person_refs", "source_journal_entry_id", "todo"],
                &["todo"],
            ),
            (
                "update_todo",
                &[
                    "add_person_refs",
                    "remove_person_ids",
                    "set_person_refs",
                    "todo",
                    "todo_id",
                ],
                &["todo_id"],
            ),
            (
                "create_journal_entry",
                &["body", "ended_at", "occurred_at"],
                &["body", "occurred_at"],
            ),
            (
                "update_journal_entry",
                &["body", "ended_at", "entity_id", "occurred_at"],
                &["body", "entity_id", "occurred_at"],
            ),
            ("delete_journal_entry", &["entity_id"], &["entity_id"]),
            ("delete_person", &["entity_id"], &["entity_id"]),
            ("delete_project", &["entity_id"], &["entity_id"]),
            ("delete_todo", &["entity_id"], &["entity_id"]),
            (
                "reference_existing_entity_from_journal_entry",
                &[
                    "body",
                    "label_snapshot",
                    "source_entity_id",
                    "target_entity_id",
                ],
                &["body", "source_entity_id", "target_entity_id"],
            ),
            (
                "apply_intent_graph",
                &["entities", "journal_entry", "links"],
                &["entities", "links"],
            ),
        ];
        // Every proposable kind is covered exactly once by the literal table.
        assert_eq!(
            expectations.len(),
            crate::mutation::ProposableMutation::ALL.len(),
            "the literal expectation table must cover all proposable kinds"
        );
        for (wire, props, required) in expectations {
            let variant = top_level_variant(&d.json_schema, wire)
                .unwrap_or_else(|| panic!("schema binds {wire}: {}", d.json_schema));
            let payload = payload_schema(&d.json_schema, variant);
            assert_eq!(
                sorted(payload, "properties"),
                *props,
                "{wire} payload property set"
            );
            assert_eq!(
                sorted(payload, "required"),
                *required,
                "{wire} payload required set"
            );
        }

        // Divergence 1: bare target ids vs patterned reference/source ids.
        let update_person = payload_schema(
            &d.json_schema,
            top_level_variant(&d.json_schema, "update_person").unwrap(),
        );
        assert!(
            update_person["properties"]["entity_id"]
                .get("pattern")
                .is_none(),
            "entity_id is advertised bare (no pattern), though the validator UUID-checks it: {}",
            update_person
        );
        let update_todo = payload_schema(
            &d.json_schema,
            top_level_variant(&d.json_schema, "update_todo").unwrap(),
        );
        assert!(
            update_todo["properties"]["todo_id"]
                .get("pattern")
                .is_none(),
            "todo_id is advertised bare (no pattern): {update_todo}"
        );
        let reference = payload_schema(
            &d.json_schema,
            top_level_variant(
                &d.json_schema,
                "reference_existing_entity_from_journal_entry",
            )
            .unwrap(),
        );
        assert!(
            reference["properties"]["source_entity_id"]["pattern"].is_string(),
            "source_entity_id carries the UUID pattern: {reference}"
        );

        // Divergence 2: plain string items on aliases / tags-equivalent arrays.
        let create_person = payload_schema(
            &d.json_schema,
            top_level_variant(&d.json_schema, "create_person").unwrap(),
        );
        assert!(
            create_person["properties"]["aliases"]["items"]
                .get("minLength")
                .is_none(),
            "aliases items advertise plain (no minLength), though the validator requires non-empty: {create_person}"
        );
        assert!(
            update_todo["properties"]["remove_person_ids"]["items"]
                .get("minLength")
                .is_none(),
            "remove_person_ids items advertise plain (no minLength): {update_todo}"
        );

        // Divergence 3: minItems on the journal body only, not on person_refs.
        let create_journal = payload_schema(
            &d.json_schema,
            top_level_variant(&d.json_schema, "create_journal_entry").unwrap(),
        );
        assert_eq!(
            create_journal["properties"]["body"]["minItems"],
            serde_json::json!(1),
            "journal body requires at least one node: {create_journal}"
        );
        let create_todo = payload_schema(
            &d.json_schema,
            top_level_variant(&d.json_schema, "create_todo").unwrap(),
        );
        assert!(
            create_todo["properties"]["person_refs"]
                .get("minItems")
                .is_none(),
            "person_refs carries no minItems: {create_todo}"
        );
    }
}
