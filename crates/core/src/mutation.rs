//! The Entity-Type taxonomy (ADR-0016, ADR-0025, CONTEXT.md "Entity Type").
//!
//! The wire `mutation_kind` string is resolved ONCE, at each write-path edge,
//! into the closed [`MutationKind`] enum; everything downstream branches on the
//! typed value so a missed case is a compile error, not a runtime panic. The
//! per-kind *classification + policy* — operation class, Entity Type, target-id
//! key, source relation, agent-proposability — lives here as one [`describe`]
//! table plus a handful of total predicates. The per-kind *apply behaviour* that
//! needs committed DB state stays behind the transaction seam in
//! [`crate::db::apply`]; this module is pure and DB-free.
//!
//! Two enums, one wide and one narrow:
//! - [`MutationKind`] — all 17 Core-known kinds. The currency of `validate`,
//!   `mutate`, `apply`, and the target-reference checks.
//! - [`ProposableMutation`] — the 13 the agent may propose (ADR-0018). Carries
//!   the agent-path-only facets (`render_accept`, `supports_edit`,
//!   `carries_review_context`) so they are total over exactly the kinds that can
//!   reach the accept path — no `unreachable!` for the 4 user-only kinds.

use serde_json::Value;

/// The schema version stamped onto a freshly-created Journal Entry + its first
/// revision.
pub const JOURNAL_ENTRY_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Person + its first revision.
pub const PERSON_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Project + its first revision.
pub const PROJECT_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Todo + its first revision.
pub const TODO_SCHEMA_VERSION: i64 = 1;

/// The schema version stamped onto a freshly-created Bookmark + its first
/// revision (ADR-0036).
pub const BOOKMARK_SCHEMA_VERSION: i64 = 1;

/// The write-class of a `mutation_kind`. Every mutation is a write — reads
/// (`entity/list`, `search_entities`, `proposal/get`) carry no `mutation_kind`
/// and are a separate surface — so there is deliberately no `Read` variant.
/// Replaces the `is_create`/`is_update`/`is_delete` predicate trio.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WriteOp {
    /// Mint a new Entity id (a `create_*`).
    Create,
    /// Write a new revision of an existing Entity (an `update_*`, the reference
    /// weave, and `mark_project_reviewed`).
    Update,
    /// Remove an existing Entity (a `delete_*`).
    Delete,
}

impl WriteOp {
    /// The provenance relation a `created_from`/`updated_from` Entity Source row
    /// carries on the agent path (ADR-0030/0031). A pure function of the write
    /// class: a create sources `created_from`, an in-place write `updated_from`,
    /// a delete writes no Entity (so no source). Only consumed on the agent path
    /// (`apply_proposal`); the user path writes no source row.
    pub(crate) fn source_relation(self) -> Option<SourceRelation> {
        match self {
            WriteOp::Create => Some(SourceRelation::CreatedFrom),
            WriteOp::Update => Some(SourceRelation::UpdatedFrom),
            WriteOp::Delete => None,
        }
    }
}

/// The Entity Source provenance relation (ADR-0030/0031): which direction a
/// `created_from`/`updated_from` row points. Stored as the `entity_sources.relation`
/// string via [`SourceRelation::as_str`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SourceRelation {
    CreatedFrom,
    UpdatedFrom,
}

impl SourceRelation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SourceRelation::CreatedFrom => "created_from",
            SourceRelation::UpdatedFrom => "updated_from",
        }
    }
}

/// The kind of structured concept an Entity is (CONTEXT.md "Entity Type"):
/// determines how its content is validated, versioned, and described back to the
/// Worker. The stored `entities.type` column value (via [`EntityType::as_str`])
/// and the home of the per-type schema version.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum EntityType {
    JournalEntry,
    Person,
    Project,
    Todo,
    Bookmark,
}

