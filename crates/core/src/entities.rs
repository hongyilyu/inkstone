//! Entity-backed Workspace mutation schemas (ADR-0016, ADR-0025). Entity
//! mutation payloads are validated by their [`MutationKind`] before they are
//! durably applied. Non-Entity proposal kinds, such as `record_observations`,
//! validate in their owning modules.
//!
//! The closed Entity-Type taxonomy ([`MutationKind`]/[`crate::mutation::ProposableMutation`]
//! and the descriptor) lives in [`crate::mutation`]; this module is the per-kind
//! *schema* layer — the validator bodies plus the accept-text rendering. Both
//! are resolved per kind via the write contract ([`MutationKind::describe`]'s
//! `validate` and `render_accept` facets, whose fn pointers name the bodies
//! below), so a new kind is a compile error, not a runtime panic.

use serde_json::Value;
use uuid::Uuid;

use crate::localtime::parse_local_datetime;
use crate::mutation::{todo_data_spec, Mode, MutationKind};

/// Validate a proposed mutation payload against its schema (ADR-0016) — a
/// match-free adapter over the kind's write contract for callers holding a
/// `(kind, payload)` pair. The per-kind dispatch lives in the ONE exhaustive
/// [`MutationKind::describe`] match; the validator bodies stay below, grouped
/// per Entity Type. `Err(reason)` is surfaced as the `invalid_params` message
/// on `proposal/decide` / `entity/mutate`. Total over the closed kind set — an
/// unknown wire string is rejected at the edge by [`MutationKind::from_wire`],
/// so this never sees one.
pub(crate) fn validate(kind: MutationKind, payload: &Value) -> Result<(), String> {
    (kind.describe().validate)(payload)
}

/// Test-only adapter over the contract's `render_accept` facet for callers
/// holding a `(kind, payload)` pair — kept solely for the parity fixture
/// emitter (`protocol/parity.rs`, itself `#[cfg(test)]`), which builds the
/// Decision-prose samples through the real renderers. Production accept paths
/// read the facet off [`MutationKind::describe`] directly; the `expect`
/// preserves the legacy router's panic-on-misuse for user-only kinds.
#[cfg(test)]
pub(crate) fn render_accept(
    kind: MutationKind,
    payload: &Value,
    entity_id: Option<&str>,
) -> String {
    (kind.describe().render_accept).expect("user-only mutation has no proposal accept text")(
        payload, entity_id,
    )
}

// ── Accept-text renderers (ADR-0025) ──────────────────────────────────────
// The human-readable Decision text the model reads on resume as the awaited
// tool's result — byte-for-byte sacred. One fn per renderable kind, named by
// the contract's `render_accept` facet ([`MutationKind::describe`]); the 7
// user-only kinds (media, habits, `mark_project_reviewed`) carry no renderer
// because they never reach the proposal accept path. Non-Entity proposals
// such as `record_observations` render in their owning modules.

pub(crate) fn render_accept_create_journal_entry(
    payload: &Value,
    entity_id: Option<&str>,
) -> String {
    let entity_id = entity_id.expect("create accept rendering requires entity_id");
    let occurred_at = payload
        .get("occurred_at")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let body = journal_body_text(payload);
    format!(
        "Accepted. Created Journal Entry (entity_id={entity_id}, occurred_at={occurred_at}, body={body})."
    )
}

pub(crate) fn render_accept_update_journal_entry(
    payload: &Value,
    _entity_id: Option<&str>,
) -> String {
    let occurred_at = payload
        .get("occurred_at")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let body = journal_body_text(payload);
    format!("Accepted. Updated Journal Entry (occurred_at={occurred_at}, body={body}).")
}

/// Shared body for the four renderable deletes. The kind threads through so
/// the text keeps its per-kind Entity noun; the contract's per-kind facet fns
/// below are thin wrappers pinning the kind (mirroring the id-only validators).
fn render_accept_delete(kind: MutationKind, payload: &Value) -> String {
    let noun = kind.describe().entity_type.spec().noun;
    let entity_id = payload
        .get("entity_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("Accepted. Deleted {noun} (entity_id={entity_id}).")
}

pub(crate) fn render_accept_delete_journal_entry(
    payload: &Value,
    _entity_id: Option<&str>,
) -> String {
    render_accept_delete(MutationKind::DeleteJournalEntry, payload)
}

pub(crate) fn render_accept_delete_person(payload: &Value, _entity_id: Option<&str>) -> String {
    render_accept_delete(MutationKind::DeletePerson, payload)
}

pub(crate) fn render_accept_delete_project(payload: &Value, _entity_id: Option<&str>) -> String {
    render_accept_delete(MutationKind::DeleteProject, payload)
}

pub(crate) fn render_accept_delete_todo(payload: &Value, _entity_id: Option<&str>) -> String {
    render_accept_delete(MutationKind::DeleteTodo, payload)
}

pub(crate) fn render_accept_reference_existing_entity_from_journal_entry(
    payload: &Value,
    _entity_id: Option<&str>,
) -> String {
    let source_entity_id = payload
        .get("source_entity_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let target_entity_id = payload
        .get("target_entity_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let body = journal_body_text(payload);
    format!(
        "Accepted. Referenced Entity (source_entity_id={source_entity_id}, target_entity_id={target_entity_id}, body={body})."
    )
}

pub(crate) fn render_accept_create_person(payload: &Value, entity_id: Option<&str>) -> String {
    let entity_id = entity_id.expect("create accept rendering requires entity_id");
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("Accepted. Created Person (entity_id={entity_id}, name={name}).")
}

pub(crate) fn render_accept_update_person(payload: &Value, _entity_id: Option<&str>) -> String {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("Accepted. Updated Person (name={name}).")
}

pub(crate) fn render_accept_create_project(payload: &Value, entity_id: Option<&str>) -> String {
    let entity_id = entity_id.expect("create accept rendering requires entity_id");
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    format!("Accepted. Created Project (entity_id={entity_id}, name={name}, status={status}).")
}

pub(crate) fn render_accept_update_project(payload: &Value, _entity_id: Option<&str>) -> String {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("Accepted. Updated Project (name={name}, status={status}).")
}

pub(crate) fn render_accept_create_todo(payload: &Value, entity_id: Option<&str>) -> String {
    let entity_id = entity_id.expect("create accept rendering requires entity_id");
    let todo = payload.get("todo");
    let title = todo
        .and_then(|t| t.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let status = todo
        .and_then(|t| t.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("active");
    format!("Accepted. Created Todo (entity_id={entity_id}, title={title}, status={status}).")
}

pub(crate) fn render_accept_update_todo(payload: &Value, _entity_id: Option<&str>) -> String {
    let todo_id = payload
        .get("todo_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("Accepted. Updated Todo (todo_id={todo_id}).")
}

// The graph applies many entities in one tx (ADR-0042); the model reads
// this on resume and re-reads the created entities via `entity/changed`.
// `entity_id` is the anchor (the Journal Entry node, or the first created
// entity for a JE-less direct-capture graph). render_accept sees only the
// PROPOSED payload, not the per-node decision vector, so the count is the
// proposed node count and is phrased "up to N" — the user may have rejected
// some; the model re-reads what actually landed via `entity/changed`.
pub(crate) fn render_accept_apply_intent_graph(payload: &Value, entity_id: Option<&str>) -> String {
    let anchor = entity_id.unwrap_or("unknown");
    let proposed_count = payload
        .get("entities")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let has_journal_entry = payload.get("journal_entry").is_some_and(|je| !je.is_null());
    let je_note = if has_journal_entry {
        " with a Journal Entry"
    } else {
        ""
    };
    format!(
        "Accepted. Applied intent graph{je_note} (anchor entity_id={anchor}, up to {proposed_count} entities; some may have been declined)."
    )
}

fn journal_body_text(payload: &Value) -> String {
    let Some(body) = payload.get("body").and_then(Value::as_array) else {
        return "unknown".to_string();
    };
    let text = body
        .iter()
        .filter_map(journal_body_node_text)
        .collect::<String>();
    if text.trim().is_empty() {
        "unknown".to_string()
    } else {
        text
    }
}

fn journal_body_node_text(node: &Value) -> Option<String> {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => node.get("text").and_then(Value::as_str).map(str::to_string),
        Some("entity_ref") => Some(
            node.get("ref_id")
                .and_then(Value::as_str)
                .map(|ref_id| format!("[entity_ref:{ref_id}]"))
                .unwrap_or_else(|| "[entity_ref]".to_string()),
        ),
        _ => None,
    }
}

/// The `target_entity_id` of a reference weave — the EXISTING Entity the new
/// inline reference points at (distinct from the `source_entity_id` Journal
/// Entry the reference is woven into, which is the mutation's target key).
pub(crate) fn reference_target_entity_id(payload: &Value) -> Option<&str> {
    payload.get("target_entity_id").and_then(Value::as_str)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyNodePolicy {
    TextOnly,
    TextOrExistingEntityRef,
    TextOrNewEntityRef,
}

pub(crate) fn validate_journal_entry(payload: &Value) -> Result<(), String> {
    // Flat shell (occurred_at/ended_at presence + datetime parse, the body-union
    // schema) from the single source; the ended_at≥occurred_at + body-content
    // invariants are the hook.
    MutationKind::CreateJournalEntry
        .payload_spec()
        .check(payload)?;
    validate_journal_body_and_times(payload, BodyNodePolicy::TextOnly)
}

/// The Journal-Entry cross-field invariants the flat spec walk cannot express:
/// `ended_at >= occurred_at` (both already parse-validated by the spec) and the
/// body's array/non-empty/per-node/policy checks (the `body` field is a schema-only
/// `Body` union in the spec, so its content is validated here). `occurred_at` is
/// present + parseable by the time this runs (the spec enforced it), so the
/// comparison re-parses cheaply.
fn validate_journal_body_and_times(
    payload: &Value,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let obj = payload.as_object().expect("check accepted an object");

    if let (Some(occurred_at), Some(ended_at)) = (
        obj.get("occurred_at").and_then(Value::as_str),
        obj.get("ended_at").and_then(Value::as_str),
    ) {
        let occurred = parse_local_datetime(occurred_at, "occurred_at")?;
        let ended = parse_local_datetime(ended_at, "ended_at")?;
        if ended < occurred {
            return Err("ended_at must be greater than or equal to occurred_at".to_string());
        }
    }

    validate_journal_body(obj, body_policy)
}

/// Validate a Journal-Entry `body`: a non-empty array of node objects, each valid
/// under `body_policy`. Shared by the create/update validators and the reference
/// weave (which adds the exactly-one-entity_ref invariant on top).
fn validate_journal_body(
    obj: &serde_json::Map<String, Value>,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .ok_or_else(|| "body must be an array".to_string())?;
    if body.is_empty() {
        return Err("body must not be empty".to_string());
    }
    for node in body {
        let node = node
            .as_object()
            .ok_or_else(|| "body nodes must be objects".to_string())?;
        validate_body_node(node, body_policy)?;
    }
    Ok(())
}

fn validate_body_node(
    node: &serde_json::Map<String, Value>,
    body_policy: BodyNodePolicy,
) -> Result<(), String> {
    let node_type = match node.get("type") {
        Some(Value::String(t)) => t.as_str(),
        Some(_) => return Err("body node type must be a string".to_string()),
        None => return Err("body node type is required".to_string()),
    };

    match node_type {
        "text" => validate_text_body_node(node),
        "entity_ref" if body_policy == BodyNodePolicy::TextOrExistingEntityRef => {
            validate_entity_ref_body_node(node)
        }
        "entity_ref" if body_policy == BodyNodePolicy::TextOrNewEntityRef => {
            validate_new_entity_ref_body_node(node)
        }
        "entity_ref" => Err("body supports only text nodes on create_journal_entry".to_string()),
        _ if body_policy != BodyNodePolicy::TextOnly => {
            Err("body node type must be text or entity_ref".to_string())
        }
        _ => Err("body supports only text nodes on create_journal_entry".to_string()),
    }
}

fn validate_text_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    required_body_node_string(node, &["type", "text"], "text", "body text")?;
    Ok(())
}

fn validate_entity_ref_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    let ref_id =
        required_body_node_string(node, &["type", "ref_id"], "ref_id", "entity_ref ref_id")?;
    Uuid::parse_str(ref_id).map_err(|_| "entity_ref ref_id must be a UUID".to_string())?;
    Ok(())
}

fn validate_new_entity_ref_body_node(node: &serde_json::Map<String, Value>) -> Result<(), String> {
    for key in node.keys() {
        if key != "type" {
            return Err(format!("unsupported body node field {key:?}"));
        }
    }
    Ok(())
}

fn required_body_node_string<'a>(
    node: &'a serde_json::Map<String, Value>,
    allowed_keys: &[&str],
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    for key in node.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(format!("unsupported body node field {key:?}"));
        }
    }
    match node.get(field) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value),
        Some(Value::String(_)) => Err(format!("{label} must not be empty")),
        Some(_) => Err(format!("{label} must be a string")),
        None => Err(format!("{label} is required")),
    }
}

