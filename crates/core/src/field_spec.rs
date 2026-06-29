//! The single source of each Entity Type's field shape (card 2 of the
//! Entity-Type refactor). One [`PayloadSpec`] per Entity Type's data core drives
//! BOTH the agent tool schema (the Draft-07 fragment [`PayloadSpec::json_schema`]
//! emits) AND the runtime validators ([`PayloadSpec::check`]) — so a renamed or
//! added field is one edit with a compiler tie, not a hand-mirrored
//! struct/validator pair.
//!
//! The split (ADR-0018, ADR-0033):
//! - **shape + scalar facts** (which keys exist, required vs optional, type,
//!   non-emptiness, enum domain, UUID/datetime parse, clearable-null) live in the
//!   spec and are checked by the generic [`PayloadSpec::check`] walk.
//! - **cross-field invariants** (status↔timestamp, the recurrence anchor-presence
//!   and inter-field couplings, exactly-one entity_ref, `ended_at >= occurred_at`)
//!   are NOT expressible as a flat field walk and stay as hand-written hooks in
//!   [`crate::entities`], run after `check`.
//!
//! Where the *advertised schema* and the *validation rule* historically diverge
//! (a bare-string `entity_id` the validator nonetheless UUID-checks; an `aliases`
//! element the schema leaves unconstrained but the validator requires non-empty),
//! the spec carries the two facts separately and faithfully — single-sourcing the
//! field's existence without forcing schema == validator.

use serde_json::{Map, Value};

use crate::entities::parse_local_datetime;

/// The standard `description` schemars emitted for every local wall-clock field,
/// surfaced to the Worker so the model knows the expected literal format. The
/// `descriptor_describes_create_journal_entry_payload` test pins that this
/// substring appears in the schema.
const LOCAL_DATETIME_DESCRIPTION: &str = "Local wall-clock time in YYYY-MM-DDTHH:MM:SS format.";

/// The `YYYY-MM-DDTHH:MM:SS` regex the deleted `#[schemars(regex(...))]`
/// attributes carried on every local-datetime field.
const LOCAL_DATETIME_PATTERN: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$";

/// The canonical UUID pattern the reference/source id fields advertise. UUID-shaped
/// ids the schema leaves bare (`entity_id`, `todo_id`) still validate via
/// [`FieldSpec::Uuid`] with `schema_regex: false`.
const UUID_PATTERN: &str =
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/// Whether a field must be present. A `Required` field missing from the payload
/// is an error; an `Optional` field absent is fine. Optionality also drives the
/// emitted schema's `required` array.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Presence {
    Required,
    Optional,
}

/// How an object spec phrases its "value is not an object" rejection — the
/// hand-written validators are inconsistent and the tests pin the substrings, so
/// each spec carries its style verbatim.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ObjErr {
    /// `"{noun} payload must be a JSON object"` — the top-level person/project/
    /// media/create_todo/update_todo payloads.
    Payload,
    /// `"{noun} must be an object"` — review_every and the recurrence sub-objects.
    Object,
    /// `"{noun} must be a JSON object"` — TodoData and the person_refs element.
    JsonObject,
}

impl ObjErr {
    fn message(self, noun: &str) -> String {
        match self {
            ObjErr::Payload => format!("{noun} payload must be a JSON object"),
            ObjErr::Object => format!("{noun} must be an object"),
            ObjErr::JsonObject => format!("{noun} must be a JSON object"),
        }
    }
}

/// Body-node policy for a Journal-Entry `body` array — which node kinds the
/// tagged `oneOf` union admits, mirroring [`crate::entities`]'s `BodyNodePolicy`.
/// Schema-side only; the per-policy validation (and the exactly-one-entity_ref
/// invariant) lives in the entities hooks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BodyPolicy {
    /// `create_journal_entry`: text nodes only.
    TextOnly,
    /// `update_journal_entry`: text or an `entity_ref` carrying a `ref_id`.
    TextOrExistingRef,
    /// the reference weave: text or a bare `entity_ref` placeholder (no `ref_id`).
    TextOrNewRef,
}