impl EntityType {
    /// The stored `entities.type` value. Bound into SQL and compared against
    /// rows read back by [`crate::db::entity_type_by_id`].
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            EntityType::JournalEntry => "journal_entry",
            EntityType::Person => "person",
            EntityType::Project => "project",
            EntityType::Todo => "todo",
            EntityType::Bookmark => "bookmark",
        }
    }

    /// The schema version to stamp onto a freshly-created Entity of this type +
    /// its first revision.
    pub(crate) fn schema_version(self) -> i64 {
        match self {
            EntityType::JournalEntry => JOURNAL_ENTRY_SCHEMA_VERSION,
            EntityType::Person => PERSON_SCHEMA_VERSION,
            EntityType::Project => PROJECT_SCHEMA_VERSION,
            EntityType::Todo => TODO_SCHEMA_VERSION,
            EntityType::Bookmark => BOOKMARK_SCHEMA_VERSION,
        }
    }

    /// Parse a stored `entities.type` value. `None` for an unknown string — the
    /// caller decides whether that is a data fault (the stored column has no
    /// CHECK constraint) or merely a type that fails an equality check.
    pub(crate) fn from_str(s: &str) -> Option<Self> {
        match s {
            "journal_entry" => Some(EntityType::JournalEntry),
            "person" => Some(EntityType::Person),
            "project" => Some(EntityType::Project),
            "todo" => Some(EntityType::Todo),
            "bookmark" => Some(EntityType::Bookmark),
            _ => None,
        }
    }

    /// Whether a Journal Entry body may reference this Entity Type (ADR-0030):
    /// People, Projects, and Todos are referenceable; Journal Entries and
    /// Bookmarks are not. A new Entity Type must declare its referenceability
    /// here (the match is total).
    pub(crate) fn is_referenceable(self) -> bool {
        match self {
            EntityType::Person | EntityType::Project | EntityType::Todo => true,
            EntityType::JournalEntry | EntityType::Bookmark => false,
        }
    }
}

/// Which top-level payload key names the target Entity of a mutation. A pure
/// function of the kind (resolved in [`describe`]); the value is read FROM the
/// payload at the edge via [`crate::entities::target_entity_id`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum TargetKey {
    /// `entity_id` — the common update/delete target key.
    EntityId,
    /// `todo_id` — `update_todo`'s target key (its envelope wraps a
    /// `Partial<TodoData>` under `todo`, so the id lives at `todo_id`).
    TodoId,
    /// `source_entity_id` — the Journal Entry a reference is woven into.
    SourceEntityId,
}

impl TargetKey {
    /// The JSON payload key this target id is read from.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TargetKey::EntityId => "entity_id",
            TargetKey::TodoId => "todo_id",
            TargetKey::SourceEntityId => "source_entity_id",
        }
    }
}

/// The path-independent classification + policy of a `mutation_kind` — the facets
/// both write paths (agent `decide`, user `mutate`) share. Resolved once via
/// [`MutationKind::describe`]; `Copy` so it threads cheaply.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Descriptor {
    /// Create / update / delete — drives entity-id derivation and the apply
    /// branch shape.
    pub(crate) write_op: WriteOp,
    /// The Entity Type this kind mutates — the stored `entities.type` and the
    /// home of the schema version.
    pub(crate) entity_type: EntityType,
    /// Which payload key holds the target id, or `None` for a create (which
    /// mints a fresh id and targets nothing).
    pub(crate) target_key: Option<TargetKey>,
}

/// Every Core-known Workspace mutation kind (ADR-0016, ADR-0025, ADR-0036). The
/// closed taxonomy: 13 are agent-proposable (see [`ProposableMutation`]); the
/// other 4 (`mark_project_reviewed` + the three bookmark kinds) are user-CRUD-only.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MutationKind {
    CreateJournalEntry,
    UpdateJournalEntry,
    DeleteJournalEntry,
    ReferenceExistingEntityFromJournalEntry,
    CreatePerson,
    UpdatePerson,
    DeletePerson,
    CreateProject,
    UpdateProject,
    DeleteProject,
    MarkProjectReviewed,
    CreateTodo,
    UpdateTodo,
    DeleteTodo,
    CreateBookmark,
    UpdateBookmark,
    DeleteBookmark,
}

