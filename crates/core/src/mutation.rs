//! The Entity-Type taxonomy (ADR-0016, ADR-0025, CONTEXT.md "Entity Type").
//!
//! The wire `mutation_kind` string is resolved ONCE, at each write-path edge,
//! into the closed [`MutationKind`] enum; everything downstream branches on the
//! typed value so a missed case is a compile error, not a runtime panic. The
//! per-kind *classification + policy* — operation class, Entity Type, target-id
//! key, source relation, and proposal-surface membership — lives here as one
//! [`MutationKind::describe`] table plus the narrower [`ProposableMutation`]
//! policy table. The per-kind *apply behaviour* that needs committed DB state
//! stays behind the transaction seam in the `db::apply` module; this module is
//! pure and DB-free.
//!
//! Two enums, one wide and one narrow:
//! - [`MutationKind`] — the 21 Entity-like Core-known kinds. The currency of
//!   `validate`, `mutate`, `apply`, and the target-reference checks.
//! - [`ProposableMutation`] — the closed set the agent may propose (ADR-0018,
//!   ADR-0042, ADR-0053). Carries the agent-path-only facets (`supports_edit`,
//!   `carries_review_context`) so they are total over exactly the kinds that can
//!   reach the accept path, including non-Entity `record_observations`.

use serde_json::Value;

use crate::field_spec::{BodyPolicy, Field, FieldSpec, ObjErr, PayloadSpec, Presence};

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

/// The schema version stamped onto a freshly-created Habit + its first revision.
pub const HABIT_SCHEMA_VERSION: i64 = 1;

/// Search/reference projection for an Entity Type. Kept small on purpose: the
/// stored data field that names the row, plus an optional aliases field for
/// Person search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntityProjectionSpec {
    pub(crate) label_field: &'static str,
    pub(crate) aliases_field: Option<&'static str>,
}

/// Which read surfaces may project an Entity Type to a compact title.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntityProjectionPolicy {
    None,
    Search(EntityProjectionSpec),
    ReferenceAndSearch(EntityProjectionSpec),
}

impl EntityProjectionPolicy {
    fn reference_spec(self) -> Option<EntityProjectionSpec> {
        match self {
            EntityProjectionPolicy::ReferenceAndSearch(spec) => Some(spec),
            EntityProjectionPolicy::None | EntityProjectionPolicy::Search(_) => None,
        }
    }

    fn search_spec(self) -> Option<EntityProjectionSpec> {
        match self {
            EntityProjectionPolicy::Search(spec)
            | EntityProjectionPolicy::ReferenceAndSearch(spec) => Some(spec),
            EntityProjectionPolicy::None => None,
        }
    }
}

/// Closed policy row for an Entity Type. This is the trait-like dispatch point
/// Phase 2 needs: static, compile-checked, and metadata-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntityTypeSpec {
    pub(crate) entity_type: EntityType,
    pub(crate) stored_type: &'static str,
    pub(crate) schema_version: i64,
    pub(crate) projection: EntityProjectionPolicy,
}

impl EntityTypeSpec {
    pub(crate) fn reference_title_from_data(self, data: &Value) -> Option<String> {
        title_from_data(data, self.projection.reference_spec()?)
    }

    pub(crate) fn is_referenceable(self) -> bool {
        self.projection.reference_spec().is_some()
    }

    pub(crate) fn search_projection(self) -> Option<EntityProjectionSpec> {
        self.projection.search_spec()
    }
}

fn title_from_data(data: &Value, projection: EntityProjectionSpec) -> Option<String> {
    data.get(projection.label_field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

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
    Habit,
}

impl EntityType {
    pub(crate) const ALL: [EntityType; 6] = [
        EntityType::JournalEntry,
        EntityType::Person,
        EntityType::Project,
        EntityType::Todo,
        EntityType::Bookmark,
        EntityType::Habit,
    ];

    pub(crate) fn spec(self) -> EntityTypeSpec {
        match self {
            EntityType::JournalEntry => EntityTypeSpec {
                entity_type: self,
                stored_type: "journal_entry",
                schema_version: JOURNAL_ENTRY_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::None,
            },
            EntityType::Person => EntityTypeSpec {
                entity_type: self,
                stored_type: "person",
                schema_version: PERSON_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: Some("aliases"),
                }),
            },
            EntityType::Project => EntityTypeSpec {
                entity_type: self,
                stored_type: "project",
                schema_version: PROJECT_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: None,
                }),
            },
            EntityType::Todo => EntityTypeSpec {
                entity_type: self,
                stored_type: "todo",
                schema_version: TODO_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "title",
                    aliases_field: None,
                }),
            },
            EntityType::Bookmark => EntityTypeSpec {
                entity_type: self,
                stored_type: "bookmark",
                schema_version: BOOKMARK_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::None,
            },
            EntityType::Habit => EntityTypeSpec {
                entity_type: self,
                stored_type: "habit",
                schema_version: HABIT_SCHEMA_VERSION,
                projection: EntityProjectionPolicy::Search(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: None,
                }),
            },
        }
    }

    /// The stored `entities.type` value. Bound into SQL and compared against
    /// rows read back by [`crate::db::entity_type_by_id`].
    pub(crate) fn as_str(self) -> &'static str {
        self.spec().stored_type
    }

    /// The schema version to stamp onto a freshly-created Entity of this type +
    /// its first revision.
    pub(crate) fn schema_version(self) -> i64 {
        self.spec().schema_version
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
            "habit" => Some(EntityType::Habit),
            _ => None,
        }
    }

    /// Whether a Journal Entry body may reference this Entity Type (ADR-0030):
    /// People, Projects, and Todos are referenceable; Journal Entries,
    /// Bookmarks, and Habits are not. A new Entity Type must declare its
    /// referenceability in its spec row.
    pub(crate) fn is_referenceable(self) -> bool {
        self.spec().is_referenceable()
    }

    pub(crate) fn searchable_specs() -> impl Iterator<Item = (EntityTypeSpec, EntityProjectionSpec)>
    {
        Self::ALL.into_iter().filter_map(|entity_type| {
            let spec = entity_type.spec();
            spec.search_projection()
                .map(|projection| (spec, projection))
        })
    }
}