/// The shape of one field's value — the leaf vocabulary the schema generator and
/// the validation walk both read. Clearability (ADR-0033 sentinel-null) is NOT
/// here; it is a [`Field`]-level facet, orthogonal to value shape.
#[derive(Clone, Debug)]
pub(crate) enum FieldSpec {
    /// An impossible field. Used only inside a `oneOf` variant to make the
    /// counterpart key explicitly forbidden in mirrors whose runtime decoder
    /// strips unknown fields even when JSON Schema says `additionalProperties:false`.
    Never,
    /// A string. `non_empty` ⇒ a present value must be non-blank
    /// (`""`/whitespace → "{field} must not be empty"; schema carries
    /// `minLength:1`).
    Str { non_empty: bool },
    /// A positive integer (`>= 1`). Schema: `{type:integer, minimum:1}` — the
    /// advertised bound matches the validator (the deleted structs carried
    /// `#[schemars(range(min = 1))]`), so a provider can't pre-pass an `interval`
    /// of `0` that Core only rejects at decide-time.
    PositiveInt,
    /// A numeric scalar. `integer` switches both the emitted schema type and the
    /// validation rule; `min`/`max`, when present, apply after the type check.
    Number {
        min: Option<f64>,
        max: Option<f64>,
        integer: bool,
    },
    /// A local wall-clock `YYYY-MM-DDTHH:MM:SS` string. Schema carries the regex
    /// pattern + the standard description.
    LocalDateTime,
    /// A UUID string. `schema_regex` ⇒ the advertised schema carries the UUID
    /// pattern + `minLength`/`maxLength` 36 (the reference/source ids); otherwise
    /// the schema is bare `{type:string}` but the validator still parses a UUID
    /// (the `entity_id`/`todo_id` target keys).
    Uuid { schema_regex: bool },
    /// A string drawn from a closed set. `err` is the exact validator message on a
    /// bad value (byte-faithful to the hand-written validators).
    EnumStr {
        domain: &'static [&'static str],
        err: &'static str,
    },
    /// A homogeneous array. The element spec validates each item. `plain_items`
    /// advertises a bare `{type:string}` element even when the element spec would
    /// constrain it (the historical divergence: `aliases`/`tags`/`remove_person_ids`
    /// validate non-empty but advertise plain); validation still runs the element
    /// spec. `min_items` emits and enforces `minItems` for homogeneous arrays that
    /// need non-empty batches.
    Array {
        items: Box<FieldSpec>,
        plain_items: bool,
        min_items: Option<u64>,
    },
    /// A nested object validated by its own [`PayloadSpec`].
    Object(PayloadSpec),
    /// An arbitrary JSON object whose keys are NOT validated here — only that the
    /// value IS an object. Used where the keys are validated LATER against a
    /// schema chosen at runtime (the `observation/update` envelope, whose `values`
    /// are checked against the STORED row's schema, not the wire payload).
    JsonObject,
    /// A nested object accepted by exactly one of a closed set of object shapes.
    /// Used where a small object is itself a tagged-ish choice, such as
    /// observation evidence naming either a Journal Entry source or a Message
    /// source, but not both.
    OneOfObject { variants: Vec<PayloadSpec> },
    /// A nested object whose SCHEMA comes from the spec but whose VALIDATION is
    /// deferred to a hand-written cross-field hook. The recurrence rule (ADR-0037,
    /// slimmed by ADR-0039) is cross-field — `end` cardinality (at most one of
    /// `until`/`after_count`) and the anchor-presence check against the whole Todo
    /// — so a flat walk cannot express it. The schema single-sources from the
    /// spec; `check` is a no-op and the owning entity's hook validates.
    HookValidated(PayloadSpec),
    /// A Journal-Entry `body`: a tagged `oneOf` union of node objects per
    /// [`BodyPolicy`]. The array-level `minItems:1` and per-node shape are emitted
    /// here; cross-node invariants are entities hooks (so `check` is a no-op).
    Body(BodyPolicy),
    /// An array whose every element is one of a closed set of object shapes — a
    /// `oneOf` of inlined [`PayloadSpec`] variants (ADR-0042 intent graph). Emits
    /// `{type:array, items:{oneOf:[…]}}` with the inlined variant schemas (no
    /// `$ref`) and an optional `minItems`. The per-element check accepts the FIRST
    /// variant whose own `check` passes; an element matching none surfaces the
    /// LAST variant's message (the deepest structural error). Cross-element graph
    /// invariants (handle references, duplicate handles, a `journal_ref` without a
    /// `journal_entry` node) are NOT a flat walk — they are the resolver's job in a
    /// later slice, like the other [`FieldSpec::HookValidated`]/[`FieldSpec::Body`]
    /// cross-field rules.
    OneOfArray {
        variants: Vec<PayloadSpec>,
        min_items: Option<u64>,
    },
}

