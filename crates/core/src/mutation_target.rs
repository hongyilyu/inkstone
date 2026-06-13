//! Run-INDEPENDENT target-reference validation shared by the agent path
//! (`decide`) and the user path (`mutate`) (ADR-0033).
//!
//! These checks resolve a mutation's referenced Entities against tier 2 — a
//! create's `source_journal_entry_id` anchor, a Todo's `project_id`/person refs,
//! an update/delete target's type — and need no Run, Thread, or Proposal
//! context. The SAME-THREAD JOURNAL GUARD (a Journal Entry update/delete, or a
//! reference's source Journal Entry, must be in the current Thread) is keyed on
//! `run_id` and stays in `decide` only; this module deliberately omits it.

use sqlx::SqlitePool;

use crate::db;
use crate::entities;

/// A run-independent target-validation failure.
///
/// - `TargetMissing` — the PRIMARY target of an update/delete (the Entity the
///   mutation operates ON) no longer exists. On the agent accept path this is a
///   user having deleted the Entity out from under a parked Proposal (ADR-0033);
///   `decide` maps it to `NotDecidable` (-32002) so the Run resolves cleanly. A
///   bad REFERENCED Entity stays `Invalid` (it is a payload error, not "the thing
///   I'm editing vanished").
/// - `Invalid` — the client-facing payload reason (a bad reference, or a missing
///   required target id).
/// - `Internal` — a DB fault.
///
/// Each caller maps these into its own vocabulary (`DecideError`/`MutateError`).
#[derive(Debug)]
pub(crate) enum TargetError {
    TargetMissing(String),
    Invalid(String),
    Internal(anyhow::Error),
}