// ─── Field shapes (card 2) ──────────────────────────────────────────────────
//
// Each Entity Type owns its data-field shape once, as a `PayloadSpec` (the
// `*_core` builders below). `MutationKind::payload_spec` FRAMES that core for a
// specific mutation — a create rides the bare core plus an optional
// `source_journal_entry_id` provenance directive; an update prepends the target
// id; a delete is the id alone. The same spec drives BOTH the agent tool schema
// (the proposable subset) and the validators (all kinds). Cross-field invariants
// stay in `crate::entities` hooks (ADR-0033).

/// The four `YYYY-MM-DDTHH:MM:SS` Project/Todo terminal+scheduling timestamps a
/// status↔timestamp invariant governs, plus (for Project) the review pair. Each
/// is an optional, clearable local datetime (ADR-0033 `null` clears).
fn clearable_datetime(name: &'static str) -> Field {
    Field::datetime(name).clearable()
}

impl EntityType {
    /// The Person data-field core: a required non-empty `name`, a clearable
    /// `note`, and a clearable `aliases` array (each element non-empty at
    /// validate-time, plain in the schema). The single source `validate_person`
    /// and the agent schema both derive from.
    fn person_core() -> Vec<Field> {
        vec![
            Field::required("name", FieldSpec::non_empty_string()),
            Field::optional("note", FieldSpec::string()).clearable(),
            Field::optional("aliases", FieldSpec::non_empty_string_array()).clearable(),
        ]
    }

    /// The Bookmark data-field core (ADR-0036): a required `title`, clearable
    /// string `url`/`note`, and a clearable `tags` array. The single source
    /// `validate_bookmark` and the user-CRUD path both derive from.
    fn bookmark_core() -> Vec<Field> {
        vec![
            Field::required("title", FieldSpec::non_empty_string()),
            Field::optional("url", FieldSpec::string()).clearable(),
            Field::optional("note", FieldSpec::string()).clearable(),
            Field::optional("tags", FieldSpec::non_empty_string_array()).clearable(),
        ]
    }

    /// The Habit data-field core: a required non-empty `name`, required cadence,
    /// optional clearable `target`, optional status, and optional clearable note.
    /// Habit is identity; individual check-ins remain Observations.
    fn habit_core() -> Vec<Field> {
        vec![
            Field::required("name", FieldSpec::non_empty_string()),
            Field::required("cadence", FieldSpec::Object(habit_cadence_spec())),
            Field::optional("target", FieldSpec::non_empty_string()).clearable(),
            Field::optional("status", habit_status_enum()),
            Field::optional("note", FieldSpec::string()).clearable(),
        ]
    }

    /// The Project data-field core: a required `name`, clearable `outcome`/`note`,
    /// optional `status` enum, the four clearable terminal/scheduling timestamps,
    /// the clearable `review_every` cadence, and the two clearable review
    /// timestamps. The single source `validate_project_data` and the agent schema
    /// both derive from. The status↔timestamp invariant is a hook, not here.
    ///
    /// `status` is optional but NOT clearable (matching Todo `status`): an absent
    /// status defaults to active, but an explicit `null` is rejected — clearing a
    /// status has no meaning, and the pre-spec validator rejected it likewise.
    fn project_core() -> Vec<Field> {
        vec![
            Field::required("name", FieldSpec::non_empty_string()),
            Field::optional("outcome", FieldSpec::string()).clearable(),
            Field::optional("note", FieldSpec::string()).clearable(),
            Field::optional("status", project_status_enum()),
            clearable_datetime("defer_at"),
            clearable_datetime("due_at"),
            clearable_datetime("completed_at"),
            clearable_datetime("dropped_at"),
            Field::optional("review_every", FieldSpec::Object(review_every_spec())).clearable(),
            clearable_datetime("next_review_at"),
            clearable_datetime("last_reviewed_at"),
        ]
    }

    /// The Todo `TodoData` core — the single source `validate_todo_data` /
    /// `validate_partial_todo_data` and the agent schema all derive from. In
    /// `Mode::Full` `title` is required and no field is clearable; in
    /// `Mode::Partial` (the `update_todo` `todo` envelope) every field is optional
    /// and all EXCEPT `title`/`status` become clearable (ADR-0033). The
    /// status↔timestamp + recurrence-anchor invariants are hooks.
    fn todo_core(mode: Mode) -> Vec<Field> {
        let partial = mode == Mode::Partial;
        // In partial mode title is optional but NOT clearable (a `null` title is
        // meaningless); status is likewise optional-non-clearable in both modes.
        let title = Field {
            name: "title",
            presence: if partial {
                Presence::Optional
            } else {
                Presence::Required
            },
            clearable: false,
            spec: FieldSpec::non_empty_string(),
            description: None,
        };
        vec![
            title,
            Field::optional("note", FieldSpec::string()).clearable_when(partial),
            Field::optional("status", todo_status_enum()),
            Field::optional("project_id", FieldSpec::non_empty_string()).clearable_when(partial),
            clearable_datetime_when("defer_at", partial),
            clearable_datetime_when("due_at", partial),
            clearable_datetime_when("completed_at", partial),
            clearable_datetime_when("dropped_at", partial),
            Field::optional("recurrence", FieldSpec::HookValidated(recurrence_spec()))
                .clearable_when(partial),
        ]
    }
}