impl FieldSpec {
    /// A non-empty string (names, titles).
    pub(crate) fn non_empty_string() -> Self {
        FieldSpec::Str { non_empty: true }
    }

    /// A may-be-empty string (the full-document `note`/`url`; emptiness unpoliced).
    pub(crate) fn string() -> Self {
        FieldSpec::Str { non_empty: false }
    }

    /// A plain-schema array whose elements validate as non-empty strings but are
    /// advertised bare (`aliases`/`tags`/`remove_person_ids`).
    pub(crate) fn non_empty_string_array() -> Self {
        FieldSpec::Array {
            items: Box::new(FieldSpec::non_empty_string()),
            plain_items: true,
            min_items: None,
        }
    }
}

/// One named field of a [`PayloadSpec`]: its key, presence, clearability, value
/// shape, and the optional schema `description` surfaced to the Worker.
#[derive(Clone, Debug)]
pub(crate) struct Field {
    pub(crate) name: &'static str,
    pub(crate) presence: Presence,
    /// ADR-0033 sentinel-null: a `null` value is the clear directive, accepted
    /// regardless of `spec`. When false, a present `null` falls through to `spec`
    /// (which produces the field's type error).
    pub(crate) clearable: bool,
    pub(crate) spec: FieldSpec,
    pub(crate) description: Option<&'static str>,
}

impl Field {
    pub(crate) fn required(name: &'static str, spec: FieldSpec) -> Self {
        Field {
            name,
            presence: Presence::Required,
            clearable: false,
            spec,
            description: None,
        }
    }

    pub(crate) fn optional(name: &'static str, spec: FieldSpec) -> Self {
        Field {
            name,
            presence: Presence::Optional,
            clearable: false,
            spec,
            description: None,
        }
    }

    /// Mark this (optional) field clearable: `null` is accepted as the ADR-0033
    /// clear directive.
    pub(crate) fn clearable(mut self) -> Self {
        self.clearable = true;
        self
    }

    /// Conditionally clearable — clearable only on the `update_todo` partial path,
    /// concrete-or-absent on the create path.
    pub(crate) fn clearable_when(self, yes: bool) -> Self {
        if yes { self.clearable() } else { self }
    }

    /// Promote this field to required (used where a helper builds an optional
    /// field that a specific kind needs present, e.g. journal `occurred_at`).
    pub(crate) fn require(mut self) -> Self {
        self.presence = Presence::Required;
        self
    }

    /// Attach a schema `description`.
    pub(crate) fn described(mut self, description: &'static str) -> Self {
        self.description = Some(description);
        self
    }

    /// A local wall-clock datetime field carrying the standard description. The
    /// helper most timestamp fields use.
    pub(crate) fn datetime(name: &'static str) -> Self {
        Field::optional(name, FieldSpec::LocalDateTime).described(LOCAL_DATETIME_DESCRIPTION)
    }
}