pub(crate) fn validate_update_journal_entry(payload: &Value) -> Result<(), String> {
    // Flat shell (entity_id target + occurred_at/ended_at + body-union schema)
    // from the single source; the cross-field invariants are the hook. The body
    // policy admits an `entity_ref` carrying a `ref_id`.
    MutationKind::UpdateJournalEntry
        .payload_spec()
        .check(payload)?;
    validate_journal_body_and_times(payload, BodyNodePolicy::TextOrExistingEntityRef)
}

pub(crate) fn validate_reference_existing_entity_from_journal_entry(
    payload: &Value,
) -> Result<(), String> {
    // Flat shell (source/target UUIDs, optional label_snapshot, body-union schema)
    // from the single source; the body content + exactly-one-entity_ref invariant
    // are the hook.
    MutationKind::ReferenceExistingEntityFromJournalEntry
        .payload_spec()
        .check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");

    validate_journal_body(obj, BodyNodePolicy::TextOrNewEntityRef)?;

    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .expect("body validated");
    let ref_count = body
        .iter()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("entity_ref"))
        .count();
    if ref_count != 1 {
        return Err("body must contain exactly one entity_ref node".to_string());
    }

    Ok(())
}

/// Validate a Journal-Entry `body` array Core itself constructs at mint time — the
/// intent-graph weave (ADR-0042), which rewrites each placeholder to a stored
/// `{type:entity_ref, ref_id}` node or collapses a rejected ref to a `{type:text,
/// text:<label>}` node. Reuses the same per-node content checks as the
/// `update_journal_entry` path (`TextOrExistingEntityRef`: a stored entity_ref
/// carries a `ref_id`), so an empty text node, a blank `ref_id`, or any malformed
/// node fails loud as `InvalidMutation` rather than being persisted and later
/// crashing the client codec. A defense-in-depth gate: the weave is expected to
/// emit only valid nodes, so this never fires in practice — it backstops a future
/// weave bug from writing a body the advertised schema forbids.
pub(crate) fn validate_woven_journal_body(body: &Value) -> Result<(), String> {
    let obj = serde_json::Map::from_iter([("body".to_string(), body.clone())]);
    validate_journal_body(&obj, BodyNodePolicy::TextOrExistingEntityRef)
}

pub(crate) fn reference_existing_entity_data_payload(
    current_data: &Value,
    payload: &Value,
    ref_id: &str,
) -> Value {
    let mut data = current_data.as_object().cloned().unwrap_or_default();
    let Some(obj) = payload.as_object() else {
        return Value::Object(data);
    };

    let body = obj
        .get("body")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| {
                    if node.get("type").and_then(Value::as_str) == Some("entity_ref") {
                        serde_json::json!({ "type": "entity_ref", "ref_id": ref_id })
                    } else {
                        node.clone()
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    data.insert("body".to_string(), Value::Array(body));

    Value::Object(data)
}

pub(crate) fn body_entity_ref_ids(payload: &Value) -> Vec<&str> {
    payload
        .get("body")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("entity_ref"))
        .filter_map(|node| node.get("ref_id").and_then(Value::as_str))
        .collect()
}

/// Validate an `{entity_id}`-only payload (the deletes + `mark_project_reviewed`)
/// against the kind's id-only spec: a single required UUID `entity_id` and no
/// other field. A delete carries no entity data, so the spec is the whole schema.
/// The kind threads through so the error text keeps its per-kind wire noun; the
/// contract's per-kind facet fns below are thin wrappers pinning the kind.
fn validate_entity_id_only(kind: MutationKind, payload: &Value) -> Result<(), String> {
    kind.payload_spec().check(payload)
}

pub(crate) fn validate_delete_journal_entry(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeleteJournalEntry, payload)
}

pub(crate) fn validate_delete_person(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeletePerson, payload)
}

pub(crate) fn validate_delete_project(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeleteProject, payload)
}

pub(crate) fn validate_delete_todo(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeleteTodo, payload)
}

pub(crate) fn validate_delete_media(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeleteMedia, payload)
}

pub(crate) fn validate_delete_habit(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::DeleteHabit, payload)
}

/// A user-path-only review touch (ADR-0034): `{entity_id}` only — Core reads
/// the Project and recomputes the review fields, so the client sends no data.
/// Deliberately absent from the agent `propose_workspace_mutation` schema; it
/// can only arrive via `entity/mutate`.
pub(crate) fn validate_mark_project_reviewed(payload: &Value) -> Result<(), String> {
    validate_entity_id_only(MutationKind::MarkProjectReviewed, payload)
}

#[cfg(test)]
fn validate_person(payload: &Value) -> Result<(), String> {
    // PersonData has no cross-field invariant — the spec walk is the whole
    // validator. `note`/`aliases` are clearable optional fields (ADR-0033): a
    // `null` value is the sentinel-clear directive (the apply path drops the key),
    // accepted by the clearable string / nullable-array specs.
    MutationKind::CreatePerson
        .payload_data_spec()
        .check(payload)
}

/// Validate a `create_person` payload. Create routes the FULL payload (entity
/// data + the `source_journal_entry_id` provenance directive) through its
/// single-source spec, so that field's shape is owned by `mutation.rs` like
/// every other — no separate strip.
pub(crate) fn validate_create_person(payload: &Value) -> Result<(), String> {
    MutationKind::CreatePerson.payload_spec().check(payload)
}

/// Validate an `update_person` payload against the kind's full spec: the
/// `entity_id` target prepended to the `PersonData` core (the single source).
/// PersonData has no cross-field invariant, so the spec walk is the whole
/// validator.
pub(crate) fn validate_update_person(payload: &Value) -> Result<(), String> {
    MutationKind::UpdatePerson.payload_spec().check(payload)
}

/// Validate a `MediaData` object (ADR-0059): a required non-empty `title`; a
/// required `medium`/`state` enum; clearable `rating`/`finished_at`; clearable
/// string `url`/`note`; clearable `tags` (an array of non-empty strings). The
/// flat spec walk validates everything but the cross-field finish-data rule (the
/// `media_state_finish_invariant` hook). Each optional field is CLEARABLE: a
/// `null` value is the ADR-0033 sentinel-clear directive (accepted; the apply
/// path drops null keys).
pub(crate) fn validate_media(payload: &Value) -> Result<(), String> {
    MutationKind::CreateMedia.payload_data_spec().check(payload)?;
    media_state_finish_invariant(payload.as_object().expect("check accepted an object"))
}

/// Validate an `update_media` payload against the kind's full spec: the
/// `entity_id` target prepended to the `MediaData` core (the single source), then
/// the finish-data invariant over the whole merged doc. Update is a full-document
/// replace (like person/project), so the data is a complete MediaData
/// (ADR-0059); the same cross-field rule applies.
pub(crate) fn validate_update_media(payload: &Value) -> Result<(), String> {
    MutationKind::UpdateMedia.payload_spec().check(payload)?;
    media_state_finish_invariant(payload.as_object().expect("check accepted an object"))
}

/// The Media state↔finish-data invariant (ADR-0059): `rating` and `finished_at`
/// are meaningful ONLY when `state ∈ {done, abandoned}` (the terminal states), and
/// are rejected otherwise — a `backlog`/`consuming` Media has no finish data. Also
/// range-checks a present `rating` to `1..=5` (the `PositiveInt` spec only gates
/// `>= 1`; the upper bound is not a `FieldSpec`). A `null` value is the ADR-0033
/// clear directive, so it counts as ABSENT here ([`present_non_null`]) — clearing
/// finish data is always allowed.
fn media_state_finish_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    let state = obj.get("state").and_then(Value::as_str).unwrap_or("");
    let terminal = matches!(state, "done" | "abandoned");
    if present_non_null(obj, "rating") && !terminal {
        return Err("rating is only valid when state is done or abandoned".to_string());
    }
    if present_non_null(obj, "finished_at") && !terminal {
        return Err("finished_at is only valid when state is done or abandoned".to_string());
    }
    // The 1..=5 cap (the spec already rejected a non-positive or non-integer
    // rating; a `null` rating is the clear directive and counts as absent).
    if let Some(rating) = obj.get("rating").and_then(Value::as_u64)
        && rating > 5
    {
        return Err("rating must be between 1 and 5".to_string());
    }
    Ok(())
}