/// Full vs partial TodoData (create vs the `update_todo` `todo` envelope).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
    Full,
    Partial,
}

/// A clearable-in-partial-mode local datetime: clearable on the `update_todo`
/// partial path (`null` clears), concrete-or-absent on the create path.
fn clearable_datetime_when(name: &'static str, partial: bool) -> Field {
    let field = Field::datetime(name);
    if partial { field.clearable() } else { field }
}

/// The Project `status` enum (`validate_project_data`).
fn project_status_enum() -> FieldSpec {
    FieldSpec::EnumStr {
        domain: &["active", "on_hold", "completed", "dropped"],
        err: "status must be one of active, on_hold, completed, dropped",
    }
}

/// The Todo `status` enum (no `on_hold`, `validate_todo_data`).
fn todo_status_enum() -> FieldSpec {
    FieldSpec::EnumStr {
        domain: &["active", "completed", "dropped"],
        err: "status must be one of active, completed, dropped",
    }
}

/// The Habit `status` enum. `archived` is a user-managed terminal-ish state for a
/// definition; check-in rows are separate Observations.
fn habit_status_enum() -> FieldSpec {
    FieldSpec::EnumStr {
        domain: &["active", "paused", "archived"],
        err: "status must be one of active, paused, archived",
    }
}

/// The Habit cadence sub-object: a positive interval and coarse calendar unit.
fn habit_cadence_spec() -> PayloadSpec {
    PayloadSpec::nested(
        "habit cadence",
        ObjErr::Object,
        vec![
            Field::required("interval", FieldSpec::PositiveInt),
            Field::required(
                "unit",
                FieldSpec::EnumStr {
                    domain: &["day", "week", "month", "year"],
                    err: "cadence unit must be one of day, week, month, year",
                },
            ),
        ],
    )
}

/// The `review_every` cadence sub-object (ADR-0031): a positive `interval` and a
/// `unit` enum. Validated inline by the spec walk (it has no cross-field rule).
fn review_every_spec() -> PayloadSpec {
    PayloadSpec::nested(
        "review_every",
        ObjErr::Object,
        vec![
            Field::required("interval", FieldSpec::PositiveInt),
            Field::required(
                "unit",
                FieldSpec::EnumStr {
                    domain: &["day", "week", "month", "year"],
                    err: "review_every unit must be one of day, week, month, year",
                },
            ),
        ],
    )
}

/// One `person_refs` element (ADR-0031): a required non-empty `person_id` and an
/// optional `role` enum. Validated inline by the spec walk; a missing role
/// defaults to `related` at apply-time.
fn person_ref_spec() -> PayloadSpec {
    PayloadSpec::nested(
        "person_refs",
        ObjErr::JsonObject,
        vec![
            Field::required("person_id", FieldSpec::non_empty_string()),
            Field::optional(
                "role",
                FieldSpec::EnumStr {
                    domain: &["waiting_on", "related"],
                    err: "person_refs role must be one of waiting_on, related",
                },
            ),
        ],
    )
}

/// The recurrence rule sub-object SCHEMA (ADR-0037, slimmed by ADR-0039).
/// Validation is the hand-written `validate_recurrence` hook (cross-field), but
/// the schema single-sources from here. `end` is itself a hook-validated nested
/// object.
fn recurrence_spec() -> PayloadSpec {
    PayloadSpec::nested(
        "recurrence",
        ObjErr::Object,
        vec![
            Field::required("interval", FieldSpec::PositiveInt),
            Field::required(
                "unit",
                FieldSpec::EnumStr {
                    domain: &["minute", "hour", "day", "week", "month", "year"],
                    err: "recurrence unit must be one of minute, hour, day, week, month, year",
                },
            ),
            Field::required(
                "anchor",
                FieldSpec::EnumStr {
                    domain: &["defer_at", "due_at"],
                    err: "recurrence anchor must be one of defer_at, due_at",
                },
            ),
            Field::optional("end", FieldSpec::HookValidated(recurrence_end_spec())),
        ],
    )
}

/// `recurrence.end` schema (`validate_recurrence_end`): an `until` datetime or an
/// `after_count`. The at-most-one cardinality is the hook's job.
fn recurrence_end_spec() -> PayloadSpec {
    PayloadSpec::nested(
        "recurrence end",
        ObjErr::Object,
        vec![
            Field::datetime("until"),
            Field::optional("after_count", FieldSpec::PositiveInt),
        ],
    )
}

/// The `source_journal_entry_id` provenance directive (ADR-0030/0031) a
/// `create_{person,project,todo}` payload may carry: an optional UUID, advertised
/// with the canonical pattern.
fn source_journal_entry_id_field() -> Field {
    Field::optional(
        "source_journal_entry_id",
        FieldSpec::Uuid { schema_regex: true },
    )
}

/// A reference/source UUID field advertised WITH the canonical pattern + length.
fn patterned_uuid(name: &'static str) -> Field {
    Field::required(name, FieldSpec::Uuid { schema_regex: true })
}

/// The `entity_id` target key shared by the full-document update kinds: a UUID the
/// validator parses but the schema advertises bare (the historical divergence —
/// no test pins a pattern on `entity_id`).
fn entity_id_target() -> Field {
    Field::required(
        "entity_id",
        FieldSpec::Uuid {
            schema_regex: false,
        },
    )
}