/// An ordered set of [`Field`]s plus the `noun` woven into the
/// `"unsupported {noun} field {key:?}"` rejection and the `obj_err` style for the
/// "not an object" rejection — the single source of an object's field shape.
/// `additionalProperties` is always denied (every validator and every deleted
/// struct denied unknown fields).
#[derive(Clone, Debug)]
pub(crate) struct PayloadSpec {
    pub(crate) noun: &'static str,
    pub(crate) obj_err: ObjErr,
    pub(crate) fields: Vec<Field>,
}

impl PayloadSpec {
    /// A top-level payload spec (`"{noun} payload must be a JSON object"`).
    pub(crate) fn payload(noun: &'static str, fields: Vec<Field>) -> Self {
        PayloadSpec {
            noun,
            obj_err: ObjErr::Payload,
            fields,
        }
    }

    /// A nested-object spec with an explicit "not an object" style.
    pub(crate) fn nested(noun: &'static str, obj_err: ObjErr, fields: Vec<Field>) -> Self {
        PayloadSpec {
            noun,
            obj_err,
            fields,
        }
    }

    fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }

    /// The inline Draft-07 object schema for this payload (no `$ref`/`definitions`
    /// — ADR-0018 wants inlined schemas; Anthropic rejects `$ref`). Emits
    /// `type:object`, `properties`, the `required` array, and
    /// `additionalProperties:false`.
    pub(crate) fn json_schema(&self) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for field in &self.fields {
            properties.insert(field.name.to_string(), field_schema(field));
            if field.presence == Presence::Required {
                required.push(Value::String(field.name.to_string()));
            }
        }
        let mut obj = Map::new();
        obj.insert("type".to_string(), Value::String("object".to_string()));
        obj.insert("properties".to_string(), Value::Object(properties));
        if !required.is_empty() {
            obj.insert("required".to_string(), Value::Array(required));
        }
        obj.insert("additionalProperties".to_string(), Value::Bool(false));
        Value::Object(obj)
    }

    /// Validate a payload's flat shape against this spec: reject unknown keys,
    /// enforce required presence, and check each present field's value. Returns
    /// the SAME substring messages the hand-written validators returned. Cross-field
    /// invariants are NOT checked here — the caller runs the per-entity hook after.
    pub(crate) fn check(&self, payload: &Value) -> Result<(), String> {
        let obj = payload
            .as_object()
            .ok_or_else(|| self.obj_err.message(self.noun))?;

        for key in obj.keys() {
            if self.field(key).is_none() {
                return Err(format!("unsupported {} field {key:?}", self.noun));
            }
        }

        for field in &self.fields {
            match obj.get(field.name) {
                Some(value) => check_field(field, value)?,
                None => {
                    if field.presence == Presence::Required {
                        return Err(format!("{} is required", field.name));
                    }
                }
            }
        }

        Ok(())
    }
}

/// The schema fragment for one field, threading its `description` in.
fn field_schema(field: &Field) -> Value {
    let mut schema = spec_schema(&field.spec);
    if let Some(description) = field.description
        && let Value::Object(obj) = &mut schema
        && !obj.contains_key("description")
    {
        obj.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }
    schema
}