/// Validate a `HabitData` object: required `name`, required cadence
/// `{interval, unit}`, optional clearable `target`/`note`, and optional status.
/// Check-ins are Observations, so no time-series data belongs here.
pub(crate) fn validate_habit(payload: &Value) -> Result<(), String> {
    MutationKind::CreateHabit.payload_data_spec().check(payload)
}

/// Validate an `update_habit` full-document replace payload: `entity_id` plus a
/// complete HabitData object.
pub(crate) fn validate_update_habit(payload: &Value) -> Result<(), String> {
    MutationKind::UpdateHabit.payload_spec().check(payload)
}

#[cfg(test)]
fn validate_project(payload: &Value) -> Result<(), String> {
    validate_project_data(payload)
}

/// Validate a `create_project` payload: the FULL payload (data core + the
/// `source_journal_entry_id` provenance directive) through the single-source
/// spec, then the status↔timestamp invariant hook the flat walk cannot express.
pub(crate) fn validate_create_project(payload: &Value) -> Result<(), String> {
    MutationKind::CreateProject.payload_spec().check(payload)?;
    project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
}

/// Validate a complete Project `data` object against the Project schema (ADR-0031).
/// Shared by the create validator and the `mark_project_reviewed` apply path,
/// which re-validates the recomputed whole before persisting it (ADR-0034).
pub(crate) fn validate_project_data(payload: &Value) -> Result<(), String> {
    // Flat shape (fields, types, the status enum, datetime parse, review_every
    // sub-object) from the single source; the status↔timestamp invariant — which
    // a flat walk cannot express — stays a hand-written hook.
    MutationKind::CreateProject
        .payload_data_spec()
        .check(payload)?;
    project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
}

/// The Project status↔timestamp invariant (ADR-0031). A `null` timestamp is the
/// ADR-0033 clear directive, so it counts as ABSENT (`null_is_absent = true`) —
/// distinct from the Todo invariant, whose spec already rejects a `null` timestamp
/// so a present key is a concrete value.
fn project_status_timestamp_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    status_timestamp_invariant(obj, "project", true)
}

/// Whether `key` is present in `obj` with a non-`null` value. A `null` value is the
/// sentinel-clear directive (ADR-0033), counting as absent (the apply path drops
/// null keys from stored data). Shared by the Media terminal-field guard and (via
/// `null_is_absent`) the Project branch of [`status_timestamp_invariant`].
fn present_non_null(obj: &serde_json::Map<String, Value>, key: &str) -> bool {
    matches!(obj.get(key), Some(v) if !v.is_null())
}

/// The shared GTD status↔timestamp state machine for Todo and Project (ADR-0031),
/// the single owner of "completed requires `completed_at` and forbids `dropped_at`;
/// dropped is the mirror; active/on_hold forbid both". An absent status defaults to
/// active. `noun` names the Entity in the client-facing error; `null_is_absent`
/// selects the timestamp-presence rule: Project treats a `null` timestamp as the
/// ADR-0033 sentinel-clear (absent), Todo treats a present key as a concrete value
/// (its spec already rejects `null`). Todo never sends `on_hold` (its status enum
/// omits it — rejected before this hook), so the shared `active | on_hold` arm is
/// safe for both.
fn status_timestamp_invariant(
    obj: &serde_json::Map<String, Value>,
    noun: &str,
    null_is_absent: bool,
) -> Result<(), String> {
    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    let present = |key: &str| {
        if null_is_absent {
            present_non_null(obj, key)
        } else {
            obj.contains_key(key)
        }
    };
    let has_completed_at = present("completed_at");
    let has_dropped_at = present("dropped_at");
    match status {
        "active" | "on_hold" => {
            if has_completed_at {
                return Err(format!("{status} {noun} must not have completed_at"));
            }
            if has_dropped_at {
                return Err(format!("{status} {noun} must not have dropped_at"));
            }
        }
        "completed" => {
            if !has_completed_at {
                return Err(format!("completed {noun} requires completed_at"));
            }
            if has_dropped_at {
                return Err(format!("completed {noun} must not have dropped_at"));
            }
        }
        "dropped" => {
            if !has_dropped_at {
                return Err(format!("dropped {noun} requires dropped_at"));
            }
            if has_completed_at {
                return Err(format!("dropped {noun} must not have completed_at"));
            }
        }
        _ => unreachable!("status validated by the spec"),
    }
    Ok(())
}

/// Validate an `update_project` payload against the kind's full spec: the
/// `entity_id` target prepended to the `ProjectData` core (the single source),
/// then the status↔timestamp invariant — same hook order as create dispatch and
/// [`validate_project_data`]. The spec tolerates an absent status, which is fine
/// for an update (status optional on update).
pub(crate) fn validate_update_project(payload: &Value) -> Result<(), String> {
    MutationKind::UpdateProject.payload_spec().check(payload)?;
    project_status_timestamp_invariant(payload.as_object().expect("check accepted an object"))
}

/// The optional `source_journal_entry_id` provenance directive (ADR-0030/0031) on
/// a `create_{person,project,todo}` payload, read from the top level (the
/// person/project payload, or the todo envelope). When present, the accept path
/// sources the new Entity `created_from` this Journal Entry rather than the user
/// Message. Decide verifies it names an actual Journal Entry.
pub(crate) fn source_journal_entry_id(payload: &Value) -> Option<&str> {
    payload
        .get("source_journal_entry_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// Validate a Todo's `recurrence` rule in ISOLATION (ADR-0037): every invariant
/// that needs only the rule itself. The cross-field `anchor` presence check —
/// the Todo must carry the date field the `anchor` names — needs the whole Todo
/// and lives in [`validate_todo_data`], not here.
fn validate_recurrence(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "recurrence must be an object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "interval" | "unit" | "anchor" | "end" => {}
            other => return Err(format!("unsupported recurrence field {other:?}")),
        }
    }

    match obj.get("interval") {
        Some(Value::Number(n)) => match n.as_u64() {
            Some(interval) if interval >= 1 => {}
            _ => return Err("recurrence interval must be a positive integer".to_string()),
        },
        Some(_) => return Err("recurrence interval must be a positive integer".to_string()),
        None => return Err("recurrence interval is required".to_string()),
    }

    match obj.get("unit") {
        Some(Value::String(unit)) => match unit.as_str() {
            "minute" | "hour" | "day" | "week" | "month" | "year" => {}
            _ => {
                return Err(
                    "recurrence unit must be one of minute, hour, day, week, month, year"
                        .to_string(),
                );
            }
        },
        Some(_) => return Err("recurrence unit must be a string".to_string()),
        None => return Err("recurrence unit is required".to_string()),
    };

    match obj.get("anchor") {
        Some(Value::String(anchor)) => match anchor.as_str() {
            "defer_at" | "due_at" => {}
            _ => return Err("recurrence anchor must be one of defer_at, due_at".to_string()),
        },
        Some(_) => return Err("recurrence anchor must be a string".to_string()),
        None => return Err("recurrence anchor is required".to_string()),
    }

    if let Some(end) = obj.get("end") {
        validate_recurrence_end(end)?;
    }

    Ok(())
}

/// Validate `recurrence.end` (ADR-0037): a non-empty object carrying at most one
/// of `until` (a parseable `YYYY-MM-DDTHH:MM:SS` wall clock) or `after_count`
/// (an integer `>= 1`).
fn validate_recurrence_end(value: &Value) -> Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "recurrence end must be an object".to_string())?;

    for key in obj.keys() {
        match key.as_str() {
            "until" | "after_count" => {}
            other => return Err(format!("unsupported recurrence end field {other:?}")),
        }
    }

    let has_until = obj.contains_key("until");
    let has_after_count = obj.contains_key("after_count");
    if !has_until && !has_after_count {
        return Err("recurrence end must carry until or after_count".to_string());
    }
    if has_until && has_after_count {
        return Err("recurrence end must carry at most one of until, after_count".to_string());
    }

    if let Some(until) = obj.get("until") {
        match until {
            Value::String(t) if !t.trim().is_empty() => {
                parse_local_datetime(t, "recurrence end until")?;
            }
            Value::String(_) => return Err("recurrence end until must not be empty".to_string()),
            _ => return Err("recurrence end until must be a string".to_string()),
        }
    }

    if let Some(after_count) = obj.get("after_count") {
        match after_count {
            Value::Number(n) => match n.as_u64() {
                Some(count) if count >= 1 => {}
                _ => {
                    return Err("recurrence end after_count must be a positive integer".to_string());
                }
            },
            _ => return Err("recurrence end after_count must be a positive integer".to_string()),
        }
    }

    Ok(())
}

/// Validate a `create_todo` payload: an ENVELOPE `{todo: TodoData, person_refs?}`
/// (ADR-0031). `todo` is required and validated as `TodoData`; `person_refs`, when
/// present, must be an array of refs, each an object with a required non-empty
/// `person_id` and an optional `role` ∈ {waiting_on, related} (a missing role
/// defaults to `related` at apply-time). Any other top-level key is rejected.
/// `person_id` existence (an Accepted Person) is checked at decide-time, not here.
pub(crate) fn validate_todo(payload: &Value) -> Result<(), String> {
    // Envelope shape (`{todo, person_refs?, source_journal_entry_id?}`) from the
    // single source — including the person_refs element shape, now spec-driven —
    // then the TodoData hook validates the `todo` value (its cross-field
    // invariants exceed a flat walk).
    MutationKind::CreateTodo.payload_spec().check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    let todo = obj
        .get("todo")
        .ok_or_else(|| "todo is required".to_string())?;
    validate_todo_data(todo)
}

/// Validate the `TodoData` sub-object (ADR-0031): a required non-empty `title`;
/// optional string `note`/`project_id` (`project_id` existence is checked at
/// decide-time, not here); an optional `status` ∈ {active, completed, dropped}
/// defaulting to active when absent (Todo has NO `on_hold`); concrete
/// `defer_at`/`due_at`/`completed_at`/`dropped_at` timestamps; and the
/// status↔timestamp invariants. Any other field is rejected. `pub(crate)` so the
/// apply path can re-validate a MERGED `update_todo` result as a whole.
pub(crate) fn validate_todo_data(payload: &Value) -> Result<(), String> {
    // Flat shape (fields, title, note, project_id, status enum, datetime parse)
    // from the single source; the status↔timestamp + recurrence (rule-in-isolation
    // and anchor-presence) invariants — which exceed a flat walk — stay hooks.
    todo_data_spec(Mode::Full).check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    todo_status_timestamp_invariant(obj)?;
    todo_recurrence_invariant(obj)
}