impl MutationKind {
    /// The flat field shape of this kind's FULL payload (id/envelope + data) — the
    /// single source from which both the agent tool schema and the validator
    /// derive. Frames the owning Entity Type's data core with the per-kind
    /// id/provenance differences.
    pub(crate) fn payload_spec(self) -> PayloadSpec {
        use MutationKind as M;
        match self {
            // ── Person ──
            M::CreatePerson => {
                let mut fields = EntityType::person_core();
                fields.push(source_journal_entry_id_field());
                PayloadSpec::payload("person", fields)
            }
            M::UpdatePerson => update_payload("person", EntityType::person_core()),
            // ── Project ──
            M::CreateProject => {
                let mut fields = EntityType::project_core();
                fields.push(source_journal_entry_id_field());
                PayloadSpec::payload("project", fields)
            }
            M::UpdateProject => update_payload("project", EntityType::project_core()),
            // ── Bookmark (user-CRUD only) ──
            M::CreateBookmark => PayloadSpec::payload("bookmark", EntityType::bookmark_core()),
            M::UpdateBookmark => update_payload("bookmark", EntityType::bookmark_core()),
            // ── Habit (user-CRUD only) ──
            M::CreateHabit => PayloadSpec::payload("habit", EntityType::habit_core()),
            M::UpdateHabit => update_payload("habit", EntityType::habit_core()),
            // ── Todo ──
            M::CreateTodo => PayloadSpec::payload(
                "create_todo",
                vec![
                    // `todo` schema recurses (HookValidated emits the TodoData
                    // schema) but its VALIDATION is `validate_todo_data` (the
                    // status↔ts + recurrence invariants exceed a flat walk).
                    Field::required("todo", FieldSpec::HookValidated(todo_data_spec(Mode::Full))),
                    Field::optional(
                        "person_refs",
                        FieldSpec::Array {
                            items: Box::new(FieldSpec::Object(person_ref_spec())),
                            plain_items: false,
                            min_items: None,
                        },
                    ),
                    source_journal_entry_id_field(),
                ],
            ),
            M::UpdateTodo => PayloadSpec::payload(
                "update_todo",
                vec![
                    Field::required(
                        "todo_id",
                        FieldSpec::Uuid {
                            schema_regex: false,
                        },
                    ),
                    Field::optional(
                        "todo",
                        FieldSpec::HookValidated(todo_data_spec(Mode::Partial)),
                    ),
                    person_ref_array("set_person_refs"),
                    person_ref_array("add_person_refs"),
                    Field::optional("remove_person_ids", FieldSpec::non_empty_string_array()),
                ],
            ),
            // ── Journal Entry ──
            M::CreateJournalEntry => journal_entry_payload(None, BodyPolicy::TextOnly),
            M::UpdateJournalEntry => {
                journal_entry_payload(Some(entity_id_target()), BodyPolicy::TextOrExistingRef)
            }
            M::ReferenceExistingEntityFromJournalEntry => PayloadSpec::payload(
                "reference",
                vec![
                    patterned_uuid("source_entity_id"),
                    patterned_uuid("target_entity_id"),
                    Field::optional("label_snapshot", FieldSpec::non_empty_string()),
                    Field::required("body", FieldSpec::Body(BodyPolicy::TextOrNewRef)),
                ],
            ),
            // ── id-only payloads ──
            M::DeleteJournalEntry => entity_id_only("delete_journal_entry"),
            M::DeletePerson => entity_id_only("delete_person"),
            M::DeleteProject => entity_id_only("delete_project"),
            M::DeleteTodo => entity_id_only("delete_todo"),
            M::DeleteBookmark => entity_id_only("delete_bookmark"),
            M::DeleteHabit => entity_id_only("delete_habit"),
            M::MarkProjectReviewed => entity_id_only("mark_project_reviewed"),
            // ── intent graph (ADR-0042) ──
            M::ApplyIntentGraph => intent_graph_payload(),
        }
    }

    /// The DATA-only spec (the entity fields, no envelope/id) — used by the update
    /// validators that strip the target id and validate the rest as entity data,
    /// and by the create validators after stripping `source_journal_entry_id`.
    pub(crate) fn payload_data_spec(self) -> PayloadSpec {
        use MutationKind as M;
        match self {
            M::CreatePerson | M::UpdatePerson => {
                PayloadSpec::payload("person", EntityType::person_core())
            }
            M::CreateProject | M::UpdateProject => {
                PayloadSpec::payload("project", EntityType::project_core())
            }
            M::CreateBookmark | M::UpdateBookmark => {
                PayloadSpec::payload("bookmark", EntityType::bookmark_core())
            }
            M::CreateHabit | M::UpdateHabit => {
                PayloadSpec::payload("habit", EntityType::habit_core())
            }
            other => other.payload_spec(),
        }
    }
}

/// The full TodoData sub-object spec for a [`Mode`] (`todo` envelope value).
pub(crate) fn todo_data_spec(mode: Mode) -> PayloadSpec {
    PayloadSpec::nested("todo", ObjErr::JsonObject, EntityType::todo_core(mode))
}

/// An update payload: the `entity_id` target prepended to the entity data core.
fn update_payload(noun: &'static str, core: Vec<Field>) -> PayloadSpec {
    let mut fields = vec![entity_id_target()];
    fields.extend(core);
    PayloadSpec::payload(noun, fields)
}

/// An optional `person_refs`-shaped array field (`set_person_refs`/`add_person_refs`).
fn person_ref_array(name: &'static str) -> Field {
    Field::optional(
        name,
        FieldSpec::Array {
            items: Box::new(FieldSpec::Object(person_ref_spec())),
            plain_items: false,
            min_items: None,
        },
    )
}