impl MutationKind {
    /// Resolve the wire `mutation_kind` string into the closed enum. `None` for
    /// an unknown string — the SINGLE string→type point on each write path. The
    /// user path maps `None` to a client `Invalid`; the agent path (a stored,
    /// already-validated `proposals.mutation_kind`) maps it to `Internal`.
    pub(crate) fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "create_journal_entry" => MutationKind::CreateJournalEntry,
            "update_journal_entry" => MutationKind::UpdateJournalEntry,
            "delete_journal_entry" => MutationKind::DeleteJournalEntry,
            "reference_existing_entity_from_journal_entry" => {
                MutationKind::ReferenceExistingEntityFromJournalEntry
            }
            "create_person" => MutationKind::CreatePerson,
            "update_person" => MutationKind::UpdatePerson,
            "delete_person" => MutationKind::DeletePerson,
            "create_project" => MutationKind::CreateProject,
            "update_project" => MutationKind::UpdateProject,
            "delete_project" => MutationKind::DeleteProject,
            "mark_project_reviewed" => MutationKind::MarkProjectReviewed,
            "create_todo" => MutationKind::CreateTodo,
            "update_todo" => MutationKind::UpdateTodo,
            "delete_todo" => MutationKind::DeleteTodo,
            "create_bookmark" => MutationKind::CreateBookmark,
            "update_bookmark" => MutationKind::UpdateBookmark,
            "delete_bookmark" => MutationKind::DeleteBookmark,
            _ => return None,
        })
    }

    /// The wire `mutation_kind` string for this kind. Used for diagnostics and
    /// the `ProposableMutation` ↔ `Input` schema round-trip test.
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            MutationKind::CreateJournalEntry => "create_journal_entry",
            MutationKind::UpdateJournalEntry => "update_journal_entry",
            MutationKind::DeleteJournalEntry => "delete_journal_entry",
            MutationKind::ReferenceExistingEntityFromJournalEntry => {
                "reference_existing_entity_from_journal_entry"
            }
            MutationKind::CreatePerson => "create_person",
            MutationKind::UpdatePerson => "update_person",
            MutationKind::DeletePerson => "delete_person",
            MutationKind::CreateProject => "create_project",
            MutationKind::UpdateProject => "update_project",
            MutationKind::DeleteProject => "delete_project",
            MutationKind::MarkProjectReviewed => "mark_project_reviewed",
            MutationKind::CreateTodo => "create_todo",
            MutationKind::UpdateTodo => "update_todo",
            MutationKind::DeleteTodo => "delete_todo",
            MutationKind::CreateBookmark => "create_bookmark",
            MutationKind::UpdateBookmark => "update_bookmark",
            MutationKind::DeleteBookmark => "delete_bookmark",
        }
    }

    /// The single home of the path-independent taxonomy: one row per kind. A new
    /// Entity Type adds one arm here and the compiler flags every consumer.
    pub(crate) fn describe(self) -> Descriptor {
        use EntityType as E;
        use MutationKind as M;
        use TargetKey as K;
        use WriteOp as W;
        match self {
            M::CreateJournalEntry => Descriptor {
                write_op: W::Create,
                entity_type: E::JournalEntry,
                target_key: None,
            },
            M::UpdateJournalEntry => Descriptor {
                write_op: W::Update,
                entity_type: E::JournalEntry,
                target_key: Some(K::EntityId),
            },
            M::DeleteJournalEntry => Descriptor {
                write_op: W::Delete,
                entity_type: E::JournalEntry,
                target_key: Some(K::EntityId),
            },
            // The reference weave writes a new revision of the SOURCE Journal
            // Entry (its body gains the entity_ref), so it is an Update whose
            // target key is `source_entity_id`.
            M::ReferenceExistingEntityFromJournalEntry => Descriptor {
                write_op: W::Update,
                entity_type: E::JournalEntry,
                target_key: Some(K::SourceEntityId),
            },
            M::CreatePerson => Descriptor {
                write_op: W::Create,
                entity_type: E::Person,
                target_key: None,
            },
            M::UpdatePerson => Descriptor {
                write_op: W::Update,
                entity_type: E::Person,
                target_key: Some(K::EntityId),
            },
            M::DeletePerson => Descriptor {
                write_op: W::Delete,
                entity_type: E::Person,
                target_key: Some(K::EntityId),
            },
            M::CreateProject => Descriptor {
                write_op: W::Create,
                entity_type: E::Project,
                target_key: None,
            },
            M::UpdateProject => Descriptor {
                write_op: W::Update,
                entity_type: E::Project,
                target_key: Some(K::EntityId),
            },
            M::DeleteProject => Descriptor {
                write_op: W::Delete,
                entity_type: E::Project,
                target_key: Some(K::EntityId),
            },
            // A read-modify-write of the Project's review fields (ADR-0034): an
            // Update targeting `entity_id`.
            M::MarkProjectReviewed => Descriptor {
                write_op: W::Update,
                entity_type: E::Project,
                target_key: Some(K::EntityId),
            },
            M::CreateTodo => Descriptor {
                write_op: W::Create,
                entity_type: E::Todo,
                target_key: None,
            },
            // update_todo's target key is `todo_id` (its envelope wraps a
            // Partial<TodoData> under `todo`), NOT `entity_id`.
            M::UpdateTodo => Descriptor {
                write_op: W::Update,
                entity_type: E::Todo,
                target_key: Some(K::TodoId),
            },
            M::DeleteTodo => Descriptor {
                write_op: W::Delete,
                entity_type: E::Todo,
                target_key: Some(K::EntityId),
            },
            M::CreateBookmark => Descriptor {
                write_op: W::Create,
                entity_type: E::Bookmark,
                target_key: None,
            },
            M::UpdateBookmark => Descriptor {
                write_op: W::Update,
                entity_type: E::Bookmark,
                target_key: Some(K::EntityId),
            },
            M::DeleteBookmark => Descriptor {
                write_op: W::Delete,
                entity_type: E::Bookmark,
                target_key: Some(K::EntityId),
            },
        }
    }
}