/// The Todo status↔timestamp invariant (ADR-0031). Unlike Project, Todo timestamps
/// reject `null` (the spec already did), so a present key is a concrete timestamp —
/// hence `null_is_absent = false` ([`status_timestamp_invariant`], the shared owner).
fn todo_status_timestamp_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    status_timestamp_invariant(obj, "todo", false)
}

/// The Todo `recurrence` invariant (ADR-0037): validate the rule in isolation
/// (the `HookValidated` spec leaves it to us), then enforce anchor-presence — the
/// Todo must carry a non-empty date at the field the rule's `anchor` names. Holds
/// for any valid stored Todo, so the apply-time re-validation of a merged
/// `update_todo` enforces it too.
fn todo_recurrence_invariant(obj: &serde_json::Map<String, Value>) -> Result<(), String> {
    if let Some(recurrence) = obj.get("recurrence") {
        validate_recurrence(recurrence)?;
        if let Some(Value::String(anchor)) = recurrence.get("anchor") {
            let present =
                matches!(obj.get(anchor.as_str()), Some(Value::String(t)) if !t.trim().is_empty());
            if !present {
                return Err(format!(
                    "recurrence anchor {anchor:?} requires the todo to have {anchor}"
                ));
            }
        }
    }
    Ok(())
}

/// Validate an `update_todo` envelope (ADR-0031): a required UUID `todo_id` (the
/// TARGET key, NOT `entity_id`); an optional `todo` Partial<TodoData> whose keys
/// are a SUBSET of TodoData fields with each SUPPLIED field individually valid
/// (title if present non-empty; status if present ∈ {active, completed, dropped};
/// timestamps parseable) — the status↔timestamp invariants are NOT enforced here
/// because the pure validator lacks the current Todo state; the apply path
/// re-validates the MERGED whole via [`validate_todo_data`]. Optional
/// `set_person_refs`/`add_person_refs` (each a ref array) and `remove_person_ids`
/// (an array of non-empty strings). Any other top-level key is rejected.
pub(crate) fn validate_update_todo(payload: &Value) -> Result<(), String> {
    // Envelope shape (`todo_id`, set/add `person_refs`, `remove_person_ids`) from
    // the single source; the partial `todo` value's recurrence rule (a non-null
    // value validated in isolation) is the one cross-field bit the spec defers.
    MutationKind::UpdateTodo.payload_spec().check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    if let Some(todo) = obj.get("todo") {
        validate_partial_todo_data(todo)?;
    }
    Ok(())
}

/// Validate a `Partial<TodoData>` (ADR-0031, ADR-0033): each SUPPLIED key must be
/// a TodoData field and individually valid (title non-empty; status enum;
/// note/project_id strings; timestamps parseable). No field is required and the
/// status↔timestamp invariants are deferred to the apply-time re-validation of
/// the merged whole, so a partial that supplies only `status` or only a
/// timestamp is accepted here. A `null` value on a CLEARABLE optional field
/// (`note`, `project_id`, `defer_at`, `due_at`, `completed_at`, `dropped_at`) is
/// the sentinel-clear directive — accepted here and translated to remove-the-key
/// by the apply-time merge. `null` on the required, non-clearable `title`/`status`
/// stays rejected (clearing them is meaningless).
fn validate_partial_todo_data(payload: &Value) -> Result<(), String> {
    // Flat partial shape from the single source (Mode::Partial: every field
    // optional; `note`/`project_id`/timestamps/`recurrence` clearable via `null`;
    // `title`/`status` optional-but-not-clearable). The recurrence rule, when a
    // non-null value is supplied, is validated in isolation here — the
    // anchor-presence cross-check is NOT done (a partial lacks the whole Todo; the
    // apply-time re-validation of the merged whole enforces it).
    todo_data_spec(Mode::Partial).check(payload)?;
    let obj = payload.as_object().expect("check accepted an object");
    match obj.get("recurrence") {
        Some(Value::Null) | None => Ok(()),
        Some(recurrence) => validate_recurrence(recurrence),
    }
}