/// A `{entity_id}`-only payload (the deletes + `mark_project_reviewed`); the noun
/// is the wire kind, woven into the unsupported-field message.
fn entity_id_only(noun: &'static str) -> PayloadSpec {
    PayloadSpec::payload(noun, vec![entity_id_target()])
}

/// A journal-entry payload: optional target id, the `occurred_at`/`ended_at`
/// timestamps, and the `body` union for the given policy.
fn journal_entry_payload(target: Option<Field>, body: BodyPolicy) -> PayloadSpec {
    let mut fields = Vec::new();
    if let Some(target) = target {
        fields.push(target);
    }
    fields.push(Field::datetime("occurred_at").require());
    fields.push(Field::datetime("ended_at"));
    fields.push(Field::required("body", FieldSpec::Body(body)));
    PayloadSpec::payload("journal entry", fields)
}

// ─── Intent graph payload (ADR-0042) ────────────────────────────────────────
//
// The graph is the most structurally complex payload the model emits: an
// optional `journal_entry` node, a `>= 1` array of typed entity nodes
// (person/project/todo, each carrying a graph-local `handle` + optional
// `existing_id` hint), and an array of three link kinds. Slice 1 advertises and
// structurally accepts the shape — deep per-entity-type field validation and the
// cross-node graph invariants (handle references, duplicate handles, a
// `journal_ref` without a `journal_entry`) are the resolver's job in slice 2+.
// Every variant is INLINED (no `$ref` — Anthropic rejects refs) and carries
// `additionalProperties:false`, so each node variant must declare ALL its keys.

/// A single-literal `type`/`kind` discriminant for a graph node variant — a
/// closed enum whose domain is exactly the variant's tag, so a node with the
/// wrong tag fails this variant (and the `oneOf` falls through to the next).
fn graph_discriminant(name: &'static str, domain: &'static [&'static str]) -> Field {
    Field::required(
        name,
        FieldSpec::EnumStr {
            domain,
            err: "unknown graph node tag",
        },
    )
}

/// One typed entity node: a required graph-local `handle`, the `type`
/// discriminant, an optional `existing_id` UUID hint (Core re-resolves
/// regardless), plus the type-specific fields. The fields are advertised so the
/// model knows the shape; deep cross-field validation is deferred to the
/// resolver.
fn entity_node(type_domain: &'static [&'static str], type_fields: Vec<Field>) -> PayloadSpec {
    let mut fields = vec![
        Field::required("handle", FieldSpec::non_empty_string()),
        graph_discriminant("type", type_domain),
        Field::optional("existing_id", FieldSpec::Uuid { schema_regex: true }),
    ];
    fields.extend(type_fields);
    PayloadSpec::nested("intent graph entity", ObjErr::JsonObject, fields)
}

/// One graph body node: a `{type:"text", text}` or a `{type:"entity_ref",
/// target}` whose `target` is a handle declared in `entities` (resolved later).
fn graph_body_nodes() -> FieldSpec {
    FieldSpec::OneOfArray {
        variants: vec![
            PayloadSpec::nested(
                "intent graph body text node",
                ObjErr::JsonObject,
                vec![
                    graph_discriminant("type", &["text"]),
                    Field::required("text", FieldSpec::non_empty_string()),
                ],
            ),
            PayloadSpec::nested(
                "intent graph body entity_ref node",
                ObjErr::JsonObject,
                vec![
                    graph_discriminant("type", &["entity_ref"]),
                    Field::required("target", FieldSpec::non_empty_string()),
                ],
            ),
        ],
        min_items: Some(1),
    }
}

/// The optional `journal_entry` node: its own handle, the occurred/ended
/// timestamps, and a body of text/entity_ref nodes (entity_ref `target`s are
/// handles). Present for journal-anchored capture, absent for direct capture.
///
/// `body` is OPTIONAL because the node has two modes (ADR-0042): a CREATE node
/// (no `existing_id`) carries the body the fresh Journal Entry weaves and mints;
/// an ANCHOR-REUSE node (`existing_id` set — the re-scan path) keeps the EXISTING
/// entry's stored body and re-emits NO body. The resolver enforces the mode rule
/// — create-mode fails loud at apply if its woven body is empty/absent
/// (`validate_woven_journal_body`), anchor-reuse ignores any body.
fn intent_graph_journal_entry_node() -> PayloadSpec {
    PayloadSpec::nested(
        "intent graph journal entry",
        ObjErr::JsonObject,
        vec![
            Field::required("handle", FieldSpec::non_empty_string()),
            Field::optional("existing_id", FieldSpec::Uuid { schema_regex: true }),
            Field::datetime("occurred_at").require(),
            Field::datetime("ended_at"),
            Field::optional("body", graph_body_nodes()),
        ],
    )
}

/// The three link kinds (ADR-0042): each a `kind` discriminant + `from`/`to`
/// handles, with `todo_person` additionally carrying a `role` enum.
fn intent_graph_links() -> FieldSpec {
    let from_to = || {
        vec![
            Field::required("from", FieldSpec::non_empty_string()),
            Field::required("to", FieldSpec::non_empty_string()),
        ]
    };
    let mut todo_project = vec![graph_discriminant("kind", &["todo_project"])];
    todo_project.extend(from_to());
    let mut todo_person = vec![graph_discriminant("kind", &["todo_person"])];
    todo_person.extend(from_to());
    todo_person.push(Field::required(
        "role",
        FieldSpec::EnumStr {
            domain: &["waiting_on", "related"],
            err: "todo_person role must be one of waiting_on, related",
        },
    ));
    let mut journal_ref = vec![graph_discriminant("kind", &["journal_ref"])];
    journal_ref.extend(from_to());
    journal_ref.push(Field::optional("match_text", FieldSpec::non_empty_string()));
    journal_ref.push(Field::optional(
        "append_text",
        FieldSpec::non_empty_string(),
    ));
    FieldSpec::OneOfArray {
        variants: vec![
            PayloadSpec::nested(
                "intent graph todo_project link",
                ObjErr::JsonObject,
                todo_project,
            ),
            PayloadSpec::nested(
                "intent graph todo_person link",
                ObjErr::JsonObject,
                todo_person,
            ),
            PayloadSpec::nested(
                "intent graph journal_ref link",
                ObjErr::JsonObject,
                journal_ref,
            ),
        ],
        min_items: None,
    }
}