/// The schema fragment for a [`FieldSpec`], independent of field-level metadata.
fn spec_schema(spec: &FieldSpec) -> Value {
    match spec {
        FieldSpec::Never => serde_json::json!({ "not": {} }),
        FieldSpec::Str { non_empty: true } => {
            serde_json::json!({ "type": "string", "minLength": 1 })
        }
        FieldSpec::Str { non_empty: false }
        | FieldSpec::Uuid {
            schema_regex: false,
        } => {
            serde_json::json!({ "type": "string" })
        }
        FieldSpec::PositiveInt => serde_json::json!({ "type": "integer", "minimum": 1 }),
        FieldSpec::Number { min, max, integer } => {
            let mut obj = Map::new();
            obj.insert(
                "type".to_string(),
                Value::String(if *integer { "integer" } else { "number" }.to_string()),
            );
            if let Some(min) = min {
                obj.insert("minimum".to_string(), number_value(*min));
            }
            if let Some(max) = max {
                obj.insert("maximum".to_string(), number_value(*max));
            }
            Value::Object(obj)
        }
        FieldSpec::LocalDateTime => serde_json::json!({
            "type": "string",
            "pattern": LOCAL_DATETIME_PATTERN,
            "description": LOCAL_DATETIME_DESCRIPTION,
        }),
        FieldSpec::Uuid { schema_regex: true } => serde_json::json!({
            "type": "string",
            "minLength": 36,
            "maxLength": 36,
            "pattern": UUID_PATTERN,
        }),
        FieldSpec::EnumStr { domain, .. } => serde_json::json!({
            "type": "string",
            "enum": domain,
        }),
        FieldSpec::Array {
            items,
            plain_items,
            min_items,
        } => {
            let item_schema = if *plain_items {
                serde_json::json!({ "type": "string" })
            } else {
                spec_schema(items)
            };
            let mut array = Map::new();
            array.insert("type".to_string(), Value::String("array".to_string()));
            array.insert("items".to_string(), item_schema);
            if let Some(min) = min_items {
                array.insert("minItems".to_string(), Value::Number((*min).into()));
            }
            Value::Object(array)
        }
        FieldSpec::Object(spec) | FieldSpec::HookValidated(spec) => spec.json_schema(),
        FieldSpec::JsonObject => serde_json::json!({ "type": "object" }),
        FieldSpec::OneOfObject { variants } => {
            let one_of: Vec<Value> = variants.iter().map(PayloadSpec::json_schema).collect();
            serde_json::json!({ "oneOf": one_of })
        }
        FieldSpec::Body(policy) => body_schema(*policy),
        FieldSpec::OneOfArray {
            variants,
            min_items,
        } => {
            let one_of: Vec<Value> = variants.iter().map(PayloadSpec::json_schema).collect();
            let mut array = Map::new();
            array.insert("type".to_string(), Value::String("array".to_string()));
            if let Some(min) = min_items {
                array.insert("minItems".to_string(), Value::Number((*min).into()));
            }
            array.insert("items".to_string(), serde_json::json!({ "oneOf": one_of }));
            Value::Object(array)
        }
    }
}

/// The tagged `oneOf` body-node union for a [`BodyPolicy`], wrapped as an array
/// with `minItems:1` (every Journal-Entry body must carry at least one node).
fn body_schema(policy: BodyPolicy) -> Value {
    let text_node = serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "type": { "type": "string", "enum": ["text"] },
            "text": { "type": "string", "minLength": 1 },
        },
        "required": ["type", "text"],
    });
    let mut variants = vec![text_node];
    match policy {
        BodyPolicy::TextOnly => {}
        BodyPolicy::TextOrExistingRef => variants.push(serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "type": { "type": "string", "enum": ["entity_ref"] },
                "ref_id": { "type": "string", "minLength": 1 },
            },
            "required": ["type", "ref_id"],
        })),
        BodyPolicy::TextOrNewRef => variants.push(serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "description": "Placeholder rewritten by Core to the generated or reused EntityRef id.",
            "properties": {
                "type": { "type": "string", "enum": ["entity_ref"] },
            },
            "required": ["type"],
        })),
    }
    serde_json::json!({
        "type": "array",
        "minItems": 1,
        "items": { "oneOf": variants },
    })
}