/// The agent-proposable subset (ADR-0018): the 13 kinds the Worker may emit via
/// `propose_workspace_mutation`. Carries the agent-path-only facets so each is
/// total over exactly the kinds that can reach the accept path — the 4 user-only
/// kinds (`mark_project_reviewed`, the bookmarks) are simply not in the type.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ProposableMutation {
    CreateJournalEntry,
    UpdateJournalEntry,
    DeleteJournalEntry,
    ReferenceExistingEntityFromJournalEntry,
    CreatePerson,
    UpdatePerson,
    DeletePerson,
    CreateProject,
    UpdateProject,
    DeleteProject,
    CreateTodo,
    UpdateTodo,
    DeleteTodo,
}

impl ProposableMutation {
    /// Every agent-proposable kind, in wire order. Powers the exhaustive
    /// predicates' tests and the `Input` schema round-trip check; test-only, so
    /// it does not warn as unused in a normal build.
    #[cfg(test)]
    pub(crate) const ALL: [ProposableMutation; 13] = [
        ProposableMutation::CreateJournalEntry,
        ProposableMutation::UpdateJournalEntry,
        ProposableMutation::DeleteJournalEntry,
        ProposableMutation::ReferenceExistingEntityFromJournalEntry,
        ProposableMutation::CreatePerson,
        ProposableMutation::UpdatePerson,
        ProposableMutation::DeletePerson,
        ProposableMutation::CreateProject,
        ProposableMutation::UpdateProject,
        ProposableMutation::DeleteProject,
        ProposableMutation::CreateTodo,
        ProposableMutation::UpdateTodo,
        ProposableMutation::DeleteTodo,
    ];

    /// Widen to the full [`MutationKind`] — infallible, so the shared
    /// [`Descriptor`] and `as_wire` are one hop away.
    pub(crate) fn kind(self) -> MutationKind {
        match self {
            ProposableMutation::CreateJournalEntry => MutationKind::CreateJournalEntry,
            ProposableMutation::UpdateJournalEntry => MutationKind::UpdateJournalEntry,
            ProposableMutation::DeleteJournalEntry => MutationKind::DeleteJournalEntry,
            ProposableMutation::ReferenceExistingEntityFromJournalEntry => {
                MutationKind::ReferenceExistingEntityFromJournalEntry
            }
            ProposableMutation::CreatePerson => MutationKind::CreatePerson,
            ProposableMutation::UpdatePerson => MutationKind::UpdatePerson,
            ProposableMutation::DeletePerson => MutationKind::DeletePerson,
            ProposableMutation::CreateProject => MutationKind::CreateProject,
            ProposableMutation::UpdateProject => MutationKind::UpdateProject,
            ProposableMutation::DeleteProject => MutationKind::DeleteProject,
            ProposableMutation::CreateTodo => MutationKind::CreateTodo,
            ProposableMutation::UpdateTodo => MutationKind::UpdateTodo,
            ProposableMutation::DeleteTodo => MutationKind::DeleteTodo,
        }
    }