/// The `apply_intent_graph` payload: an optional `journal_entry` node, a
/// `minItems:1` array of typed entity nodes, and an array of link nodes.
fn intent_graph_payload() -> PayloadSpec {
    let entity_variants = vec![
        entity_node(
            &["person"],
            vec![
                Field::required("name", FieldSpec::non_empty_string()),
                Field::optional("note", FieldSpec::string()),
                Field::optional("aliases", FieldSpec::non_empty_string_array()),
            ],
        ),
        entity_node(
            &["project"],
            vec![
                Field::required("name", FieldSpec::non_empty_string()),
                Field::optional("outcome", FieldSpec::string()),
                Field::optional("note", FieldSpec::string()),
            ],
        ),
        entity_node(
            &["todo"],
            vec![
                Field::required("title", FieldSpec::non_empty_string()),
                Field::optional("note", FieldSpec::string()),
                Field::datetime("defer_at"),
                Field::datetime("due_at"),
            ],
        ),
    ];
    PayloadSpec::payload(
        "apply_intent_graph",
        vec![
            Field::optional(
                "journal_entry",
                FieldSpec::Object(intent_graph_journal_entry_node()),
            ),
            Field::required(
                "entities",
                FieldSpec::OneOfArray {
                    variants: entity_variants,
                    min_items: Some(1),
                },
            ),
            Field::required("links", intent_graph_links()),
        ],
    )
}

/// Which top-level payload key names the target Entity of a mutation. A pure
/// function of the kind (resolved in [`MutationKind::describe`]); the value is
/// read FROM the payload at the edge via [`target_entity_id`].
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

/// Every Entity-like Workspace mutation kind (ADR-0016, ADR-0025, ADR-0036,
/// ADR-0042). Observation capture is intentionally not here because it has no
/// Entity descriptor; it lives in [`ProposableMutation`] only.
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
    CreateHabit,
    UpdateHabit,
    DeleteHabit,
    /// One intent graph (ADR-0042): candidate entities + intended links, resolved
    /// and applied by Core in one atomic transaction. Agent-proposable; the
    /// resolve/apply path lands in a later slice (slice 1 is the schema only).
    ApplyIntentGraph,
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
            "create_habit" => MutationKind::CreateHabit,
            "update_habit" => MutationKind::UpdateHabit,
            "delete_habit" => MutationKind::DeleteHabit,
            "apply_intent_graph" => MutationKind::ApplyIntentGraph,
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
            MutationKind::CreateHabit => "create_habit",
            MutationKind::UpdateHabit => "update_habit",
            MutationKind::DeleteHabit => "delete_habit",
            MutationKind::ApplyIntentGraph => "apply_intent_graph",
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
            M::CreateHabit => Descriptor {
                write_op: W::Create,
                entity_type: E::Habit,
                target_key: None,
            },
            M::UpdateHabit => Descriptor {
                write_op: W::Update,
                entity_type: E::Habit,
                target_key: Some(K::EntityId),
            },
            M::DeleteHabit => Descriptor {
                write_op: W::Delete,
                entity_type: E::Habit,
                target_key: Some(K::EntityId),
            },
            // A graph spans many entities, so it has NO single target id — like a
            // create, `target_key` is None. `entity_type` is the JE anchor; the
            // graph actually mints many types, so this field is unused until the
            // slice-2 resolver (which loops `apply_entity_mutation` per node with
            // each node's own type). `write_op: Create` keeps the descriptor total
            // and matches the create-and-link-only nature of the kind (ADR-0042).
            M::ApplyIntentGraph => Descriptor {
                write_op: W::Create,
                entity_type: E::JournalEntry,
                target_key: None,
            },
        }
    }
}

/// The agent-proposable subset (ADR-0018, ADR-0053): the 15 kinds the Worker may emit via
/// `propose_workspace_mutation`. Carries the agent-path-only policy facets so each is
/// total over exactly the kinds that can reach the accept path — the user-only
/// kind families (`mark_project_reviewed`, bookmarks, habits) are simply not in
/// the type.
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
    ApplyIntentGraph,
    RecordObservations,
}

impl ProposableMutation {
    /// Every agent-proposable kind, in wire order. The single source the
    /// `propose_workspace_mutation` tool descriptor iterates to emit its `oneOf`
    /// schema, and the closed set the drift-guard test pins.
    pub(crate) const ALL: [ProposableMutation; 15] = [
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
        ProposableMutation::ApplyIntentGraph,
        ProposableMutation::RecordObservations,
    ];