/// Validate one present field's value against its [`Field`], honoring
/// clearability first, then emitting byte-faithful validator messages.
fn check_field(field: &Field, value: &Value) -> Result<(), String> {
    if field.clearable && value.is_null() {
        return Ok(());
    }
    let name = field.name;
    match &field.spec {
        FieldSpec::Never => Err(format!("{name} is not supported")),
        FieldSpec::Str { non_empty } => match value {
            Value::String(s) if !*non_empty || !s.trim().is_empty() => Ok(()),
            Value::String(_) => Err(format!("{name} must not be empty")),
            _ => Err(format!("{name} must be a string")),
        },
        FieldSpec::PositiveInt => match value {
            Value::Number(n) => match n.as_u64() {
                Some(v) if v >= 1 => Ok(()),
                _ => Err(format!("{name} must be a positive integer")),
            },
            _ => Err(format!("{name} must be a positive integer")),
        },
        FieldSpec::Number { min, max, integer } => {
            let Value::Number(n) = value else {
                return Err(format!("{name} must be a number"));
            };
            if *integer && n.as_i64().is_none() && n.as_u64().is_none() {
                return Err(format!("{name} must be an integer"));
            }
            let Some(value) = n.as_f64() else {
                return Err(format!("{name} must be a number"));
            };
            if let Some(min) = min
                && value < *min
            {
                return Err(format!("{name} must be at least {}", format_bound(*min)));
            }
            if let Some(max) = max
                && value > *max
            {
                return Err(format!("{name} must be at most {}", format_bound(*max)));
            }
            Ok(())
        }
        FieldSpec::LocalDateTime => match value {
            Value::String(t) if !t.trim().is_empty() => {
                parse_local_datetime(t, name)?;
                Ok(())
            }
            Value::String(_) => Err(format!("{name} must not be empty")),
            _ => Err(format!("{name} must be a string")),
        },
        FieldSpec::Uuid { .. } => match value {
            Value::String(s) if !s.trim().is_empty() => {
                uuid::Uuid::parse_str(s).map_err(|_| format!("{name} must be a UUID"))?;
                Ok(())
            }
            Value::String(_) => Err(format!("{name} must not be empty")),
            _ => Err(format!("{name} must be a string")),
        },
        FieldSpec::EnumStr { domain, err } => match value {
            Value::String(s) if domain.contains(&s.as_str()) => Ok(()),
            Value::String(_) => Err((*err).to_string()),
            // A non-string enum value is rejected as "{field} must be a string"
            // (distinct from the bad-value domain message), faithful to the
            // hand-written validators.
            _ => Err(format!("{name} must be a string")),
        },
        FieldSpec::Array {
            items, min_items, ..
        } => {
            let array = value
                .as_array()
                .ok_or_else(|| format!("{name} must be an array"))?;
            if let Some(min) = min_items
                && (array.len() as u64) < *min
            {
                return Err(format!("{name} must have at least {min} item(s)"));
            }
            let element = Field {
                name,
                presence: Presence::Required,
                clearable: false,
                spec: (**items).clone(),
                description: None,
            };
            for item in array {
                check_field(&element, item)?;
            }
            Ok(())
        }
        FieldSpec::Object(spec) => spec.check(value),
        FieldSpec::JsonObject => {
            if value.is_object() {
                Ok(())
            } else {
                Err(format!("{name} must be an object"))
            }
        }
        FieldSpec::OneOfObject { variants } => check_one_of(name, variants, value),
        FieldSpec::OneOfArray {
            variants,
            min_items,
        } => {
            let array = value
                .as_array()
                .ok_or_else(|| format!("{name} must be an array"))?;
            if let Some(min) = min_items
                && (array.len() as u64) < *min
            {
                return Err(format!("{name} must have at least {min} item(s)"));
            }
            for item in array {
                check_one_of(name, variants, item)?;
            }
            Ok(())
        }
        // Recurrence: schema only; the owning entity's hook validates the rule.
        FieldSpec::HookValidated(_) | FieldSpec::Body(_) => Ok(()),
    }
}