    /// Whether an accepted Proposal of this kind supports an `edit` Decision
    /// (ADR-0025). Deletes carry no editable data, and the reference weave's
    /// shape is fixed (its single entity_ref placeholder), so neither is
    /// editable; every create/update otherwise is. Total over the 13 (both arms
    /// listed) so a new proposable kind must declare its editability.
    pub(crate) fn supports_edit(self) -> bool {
        use ProposableMutation as P;
        match self {
            P::DeleteJournalEntry
            | P::DeletePerson
            | P::DeleteProject
            | P::DeleteTodo
            | P::ReferenceExistingEntityFromJournalEntry => false,
            P::CreateJournalEntry
            | P::UpdateJournalEntry
            | P::CreatePerson
            | P::UpdatePerson
            | P::CreateProject
            | P::UpdateProject
            | P::CreateTodo
            | P::UpdateTodo => true,
        }
    }

    /// Whether `proposal/get` attaches the current Journal Entry as review
    /// context (ADR-0025): the kinds that mutate an EXISTING Journal Entry the
    /// user should see before deciding — update/delete of a Journal Entry, and
    /// the reference weave. A fresh create has nothing to show. Total over the 13.
    pub(crate) fn carries_review_context(self) -> bool {
        use ProposableMutation as P;
        match self {
            P::UpdateJournalEntry
            | P::DeleteJournalEntry
            | P::ReferenceExistingEntityFromJournalEntry => true,
            P::CreateJournalEntry
            | P::CreatePerson
            | P::UpdatePerson
            | P::DeletePerson
            | P::CreateProject
            | P::UpdateProject
            | P::DeleteProject
            | P::CreateTodo
            | P::UpdateTodo
            | P::DeleteTodo => false,
        }
    }
}

/// A [`MutationKind`] that is not agent-proposable was routed to the accept
/// path — a should-be-impossible state (the propose schema cannot emit it). The
/// agent path maps this to a graceful `Invalid`, replacing the former panic.
#[derive(Debug)]
pub(crate) struct NotProposable(pub(crate) MutationKind);

impl TryFrom<MutationKind> for ProposableMutation {
    type Error = NotProposable;

    fn try_from(kind: MutationKind) -> Result<Self, Self::Error> {
        Ok(match kind {
            MutationKind::CreateJournalEntry => ProposableMutation::CreateJournalEntry,
            MutationKind::UpdateJournalEntry => ProposableMutation::UpdateJournalEntry,
            MutationKind::DeleteJournalEntry => ProposableMutation::DeleteJournalEntry,
            MutationKind::ReferenceExistingEntityFromJournalEntry => {
                ProposableMutation::ReferenceExistingEntityFromJournalEntry
            }
            MutationKind::CreatePerson => ProposableMutation::CreatePerson,
            MutationKind::UpdatePerson => ProposableMutation::UpdatePerson,
            MutationKind::DeletePerson => ProposableMutation::DeletePerson,
            MutationKind::CreateProject => ProposableMutation::CreateProject,
            MutationKind::UpdateProject => ProposableMutation::UpdateProject,
            MutationKind::DeleteProject => ProposableMutation::DeleteProject,
            MutationKind::CreateTodo => ProposableMutation::CreateTodo,
            MutationKind::UpdateTodo => ProposableMutation::UpdateTodo,
            MutationKind::DeleteTodo => ProposableMutation::DeleteTodo,
            user_only @ (MutationKind::MarkProjectReviewed
            | MutationKind::CreateBookmark
            | MutationKind::UpdateBookmark
            | MutationKind::DeleteBookmark) => return Err(NotProposable(user_only)),
        })
    }
}

