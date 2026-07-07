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

// Re-export schema version values for external consumers (entities.rs tests,
// db/mod.rs). The canonical values now live inline on the `EntityTypeSpec` rows.
pub const JOURNAL_ENTRY_SCHEMA_VERSION: i64 = 1;
pub const PERSON_SCHEMA_VERSION: i64 = 1;
pub const PROJECT_SCHEMA_VERSION: i64 = 1;
pub const TODO_SCHEMA_VERSION: i64 = 1;
pub const MEDIA_SCHEMA_VERSION: i64 = 1;
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

/// Declarative pre-write normalization for a regular create/update payload,
/// consumed by `db::apply`'s `entity_data_payload` seam. Fn pointers (not
/// closures/traits) keep the spec row `Copy`/`Eq`, matching the
/// `launch::resolve_with` precedent. The step ORDER is load-bearing:
/// extract → strip → null-drop → post — the Project review-default seeding must
/// observe null-cleared input (a `null` review field is a clear directive,
/// treated as absent and thus seeded; ADR-0033).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NormalizePolicy {
    /// Transport fields to strip (target/provenance keys, never entity data),
    /// e.g. `["entity_id", "source_journal_entry_id"]`.
    pub(crate) strip: &'static [&'static str],
    /// Sentinel-null clear (ADR-0033): a `null`-valued optional field is a clear
    /// directive — drop the key rather than persist a JSON null.
    pub(crate) drop_nulls: bool,
    /// Runs AFTER strip + null-drop (ordering is load-bearing for the Project
    /// review seeding).
    pub(crate) post: Option<fn(&mut serde_json::Map<String, Value>, now_ms: i64, offset_minutes: i64)>,
    /// Pre-step for envelope kinds (`create_todo` unwraps `payload.todo`).
    /// `None` from the extractor means "no envelope to unwrap" — the payload is
    /// stored as-is (the pre-policy arms returned `payload.clone()` likewise).
    pub(crate) extract: Option<fn(&Value) -> Option<Value>>,
}

/// A store-as-is policy (no strip, no null-drop): the Journal Entry create,
/// whose body is woven at decide-time and stored verbatim.
const IDENTITY_NORMALIZE: NormalizePolicy = NormalizePolicy {
    strip: &[],
    drop_nulls: false,
    post: None,
    extract: None,
};

/// The shared full-replace update policy: strip the `entity_id` target (it
/// targets the row but is not entity data) and the create-only
/// `source_journal_entry_id` provenance directive (honored solely for
/// `created_from` — stripping it means an update payload can never persist this
/// transport field into entity data), then sentinel-null clear (ADR-0033: the
/// person/project update is a full-document replace, so an omitted-or-null
/// optional field is simply absent in the stored data).
pub(crate) const UPDATE_NORMALIZE: NormalizePolicy = NormalizePolicy {
    strip: &["entity_id", "source_journal_entry_id"],
    drop_nulls: true,
    post: None,
    extract: None,
};

impl NormalizePolicy {
    /// Run the pipeline: extract → (non-object passthrough) → strip → null-drop
    /// → post. A payload the extractor rejects, or a non-object payload, is
    /// stored as-is — exactly what the pre-policy per-kind arms did.
    pub(crate) fn apply(self, payload: &Value, now_ms: i64, offset_minutes: i64) -> Value {
        let value = match self.extract {
            Some(extract) => match extract(payload) {
                Some(value) => value,
                None => return payload.clone(),
            },
            None => payload.clone(),
        };
        let Value::Object(mut data) = value else {
            return value;
        };
        for key in self.strip {
            data.remove(*key);
        }
        if self.drop_nulls {
            data.retain(|_, value| !value.is_null());
        }
        if let Some(post) = self.post {
            post(&mut data, now_ms, offset_minutes);
        }
        Value::Object(data)
    }
}

/// `create_project` post-normalization (registered on the Project spec row):
/// inject `status:"active"` when absent so the stored data always carries an
/// explicit status (validate tolerates a missing status), and for a resulting
/// active Project with no review fields supplied seed the default weekly review
/// ritual (`review_every` + `next_review_at`) from the review anchor (ADR-0031).
/// Runs AFTER null-drop so a `null` review field is treated as absent (and thus
/// seeded).
fn project_create_defaults(
    data: &mut serde_json::Map<String, Value>,
    now_ms: i64,
    offset_minutes: i64,
) {
    let status = data
        .entry("status")
        .or_insert_with(|| serde_json::json!("active"));
    let is_active = status.as_str() == Some("active");
    if is_active && !data.contains_key("review_every") && !data.contains_key("next_review_at") {
        data.insert(
            "review_every".to_string(),
            serde_json::json!({ "interval": 1, "unit": "week" }),
        );
        data.insert(
            "next_review_at".to_string(),
            serde_json::json!(crate::localtime::next_review_at_local(
                now_ms,
                offset_minutes
            )),
        );
    }
}

/// `create_todo` post-normalization (registered on the Todo spec row): inject
/// `status:"active"` when absent, mirroring the Project status default.
fn todo_create_defaults(
    data: &mut serde_json::Map<String, Value>,
    _now_ms: i64,
    _offset_minutes: i64,
) {
    data.entry("status")
        .or_insert_with(|| serde_json::json!("active"));
}

/// `create_todo` envelope unwrap (registered on the Todo spec row): store
/// `payload.todo` (the TodoData); `person_refs` persist separately in
/// `todo_person_refs`, never in `entities.data`.
fn todo_envelope_extract(payload: &Value) -> Option<Value> {
    payload.get("todo").filter(|todo| todo.is_object()).cloned()
}