    pub(crate) fn from_wire(s: &str) -> Option<Self> {
        if s == "record_observations" {
            return Some(ProposableMutation::RecordObservations);
        }
        MutationKind::from_wire(s).and_then(|kind| ProposableMutation::try_from(kind).ok())
    }

    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            ProposableMutation::RecordObservations => "record_observations",
            ProposableMutation::CreateJournalEntry
            | ProposableMutation::UpdateJournalEntry
            | ProposableMutation::DeleteJournalEntry
            | ProposableMutation::ReferenceExistingEntityFromJournalEntry
            | ProposableMutation::CreatePerson
            | ProposableMutation::UpdatePerson
            | ProposableMutation::DeletePerson
            | ProposableMutation::CreateProject
            | ProposableMutation::UpdateProject
            | ProposableMutation::DeleteProject
            | ProposableMutation::CreateTodo
            | ProposableMutation::UpdateTodo
            | ProposableMutation::DeleteTodo
            | ProposableMutation::ApplyIntentGraph => self
                .entity_kind()
                .expect("entity-backed proposable kind")
                .as_wire(),
        }
    }

    pub(crate) fn payload_spec(self) -> PayloadSpec {
        match self {
            ProposableMutation::RecordObservations => {
                crate::observations::record_observations_payload_spec()
            }
            ProposableMutation::CreateJournalEntry
            | ProposableMutation::UpdateJournalEntry
            | ProposableMutation::DeleteJournalEntry
            | ProposableMutation::ReferenceExistingEntityFromJournalEntry
            | ProposableMutation::CreatePerson
            | ProposableMutation::UpdatePerson
            | ProposableMutation::DeletePerson
            | ProposableMutation::CreateProject
            | ProposableMutation::UpdateProject
            | ProposableMutation::DeleteProject
            | ProposableMutation::CreateTodo
            | ProposableMutation::UpdateTodo
            | ProposableMutation::DeleteTodo
            | ProposableMutation::ApplyIntentGraph => self
                .entity_kind()
                .expect("entity-backed proposable kind")
                .payload_spec(),
        }
    }

    /// Validate proposal kinds that must be fully checked before parking.
    /// Editable Entity proposals may park with invalid draft fields so the
    /// review UI can repair them; Observation proposals need a valid batch shape
    /// and cross-field invariants up front.
    pub(crate) fn validate_before_park(self, payload: &Value) -> Result<(), String> {
        match self {
            ProposableMutation::RecordObservations => {
                crate::observations::validate_record_observations_payload(payload)
            }
            ProposableMutation::CreateJournalEntry
            | ProposableMutation::UpdateJournalEntry
            | ProposableMutation::DeleteJournalEntry
            | ProposableMutation::ReferenceExistingEntityFromJournalEntry
            | ProposableMutation::CreatePerson
            | ProposableMutation::UpdatePerson
            | ProposableMutation::DeletePerson
            | ProposableMutation::CreateProject
            | ProposableMutation::UpdateProject
            | ProposableMutation::DeleteProject
            | ProposableMutation::CreateTodo
            | ProposableMutation::UpdateTodo
            | ProposableMutation::DeleteTodo
            | ProposableMutation::ApplyIntentGraph => Ok(()),
        }
    }

    /// Widen to an Entity-like [`MutationKind`]. `record_observations` is
    /// intentionally absent: it is a proposable Workspace mutation, not an Entity
    /// mutation and has no [`Descriptor`].
    pub(crate) fn entity_kind(self) -> Option<MutationKind> {
        Some(match self {
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
            ProposableMutation::ApplyIntentGraph => MutationKind::ApplyIntentGraph,
            ProposableMutation::RecordObservations => return None,
        })
    }

    /// Whether an accepted Proposal of this kind supports an `edit` Decision
    /// (ADR-0025). Deletes carry no editable data, and the reference weave's
    /// shape is fixed (its single entity_ref placeholder), so neither is
    /// editable; every create/update otherwise is. Total over the 15 (both arms
    /// listed) so a new proposable kind must declare its editability.
    pub(crate) fn supports_edit(self) -> bool {
        use ProposableMutation as P;
        match self {
            P::DeleteJournalEntry
            | P::DeletePerson
            | P::DeleteProject
            | P::DeleteTodo
            | P::ReferenceExistingEntityFromJournalEntry
            // The graph is corrected via the per-node decision vector's
            // `edited_fields` (ADR-0042), NOT the whole-payload `edit` verb. So it
            // does not support `edit`.
            | P::ApplyIntentGraph => false,
            P::CreateJournalEntry
            | P::UpdateJournalEntry
            | P::CreatePerson
            | P::UpdatePerson
            | P::CreateProject
            | P::UpdateProject
            | P::CreateTodo
            | P::UpdateTodo
            | P::RecordObservations => true,
        }
    }

    /// Whether `proposal/get` attaches the current stored Entity as review
    /// context (ADR-0025): the kinds that mutate an EXISTING Entity the user
    /// should see before deciding — update/delete of a Journal Entry and the
    /// reference weave, plus the two GTD full-document REPLACE updates
    /// (update_person, update_project — lamplit-desk-alignment), so the Client can
    /// render Current-vs-Proposed and surface what an accepted REPLACE removes
    /// (ADR-0016, ADR-0033). `update_todo` is a partial MERGE (ADR-0033) — omitted
    /// fields are NOT dropped — so a "what a REPLACE removes" diff does not apply,
    /// and it carries no review context. A fresh create has nothing to show; a GTD
    /// delete needs no current-vs-proposed diff. Total over the 15.
    pub(crate) fn carries_review_context(self) -> bool {
        use ProposableMutation as P;
        match self {
            P::UpdateJournalEntry
            | P::DeleteJournalEntry
            | P::ReferenceExistingEntityFromJournalEntry
            | P::UpdatePerson
            | P::UpdateProject => true,
            P::CreateJournalEntry
            | P::CreatePerson
            | P::DeletePerson
            | P::CreateProject
            | P::DeleteProject
            | P::CreateTodo
            | P::UpdateTodo
            | P::DeleteTodo
            | P::RecordObservations
            // The graph mints its own newborn Journal Entry (ADR-0042 create mode)
            // OR re-anchors an existing one (ADR-0042 anchor-reuse amendment), but
            // either way the card displays create nodes + links, never a
            // current-vs-proposed JE body diff — so there is no review context to
            // attach. Anchor-reuse splices into the stored body Core-side; the user
            // is not editing the JE, so the UPDATE-kind review diff does not apply.
            | P::ApplyIntentGraph => false,
        }
    }
}