/// Read the target Entity id off a payload, given the resolved descriptor: the
/// `target_key` selects the JSON key, and a create (`target_key: None`) targets
/// nothing. The single reader of the per-kind target-key choice (shared by the
/// edges that resolve an update/delete target).
pub(crate) fn target_entity_id<'a>(desc: Descriptor, payload: &'a Value) -> Option<&'a str> {
    desc.target_key
        .and_then(|key| payload.get(key.as_str()).and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_wire_round_trips_every_kind() {
        // Every wire string the propose schema / user path can send resolves,
        // and as_wire is its exact inverse.
        for kind in [
            MutationKind::CreateJournalEntry,
            MutationKind::UpdateJournalEntry,
            MutationKind::DeleteJournalEntry,
            MutationKind::ReferenceExistingEntityFromJournalEntry,
            MutationKind::CreatePerson,
            MutationKind::UpdatePerson,
            MutationKind::DeletePerson,
            MutationKind::CreateProject,
            MutationKind::UpdateProject,
            MutationKind::DeleteProject,
            MutationKind::MarkProjectReviewed,
            MutationKind::CreateTodo,
            MutationKind::UpdateTodo,
            MutationKind::DeleteTodo,
            MutationKind::CreateBookmark,
            MutationKind::UpdateBookmark,
            MutationKind::DeleteBookmark,
        ] {
            assert_eq!(MutationKind::from_wire(kind.as_wire()), Some(kind));
        }
    }

    #[test]
    fn from_wire_rejects_unknown_kind() {
        // Replaces validate's former `_ => Err("not supported")` arm: an unknown
        // kind is None at the edge (the edge maps it to Invalid/Internal).
        assert_eq!(MutationKind::from_wire("create_widget"), None);
    }

    #[test]
    fn source_relation_follows_write_op() {
        assert_eq!(
            WriteOp::Create.source_relation(),
            Some(SourceRelation::CreatedFrom)
        );
        assert_eq!(
            WriteOp::Update.source_relation(),
            Some(SourceRelation::UpdatedFrom)
        );
        assert_eq!(WriteOp::Delete.source_relation(), None);
        // The reference weave + mark_project_reviewed are Updates, so they source
        // `updated_from` (mark_project_reviewed's value is computed-but-never-read
        // on the agent path; the user path writes no source row).
        assert_eq!(
            MutationKind::ReferenceExistingEntityFromJournalEntry
                .describe()
                .write_op
                .source_relation(),
            Some(SourceRelation::UpdatedFrom)
        );
    }

    #[test]
    fn proposable_all_widens_and_excludes_user_only() {
        // ALL widens cleanly; the 4 user-only kinds are not proposable.
        assert_eq!(ProposableMutation::ALL.len(), 13);
        for p in ProposableMutation::ALL {
            assert_eq!(ProposableMutation::try_from(p.kind()).unwrap(), p);
        }
        for user_only in [
            MutationKind::MarkProjectReviewed,
            MutationKind::CreateBookmark,
            MutationKind::UpdateBookmark,
            MutationKind::DeleteBookmark,
        ] {
            assert!(ProposableMutation::try_from(user_only).is_err());
        }
    }

    #[test]
    fn target_key_matches_legacy_key_choice() {
        // None for creates; todo_id for update_todo; source_entity_id for the
        // reference weave; entity_id for every other update/delete.
        assert_eq!(MutationKind::CreateTodo.describe().target_key, None);
        assert_eq!(
            MutationKind::UpdateTodo.describe().target_key,
            Some(TargetKey::TodoId)
        );
        assert_eq!(
            MutationKind::ReferenceExistingEntityFromJournalEntry
                .describe()
                .target_key,
            Some(TargetKey::SourceEntityId)
        );
        for entity_id_kind in [
            MutationKind::UpdateJournalEntry,
            MutationKind::DeleteJournalEntry,
            MutationKind::UpdatePerson,
            MutationKind::DeletePerson,
            MutationKind::UpdateProject,
            MutationKind::DeleteProject,
            MutationKind::MarkProjectReviewed,
            MutationKind::DeleteTodo,
            MutationKind::UpdateBookmark,
            MutationKind::DeleteBookmark,
        ] {
            assert_eq!(
                entity_id_kind.describe().target_key,
                Some(TargetKey::EntityId),
                "{} targets entity_id",
                entity_id_kind.as_wire()
            );
        }
    }

    #[test]
    fn entity_type_round_trips_and_classifies_referenceable() {
        for et in [
            EntityType::JournalEntry,
            EntityType::Person,
            EntityType::Project,
            EntityType::Todo,
            EntityType::Bookmark,
        ] {
            assert_eq!(EntityType::from_str(et.as_str()), Some(et));
        }
        assert_eq!(EntityType::from_str("nonsense"), None);
        assert!(EntityType::Person.is_referenceable());
        assert!(EntityType::Project.is_referenceable());
        assert!(EntityType::Todo.is_referenceable());
        assert!(!EntityType::JournalEntry.is_referenceable());
        assert!(!EntityType::Bookmark.is_referenceable());
    }
}