/// Closed policy row for an Entity Type. This is the trait-like dispatch point
/// Phase 2 needs: static, compile-checked, and metadata-only — ONE row per type
/// from which the regular payload specs, schema version, accept-text noun, and
/// apply-normalization policy all derive. Adding an Entity Type is adding one
/// row (plus explicit arms for anything genuinely irregular).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntityTypeSpec {
    pub(crate) entity_type: EntityType,
    pub(crate) stored_type: &'static str,
    /// The schema version stamped onto a freshly-created Entity of this type +
    /// its first revision.
    pub(crate) schema_version: i64,
    /// The human noun accept-text rendering weaves ("Accepted. Deleted {noun} …").
    pub(crate) noun: &'static str,
    pub(crate) projection: EntityProjectionPolicy,
    /// The data field core the regular payload specs derive from. `None` for
    /// the irregular types — journal (body policies) and todo (the `Mode`-split
    /// core) — whose `payload_spec` arms stay explicit.
    pub(crate) data_core: Option<fn() -> Vec<Field>>,
    /// Whether this type's create payload carries the optional
    /// `source_journal_entry_id` provenance directive (ADR-0030/0031):
    /// person/project/todo creates do; media/habit are user-CRUD only and do
    /// not. Consumed by [`EntityTypeSpec::create_payload`] — an explicit flag,
    /// never a guess, because appending it unconditionally would change the
    /// media/habit contract fixtures.
    pub(crate) create_source_directive: bool,
    /// Pre-write normalization for this type's create kind, consumed by
    /// `db::apply::entity_data_payload`.
    pub(crate) create_normalize: NormalizePolicy,
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

    /// The regular create payload: the data core plus, where the row declares
    /// it, the `source_journal_entry_id` provenance directive. The irregular
    /// types (journal, todo) keep explicit `payload_spec` arms.
    fn create_payload(self) -> PayloadSpec {
        let mut fields = self.data_core_fields();
        if self.create_source_directive {
            fields.push(source_journal_entry_id_field());
        }
        PayloadSpec::payload(self.stored_type, fields)
    }

    /// The regular update payload: the `entity_id` target prepended to the core.
    fn update_payload(self) -> PayloadSpec {
        update_payload(self.stored_type, self.data_core_fields())
    }

    /// The DATA-only payload (the entity fields, no envelope/id) the update
    /// validators check after stripping the target id.
    fn data_payload(self) -> PayloadSpec {
        PayloadSpec::payload(self.stored_type, self.data_core_fields())
    }

    fn data_core_fields(self) -> Vec<Field> {
        (self
            .data_core
            .expect("regular payload derives from a data core"))()
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
    Media,
    Habit,
}

impl EntityType {
    pub(crate) const ALL: [EntityType; 6] = [
        EntityType::JournalEntry,
        EntityType::Person,
        EntityType::Project,
        EntityType::Todo,
        EntityType::Media,
        EntityType::Habit,
    ];

    pub(crate) fn spec(self) -> EntityTypeSpec {
        match self {
            // Journal Entry's data core is irregular (body policies split the
            // create/update shapes), so `data_core` is None and its payload
            // arms stay explicit; its create stores the woven body verbatim.
            EntityType::JournalEntry => EntityTypeSpec {
                entity_type: self,
                stored_type: "journal_entry",
                schema_version: 1,
                noun: "Journal Entry",
                projection: EntityProjectionPolicy::None,
                data_core: None,
                create_source_directive: false,
                create_normalize: IDENTITY_NORMALIZE,
            },
            EntityType::Person => EntityTypeSpec {
                entity_type: self,
                stored_type: "person",
                schema_version: 1,
                noun: "Person",
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: Some("aliases"),
                }),
                data_core: Some(EntityType::person_core),
                create_source_directive: true,
                create_normalize: NormalizePolicy {
                    // `source_journal_entry_id` is a provenance directive, never
                    // Person data — strip it before storing (validate already
                    // accepted it). A `null` optional field carries no value to
                    // store (ADR-0033).
                    strip: &["source_journal_entry_id"],
                    drop_nulls: true,
                    post: None,
                    extract: None,
                },
            },
            EntityType::Project => EntityTypeSpec {
                entity_type: self,
                stored_type: "project",
                schema_version: 1,
                noun: "Project",
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: None,
                }),
                data_core: Some(EntityType::project_core),
                create_source_directive: true,
                create_normalize: NormalizePolicy {
                    // `source_journal_entry_id` is provenance, never Project
                    // data. Null-drop precedes the review-default seeding so a
                    // `null` review field is treated as absent (and thus seeded
                    // for an active Project) — see `project_create_defaults`.
                    strip: &["source_journal_entry_id"],
                    drop_nulls: true,
                    post: Some(project_create_defaults),
                    extract: None,
                },
            },
            // Todo's data core is Mode-split (full create vs the `update_todo`
            // partial envelope), so `data_core` is None and its payload arms
            // stay explicit; its create unwraps the `{todo, person_refs?}`
            // envelope and defaults `status`.
            EntityType::Todo => EntityTypeSpec {
                entity_type: self,
                stored_type: "todo",
                schema_version: 1,
                noun: "Todo",
                projection: EntityProjectionPolicy::ReferenceAndSearch(EntityProjectionSpec {
                    label_field: "title",
                    aliases_field: None,
                }),
                data_core: None,
                create_source_directive: true,
                create_normalize: NormalizePolicy {
                    strip: &[],
                    drop_nulls: false,
                    post: Some(todo_create_defaults),
                    extract: Some(todo_envelope_extract),
                },
            },
            EntityType::Media => EntityTypeSpec {
                entity_type: self,
                stored_type: "media",
                schema_version: 1,
                noun: "Media",
                projection: EntityProjectionPolicy::None,
                data_core: Some(EntityType::media_core),
                create_source_directive: false,
                create_normalize: NormalizePolicy {
                    // A `null` optional field carries no value to store
                    // (ADR-0033). No envelope, no defaults.
                    strip: &[],
                    drop_nulls: true,
                    post: None,
                    extract: None,
                },
            },
            EntityType::Habit => EntityTypeSpec {
                entity_type: self,
                stored_type: "habit",
                schema_version: 1,
                noun: "Habit",
                projection: EntityProjectionPolicy::Search(EntityProjectionSpec {
                    label_field: "name",
                    aliases_field: None,
                }),
                data_core: Some(EntityType::habit_core),
                create_source_directive: false,
                create_normalize: NormalizePolicy {
                    strip: &[],
                    drop_nulls: true,
                    post: None,
                    extract: None,
                },
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
            "media" => Some(EntityType::Media),
            "habit" => Some(EntityType::Habit),
            _ => None,
        }
    }

    /// Whether a Journal Entry body may reference this Entity Type (ADR-0030):
    /// People, Projects, and Todos are referenceable; Journal Entries,
    /// Media, and Habits are not. A new Entity Type must declare its
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