/// A [`MutationKind`] that is not agent-proposable was routed to the accept
/// path — a should-be-impossible state (the propose schema cannot emit it). The
/// agent path maps this to a graceful `Invalid`, replacing the former panic.
#[derive(Debug)]
pub(crate) struct NotProposable;

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
            MutationKind::ApplyIntentGraph => ProposableMutation::ApplyIntentGraph,
            MutationKind::MarkProjectReviewed
            | MutationKind::CreateBookmark
            | MutationKind::UpdateBookmark
            | MutationKind::DeleteBookmark
            | MutationKind::CreateHabit
            | MutationKind::UpdateHabit
            | MutationKind::DeleteHabit => return Err(NotProposable),
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
            MutationKind::CreateHabit,
            MutationKind::UpdateHabit,
            MutationKind::DeleteHabit,
            MutationKind::ApplyIntentGraph,
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
        // ALL widens cleanly; the user-only kinds are not proposable.
        assert_eq!(ProposableMutation::ALL.len(), 15);
        for p in ProposableMutation::ALL {
            if let Some(kind) = p.entity_kind() {
                assert_eq!(ProposableMutation::try_from(kind).unwrap(), p);
            } else {
                assert_eq!(p, ProposableMutation::RecordObservations);
                assert_eq!(ProposableMutation::from_wire(p.as_wire()), Some(p));
            }
        }
        for user_only in [
            MutationKind::MarkProjectReviewed,
            MutationKind::CreateBookmark,
            MutationKind::UpdateBookmark,
            MutationKind::DeleteBookmark,
            MutationKind::CreateHabit,
            MutationKind::UpdateHabit,
            MutationKind::DeleteHabit,
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
            MutationKind::UpdateHabit,
            MutationKind::DeleteHabit,
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
        for et in EntityType::ALL {
            assert_eq!(EntityType::from_str(et.as_str()), Some(et));
        }
        assert_eq!(EntityType::from_str("nonsense"), None);
        assert!(EntityType::Person.is_referenceable());
        assert!(EntityType::Project.is_referenceable());
        assert!(EntityType::Todo.is_referenceable());
        assert!(!EntityType::JournalEntry.is_referenceable());
        assert!(!EntityType::Bookmark.is_referenceable());
        assert!(!EntityType::Habit.is_referenceable());
    }

    #[test]
    fn entity_type_specs_round_trip_stored_types() {
        let mut stored_types = std::collections::HashSet::new();

        for et in EntityType::ALL {
            let spec = et.spec();
            assert_eq!(spec.entity_type, et);
            assert_eq!(EntityType::from_str(spec.stored_type), Some(et));
            assert!(
                stored_types.insert(spec.stored_type),
                "stored Entity Type string is unique: {}",
                spec.stored_type
            );
        }
    }

    #[test]
    fn entity_type_specs_declare_current_policy() {
        let searchable = EntityType::searchable_specs()
            .map(|(spec, _projection)| spec.entity_type)
            .collect::<Vec<_>>();
        assert_eq!(
            searchable,
            vec![
                EntityType::Person,
                EntityType::Project,
                EntityType::Todo,
                EntityType::Habit
            ],
            "search_entities exposes searchable Entity Type specs"
        );

        assert_eq!(
            EntityType::Person.spec().schema_version,
            PERSON_SCHEMA_VERSION
        );
        assert_eq!(
            EntityType::Project.spec().schema_version,
            PROJECT_SCHEMA_VERSION
        );
        assert_eq!(EntityType::Todo.spec().schema_version, TODO_SCHEMA_VERSION);
        assert_eq!(
            EntityType::Bookmark.spec().schema_version,
            BOOKMARK_SCHEMA_VERSION
        );
        assert_eq!(
            EntityType::Habit.spec().schema_version,
            HABIT_SCHEMA_VERSION
        );
        assert_eq!(
            EntityType::JournalEntry.spec().schema_version,
            JOURNAL_ENTRY_SCHEMA_VERSION
        );
    }

    #[test]
    fn carries_review_context_covers_journal_and_gtd_updates() {
        use ProposableMutation as P;
        // The kinds that mutate an EXISTING Entity the user should see before
        // deciding: the three Journal Entry review kinds plus the two GTD
        // full-document REPLACE updates (update_person, update_project —
        // lamplit-desk-alignment) — so the Client can show what an accepted REPLACE
        // removes.
        for carries in [
            P::UpdateJournalEntry,
            P::DeleteJournalEntry,
            P::ReferenceExistingEntityFromJournalEntry,
            P::UpdatePerson,
            P::UpdateProject,
        ] {
            assert!(
                carries.carries_review_context(),
                "{} carries review context",
                carries.as_wire()
            );
        }
        // Creates have no current Entity; `update_todo` is a partial MERGE (ADR-0033)
        // with no "what a REPLACE removes" diff to surface; deletes of GTD kinds and
        // the graph do not surface current-vs-proposed context.
        for omits in [
            P::CreateJournalEntry,
            P::CreatePerson,
            P::DeletePerson,
            P::CreateProject,
            P::DeleteProject,
            P::CreateTodo,
            P::UpdateTodo,
            P::DeleteTodo,
            P::RecordObservations,
            P::ApplyIntentGraph,
        ] {
            assert!(
                !omits.carries_review_context(),
                "{} omits review context",
                omits.as_wire()
            );
        }
    }
}