/// Validate a mutation's referenced Entities (ADR-0030/0031/0033), dispatched on
/// `mutation_kind`. Run-independent only — the same-thread Journal guard is the
/// caller's (`decide`'s) responsibility. Checked BEFORE apply so a bad reference
/// writes nothing.
pub(crate) async fn validate_mutation_target_refs(
    pool: &SqlitePool,
    mutation_kind: &str,
    payload: &serde_json::Value,
) -> Result<(), TargetError> {
    // A create carrying `source_journal_entry_id` (ADR-0030/0031) must reference a
    // Canonical Journal Entry; an absent field is fine (the Entity is then sourced
    // from the user Message on the agent path, or unsourced on the user path).
    if matches!(mutation_kind, "create_person" | "create_project" | "create_todo")
        && let Some(journal_entry_id) = entities::source_journal_entry_id(payload)
    {
        let is_journal_entry = db::entity_is_type(pool, journal_entry_id, "journal_entry")
            .await
            .map_err(|e| TargetError::Internal(e.into()))?;
        if !is_journal_entry {
            return Err(TargetError::Invalid(
                "source_journal_entry_id must reference an Accepted Journal Entry".to_string(),
            ));
        }
    }

    // A create_todo's `todo.project_id`, when present, must reference a Canonical
    // Project; an absent project_id is fine (a standalone Todo).
    if mutation_kind == "create_todo" {
        let project_id = payload
            .get("todo")
            .and_then(|todo| todo.get("project_id"))
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(project_id) = project_id {
            let is_project = db::entity_is_type(pool, project_id, "project")
                .await
                .map_err(|e| TargetError::Internal(e.into()))?;
            if !is_project {
                return Err(TargetError::Invalid(
                    "create_todo project_id must reference an Accepted Project".to_string(),
                ));
            }
        }
        // Every person_refs[].person_id must reference a Canonical Person; a bad
        // one fails the whole mutation (-32602) before any write.
        if let Some(person_refs) = payload
            .get("person_refs")
            .and_then(serde_json::Value::as_array)
        {
            for person_ref in person_refs {
                let Some(person_id) = person_ref
                    .get("person_id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                let is_person = db::entity_is_type(pool, person_id, "person")
                    .await
                    .map_err(|e| TargetError::Internal(e.into()))?;
                if !is_person {
                    return Err(TargetError::Invalid(
                        "create_todo person_refs person_id must reference an Accepted Person"
                            .to_string(),
                    ));
                }
            }
        }
        return Ok(());
    }

    // update_todo: `todo_id` must reference a Canonical Todo; each person_id in
    // set_person_refs/add_person_refs must reference a Canonical Person; a
    // supplied `todo.project_id` (the partial may set it) must reference a
    // Canonical Project. All checked BEFORE apply so a bad ref/target writes
    // nothing.
    if mutation_kind == "update_todo" {
        let todo_id = entities::target_entity_id(mutation_kind, payload).ok_or_else(|| {
            TargetError::Invalid("todo_id is required for update_todo".to_string())
        })?;
        match db::entity_type_by_id(pool, todo_id)
            .await
            .map_err(|e| TargetError::Internal(e.into()))?
        {
            // The Todo being edited is GONE — a primary-target miss, not a payload
            // error (TargetMissing → NotDecidable on the accept path, ADR-0033).
            None => {
                return Err(TargetError::TargetMissing(
                    "update_todo todo_id no longer references an Accepted Todo".to_string(),
                ));
            }
            // The id resolves to a non-Todo Entity — a genuine payload error.
            Some(actual) if actual != "todo" => {
                return Err(TargetError::Invalid(
                    "update_todo todo_id must reference an Accepted Todo".to_string(),
                ));
            }
            Some(_) => {}
        }

        for field in ["set_person_refs", "add_person_refs"] {
            let Some(refs) = payload.get(field).and_then(serde_json::Value::as_array) else {
                continue;
            };
            for person_ref in refs {
                let Some(person_id) = person_ref
                    .get("person_id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                let is_person = db::entity_is_type(pool, person_id, "person")
                    .await
                    .map_err(|e| TargetError::Internal(e.into()))?;
                if !is_person {
                    return Err(TargetError::Invalid(
                        "update_todo person_refs person_id must reference an Accepted Person"
                            .to_string(),
                    ));
                }
            }
        }

        let project_id = payload
            .get("todo")
            .and_then(|todo| todo.get("project_id"))
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(project_id) = project_id {
            let is_project = db::entity_is_type(pool, project_id, "project")
                .await
                .map_err(|e| TargetError::Internal(e.into()))?;
            if !is_project {
                return Err(TargetError::Invalid(
                    "update_todo project_id must reference an Accepted Project".to_string(),
                ));
            }
        }
        return Ok(());
    }

    // An update_person/update_project or delete_person/delete_todo's `entity_id`
    // must reference a Canonical Entity of the matching type. These use this simple
    // type check; journal entries keep the stricter same-thread guard in `decide`
    // (delete_journal_entry included).
    if let Some(target_type) = match mutation_kind {
        "update_person" | "delete_person" => Some("person"),
        "update_project" | "delete_project" => Some("project"),
        "delete_todo" => Some("todo"),
        _ => None,
    } {
        let entity_id = entities::target_entity_id(mutation_kind, payload).ok_or_else(|| {
            TargetError::Invalid(format!("entity_id is required for {mutation_kind}"))
        })?;
        match db::entity_type_by_id(pool, entity_id)
            .await
            .map_err(|e| TargetError::Internal(e.into()))?
        {
            // The Entity being updated/deleted is GONE — a primary-target miss, not
            // a payload error (TargetMissing → NotDecidable on the accept path,
            // ADR-0033). A wrong-TYPE id (e.g. delete_person against a Todo) still
            // resolves to a row, so it stays Invalid below.
            None => {
                return Err(TargetError::TargetMissing(format!(
                    "{mutation_kind} target no longer references an Accepted {target_type}"
                )));
            }
            Some(actual) if actual != target_type => {
                return Err(TargetError::Invalid(format!(
                    "{mutation_kind} target must reference an Accepted {target_type}"
                )));
            }
            Some(_) => {}
        }
        return Ok(());
    }

    // reference_existing_entity_from_journal_entry: its `target_entity_id` must
    // name an existing Canonical Entity of a referenceable type (person/project/
    // todo). The source-Journal-Entry same-thread guard is run-coupled and stays
    // in `decide`.
    if mutation_kind == "reference_existing_entity_from_journal_entry" {
        let target_entity_id = entities::reference_target_entity_id(payload).ok_or_else(|| {
            TargetError::Invalid(
                "target_entity_id is required for reference_existing_entity_from_journal_entry"
                    .to_string(),
            )
        })?;
        let Some(target_type) = db::entity_type_by_id(pool, target_entity_id)
            .await
            .map_err(|e| TargetError::Internal(e.into()))?
        else {
            return Err(TargetError::Invalid(
                "target_entity_id must be an existing accepted Entity".to_string(),
            ));
        };
        if !matches!(target_type.as_str(), "person" | "project" | "todo") {
            return Err(TargetError::Invalid(
                "target_entity_id must be a person, project, or todo".to_string(),
            ));
        }
        return Ok(());
    }

    // Remaining kinds (create_journal_entry, update_journal_entry,
    // delete_journal_entry) carry no run-independent target reference here:
    // create has nothing to resolve, and the journal update/delete target is
    // validated by the same-thread guard in `decide`.
    Ok(())
}
