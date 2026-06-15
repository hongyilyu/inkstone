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
use crate::mutation::{self, EntityType, MutationKind};

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
    kind: MutationKind,
    payload: &serde_json::Value,
) -> Result<(), TargetError> {
    // A create carrying `source_journal_entry_id` (ADR-0030/0031) must reference a
    // Canonical Journal Entry; an absent field is fine (the Entity is then sourced
    // from the user Message on the agent path, or unsourced on the user path).
    if matches!(
        kind,
        MutationKind::CreatePerson | MutationKind::CreateProject | MutationKind::CreateTodo
    ) && let Some(journal_entry_id) = entities::source_journal_entry_id(payload)
    {
        let is_journal_entry =
            db::entity_is_type(pool, journal_entry_id, EntityType::JournalEntry.as_str())
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
    if kind == MutationKind::CreateTodo {
        let project_id = payload
            .get("todo")
            .and_then(|todo| todo.get("project_id"))
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(project_id) = project_id {
            let is_project = db::entity_is_type(pool, project_id, EntityType::Project.as_str())
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
                let is_person = db::entity_is_type(pool, person_id, EntityType::Person.as_str())
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
    if kind == MutationKind::UpdateTodo {
        let todo_id = mutation::target_entity_id(kind.describe(), payload).ok_or_else(|| {
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
            Some(actual) if actual != EntityType::Todo => {
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
                let is_person = db::entity_is_type(pool, person_id, EntityType::Person.as_str())
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
            let is_project = db::entity_is_type(pool, project_id, EntityType::Project.as_str())
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

    // An update/delete's `entity_id` must reference a Canonical Entity of the
    // matching type. These kinds use this simple pool-level type/existence check;
    // the target TYPE is the kind's own Entity Type (`desc.entity_type`). The
    // journal update/delete kinds are included here too: this run-INDEPENDENT
    // check is the only target validation the user path (`mutate`) has, and on the
    // agent path it runs BEFORE — not instead of — the stricter same-thread guard
    // in `decide` (which still fires for a correct-type Journal Entry). It also
    // disambiguates a wrong-TYPE journal target (e.g. a Person id) as `Invalid`
    // rather than letting `decide`'s existence probe report it as target-missing.
    //
    // NOT routed here: the create kinds returned earlier (nothing to resolve);
    // update_todo / the reference weave have their own branches above/below.
    let generic_type_check = matches!(
        kind,
        MutationKind::UpdateJournalEntry
            | MutationKind::DeleteJournalEntry
            | MutationKind::UpdatePerson
            | MutationKind::DeletePerson
            | MutationKind::UpdateProject
            | MutationKind::DeleteProject
            | MutationKind::MarkProjectReviewed
            | MutationKind::DeleteTodo
            | MutationKind::UpdateBookmark
            | MutationKind::DeleteBookmark
    );
    if generic_type_check {
        let target_type = kind.describe().entity_type;
        let wire = kind.as_wire();
        let entity_id = mutation::target_entity_id(kind.describe(), payload)
            .ok_or_else(|| TargetError::Invalid(format!("entity_id is required for {wire}")))?;
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
                    "{wire} target no longer references an Accepted {}",
                    target_type.as_str()
                )));
            }
            Some(actual) if actual != target_type => {
                return Err(TargetError::Invalid(format!(
                    "{wire} target must reference an Accepted {}",
                    target_type.as_str()
                )));
            }
            Some(_) => {}
        }
        return Ok(());
    }

    // reference_existing_entity_from_journal_entry: its `target_entity_id` must
    // name an existing Canonical Entity of a referenceable type (person/project/
    // todo), and its `source_entity_id` must name an existing Journal Entry (the
    // PRIMARY anchor the reference is woven into). The source-Journal-Entry
    // same-thread guard is run-coupled and stays in `decide`.
    if kind == MutationKind::ReferenceExistingEntityFromJournalEntry {
        // Validate the source Journal Entry (the primary anchor) FIRST: the apply
        // path inserts into `entity_refs` keyed on `source_entity_id` before it
        // loads the source JE, so a deleted source trips the FK → an opaque
        // internal error. A GONE source is a delete-race on the primary anchor
        // (TargetMissing → NotDecidable on the accept path); a wrong-TYPE source
        // is a payload error (Invalid).
        //
        // This pool-level read is sufficient (no in-tx re-check needed) because the
        // pool is `max_connections(1)` (see `db::open`): every write path runs on
        // the single shared, serialized connection, so no concurrent transaction
        // can delete the source/target between this check and the `entity_refs`
        // insert. It closes the validate→apply gap for THIS mutation, not a race
        // against another writer (there is none).
        let source_entity_id =
            mutation::target_entity_id(kind.describe(), payload).ok_or_else(|| {
                TargetError::Invalid(
                    "source_entity_id is required for reference_existing_entity_from_journal_entry"
                        .to_string(),
                )
            })?;
        match db::entity_type_by_id(pool, source_entity_id)
            .await
            .map_err(|e| TargetError::Internal(e.into()))?
        {
            None => {
                return Err(TargetError::TargetMissing(
                    "reference source_entity_id no longer references an Accepted Journal Entry"
                        .to_string(),
                ));
            }
            Some(actual) if actual != EntityType::JournalEntry => {
                return Err(TargetError::Invalid(
                    "reference source_entity_id must reference an Accepted Journal Entry"
                        .to_string(),
                ));
            }
            Some(_) => {}
        }

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
        if !target_type.is_referenceable() {
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