/// One relation-bearing observation schema's link to an Entity Type (ADR-0053).
/// A relation-bearing observation stores a target Entity id in a `values_json`
/// field (`json_field`); the write path checks the target exists and is `target`,
/// and the read/lifecycle consumers (the `related_entity_id` query filter; the
/// delete-block) dispatch off this same closed table. The single source of truth
/// for relation descriptors — adding a relation-bearing schema is one entry here,
/// not edits scattered across the write path, the query filter, and the
/// delete-block. Sited beside [`EntityType`] (the `db`-read policy leaf) so `db`
/// reads it without importing `crate::observations`.
///
/// Delete behavior is uniformly *block* today (deleting a `target` entity is
/// rejected while any live or historical observation references it; ADR-0056). A
/// descriptor here auto-inherits that block — there is no per-descriptor opt-out.
/// If a future schema needs a different policy (cascade/allow), the seam is a
/// `delete_behavior` field on this struct; don't add it speculatively (AGENTS.md §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ObservationRelation {
    pub schema_key: &'static str,
    pub json_field: &'static str,
    pub target: EntityType,
}

pub(crate) const OBSERVATION_RELATIONS: &[ObservationRelation] = &[ObservationRelation {
    schema_key: "habit.checkin",
    json_field: "habit_id",
    target: EntityType::Habit,
}];

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

    /// The Media data-field core (ADR-0059): a required `title`, a required
    /// `medium` and lifecycle `state` enum, a clearable `rating`/`finished_at`
    /// log pair, clearable string `url`/`note`, and a clearable `tags` array. The
    /// single source `validate_media` and the user-CRUD path both derive from.
    /// The `rating` 1..=5 cap and the state↔finish-data cross-field rule are the
    /// `media_state_finish_invariant` hook's job, not the spec's.
    fn media_core() -> Vec<Field> {
        vec![
            Field::required("title", FieldSpec::non_empty_string()),
            Field::required("medium", media_medium_enum()),
            Field::required("state", media_state_enum()),
            Field::optional("rating", FieldSpec::PositiveInt).clearable(),
            clearable_datetime("finished_at"),
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

/// The Media `medium` enum (ADR-0059): what kind of thing the queue entry is.
fn media_medium_enum() -> FieldSpec {
    FieldSpec::EnumStr {
        domain: &["link", "article", "book", "tv", "movie"],
        err: "medium must be one of link, article, book, tv, movie",
    }
}

/// The Media `state` enum (ADR-0059): the queue→log lifecycle. `done`/`abandoned`
/// are the terminal states the finish-data invariant gates `rating`/`finished_at`
/// on.
fn media_state_enum() -> FieldSpec {
    FieldSpec::EnumStr {
        domain: &["backlog", "consuming", "done", "abandoned"],
        err: "state must be one of backlog, consuming, done, abandoned",
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
            // ── Regular create/update kinds (Person/Project + the user-CRUD-only
            // Media/Habit): the spec row frames the data core; the row's
            // `create_source_directive` flag decides the provenance field. ──
            M::CreatePerson | M::CreateProject | M::CreateMedia | M::CreateHabit => {
                self.describe().entity_type.spec().create_payload()
            }
            M::UpdatePerson | M::UpdateProject | M::UpdateMedia | M::UpdateHabit => {
                self.describe().entity_type.spec().update_payload()
            }
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
            // ── id-only payloads: the noun is the wire kind, woven into the
            // unsupported-field message. ──
            M::DeleteJournalEntry
            | M::DeletePerson
            | M::DeleteProject
            | M::DeleteTodo
            | M::DeleteMedia
            | M::DeleteHabit
            | M::MarkProjectReviewed => entity_id_only(self.as_wire()),
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
            M::CreatePerson
            | M::UpdatePerson
            | M::CreateProject
            | M::UpdateProject
            | M::CreateMedia
            | M::UpdateMedia
            | M::CreateHabit
            | M::UpdateHabit => self.describe().entity_type.spec().data_payload(),
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

/// The shape of a kind's run-independent target-reference check — which
/// referenced Entities `mutation_target::validate_mutation_target_refs` must
/// resolve against tier 2 BEFORE apply (ADR-0030/0031/0033).
///
/// Design decision (a): the check rides the `Copy` contract as this DECLARATIVE
/// facet, interpreted by one kind-generic driver in `crate::mutation_target`
/// (whose async checkers stay private there) — NOT as a boxed-future fn pointer
/// on the descriptor. Only ~6 shapes exist across all 21 kinds, and the checks
/// need async + a DB pool: plain fn pointers cannot be async, and boxing a
/// future would cost the descriptor its `Copy`. A kind with no run-independent
/// reference declares [`TargetRefs::NoCheck`] explicitly, so a newly-added kind
/// is a COMPILE ERROR in `describe()` until it states its target policy — it can
/// never silently fall through to "no check".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum TargetRefs {
    /// Resolve the optional `source_journal_entry_id` anchor only (the
    /// Person/Project creates).
    SourceAnchor,
    /// The Todo create: the source anchor FIRST, then its `todo.project_id` /
    /// `person_refs` references — sequential, in that order.
    SourceAnchorAndTodoCreateRefs,
    /// `update_todo`'s envelope-aware walk: the `todo_id` primary target, the
    /// set/add person refs, and a supplied `todo.project_id`.
    TodoUpdateRefs,
    /// An update/delete whose only reference is the primary target Entity id,
    /// type-checked against the kind's own Entity Type.
    GenericTarget,
    /// The reference weave: its source Journal Entry (primary anchor) and its
    /// referenceable target Entity.
    ReferenceWeave,
    /// NO run-independent target reference: direct creates with no auxiliary
    /// refs, and `apply_intent_graph` (which owns its graph-level resolution in
    /// the graph apply path).
    NoCheck,
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
    /// Pre-write payload validation for this kind (ADR-0016): the schema walk
    /// plus any cross-field invariant hook. `Err(reason)` surfaces as the
    /// `invalid_params` message on `proposal/decide` / `entity/mutate`.
    /// Design decision (b): the per-kind validator BODIES stay in
    /// `crate::entities`, grouped per Entity Type; the contract references them
    /// here by fn pointer — fn pointers are `Copy`, so the descriptor stays
    /// `Copy` and the contract table stays scannable while bodies keep their
    /// locality.
    pub(crate) validate: fn(&Value) -> Result<(), String>,
    /// Renders the human-readable Decision text the model reads on resume as
    /// the awaited tool's result (ADR-0025 — byte-for-byte sacred). `None` for
    /// the 7 user-only kinds (media, habits, `mark_project_reviewed`), which
    /// never reach the proposal accept path — the accept driver `expect`s, so
    /// a user-only kind arriving there stays a loud bug (the legacy router's
    /// `unreachable!` arm). Bodies live in `crate::entities` per design
    /// decision (b) above; `entity_id` is the freshly minted id on creates
    /// (and the graph anchor), `None` on updates/deletes.
    pub(crate) render_accept: Option<fn(&Value, Option<&str>) -> String>,
    /// The shape of this kind's run-independent target-reference check —
    /// interpreted by `crate::mutation_target`'s kind-generic driver (design
    /// decision (a) — see [`TargetRefs`]).
    pub(crate) target_refs: TargetRefs,
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
    CreateMedia,
    UpdateMedia,
    DeleteMedia,
    CreateHabit,
    UpdateHabit,
    DeleteHabit,
    /// One intent graph (ADR-0042): candidate entities + intended links, resolved
    /// and applied by Core in one atomic transaction. Agent-proposable; the
    /// resolve/apply path lands in a later slice (slice 1 is the schema only).
    ApplyIntentGraph,
}

/// Single source of truth for the wire string ↔ `MutationKind` mapping.
/// Consulted in both directions by `from_wire`/`as_wire`; the round-trip test
/// asserts totality (every kind appears exactly once). The order is the
/// historical wire-insertion order and matches `ProposableMutation::ALL`.
const WIRE: &[(&str, MutationKind)] = &[
    ("create_journal_entry", MutationKind::CreateJournalEntry),
    ("update_journal_entry", MutationKind::UpdateJournalEntry),
    ("delete_journal_entry", MutationKind::DeleteJournalEntry),
    (
        "reference_existing_entity_from_journal_entry",
        MutationKind::ReferenceExistingEntityFromJournalEntry,
    ),
    ("create_person", MutationKind::CreatePerson),
    ("update_person", MutationKind::UpdatePerson),
    ("delete_person", MutationKind::DeletePerson),
    ("create_project", MutationKind::CreateProject),
    ("update_project", MutationKind::UpdateProject),
    ("delete_project", MutationKind::DeleteProject),
    ("mark_project_reviewed", MutationKind::MarkProjectReviewed),
    ("create_todo", MutationKind::CreateTodo),
    ("update_todo", MutationKind::UpdateTodo),
    ("delete_todo", MutationKind::DeleteTodo),
    ("create_media", MutationKind::CreateMedia),
    ("update_media", MutationKind::UpdateMedia),
    ("delete_media", MutationKind::DeleteMedia),
    ("create_habit", MutationKind::CreateHabit),
    ("update_habit", MutationKind::UpdateHabit),
    ("delete_habit", MutationKind::DeleteHabit),
    ("apply_intent_graph", MutationKind::ApplyIntentGraph),
];

impl MutationKind {
    /// Resolve the wire `mutation_kind` string into the closed enum. `None` for
    /// an unknown string — the SINGLE string→type point on each write path. The
    /// user path maps `None` to a client `Invalid`; the agent path (a stored,
    /// already-validated `proposals.mutation_kind`) maps it to `Internal`.
    pub(crate) fn from_wire(s: &str) -> Option<Self> {
        WIRE.iter()
            .find(|(w, _)| *w == s)
            .map(|&(_, kind)| kind)
    }

    /// The wire `mutation_kind` string for this kind. Used for diagnostics and
    /// the `ProposableMutation` ↔ `Input` schema round-trip test.
    pub(crate) fn as_wire(self) -> &'static str {
        WIRE.iter()
            .find(|&&(_, kind)| kind == self)
            .map(|&(w, _)| w)
            .expect("every MutationKind is in the WIRE table")
    }

    /// The single home of the path-independent taxonomy: one contract block per
    /// kind. A new Entity Type adds its per-kind blocks here and the compiler
    /// flags every consumer. Behavior facets (`validate`) are fn pointers into
    /// `crate::entities`, where the per-kind bodies live grouped per Entity Type
    /// (design decision (b) — see [`Descriptor::validate`]).
    pub(crate) fn describe(self) -> Descriptor {
        use crate::entities as v;
        use EntityType as E;
        use MutationKind as M;
        use TargetKey as K;
        use TargetRefs as T;
        use WriteOp as W;
        match self {
            // ── Journal Entry ──
            M::CreateJournalEntry => regular(
                W::Create,
                E::JournalEntry,
                None,
                v::validate_journal_entry,
                Some(v::render_accept_create_journal_entry),
                T::NoCheck,
            ),
            M::UpdateJournalEntry => regular(
                W::Update,
                E::JournalEntry,
                Some(K::EntityId),
                v::validate_update_journal_entry,
                Some(v::render_accept_update_journal_entry),
                T::GenericTarget,
            ),
            M::DeleteJournalEntry => regular(
                W::Delete,
                E::JournalEntry,
                Some(K::EntityId),
                v::validate_delete_journal_entry,
                Some(v::render_accept_delete_journal_entry),
                T::GenericTarget,
            ),
            // ── Person ──
            M::CreatePerson => regular(
                W::Create,
                E::Person,
                None,
                v::validate_create_person,
                Some(v::render_accept_create_person),
                T::SourceAnchor,
            ),
            M::UpdatePerson => regular(
                W::Update,
                E::Person,
                Some(K::EntityId),
                v::validate_update_person,
                Some(v::render_accept_update_person),
                T::GenericTarget,
            ),
            M::DeletePerson => regular(
                W::Delete,
                E::Person,
                Some(K::EntityId),
                v::validate_delete_person,
                Some(v::render_accept_delete_person),
                T::GenericTarget,
            ),
            // ── Project ──
            M::CreateProject => regular(
                W::Create,
                E::Project,
                None,
                v::validate_create_project,
                Some(v::render_accept_create_project),
                T::SourceAnchor,
            ),
            M::UpdateProject => regular(
                W::Update,
                E::Project,
                Some(K::EntityId),
                v::validate_update_project,
                Some(v::render_accept_update_project),
                T::GenericTarget,
            ),
            M::DeleteProject => regular(
                W::Delete,
                E::Project,
                Some(K::EntityId),
                v::validate_delete_project,
                Some(v::render_accept_delete_project),
                T::GenericTarget,
            ),
            // ── Todo ──
            M::CreateTodo => regular(
                W::Create,
                E::Todo,
                None,
                v::validate_todo,
                Some(v::render_accept_create_todo),
                T::SourceAnchorAndTodoCreateRefs,
            ),
            M::DeleteTodo => regular(
                W::Delete,
                E::Todo,
                Some(K::EntityId),
                v::validate_delete_todo,
                Some(v::render_accept_delete_todo),
                T::GenericTarget,
            ),
            // ── Media (user-only: no proposal accept text) ──
            M::CreateMedia => regular(
                W::Create,
                E::Media,
                None,
                v::validate_media,
                None,
                T::NoCheck,
            ),
            M::UpdateMedia => regular(
                W::Update,
                E::Media,
                Some(K::EntityId),
                v::validate_update_media,
                None,
                T::GenericTarget,
            ),
            M::DeleteMedia => regular(
                W::Delete,
                E::Media,
                Some(K::EntityId),
                v::validate_delete_media,
                None,
                T::GenericTarget,
            ),
            // ── Habit (user-only: no proposal accept text) ──
            M::CreateHabit => regular(
                W::Create,
                E::Habit,
                None,
                v::validate_habit,
                None,
                T::NoCheck,
            ),
            M::UpdateHabit => regular(
                W::Update,
                E::Habit,
                Some(K::EntityId),
                v::validate_update_habit,
                None,
                T::GenericTarget,
            ),
            M::DeleteHabit => regular(
                W::Delete,
                E::Habit,
                Some(K::EntityId),
                v::validate_delete_habit,
                None,
                T::GenericTarget,
            ),
            // ── Irregular kinds (comment-held invariants) ──
            // The reference weave writes a new revision of the SOURCE Journal
            // Entry (its body gains the entity_ref), so it is an Update whose
            // target key is `source_entity_id`.
            M::ReferenceExistingEntityFromJournalEntry => Descriptor {
                write_op: W::Update,
                entity_type: E::JournalEntry,
                target_key: Some(K::SourceEntityId),
                validate: v::validate_reference_existing_entity_from_journal_entry,
                render_accept: Some(v::render_accept_reference_existing_entity_from_journal_entry),
                target_refs: T::ReferenceWeave,
            },
            // A read-modify-write of the Project's review fields (ADR-0034): an
            // Update targeting `entity_id`. User-only: no proposal accept text.
            M::MarkProjectReviewed => Descriptor {
                write_op: W::Update,
                entity_type: E::Project,
                target_key: Some(K::EntityId),
                validate: v::validate_mark_project_reviewed,
                render_accept: None,
                target_refs: T::GenericTarget,
            },
            // update_todo's target key is `todo_id` (its envelope wraps a
            // Partial<TodoData> under `todo`), NOT `entity_id`.
            M::UpdateTodo => Descriptor {
                write_op: W::Update,
                entity_type: E::Todo,
                target_key: Some(K::TodoId),
                validate: v::validate_update_todo,
                render_accept: Some(v::render_accept_update_todo),
                target_refs: T::TodoUpdateRefs,
            },
            // A graph spans many entities, so it has NO single target id — like a
            // create, `target_key` is None. `entity_type` is the JE anchor; the
            // graph actually mints many types, so this field is unused until the
            // slice-2 resolver (which loops `apply_entity_mutation` per node with
            // each node's own type). `write_op: Create` keeps the descriptor total
            // and matches the create-and-link-only nature of the kind (ADR-0042).
            // NoCheck: the graph owns its graph-level resolution in the graph
            // apply path, so it carries no run-independent target reference.
            M::ApplyIntentGraph => Descriptor {
                write_op: W::Create,
                entity_type: E::JournalEntry,
                target_key: None,
                validate: v::validate_apply_intent_graph,
                render_accept: Some(v::render_accept_apply_intent_graph),
                target_refs: T::NoCheck,
            },
        }
    }
}

/// Helper for the mechanical rows in `describe`: a pure `(WriteOp, EntityType,
/// TargetKey)` triple plus the kind's validate, render, and target-ref facets.
/// Named explicitly (not a closure) so it reads alongside the irregular arms.
fn regular(
    write_op: WriteOp,
    entity_type: EntityType,
    target_key: Option<TargetKey>,
    validate: fn(&Value) -> Result<(), String>,
    render_accept: Option<fn(&Value, Option<&str>) -> String>,
    target_refs: TargetRefs,
) -> Descriptor {
    Descriptor {
        write_op,
        entity_type,
        target_key,
        validate,
        render_accept,
        target_refs,
    }
}

/// The agent-proposable subset (ADR-0018, ADR-0053): the 15 kinds the Worker may emit via
/// `propose_workspace_mutation`. Carries the agent-path-only policy facets so each is
/// total over exactly the kinds that can reach the accept path — the user-only
/// kind families (`mark_project_reviewed`, media, habits) are simply not in
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
            | MutationKind::CreateMedia
            | MutationKind::UpdateMedia
            | MutationKind::DeleteMedia
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
        // Derived from the WIRE table — no hand-list to drift.
        assert_eq!(
            WIRE.len(),
            21,
            "WIRE table covers all 21 MutationKinds"
        );
        for &(wire_str, kind) in WIRE {
            assert_eq!(
                MutationKind::from_wire(wire_str),
                Some(kind),
                "from_wire({wire_str:?}) resolves"
            );
            assert_eq!(kind.as_wire(), wire_str, "{kind:?} round-trips");
        }
    }

    #[test]
    fn entity_type_spec_registry_is_coherent() {
        // Iterates EntityType::ALL and asserts each spec row is coherent: the
        // spec-driven tables derive correctly and a missing hook on a future
        // kind fails here rather than at runtime.
        for entity_type in EntityType::ALL {
            let spec = entity_type.spec();
            assert_eq!(spec.entity_type, entity_type);
            assert_eq!(
                EntityType::from_str(spec.stored_type),
                Some(entity_type),
                "{:?} stored_type round-trips via from_str",
                entity_type
            );
            assert!(spec.schema_version > 0, "{:?} schema_version positive", entity_type);
            assert!(!spec.noun.is_empty(), "{:?} noun non-empty", entity_type);

            // Regular create/update/delete kinds route through the spec.
            if let Some(core_fn) = spec.data_core {
                let core = core_fn();
                assert!(!core.is_empty(), "{:?} data_core non-empty", entity_type);
            }

            // A create carrying the provenance directive with no envelope
            // extraction must strip it, or it persists into entity data.
            if spec.create_source_directive && spec.create_normalize.extract.is_none() {
                assert!(
                    spec.create_normalize
                        .strip
                        .contains(&"source_journal_entry_id"),
                    "{:?} carries source_journal_entry_id but its create_normalize does not strip it",
                    entity_type
                );
            }
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
            MutationKind::CreateMedia,
            MutationKind::UpdateMedia,
            MutationKind::DeleteMedia,
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
            MutationKind::UpdateMedia,
            MutationKind::DeleteMedia,
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
    fn target_refs_facet_matches_legacy_dispatch_per_kind() {
        use MutationKind as M;
        use TargetRefs as T;
        // Closed-set mapping: the contract's target-ref facet reproduces the
        // legacy `validate_mutation_target_refs` dispatch's exact 6-shape
        // partition of all 21 kinds (in wire order). Person/Project creates
        // resolve only the optional source Journal Entry anchor; a Todo create
        // additionally resolves its project/person refs; update_todo has its own
        // envelope-aware ref walk; every update/delete whose only reference is
        // the primary target rides the generic check; the reference weave
        // resolves both endpoints; and the kinds with NO run-independent target
        // reference declare that explicitly (never a silent fall-through).
        let expected: [(MutationKind, TargetRefs); 21] = [
            (M::CreateJournalEntry, T::NoCheck),
            (M::UpdateJournalEntry, T::GenericTarget),
            (M::DeleteJournalEntry, T::GenericTarget),
            (
                M::ReferenceExistingEntityFromJournalEntry,
                T::ReferenceWeave,
            ),
            (M::CreatePerson, T::SourceAnchor),
            (M::UpdatePerson, T::GenericTarget),
            (M::DeletePerson, T::GenericTarget),
            (M::CreateProject, T::SourceAnchor),
            (M::UpdateProject, T::GenericTarget),
            (M::DeleteProject, T::GenericTarget),
            (M::MarkProjectReviewed, T::GenericTarget),
            (M::CreateTodo, T::SourceAnchorAndTodoCreateRefs),
            (M::UpdateTodo, T::TodoUpdateRefs),
            (M::DeleteTodo, T::GenericTarget),
            (M::CreateMedia, T::NoCheck),
            (M::UpdateMedia, T::GenericTarget),
            (M::DeleteMedia, T::GenericTarget),
            (M::CreateHabit, T::NoCheck),
            (M::UpdateHabit, T::GenericTarget),
            (M::DeleteHabit, T::GenericTarget),
            (M::ApplyIntentGraph, T::NoCheck),
        ];
        assert_eq!(
            expected.len(),
            WIRE.len(),
            "every MutationKind declares its target-ref shape"
        );
        for (kind, shape) in expected {
            assert_eq!(
                kind.describe().target_refs,
                shape,
                "{} declares the legacy dispatch's target-ref shape",
                kind.as_wire()
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
        assert!(!EntityType::Media.is_referenceable());
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
            EntityType::Media.spec().schema_version,
            MEDIA_SCHEMA_VERSION
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
    fn descriptor_validate_facet_matches_legacy_router_per_entity_type() {
        use serde_json::json;
        // One kind per Entity Type: the contract's `validate` facet accepts a
        // valid payload and reproduces the legacy `entities::validate` router's
        // exact error text on an invalid one. The invalid payloads are chosen to
        // exercise each kind's full validator body (spec walk AND, where one
        // exists, the cross-field invariant hook) — no SQLite involved.
        let cases: [(MutationKind, Value, Value, &str); 6] = [
            (
                MutationKind::CreateJournalEntry,
                json!({
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Talked to Alice." }]
                }),
                json!({ "body": [{ "type": "text", "text": "Talked to Alice." }] }),
                "occurred_at is required",
            ),
            (
                MutationKind::CreatePerson,
                json!({ "name": "Alice" }),
                json!({}),
                "name is required",
            ),
            (
                // The invalid case fails the status↔timestamp invariant HOOK
                // (not the spec walk), proving CreateProject's two-step body.
                MutationKind::CreateProject,
                json!({ "name": "Ship v1" }),
                json!({ "name": "Ship v1", "status": "completed" }),
                "completed project requires completed_at",
            ),
            (
                // The invalid case fails inside the `todo` envelope's TodoData
                // hook, proving the envelope unwrap survives on the facet.
                MutationKind::CreateTodo,
                json!({ "todo": { "title": "Email Alice" } }),
                json!({ "todo": { "title": "" } }),
                "title must not be empty",
            ),
            (
                // The invalid case fails the state↔finish-data invariant HOOK.
                MutationKind::CreateMedia,
                json!({ "title": "Dune", "medium": "book", "state": "backlog" }),
                json!({ "title": "Dune", "medium": "book", "state": "backlog", "rating": 5 }),
                "rating is only valid when state is done or abandoned",
            ),
            (
                MutationKind::CreateHabit,
                json!({ "name": "Meditate", "cadence": { "interval": 1, "unit": "day" } }),
                json!({ "name": "Meditate" }),
                "cadence is required",
            ),
        ];
        for (kind, valid, invalid, expected_err) in cases {
            let validate = kind.describe().validate;
            assert_eq!(
                validate(&valid),
                Ok(()),
                "{} accepts a valid payload",
                kind.as_wire()
            );
            assert_eq!(
                validate(&invalid),
                Err(expected_err.to_string()),
                "{} rejects with the router's exact error text",
                kind.as_wire()
            );
        }
    }

    #[test]
    fn descriptor_validate_facet_keeps_id_only_error_nouns_per_kind() {
        use serde_json::json;
        // The id-only kinds (deletes + mark_project_reviewed) share one spec
        // shape but weave their own wire kind into the unsupported-field error —
        // the per-kind facet fns must keep that text byte-identical to the old
        // shared `validate_entity_id_only(kind, _)` dispatch.
        let valid = json!({ "entity_id": "00000000-0000-4000-8000-000000000000" });
        let invalid = json!({
            "entity_id": "00000000-0000-4000-8000-000000000000",
            "extra": 1
        });
        for kind in [
            MutationKind::DeleteJournalEntry,
            MutationKind::DeletePerson,
            MutationKind::DeleteProject,
            MutationKind::DeleteTodo,
            MutationKind::DeleteMedia,
            MutationKind::DeleteHabit,
            MutationKind::MarkProjectReviewed,
        ] {
            let validate = kind.describe().validate;
            assert_eq!(
                validate(&valid),
                Ok(()),
                "{} accepts an id-only payload",
                kind.as_wire()
            );
            assert_eq!(
                validate(&invalid),
                Err(format!("unsupported {} field \"extra\"", kind.as_wire())),
                "{} keeps its wire noun in the error text",
                kind.as_wire()
            );
        }
    }

    #[test]
    fn descriptor_render_accept_facet_matches_legacy_router_per_kind() {
        use serde_json::json;
        // Every renderable kind: the contract's `render_accept` facet reproduces
        // the legacy `entities::render_accept` router's accept text byte-for-byte
        // (ADR-0025 — this prose is the Decision text the resumed model reads).
        // Covers all four delete nouns, so the per-kind delete wrappers cannot
        // drift from the shared body. No SQLite involved.
        let cases: [(MutationKind, Value, Option<&str>, &str); 14] = [
            (
                MutationKind::CreateJournalEntry,
                json!({
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Talked to Alice." }]
                }),
                Some("je-1"),
                "Accepted. Created Journal Entry (entity_id=je-1, occurred_at=2026-06-10T10:30:00, body=Talked to Alice.).",
            ),
            (
                MutationKind::UpdateJournalEntry,
                json!({
                    "occurred_at": "2026-06-10T10:30:00",
                    "body": [{ "type": "text", "text": "Talked to Alice." }]
                }),
                None,
                "Accepted. Updated Journal Entry (occurred_at=2026-06-10T10:30:00, body=Talked to Alice.).",
            ),
            (
                MutationKind::DeleteJournalEntry,
                json!({ "entity_id": "e-1" }),
                None,
                "Accepted. Deleted Journal Entry (entity_id=e-1).",
            ),
            (
                // The reference weave renders both endpoint ids plus the woven
                // body, entity_ref placeholders included.
                MutationKind::ReferenceExistingEntityFromJournalEntry,
                json!({
                    "source_entity_id": "s-1",
                    "target_entity_id": "t-1",
                    "body": [
                        { "type": "text", "text": "See " },
                        { "type": "entity_ref", "ref_id": "t-1" }
                    ]
                }),
                None,
                "Accepted. Referenced Entity (source_entity_id=s-1, target_entity_id=t-1, body=See [entity_ref:t-1]).",
            ),
            (
                MutationKind::CreatePerson,
                json!({ "name": "Alice" }),
                Some("p-1"),
                "Accepted. Created Person (entity_id=p-1, name=Alice).",
            ),
            (
                MutationKind::UpdatePerson,
                json!({ "name": "Alice" }),
                None,
                "Accepted. Updated Person (name=Alice).",
            ),
            (
                MutationKind::DeletePerson,
                json!({ "entity_id": "e-2" }),
                None,
                "Accepted. Deleted Person (entity_id=e-2).",
            ),
            (
                MutationKind::CreateProject,
                json!({ "name": "Ship v1", "status": "active" }),
                Some("pr-1"),
                "Accepted. Created Project (entity_id=pr-1, name=Ship v1, status=active).",
            ),
            (
                MutationKind::UpdateProject,
                json!({ "name": "Ship v1", "status": "completed" }),
                None,
                "Accepted. Updated Project (name=Ship v1, status=completed).",
            ),
            (
                MutationKind::DeleteProject,
                json!({ "entity_id": "e-3" }),
                None,
                "Accepted. Deleted Project (entity_id=e-3).",
            ),
            (
                // CreateTodo reads title/status through the `{todo}` envelope.
                MutationKind::CreateTodo,
                json!({ "todo": { "title": "Email Alice", "status": "active" } }),
                Some("td-1"),
                "Accepted. Created Todo (entity_id=td-1, title=Email Alice, status=active).",
            ),
            (
                MutationKind::UpdateTodo,
                json!({ "todo_id": "td-9", "todo": { "status": "done" } }),
                None,
                "Accepted. Updated Todo (todo_id=td-9).",
            ),
            (
                MutationKind::DeleteTodo,
                json!({ "entity_id": "e-4" }),
                None,
                "Accepted. Deleted Todo (entity_id=e-4).",
            ),
            (
                // JE-less graph: no "with a Journal Entry" note; the count is the
                // PROPOSED node count ("up to N" — some may have been declined).
                MutationKind::ApplyIntentGraph,
                json!({ "entities": [{}, {}] }),
                Some("anchor-1"),
                "Accepted. Applied intent graph (anchor entity_id=anchor-1, up to 2 entities; some may have been declined).",
            ),
        ];
        for (kind, payload, entity_id, expected) in cases {
            let render = kind
                .describe()
                .render_accept
                .expect("renderable kind carries a render facet");
            assert_eq!(
                render(&payload, entity_id),
                expected,
                "{} renders the router's exact accept text",
                kind.as_wire()
            );
        }

        // The with-Journal-Entry graph variant pins the `je_note` branch.
        let render = MutationKind::ApplyIntentGraph
            .describe()
            .render_accept
            .expect("apply_intent_graph carries a render facet");
        assert_eq!(
            render(
                &json!({ "journal_entry": { "body": [] }, "entities": [{}] }),
                Some("anchor-2"),
            ),
            "Accepted. Applied intent graph with a Journal Entry (anchor entity_id=anchor-2, up to 1 entities; some may have been declined).",
            "apply_intent_graph notes the Journal Entry when one is proposed"
        );
    }

    #[test]
    fn descriptor_render_accept_facet_partitions_user_only_kinds() {
        use MutationKind as M;
        // The 7 user-only kinds never reach the proposal accept path (they
        // arrive via `entity/mutate` only), so the contract carries no renderer
        // — the accept driver's `expect` keeps "user-only kind on the accept
        // path" a loud bug, preserving the legacy `unreachable!` arm.
        for kind in [
            M::CreateMedia,
            M::UpdateMedia,
            M::DeleteMedia,
            M::CreateHabit,
            M::UpdateHabit,
            M::DeleteHabit,
            M::MarkProjectReviewed,
        ] {
            assert!(
                kind.describe().render_accept.is_none(),
                "{} is user-only: no proposal accept text",
                kind.as_wire()
            );
        }
        // Every kind on the proposable accept path carries a renderer.
        for kind in [
            M::CreateJournalEntry,
            M::UpdateJournalEntry,
            M::DeleteJournalEntry,
            M::ReferenceExistingEntityFromJournalEntry,
            M::CreatePerson,
            M::UpdatePerson,
            M::DeletePerson,
            M::CreateProject,
            M::UpdateProject,
            M::DeleteProject,
            M::CreateTodo,
            M::UpdateTodo,
            M::DeleteTodo,
            M::ApplyIntentGraph,
        ] {
            assert!(
                kind.describe().render_accept.is_some(),
                "{} renders proposal accept text",
                kind.as_wire()
            );
        }
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