/// Accept an array element if it matches ANY of the `oneOf` variants. Returns the
/// LAST variant's rejection message when none match — the deepest structural
/// error, faithful to how a Worker reads a failed `oneOf` (the variants are
/// tagged by `type`/`kind`, so the last is the most specific to report).
fn check_one_of(name: &str, variants: &[PayloadSpec], item: &Value) -> Result<(), String> {
    let mut last_err = format!("{name} item matches no allowed variant");
    for variant in variants {
        match variant.check(item) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn number_value(value: f64) -> Value {
    Value::Number(serde_json::Number::from_f64(value).expect("finite FieldSpec::Number bound"))
}

fn format_bound(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod observations_number_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn observations_number_spec_emits_schema_and_rejects_integer_mismatch() {
        let decimal = PayloadSpec::payload(
            "observation values",
            vec![Field::required(
                "kg",
                FieldSpec::Number {
                    min: Some(0.0),
                    max: None,
                    integer: false,
                },
            )],
        );
        assert_eq!(
            decimal.json_schema(),
            json!({
                "type": "object",
                "properties": {
                    "kg": { "type": "number", "minimum": 0.0 }
                },
                "required": ["kg"],
                "additionalProperties": false
            })
        );
        assert!(decimal.check(&json!({ "kg": 72 })).is_ok());
        assert!(decimal.check(&json!({ "kg": 72.4 })).is_ok());

        let reps = PayloadSpec::payload(
            "observation values",
            vec![Field::required(
                "reps",
                FieldSpec::Number {
                    min: Some(1.0),
                    max: Some(500.0),
                    integer: true,
                },
            )],
        );
        assert_eq!(
            reps.json_schema(),
            json!({
                "type": "object",
                "properties": {
                    "reps": { "type": "integer", "minimum": 1.0, "maximum": 500.0 }
                },
                "required": ["reps"],
                "additionalProperties": false
            })
        );
        assert!(reps.check(&json!({ "reps": 12 })).is_ok());
        let reason = reps
            .check(&json!({ "reps": 12.5 }))
            .expect_err("decimal is not an integer");
        assert_eq!(reason, "reps must be an integer");
    }

    #[test]
    fn optional_datetime_and_string_fields_reject_present_null() {
        // Pins the observation envelope's present-`null` rejection messages at the
        // value-spec layer. The `observation/record` path validates each draft via a
        // `oneOf` over the schema variants (`check_one_of` reports the last variant's
        // error), so its RPC-level messages depend on variant order; `observation/update`
        // now validates against a single non-discriminated envelope, so its messages
        // surface directly. Binding the guarantee to the field spec here keeps it stable
        // regardless of either path's variant ordering, so appending a new schema can't
        // silently drop it.
        let spec = PayloadSpec::payload(
            "observation envelope",
            vec![Field::datetime("ended_at"), Field::optional("note", FieldSpec::string())],
        );
        assert_eq!(
            spec.check(&json!({ "ended_at": null }))
                .expect_err("present-null ended_at is rejected"),
            "ended_at must be a string"
        );
        assert_eq!(
            spec.check(&json!({ "note": null }))
                .expect_err("present-null note is rejected"),
            "note must be a string"
        );
    }

    #[test]
    fn json_object_accepts_any_object_and_rejects_non_objects() {
        // The opaque-`values` leaf used by the schema-agnostic observation/update
        // envelope: it type-checks object-ness only; per-field validation runs later
        // against the stored schema.
        let spec = PayloadSpec::payload(
            "update envelope",
            vec![Field::required("values", FieldSpec::JsonObject)],
        );
        assert!(spec.check(&json!({ "values": {} })).is_ok());
        assert!(spec.check(&json!({ "values": { "kg": 71.8 } })).is_ok());
        for non_object in [json!({ "values": "x" }), json!({ "values": 1 }), json!({ "values": [] })] {
            assert_eq!(
                spec.check(&non_object).expect_err("non-object values is rejected"),
                "values must be an object"
            );
        }
    }
}