/// Validate an `apply_intent_graph` payload. The intent graph (ADR-0042)
/// validates its STRUCTURE via the single-source spec (optional journal_entry,
/// >= 1 typed entity nodes, the three link kinds). The cross-node graph
/// invariants (handle references, duplicate handles,
/// journal_ref-without-journal_entry) are the resolver's job (slice 2+); slice 1
/// short-circuits before apply, so structural acceptance is all the agent path
/// needs here.
pub(crate) fn validate_apply_intent_graph(payload: &Value) -> Result<(), String> {
    MutationKind::ApplyIntentGraph.payload_spec().check(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mutation::{
        HABIT_SCHEMA_VERSION, JOURNAL_ENTRY_SCHEMA_VERSION, MEDIA_SCHEMA_VERSION,
    };
    use serde_json::json;

    /// Test shim: validate by wire string, mirroring the pre-refactor
    /// `validate(&str, _)` signature so the schema tests stay string-driven. An
    /// unknown kind is the from_wire-None case the edge maps to Invalid; here it
    /// surfaces as the same "not supported" reason the old `_` arm returned.
    fn validate(kind: &str, payload: &Value) -> Result<(), String> {
        match MutationKind::from_wire(kind) {
            Some(k) => (k.describe().validate)(payload),
            None => Err(format!("mutation_kind {kind:?} not supported")),
        }
    }

    /// Test shim: render the accept text by wire string (the kind must be
    /// Entity-backed, as Observation rendering is owned by observations.rs).
    fn render_accept(kind: &str, payload: &Value) -> String {
        let kind = MutationKind::from_wire(kind).expect("known Entity mutation kind");
        super::render_accept(kind, payload, Some("test-entity-id"))
    }

    /// Test shim: the schema version for a wire kind, via its Entity Type — the
    /// pre-refactor `schema_version(&str)` the version tests assert against.
    fn schema_version(kind: &str) -> i64 {
        MutationKind::from_wire(kind)
            .expect("known mutation_kind")
            .describe()
            .entity_type
            .schema_version()
    }

    #[test]
    fn accepts_minimal_journal_entry() {
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
    }

    #[test]
    fn accepts_equal_or_later_ended_at() {
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
        assert!(validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T11:00:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_missing_or_empty_occurred_at() {
        assert!(
            validate_journal_entry(&json!({ "body": [{ "type": "text", "text": "x" }] })).is_err()
        );
        assert!(validate_journal_entry(
            &json!({ "occurred_at": "", "body": [{ "type": "text", "text": "x" }] })
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_or_reversed_times() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "banana",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("occurred_at must be parseable");
        assert!(
            reason.contains("occurred_at"),
            "reason names occurred_at: {reason}"
        );

        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "2026-06-10T10:29:59",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("ended_at cannot be before occurred_at");
        assert!(
            reason.contains("ended_at"),
            "reason names ended_at: {reason}"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice." }],
            "status": "draft"
        }))
        .expect_err("unknown payload fields are not part of the first slice");
        assert!(
            reason.contains("status"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn rejects_non_text_body_nodes() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "entity_ref" }]
        }))
        .expect_err("fresh Journal Entry creates cannot include entity_ref nodes");
        assert!(
            reason.contains("text nodes"),
            "reason names text-only body: {reason}"
        );
    }

    #[test]
    fn woven_body_accepts_text_and_existing_entity_ref_nodes() {
        // The shape the intent-graph weave produces: collapsed-to-text + stored refs.
        assert!(validate_woven_journal_body(&json!([
            { "type": "text", "text": "Talked with Morris about " },
            { "type": "entity_ref", "ref_id": Uuid::now_v7().to_string() }
        ]))
        .is_ok());
    }

    #[test]
    fn woven_body_rejects_empty_text_node() {
        // The exact regression: a rejected-ref collapse that emits empty text must
        // fail loud here (defense in depth) rather than persist and crash the client.
        let reason = validate_woven_journal_body(&json!([
            { "type": "text", "text": "Synced on " },
            { "type": "text", "text": "" }
        ]))
        .expect_err("an empty text node is not a valid woven body");
        assert!(
            reason.contains("must not be empty"),
            "reason names the empty text: {reason}"
        );
    }

    #[test]
    fn update_accepts_mixed_text_and_entity_ref_body_nodes() {
        assert!(validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref", "ref_id": Uuid::now_v7().to_string() },
                    { "type": "text", "text": " at school." }
                ]
            })
        )
        .is_ok());
    }

    #[test]
    fn update_rejects_entity_ref_nodes_without_ref_id() {
        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref" }]
            }),
        )
        .expect_err("entity_ref nodes require ref_id");
        assert!(
            reason.contains("ref_id"),
            "reason names missing ref_id: {reason}"
        );

        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref", "ref_id": "  " }]
            }),
        )
        .expect_err("entity_ref ref_id cannot be empty");
        assert!(
            reason.contains("ref_id"),
            "reason names empty ref_id: {reason}"
        );
    }

    #[test]
    fn update_rejects_entity_ref_nodes_with_malformed_ref_id() {
        let reason = validate(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "entity_ref", "ref_id": "not-a-uuid" }]
            }),
        )
        .expect_err("entity_ref ref_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names malformed ref_id: {reason}"
        );
    }

    #[test]
    fn reference_existing_entity_accepts_one_new_entity_ref_placeholder() {
        assert!(validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "label_snapshot": "Ada",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref" },
                    { "type": "text", "text": " at school." }
                ]
            })
        )
        .is_ok());
    }

    #[test]
    fn reference_existing_entity_rejects_missing_or_multiple_placeholders() {
        let reason = validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "body": [{ "type": "text", "text": "Met Ada." }]
            }),
        )
        .expect_err("reference mutation needs one placeholder");
        assert!(
            reason.contains("exactly one entity_ref"),
            "reason names the placeholder count: {reason}"
        );

        let reason = validate(
            "reference_existing_entity_from_journal_entry",
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "body": [
                    { "type": "entity_ref" },
                    { "type": "entity_ref" }
                ]
            }),
        )
        .expect_err("reference mutation allows one reference per payload");
        assert!(
            reason.contains("exactly one entity_ref"),
            "reason names the placeholder count: {reason}"
        );
    }

    #[test]
    fn reference_existing_entity_data_payload_rewrites_placeholder() {
        let ref_id = Uuid::now_v7().to_string();
        let data = reference_existing_entity_data_payload(
            &json!({
                "occurred_at": "2026-06-10T10:00:00",
                "ended_at": "2026-06-10T10:15:00",
                "body": [{ "type": "text", "text": "Old body." }]
            }),
            &json!({
                "source_entity_id": Uuid::now_v7().to_string(),
                "target_entity_id": Uuid::now_v7().to_string(),
                "label_snapshot": "Ada",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref" }
                ]
            }),
            &ref_id,
        );
        assert!(data.get("source_entity_id").is_none());
        assert!(data.get("target_entity_id").is_none());
        assert!(data.get("label_snapshot").is_none());
        assert_eq!(data["occurred_at"].as_str(), Some("2026-06-10T10:00:00"));
        assert_eq!(data["ended_at"].as_str(), Some("2026-06-10T10:15:00"));
        assert_eq!(data["body"][1]["ref_id"].as_str(), Some(ref_id.as_str()));
    }

    #[test]
    fn rejects_extra_body_node_fields_and_empty_ended_at() {
        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "ended_at": "  ",
            "body": [{ "type": "text", "text": "Talked to Alice." }]
        }))
        .expect_err("ended_at must be concrete when present");
        assert!(
            reason.contains("ended_at"),
            "reason names ended_at: {reason}"
        );

        let reason = validate_journal_entry(&json!({
            "occurred_at": "2026-06-10T10:30:00",
            "body": [{ "type": "text", "text": "Talked to Alice.", "ref_id": "r1" }]
        }))
        .expect_err("text body nodes have only type and text");
        assert!(
            reason.contains("ref_id"),
            "reason names unsupported body field: {reason}"
        );
    }

    #[test]
    fn validate_dispatches_journal_entry_ok() {
        assert!(validate(
            "create_journal_entry",
            &json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Talked to Alice." }]
            })
        )
        .is_ok());
        assert!(validate(
            "delete_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string()
            })
        )
        .is_ok());
    }

    #[test]
    fn validate_delete_person_and_todo_accept_a_uuid_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            assert!(
                validate(kind, &json!({ "entity_id": Uuid::now_v7().to_string() })).is_ok(),
                "{kind} with a UUID entity_id validates"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_unsupported_field() {
        for kind in ["delete_person", "delete_todo"] {
            let reason = validate(
                kind,
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice" }),
            )
            .expect_err("an extra field on a delete payload is unsupported");
            assert!(
                reason.contains(kind) && reason.contains("name"),
                "{kind} names the unsupported field: {reason}"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_missing_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            let reason =
                validate(kind, &json!({})).expect_err("a delete requires an entity_id target");
            assert!(
                reason.contains("entity_id"),
                "{kind} names the required entity_id: {reason}"
            );
        }
    }

    #[test]
    fn validate_delete_person_and_todo_reject_non_uuid_entity_id() {
        for kind in ["delete_person", "delete_todo"] {
            let reason = validate(kind, &json!({ "entity_id": "not-a-uuid" }))
                .expect_err("a delete entity_id must be a UUID");
            assert!(
                reason.contains("UUID"),
                "{kind} names the malformed entity_id: {reason}"
            );
        }
    }

    #[test]
    fn validate_rejects_unsupported_mutation_kind() {
        let reason = validate("create_widget", &json!({ "title": "Buy milk" }))
            .expect_err("widget mutation is unsupported");
        assert!(
            reason.contains("create_widget") && reason.contains("not supported"),
            "unsupported reason names the mutation kind: {reason}"
        );
    }

    #[test]
    fn render_accept_journal_entry_confirms_creation() {
        let text = render_accept(
            "create_journal_entry",
            &json!({
                "occurred_at": "2026-06-10T10:30:00",
                "body": [{ "type": "text", "text": "Bought milk." }]
            }),
        );
        assert!(
            text.contains("Journal Entry")
                && text.contains("2026-06-10T10:30:00")
                && text.contains("Bought milk."),
            "confirmation names the created Journal Entry fields: {text}"
        );
    }

    #[test]
    fn render_accept_journal_entry_includes_entity_ref_placeholders() {
        let ref_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "update_journal_entry",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "occurred_at": "2026-06-10T10:30:00",
                "body": [
                    { "type": "text", "text": "Met " },
                    { "type": "entity_ref", "ref_id": ref_id },
                    { "type": "text", "text": " at school." }
                ]
            }),
        );
        assert!(
            text.contains("[entity_ref:") && text.contains(" at school."),
            "confirmation keeps entity_ref nodes visible: {text}"
        );
    }

    #[test]
    fn render_accept_delete_journal_entry_confirms_deletion() {
        let entity_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "delete_journal_entry",
            &json!({
                "entity_id": entity_id
            }),
        );
        assert!(
            text.contains("Deleted Journal Entry") && text.contains("entity_id="),
            "confirmation names the deleted Journal Entry target: {text}"
        );
    }

    #[test]
    fn schema_version_journal_entry_is_one() {
        assert_eq!(
            schema_version("create_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            schema_version("delete_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(
            schema_version("reference_existing_entity_from_journal_entry"),
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
        assert_eq!(schema_version("create_journal_entry"), 1);
    }

    #[test]
    fn accepts_minimal_person() {
        assert!(validate_person(&json!({ "name": "Alice" })).is_ok());
    }

    #[test]
    fn accepts_person_with_note_and_aliases() {
        assert!(validate_person(&json!({
            "name": "Alice",
            "note": "daycare coordinator",
            "aliases": ["Al", "Ali"]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_missing_or_blank_name() {
        assert!(validate_person(&json!({ "note": "no name" })).is_err());
        let reason =
            validate_person(&json!({ "name": "   " })).expect_err("blank name is not a name");
        assert!(
            reason.contains("name"),
            "reason names the name field: {reason}"
        );
    }

    #[test]
    fn rejects_blank_alias() {
        let reason = validate_person(&json!({ "name": "Alice", "aliases": ["Al", "  "] }))
            .expect_err("blank aliases are not allowed");
        assert!(reason.contains("alias"), "reason names the alias: {reason}");
    }

    #[test]
    fn rejects_non_array_aliases() {
        let reason = validate_person(&json!({ "name": "Alice", "aliases": "Al" }))
            .expect_err("aliases must be an array");
        assert!(reason.contains("aliases"), "reason names aliases: {reason}");
    }

    #[test]
    fn rejects_unsupported_person_field() {
        let reason = validate_person(&json!({ "name": "Alice", "status": "active" }))
            .expect_err("person has no status field");
        assert!(
            reason.contains("status"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn update_person_validates_payload_minus_entity_id() {
        // entity_id + a valid PersonData body is ok.
        assert!(validate(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice", "note": "x" })
        )
        .is_ok());
        // The PersonData rules still apply to the rest (no status field).
        let reason = validate(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "status": "active" }),
        )
        .expect_err("person has no status field");
        assert!(
            reason.contains("status"),
            "reason names the unsupported person field: {reason}"
        );
    }

    #[test]
    fn update_person_requires_a_uuid_entity_id() {
        let reason = validate("update_person", &json!({ "name": "Alice" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_person",
            &json!({ "entity_id": "nope", "name": "Alice" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn accepts_project_without_status() {
        assert!(validate_project(&json!({ "name": "Ship API v2 migration" })).is_ok());
    }

    #[test]
    fn rejects_null_project_status() {
        // `status` is optional (absent ⇒ active) but NOT clearable: an explicit
        // `null` is rejected, matching Todo `status` and the pre-spec validator.
        // Clearing a status is meaningless, so `null` must not slip through as a
        // silent "active".
        let reason = validate_project(&json!({ "name": "Roadmap", "status": null }))
            .expect_err("a null status is not a valid status");
        assert!(
            reason.contains("status"),
            "reason names the status field: {reason}"
        );
    }

    #[test]
    fn accepts_project_with_active_or_on_hold_status() {
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "active" })).is_ok());
        assert!(validate_project(&json!({ "name": "Roadmap", "status": "on_hold" })).is_ok());
    }

    #[test]
    fn accepts_completed_project_with_completed_at() {
        assert!(validate_project(&json!({
            "name": "Roadmap",
            "status": "completed",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .is_ok());
    }

    #[test]
    fn rejects_completed_project_without_completed_at() {
        let reason = validate_project(&json!({ "name": "Roadmap", "status": "completed" }))
            .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_active_project_with_completed_at() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "status": "active",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .expect_err("active forbids completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_dropped_project_with_completed_at() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "status": "dropped",
            "completed_at": "2026-06-10T10:00:00"
        }))
        .expect_err("dropped forbids completed_at and requires dropped_at");
        assert!(
            reason.contains("completed_at") || reason.contains("dropped_at"),
            "reason names the violated timestamp: {reason}"
        );
    }

    #[test]
    fn rejects_completed_project_with_both_timestamps() {
        // A completed Project requires completed_at and FORBIDS dropped_at
        // (project_status_timestamp_invariant). Both present is rejected.
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "status": "completed",
            "completed_at": "2026-06-10T10:00:00",
            "dropped_at": "2026-06-11T10:00:00"
        }))
        .expect_err("completed project must not also carry dropped_at");
        assert!(
            reason.contains("dropped_at"),
            "reason names dropped_at: {reason}"
        );
    }

    #[test]
    fn rejects_missing_or_blank_project_name() {
        assert!(validate_project(&json!({ "status": "active" })).is_err());
        let reason =
            validate_project(&json!({ "name": "   " })).expect_err("blank name is not a name");
        assert!(
            reason.contains("name"),
            "reason names the name field: {reason}"
        );
    }

    #[test]
    fn rejects_unparseable_due_at() {
        let reason = validate_project(&json!({ "name": "Roadmap", "due_at": "banana" }))
            .expect_err("due_at must be parseable");
        assert!(reason.contains("due_at"), "reason names due_at: {reason}");
    }

    #[test]
    fn rejects_bad_review_every() {
        let reason = validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 0, "unit": "week" }
        }))
        .expect_err("interval must be positive");
        assert!(
            reason.contains("interval"),
            "reason names interval: {reason}"
        );

        let reason = validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 1, "unit": "fortnight" }
        }))
        .expect_err("unit must be a known unit");
        assert!(reason.contains("unit"), "reason names unit: {reason}");
    }

    #[test]
    fn accepts_valid_review_every() {
        assert!(validate_project(&json!({
            "name": "Roadmap",
            "review_every": { "interval": 1, "unit": "week" }
        }))
        .is_ok());
    }

    #[test]
    fn mark_project_reviewed_validates_entity_id_only() {
        // A bare UUID `entity_id` is the whole payload (Core recomputes the rest).
        assert!(validate(
            "mark_project_reviewed",
            &json!({ "entity_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
        // Missing id, non-UUID id, and any extra field are all rejected.
        assert!(validate("mark_project_reviewed", &json!({})).is_err());
        assert!(validate("mark_project_reviewed", &json!({ "entity_id": "nope" })).is_err());
        let reason = validate(
            "mark_project_reviewed",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "next_review_at": "2026-01-01T20:00:00" }),
        )
        .expect_err("client may not send review fields");
        assert!(
            reason.contains("next_review_at"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn rejects_disallowed_project_fields() {
        for field in ["type", "person_ids", "todo_ids", "tags"] {
            let reason = validate_project(&json!({ "name": "Roadmap", field: "x" }))
                .expect_err("disallowed ProjectData field");
            assert!(
                reason.contains(field),
                "reason names the unsupported field {field}: {reason}"
            );
        }
    }

    #[test]
    fn update_project_validates_payload_minus_entity_id() {
        // entity_id + a valid status transition is ok; status is optional on update.
        assert!(
            validate(
                "update_project",
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "on_hold" })
            )
            .is_ok()
        );
        assert!(
            validate(
                "update_project",
                &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap" })
            )
            .is_ok(),
            "status is optional on an update"
        );
        // The completed↔completed_at invariant still applies to the rest.
        let reason = validate(
            "update_project",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "completed" }),
        )
        .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn update_project_requires_a_uuid_entity_id() {
        // All four `entity_id` failure modes are pinned on one update kind — the
        // three update kinds share `entity_id_target()`/`FieldSpec::Uuid`, so one
        // suffices to gate the spec path the validators now route through.
        let reason = validate("update_project", &json!({ "name": "Roadmap" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id") && reason.contains("required"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": "", "name": "Roadmap" }),
        )
        .expect_err("a blank entity_id is not a target");
        assert!(
            reason.contains("must not be empty"),
            "reason rejects the empty entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": 42, "name": "Roadmap" }),
        )
        .expect_err("a non-string entity_id is not a target");
        assert!(
            reason.contains("must be a string"),
            "reason rejects the non-string entity_id: {reason}"
        );
        let reason = validate(
            "update_project",
            &json!({ "entity_id": "nope", "name": "Roadmap" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn render_accept_update_person_and_project() {
        let person = render_accept(
            "update_person",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Alice" }),
        );
        assert!(
            person.contains("Updated Person") && person.contains("Alice"),
            "confirmation names the updated Person: {person}"
        );
        let project = render_accept(
            "update_project",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "Roadmap", "status": "on_hold" }),
        );
        assert!(
            project.contains("Updated Project")
                && project.contains("Roadmap")
                && project.contains("on_hold"),
            "confirmation names the updated Project: {project}"
        );
    }

    #[test]
    fn accepts_minimal_todo_without_status() {
        assert!(validate_todo(&json!({ "todo": { "title": "buy milk" } })).is_ok());
    }

    #[test]
    fn accepts_todo_with_each_valid_status() {
        assert!(validate_todo(&json!({ "todo": { "title": "x", "status": "active" } })).is_ok());
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "status": "completed", "completed_at": "2026-06-10T10:00:00" }
        }))
        .is_ok());
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "status": "dropped", "dropped_at": "2026-06-10T10:00:00" }
        }))
        .is_ok());
    }

    #[test]
    fn accepts_todo_with_project_link_and_person_refs_array() {
        // project_id existence is a decide-time check, not the pure validator's.
        assert!(validate_todo(&json!({
            "todo": { "title": "x", "project_id": "some-id" },
            "person_refs": [{ "person_id": "alice", "role": "waiting_on" }]
        }))
        .is_ok());
    }

    #[test]
    fn rejects_blank_todo_project_id() {
        // A blank project_id would slip past the decide-time Accepted-Project
        // check (which filters empty ids) and persist "" into Todo JSON, leaving
        // the Todo neither projectless nor linked. Reject it at validate.
        let reason = validate_todo(&json!({ "todo": { "title": "x", "project_id": "" } }))
            .expect_err("blank project_id is rejected");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
        let reason = validate_todo(&json!({ "todo": { "title": "x", "project_id": "   " } }))
            .expect_err("whitespace project_id is rejected");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
        // The same guard on the update_todo partial path.
        let reason = validate_partial_todo_data(&json!({ "project_id": "" }))
            .expect_err("blank project_id is rejected on update");
        assert!(
            reason.contains("project_id"),
            "reason names project_id: {reason}"
        );
    }

    #[test]
    fn rejects_missing_or_blank_todo_title() {
        let reason = validate_todo(&json!({ "todo": { "note": "no title" } }))
            .expect_err("title is required");
        assert!(reason.contains("title"), "reason names title: {reason}");
        let reason = validate_todo(&json!({ "todo": { "title": "   " } }))
            .expect_err("blank title is not a title");
        assert!(reason.contains("title"), "reason names title: {reason}");
    }

    #[test]
    fn rejects_completed_todo_without_completed_at_and_active_with_completed_at() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "status": "completed" } }))
            .expect_err("completed requires completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
        let reason = validate_todo(&json!({
            "todo": { "title": "x", "status": "active", "completed_at": "2026-06-10T10:00:00" }
        }))
        .expect_err("active forbids completed_at");
        assert!(
            reason.contains("completed_at"),
            "reason names completed_at: {reason}"
        );
    }

    #[test]
    fn rejects_unparseable_todo_timestamps() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "defer_at": "banana" } }))
            .expect_err("defer_at must be parseable");
        assert!(
            reason.contains("defer_at"),
            "reason names defer_at: {reason}"
        );
        let reason = validate_todo(&json!({ "todo": { "title": "x", "due_at": "soon" } }))
            .expect_err("due_at must be parseable");
        assert!(reason.contains("due_at"), "reason names due_at: {reason}");
    }

    #[test]
    fn rejects_on_hold_status_value() {
        let reason = validate_todo(&json!({ "todo": { "title": "x", "status": "on_hold" } }))
            .expect_err("todo has no on_hold status");
        assert!(reason.contains("status"), "reason names status: {reason}");
    }

    #[test]
    fn rejects_disallowed_todo_fields() {
        for field in [
            "repeat",
            "inbox",
            "standalone",
            "blocked",
            "on_hold",
            "subtasks",
            "tags",
            "person_ids",
        ] {
            let reason = validate_todo(&json!({ "todo": { "title": "x", field: "v" } }))
                .expect_err("disallowed TodoData field");
            assert!(
                reason.contains(field),
                "reason names the unsupported field {field}: {reason}"
            );
        }
    }

    #[test]
    fn rejects_create_todo_envelope_violations() {
        // Missing todo.
        let reason = validate_todo(&json!({ "person_refs": [] })).expect_err("todo is required");
        assert!(reason.contains("todo"), "reason names todo: {reason}");
        // person_refs must be an array when present.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": "alice"
        }))
        .expect_err("person_refs must be an array");
        assert!(
            reason.contains("person_refs"),
            "reason names person_refs: {reason}"
        );
    }

    #[test]
    fn validates_create_todo_person_ref_elements() {
        // Valid: a ref with an explicit role, and a ref with role omitted (the
        // missing role is friendly — defaulted to related at apply-time).
        assert!(validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [
                { "person_id": "alice", "role": "waiting_on" },
                { "person_id": "bob" }
            ]
        }))
        .is_ok());

        // Missing person_id.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "role": "related" }]
        }))
        .expect_err("person_id is required");
        assert!(
            reason.contains("person_id"),
            "reason names missing person_id: {reason}"
        );

        // Bad role value.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "person_id": "alice", "role": "blocking" }]
        }))
        .expect_err("role must be a known enum");
        assert!(reason.contains("role"), "reason names bad role: {reason}");

        // Extra key in a ref element.
        let reason = validate_todo(&json!({
            "todo": { "title": "x" },
            "person_refs": [{ "person_id": "alice", "note": "hi" }]
        }))
        .expect_err("extra person_refs keys are rejected");
        assert!(
            reason.contains("note"),
            "reason names the unsupported ref field: {reason}"
        );
    }

    #[test]
    fn create_accepts_valid_source_journal_entry_id_and_validates_the_rest() {
        let je = Uuid::now_v7().to_string();
        // A valid source rides alongside the entity fields and the rest validates.
        assert!(validate(
            "create_person",
            &json!({ "name": "Alice", "source_journal_entry_id": je })
        )
        .is_ok());
        assert!(validate(
            "create_project",
            &json!({ "name": "Roadmap", "source_journal_entry_id": je })
        )
        .is_ok());
        assert!(validate(
            "create_todo",
            &json!({ "todo": { "title": "follow up" }, "source_journal_entry_id": je })
        )
        .is_ok());
    }

    #[test]
    fn create_rejects_non_uuid_source_journal_entry_id() {
        for kind in ["create_person", "create_project"] {
            let reason = validate(
                kind,
                &json!({ "name": "x", "source_journal_entry_id": "not-a-uuid" }),
            )
            .expect_err("source must be a UUID");
            assert!(
                reason.contains("source_journal_entry_id") && reason.contains("UUID"),
                "{kind} names the malformed source: {reason}"
            );
        }
        let reason = validate(
            "create_todo",
            &json!({ "todo": { "title": "x" }, "source_journal_entry_id": "not-a-uuid" }),
        )
        .expect_err("source must be a UUID");
        assert!(
            reason.contains("source_journal_entry_id") && reason.contains("UUID"),
            "create_todo names the malformed source: {reason}"
        );
    }

    #[test]
    fn create_person_with_only_source_still_requires_name() {
        let reason = validate(
            "create_person",
            &json!({ "source_journal_entry_id": Uuid::now_v7().to_string() }),
        )
        .expect_err("source is provenance, not a name");
        assert!(
            reason.contains("name"),
            "reason names the missing name: {reason}"
        );
    }

    #[test]
    fn render_accept_create_todo_confirms_creation() {
        let text = render_accept(
            "create_todo",
            &json!({ "todo": { "title": "Ship it", "status": "active" } }),
        );
        assert!(
            text.contains("Created Todo") && text.contains("Ship it") && text.contains("active"),
            "confirmation names the created Todo fields: {text}"
        );
    }

    #[test]
    fn update_todo_accepts_partial_todo_and_ref_ops() {
        // A partial `todo` may omit title; ref arrays + remove ids are shape-valid.
        assert!(validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": { "due_at": "2026-07-01T09:00:00" },
                "set_person_refs": [{ "person_id": "alice", "role": "related" }],
                "add_person_refs": [{ "person_id": "bob" }],
                "remove_person_ids": ["carol"]
            })
        )
        .is_ok());
        // A lone status (no completed_at) is fine for the PURE validator — the
        // invariant is checked on the merged whole at apply-time.
        assert!(validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "status": "completed" } })
        )
        .is_ok());
        // A bare todo_id (no changes) is also valid.
        assert!(validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
    }

    #[test]
    fn update_todo_requires_a_uuid_todo_id() {
        let reason = validate(
            "update_todo",
            &json!({ "todo": { "due_at": "2026-07-01T09:00:00" } }),
        )
        .expect_err("update requires a target todo_id");
        assert!(
            reason.contains("todo_id"),
            "reason names the missing todo_id: {reason}"
        );
        let reason = validate("update_todo", &json!({ "todo_id": "nope" }))
            .expect_err("todo_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed todo_id: {reason}"
        );
    }

    #[test]
    fn update_todo_rejects_unknown_top_level_key_and_bad_partial_field() {
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "entity_id": "x" }),
        )
        .expect_err("update_todo's target key is todo_id, not entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the unsupported top-level field: {reason}"
        );
        // The partial todo still rejects non-TodoData fields and a blank title.
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "on_hold": true } }),
        )
        .expect_err("todo has no on_hold field");
        assert!(
            reason.contains("on_hold"),
            "reason names the unsupported todo field: {reason}"
        );
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "title": "   " } }),
        )
        .expect_err("a supplied title must be non-empty");
        assert!(
            reason.contains("title"),
            "reason names the blank title: {reason}"
        );
    }

    #[test]
    fn update_todo_rejects_malformed_ref_ops() {
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "set_person_refs": "alice" }),
        )
        .expect_err("set_person_refs must be an array");
        assert!(
            reason.contains("set_person_refs"),
            "reason names set_person_refs: {reason}"
        );
        let reason = validate(
            "update_todo",
            &json!({ "todo_id": Uuid::now_v7().to_string(), "remove_person_ids": [""] }),
        )
        .expect_err("remove_person_ids entries must be non-empty");
        assert!(
            reason.contains("remove_person_ids"),
            "reason names remove_person_ids: {reason}"
        );
    }

    #[test]
    fn render_accept_update_todo_confirms_update() {
        let todo_id = Uuid::now_v7().to_string();
        let text = render_accept(
            "update_todo",
            &json!({ "todo_id": todo_id, "todo": { "due_at": "2026-07-01T09:00:00" } }),
        );
        assert!(
            text.contains("Updated Todo") && text.contains("todo_id="),
            "confirmation names the updated Todo target: {text}"
        );
    }

    // ─── Media (ADR-0059) ──────────────────────────────────────────────────

    #[test]
    fn accepts_minimal_media() {
        // The minimal queue entry: a title, a medium, and a backlog state — no
        // finish data (rating/finished_at are forbidden off a terminal state).
        assert!(validate_media(&json!({ "title": "Dune", "medium": "book", "state": "backlog" })).is_ok());
    }

    #[test]
    fn accepts_done_media_with_full_log_fields() {
        assert!(validate_media(&json!({
            "title": "Dune",
            "medium": "book",
            "state": "done",
            "rating": 4,
            "finished_at": "2026-01-01T00:00:00",
            "url": "https://x",
            "note": "loved it",
            "tags": ["sci-fi"]
        }))
        .is_ok());
    }

    #[test]
    fn media_rejects_finish_data_without_terminal_state() {
        // The one new behavioral rule (ADR-0059): rating + finished_at are valid
        // ONLY when state ∈ {done, abandoned}; a backlog/consuming Media carrying
        // either is rejected.
        let reason = validate_media(&json!({
            "title": "Dune",
            "medium": "book",
            "state": "backlog",
            "rating": 4
        }))
        .expect_err("a backlog Media has no finish data");
        assert!(reason.contains("rating"), "reason names rating: {reason}");

        let reason = validate_media(&json!({
            "title": "Dune",
            "medium": "movie",
            "state": "consuming",
            "finished_at": "2026-01-01T00:00:00"
        }))
        .expect_err("a consuming Media has not finished");
        assert!(
            reason.contains("finished_at"),
            "reason names finished_at: {reason}"
        );
    }

    #[test]
    fn media_accepts_finish_data_on_abandoned_state() {
        // `abandoned` is terminal too, so finish data is allowed.
        assert!(validate_media(&json!({
            "title": "Dune",
            "medium": "book",
            "state": "abandoned",
            "rating": 2,
            "finished_at": "2026-01-01T00:00:00"
        }))
        .is_ok());
    }

    #[test]
    fn media_rejects_rating_out_of_one_to_five() {
        // The 1..=5 cap is enforced in the invariant hook (PositiveInt only gates
        // `>= 1`). A done Media may carry a rating, but only 1–5.
        let reason = validate_media(&json!({
            "title": "Dune",
            "medium": "book",
            "state": "done",
            "rating": 6
        }))
        .expect_err("a rating above 5 is rejected");
        assert!(reason.contains("rating"), "reason names rating: {reason}");
    }

    #[test]
    fn media_rejects_out_of_domain_medium() {
        let reason = validate_media(&json!({ "title": "x", "medium": "podcast", "state": "backlog" }))
            .expect_err("podcast is not a known medium");
        assert!(reason.contains("medium"), "reason names medium: {reason}");
    }

    #[test]
    fn media_rejects_out_of_domain_state() {
        let reason = validate_media(&json!({ "title": "x", "medium": "link", "state": "queued" }))
            .expect_err("queued is not a known state");
        assert!(reason.contains("state"), "reason names state: {reason}");
    }

    #[test]
    fn media_rejects_missing_required_fields() {
        assert!(validate_media(&json!({ "medium": "link", "state": "backlog" })).is_err());
        assert!(validate_media(&json!({ "title": "x", "state": "backlog" })).is_err());
        assert!(validate_media(&json!({ "title": "x", "medium": "link" })).is_err());
        let reason = validate_media(&json!({ "title": "   ", "medium": "link", "state": "backlog" }))
            .expect_err("blank title is not a title");
        assert!(reason.contains("title"), "reason names title: {reason}");
    }

    #[test]
    fn media_rejects_unsupported_field() {
        let reason =
            validate_media(&json!({ "title": "x", "medium": "link", "state": "backlog", "servings": 4 }))
                .expect_err("media has no servings field");
        assert!(
            reason.contains("servings"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn accepts_null_clear_on_media_optional_fields() {
        // `null` is the ADR-0033 sentinel-clear directive on every optional field.
        assert!(validate_media(&json!({
            "title": "x",
            "medium": "link",
            "state": "done",
            "rating": null,
            "finished_at": null,
            "url": null,
            "note": null,
            "tags": null
        }))
        .is_ok());
    }

    #[test]
    fn media_rejects_non_string_url_or_note_and_bad_tags() {
        let reason = validate_media(&json!({ "title": "x", "medium": "link", "state": "backlog", "url": 42 }))
            .expect_err("url must be a string");
        assert!(reason.contains("url"), "reason names url: {reason}");
        let reason = validate_media(&json!({ "title": "x", "medium": "link", "state": "backlog", "tags": "fp" }))
            .expect_err("tags must be an array");
        assert!(reason.contains("tags"), "reason names tags: {reason}");
        let reason = validate_media(&json!({ "title": "x", "medium": "link", "state": "backlog", "tags": ["ok", "  "] }))
            .expect_err("blank tags are not allowed");
        assert!(reason.contains("tag"), "reason names the tag: {reason}");
    }

    #[test]
    fn update_media_validates_payload_minus_entity_id_and_invariant() {
        // entity_id + a valid MediaData body is ok.
        assert!(validate(
            "update_media",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x", "medium": "tv", "state": "consuming" })
        )
        .is_ok());
        // The MediaData rules still apply to the rest (no unknown field).
        let reason = validate(
            "update_media",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x", "medium": "tv", "state": "consuming", "servings": 4 }),
        )
        .expect_err("media has no servings field");
        assert!(
            reason.contains("servings"),
            "reason names the unsupported media field: {reason}"
        );
        // The state↔finish-data invariant fires over the whole merged doc on update too.
        let reason = validate(
            "update_media",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x", "medium": "tv", "state": "consuming", "rating": 5 }),
        )
        .expect_err("finish data is forbidden off a terminal state on update too");
        assert!(reason.contains("rating"), "reason names rating: {reason}");
    }

    #[test]
    fn update_media_requires_a_uuid_entity_id() {
        let reason = validate("update_media", &json!({ "title": "x", "medium": "link", "state": "backlog" }))
            .expect_err("update requires a target entity_id");
        assert!(
            reason.contains("entity_id"),
            "reason names the missing entity_id: {reason}"
        );
        let reason = validate(
            "update_media",
            &json!({ "entity_id": "nope", "title": "x", "medium": "link", "state": "backlog" }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names the malformed entity_id: {reason}"
        );
    }

    #[test]
    fn validate_delete_media_accepts_uuid_and_rejects_extras() {
        assert!(validate(
            "delete_media",
            &json!({ "entity_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
        let reason = validate(
            "delete_media",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "title": "x" }),
        )
        .expect_err("an extra field on a delete payload is unsupported");
        assert!(
            reason.contains("delete_media") && reason.contains("title"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn schema_version_media_is_one() {
        assert_eq!(schema_version("create_media"), MEDIA_SCHEMA_VERSION);
        assert_eq!(schema_version("update_media"), MEDIA_SCHEMA_VERSION);
        assert_eq!(schema_version("delete_media"), MEDIA_SCHEMA_VERSION);
        assert_eq!(schema_version("create_media"), 1);
    }

    // ─── Habit (Phase 2b) ─────────────────────────────────────────────────

    #[test]
    fn accepts_minimal_habit() {
        assert!(validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 1, "unit": "day" }
        }))
        .is_ok());
    }

    #[test]
    fn accepts_habit_with_target_status_and_note() {
        assert!(validate_habit(&json!({
            "name": "Strength training",
            "cadence": { "interval": 3, "unit": "week" },
            "target": "45 minutes",
            "status": "paused",
            "note": "restart after travel"
        }))
        .is_ok());
    }

    #[test]
    fn rejects_invalid_habit_name_cadence_status_and_target() {
        let reason = validate_habit(&json!({ "name": "Morning walk" }))
            .expect_err("cadence is required");
        assert!(reason.contains("cadence"), "reason names cadence: {reason}");

        let reason = validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 0, "unit": "day" }
        }))
        .expect_err("interval must be positive");
        assert!(
            reason.contains("interval"),
            "reason names interval: {reason}"
        );

        let reason = validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 1, "unit": "hour" }
        }))
        .expect_err("unit domain is closed");
        assert!(reason.contains("unit"), "reason names unit: {reason}");

        let reason = validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 1, "unit": "day" },
            "status": "done"
        }))
        .expect_err("status domain is closed");
        assert!(reason.contains("status"), "reason names status: {reason}");

        let reason = validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 1, "unit": "day" },
            "target": " "
        }))
        .expect_err("target must be non-empty when present");
        assert!(reason.contains("target"), "reason names target: {reason}");
    }

    #[test]
    fn accepts_null_clear_on_habit_optional_fields() {
        assert!(validate_habit(&json!({
            "name": "Morning walk",
            "cadence": { "interval": 1, "unit": "day" },
            "target": null,
            "note": null
        }))
        .is_ok());
    }

    #[test]
    fn update_habit_and_delete_habit_validate_target_id() {
        assert!(validate(
            "update_habit",
            &json!({
                "entity_id": Uuid::now_v7().to_string(),
                "name": "Morning walk",
                "cadence": { "interval": 1, "unit": "day" },
                "status": "archived"
            })
        )
        .is_ok());

        let reason = validate(
            "update_habit",
            &json!({
                "entity_id": "nope",
                "name": "Morning walk",
                "cadence": { "interval": 1, "unit": "day" }
            }),
        )
        .expect_err("entity_id must be a UUID");
        assert!(
            reason.contains("UUID"),
            "reason names malformed entity_id: {reason}"
        );

        assert!(validate(
            "delete_habit",
            &json!({ "entity_id": Uuid::now_v7().to_string() })
        )
        .is_ok());
        let reason = validate(
            "delete_habit",
            &json!({ "entity_id": Uuid::now_v7().to_string(), "name": "x" }),
        )
        .expect_err("an extra field on a delete payload is unsupported");
        assert!(
            reason.contains("delete_habit") && reason.contains("name"),
            "reason names the unsupported field: {reason}"
        );
    }

    #[test]
    fn schema_version_habit_is_one() {
        assert_eq!(schema_version("create_habit"), HABIT_SCHEMA_VERSION);
        assert_eq!(schema_version("update_habit"), HABIT_SCHEMA_VERSION);
        assert_eq!(schema_version("delete_habit"), HABIT_SCHEMA_VERSION);
        assert_eq!(schema_version("create_habit"), 1);
    }

    // ─── recurrence rule (ADR-0037) ────────────────────────────────────────

    /// A `create_todo` envelope carrying a Todo with both anchor dates present
    /// (so any `anchor` choice satisfies anchor-presence) plus the given rule.
    fn todo_with_recurrence(recurrence: Value) -> Value {
        json!({
            "todo": {
                "title": "water the plants",
                "defer_at": "2026-06-14T09:00:00",
                "due_at": "2026-06-14T18:00:00",
                "recurrence": recurrence
            }
        })
    }

    #[test]
    fn accepts_recurrence_rules() {
        // The slimmed shape (ADR-0039): interval + unit across all six units, both
        // anchors, and the two end conditions.
        let rules = [
            json!({ "interval": 1, "unit": "minute", "anchor": "due_at" }),
            json!({ "interval": 2, "unit": "hour", "anchor": "due_at" }),
            json!({ "interval": 3, "unit": "day", "anchor": "defer_at" }),
            json!({ "interval": 1, "unit": "week", "anchor": "due_at" }),
            json!({ "interval": 6, "unit": "month", "anchor": "due_at" }),
            json!({ "interval": 1, "unit": "year", "anchor": "defer_at" }),
            // end via until.
            json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "until": "2026-12-31T23:59:59" }
            }),
            // end via after_count.
            json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "after_count": 10 }
            }),
        ];
        for rule in rules {
            assert!(
                validate("create_todo", &todo_with_recurrence(rule.clone())).is_ok(),
                "valid recurrence rule should be accepted: {rule}"
            );
        }
    }

    #[test]
    fn rejects_recurrence_invariant_violations() {
        // Each entry: (rule, substring the reason must contain). The Todo carries
        // both anchor dates so only the rule's own invariant trips.
        let cases: [(Value, &str); 8] = [
            // interval must be an integer >= 1.
            (
                json!({ "interval": 0, "unit": "day", "anchor": "due_at" }),
                "interval",
            ),
            (
                json!({ "interval": 1.5, "unit": "day", "anchor": "due_at" }),
                "interval",
            ),
            // unit must be one of the six.
            (
                json!({ "interval": 1, "unit": "fortnight", "anchor": "due_at" }),
                "unit",
            ),
            // anchor enum.
            (
                json!({ "interval": 1, "unit": "day", "anchor": "planned_at" }),
                "anchor",
            ),
            // anchor is required.
            (json!({ "interval": 1, "unit": "day" }), "anchor"),
            // end carrying both keys.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": { "until": "2026-12-31T23:59:59", "after_count": 5 }
                }),
                "end",
            ),
            // end.until unparseable.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": { "until": "next year" }
                }),
                "until",
            ),
            // empty end object.
            (
                json!({
                    "interval": 1, "unit": "day", "anchor": "due_at",
                    "end": {}
                }),
                "end",
            ),
        ];
        for (rule, needle) in cases {
            let reason = validate("create_todo", &todo_with_recurrence(rule.clone()))
                .expect_err("invalid recurrence rule should be rejected");
            assert!(
                reason.contains(needle),
                "reason should name {needle:?}: {reason} (rule {rule})"
            );
        }
    }

    #[test]
    fn rejects_removed_recurrence_fields() {
        // schedule/catch_up/only_on were removed from the durable shape (ADR-0039
        // amendment). A rule carrying any of them is now an unknown-field error —
        // proves a stored/proposed rule can't smuggle a dead field back in.
        for field in ["schedule", "catch_up", "only_on"] {
            let mut rule = serde_json::Map::new();
            rule.insert("interval".into(), json!(1));
            rule.insert("unit".into(), json!("week"));
            rule.insert("anchor".into(), json!("due_at"));
            rule.insert(field.into(), json!("regular"));
            let reason = validate("create_todo", &todo_with_recurrence(Value::Object(rule)))
                .expect_err("a removed recurrence field is rejected as unknown");
            assert!(
                reason.contains(field),
                "reason names the removed field {field:?}: {reason}"
            );
        }
    }

    #[test]
    fn rejects_recurrence_unknown_fields() {
        // Unknown key on the rule and on end.
        let reason = validate(
            "create_todo",
            &todo_with_recurrence(json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "timezone": "UTC"
            })),
        )
        .expect_err("unknown recurrence field is rejected");
        assert!(
            reason.contains("timezone"),
            "names the unknown field: {reason}"
        );

        let reason = validate(
            "create_todo",
            &todo_with_recurrence(json!({
                "interval": 1, "unit": "day", "anchor": "due_at",
                "end": { "after_count": 3, "grace": 1 }
            })),
        )
        .expect_err("unknown end field is rejected");
        assert!(
            reason.contains("grace"),
            "names the unknown end field: {reason}"
        );
    }

    #[test]
    fn rejects_recurrence_anchor_naming_an_absent_date() {
        // anchor names due_at but the Todo has only defer_at → rejected as a
        // cross-field check against the whole Todo.
        let reason = validate(
            "create_todo",
            &json!({
                "todo": {
                    "title": "water the plants",
                    "defer_at": "2026-06-14T09:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "day", "anchor": "due_at"
                    }
                }
            }),
        )
        .expect_err("anchor must name a date the Todo has");
        assert!(
            reason.contains("anchor") && reason.contains("due_at"),
            "reason names the missing anchor date: {reason}"
        );
        // The mirror: anchor defer_at with only due_at present.
        let reason = validate(
            "create_todo",
            &json!({
                "todo": {
                    "title": "water the plants",
                    "due_at": "2026-06-14T18:00:00",
                    "recurrence": {
                        "interval": 1, "unit": "day", "anchor": "defer_at"
                    }
                }
            }),
        )
        .expect_err("anchor must name a date the Todo has");
        assert!(
            reason.contains("anchor") && reason.contains("defer_at"),
            "reason names the missing anchor date: {reason}"
        );
    }

    #[test]
    fn update_todo_partial_accepts_recurrence_and_null_clear() {
        // A supplied valid rule is accepted; `null` is the sentinel-clear directive
        // (ADR-0037). The anchor-presence cross-check is NOT done here — the partial
        // lacks the whole Todo; the merged-whole re-validation in apply enforces it.
        assert!(validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at"
                    }
                }
            })
        )
        .is_ok());
        assert!(
            validate(
                "update_todo",
                &json!({ "todo_id": Uuid::now_v7().to_string(), "todo": { "recurrence": null } })
            )
            .is_ok(),
            "recurrence: null is the sentinel-clear directive"
        );
    }

    #[test]
    fn update_todo_partial_rejects_invalid_recurrence_rule() {
        // The standalone rule check still runs on a supplied (non-null) rule.
        let reason = validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "fortnight", "anchor": "due_at"
                    }
                }
            }),
        )
        .expect_err("an invalid unit is rejected in the partial");
        assert!(
            reason.contains("unit"),
            "reason names the bad unit: {reason}"
        );
        // A removed field (only_on) is an unknown-field error in the partial too.
        let reason = validate(
            "update_todo",
            &json!({
                "todo_id": Uuid::now_v7().to_string(),
                "todo": {
                    "recurrence": {
                        "interval": 1, "unit": "week", "anchor": "due_at",
                        "only_on": { "weekdays": ["mon"] }
                    }
                }
            }),
        )
        .expect_err("a removed recurrence field is rejected in the partial");
        assert!(reason.contains("only_on"), "reason names only_on: {reason}");
    }
}
