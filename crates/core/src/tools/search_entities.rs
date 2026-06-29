//! The `search_entities` tool. Looks up accepted People, Projects, Todos, and
//! Habits by type and a case-insensitive substring query, returning compact
//! lookup rows. Search is over accepted entities only (via
//! `crate::db::list_by_type`); the tool exposes no arbitrary SQL or table-level
//! CRUD.

use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::ToolError;
use crate::mutation::{EntityProjectionSpec, EntityType, EntityTypeSpec};
use crate::protocol::{AgentToolResult, CoreToolDescriptor, ToolTextContent};

pub const NAME: &str = "search_entities";
const DESCRIPTION: &str = "Search accepted People, Projects, Todos, and Habits by type and query; returns compact lookup rows.";
const LABEL: &str = "Search entities";

/// Default and hard-cap on how many compact rows to return.
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;

/// `search_entities`'s arguments. Core re-validates the model's args against
/// this struct on receipt (ADR-0018).
#[derive(Debug, Deserialize)]
pub struct Input {
    #[serde(rename = "type")]
    pub r#type: String,
    pub query: String,
    pub limit: Option<u32>,
}

fn searchable_spec(type_str: &str) -> Result<(EntityTypeSpec, EntityProjectionSpec), ToolError> {
    EntityType::from_str(type_str)
        .map(EntityType::spec)
        .and_then(|spec| {
            spec.search_projection()
                .map(|projection| (spec, projection))
        })
        .ok_or_else(|| ToolError {
            code: "invalid_params".to_string(),
            message: format!("entity type {type_str:?} is not searchable"),
        })
}

fn searchable_type_values() -> Vec<&'static str> {
    EntityType::searchable_specs()
        .map(|(spec, _projection)| spec.stored_type)
        .collect()
}

/// The display argument for a `search_entities` tool-activity row (ADR-0043):
/// the search `query`. `None` for a malformed payload or an empty query (an
/// empty query matches all, so it has no meaningful label).
pub fn display_arg(params: &Value) -> Option<String> {
    let input: Input = serde_json::from_value(params.clone()).ok()?;
    searchable_spec(&input.r#type).ok()?;
    let query = input.query.trim();
    if query.is_empty() {
        None
    } else {
        Some(query.to_string())
    }
}

pub fn descriptor() -> CoreToolDescriptor {
    CoreToolDescriptor {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        label: LABEL.to_string(),
        json_schema: json!({
            "type": "object",
            "required": ["type", "query"],
            "properties": {
                "type": {
                    "type": "string",
                    "enum": searchable_type_values(),
                },
                "query": { "type": "string" },
                "limit": {
                    "type": "integer",
                    "format": "uint32",
                    "minimum": 0,
                },
            },
        }),
    }
}

/// Search accepted entities of the requested `type` whose label — or, for a
/// person, any alias — contains `query` (case-insensitive); an empty `query`
/// matches all. Returns up to `limit` compact lookup rows `{ id, type, label,
/// aliases? }` as a `{ "results": [...] }` text payload. Search is over
/// accepted entities only (`crate::db::list_by_type`).
pub async fn execute(pool: &SqlitePool, params: Value) -> Result<AgentToolResult, ToolError> {
    let input: Input = serde_json::from_value(params).map_err(|e| ToolError {
        code: "invalid_params".to_string(),
        message: e.to_string(),
    })?;

    let (spec, projection) = searchable_spec(&input.r#type)?;
    let label_key = projection.label_field;
    let aliases_field = projection.aliases_field;
    let needle = input.query.to_lowercase();
    let limit = input
        .limit
        .map(|n| (n as usize).min(MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT);

    let rows = crate::db::list_by_type(pool, spec.stored_type)
        .await
        .map_err(|e| ToolError {
            code: "internal".to_string(),
            message: e.to_string(),
        })?;

    let results = rows
        .into_iter()
        .filter_map(|row| {
            let label = row.data.get(label_key).and_then(Value::as_str);
            let aliases: Vec<String> = aliases_field
                .and_then(|field| row.data.get(field))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();

            let matches = needle.is_empty()
                || label.is_some_and(|l| l.to_lowercase().contains(&needle))
                || aliases.iter().any(|a| a.to_lowercase().contains(&needle));
            if !matches {
                return None;
            }

            let mut compact = serde_json::Map::new();
            compact.insert("id".to_string(), Value::String(row.id));
            compact.insert("type".to_string(), Value::String(row.r#type));
            compact.insert(
                "label".to_string(),
                label
                    .map(|l| Value::String(l.to_string()))
                    .unwrap_or(Value::Null),
            );
            if aliases_field.is_some() && !aliases.is_empty() {
                compact.insert(
                    "aliases".to_string(),
                    Value::Array(aliases.into_iter().map(Value::String).collect()),
                );
            }
            Some(Value::Object(compact))
        })
        .take(limit)
        .collect::<Vec<_>>();

    let payload = serde_json::json!({ "results": results });
    Ok(AgentToolResult {
        content: vec![ToolTextContent {
            r#type: "text".to_string(),
            text: payload.to_string(),
        }],
        details: None,
        terminate: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A migrated in-memory pool, mirroring `db::tests::memory_pool`.
    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    /// Seed one accepted entity (`created_by='user'`, no proposal) of `type`.
    async fn seed_entity(pool: &SqlitePool, id: &str, r#type: &str, data: &str) {
        sqlx::query(
            "INSERT INTO entities \
             (id, type, schema_version, data, created_by, created_via_proposal_id, \
              created_at, updated_at) \
             VALUES (?, ?, 1, ?, 'user', NULL, ?, ?)",
        )
        .bind(id)
        .bind(r#type)
        .bind(data)
        .bind(1_i64)
        .bind(1_i64)
        .execute(pool)
        .await
        .expect("seed entity");
    }

    fn results(out: &AgentToolResult) -> Vec<Value> {
        let payload: Value = serde_json::from_str(&out.content[0].text).expect("payload is JSON");
        payload["results"]
            .as_array()
            .expect("results array")
            .clone()
    }

    #[tokio::test]
    async fn person_search_matches_name_and_alias_excludes_others() {
        let pool = memory_pool().await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000001",
            "person",
            r#"{"name":"Alice Andrews","aliases":["Al"]}"#,
        )
        .await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000002",
            "person",
            r#"{"name":"Bob"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000003",
            "project",
            r#"{"name":"Ship API v2"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000004",
            "todo",
            r#"{"title":"email Alice"}"#,
        )
        .await;

        // Match by name substring (case-insensitive): "ali" -> Alice only.
        let out = execute(&pool, json!({ "type": "person", "query": "ali" }))
            .await
            .expect("search ok");
        let rows = results(&out);
        assert_eq!(rows.len(), 1, "only Alice matches 'ali', got {rows:?}");
        assert_eq!(rows[0]["id"], "00000000-0000-4000-8000-000000000001");
        assert_eq!(rows[0]["type"], "person");
        assert_eq!(rows[0]["label"], "Alice Andrews");
        assert_eq!(rows[0]["aliases"], json!(["Al"]));

        // Match by alias ALONE: query a substring the NAME does not contain, so
        // only the alias branch can produce the hit. "Alice Andrews" has no "ac";
        // alias "AC" does. This isolates the alias-matching branch — a regression
        // that ignored aliases would return zero rows here.
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000005",
            "person",
            r#"{"name":"Grace Hopper","aliases":["AC"]}"#,
        )
        .await;
        let out = execute(&pool, json!({ "type": "person", "query": "ac" }))
            .await
            .expect("search ok");
        let rows = results(&out);
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(
            rows.len(),
            1,
            "only the aliased Grace matches 'ac' (name has no 'ac'), got {rows:?}"
        );
        assert!(
            ids.contains(&"00000000-0000-4000-8000-000000000005"),
            "alias-only match returns Grace, got {rows:?}"
        );
    }

    #[tokio::test]
    async fn todo_matches_title_project_matches_name_no_aliases() {
        let pool = memory_pool().await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000010",
            "project",
            r#"{"name":"Ship API v2"}"#,
        )
        .await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000011",
            "todo",
            r#"{"title":"email Alice"}"#,
        )
        .await;

        // Project label comes from data.name; no aliases key on non-person rows.
        let out = execute(&pool, json!({ "type": "project", "query": "api" }))
            .await
            .expect("search ok");
        let rows = results(&out);
        assert_eq!(rows.len(), 1, "one project matches 'api', got {rows:?}");
        assert_eq!(rows[0]["label"], "Ship API v2");
        assert!(
            rows[0].get("aliases").is_none(),
            "non-person rows omit aliases, got {rows:?}"
        );

        // Todo label comes from data.title.
        let out = execute(&pool, json!({ "type": "todo", "query": "EMAIL" }))
            .await
            .expect("search ok");
        let rows = results(&out);
        assert_eq!(rows.len(), 1, "one todo matches 'EMAIL', got {rows:?}");
        assert_eq!(rows[0]["label"], "email Alice");
    }

    #[tokio::test]
    async fn habit_matches_name_and_omits_aliases() {
        let pool = memory_pool().await;
        seed_entity(
            &pool,
            "00000000-0000-4000-8000-000000000012",
            "habit",
            r#"{"name":"Morning walk","cadence":{"interval":1,"unit":"day"}}"#,
        )
        .await;

        let out = execute(&pool, json!({ "type": "habit", "query": "walk" }))
            .await
            .expect("search ok");
        let rows = results(&out);
        assert_eq!(rows.len(), 1, "one habit matches 'walk', got {rows:?}");
        assert_eq!(rows[0]["type"], "habit");
        assert_eq!(rows[0]["label"], "Morning walk");
        assert!(
            rows[0].get("aliases").is_none(),
            "habits omit aliases, got {rows:?}"
        );
    }

    #[tokio::test]
    async fn empty_query_returns_all_of_type_and_limit_caps() {
        let pool = memory_pool().await;
        for i in 0..5 {
            seed_entity(
                &pool,
                &format!("00000000-0000-4000-8000-00000000002{i}"),
                "person",
                &format!(r#"{{"name":"Person {i}"}}"#),
            )
            .await;
        }

        // Empty query matches every accepted person of the type.
        let out = execute(&pool, json!({ "type": "person", "query": "" }))
            .await
            .expect("search ok");
        assert_eq!(results(&out).len(), 5, "empty query returns all five");

        // limit caps the count after filtering.
        let out = execute(&pool, json!({ "type": "person", "query": "", "limit": 2 }))
            .await
            .expect("search ok");
        assert_eq!(results(&out).len(), 2, "limit caps the result count");
    }

    #[tokio::test]
    async fn limit_defaults_to_20_and_clamps_at_50() {
        let pool = memory_pool().await;
        // Seed more than MAX_LIMIT so the default and the hard cap are observable
        // (with ≤50 rows neither branch would be distinguishable).
        for i in 0..60 {
            seed_entity(
                &pool,
                &format!("00000000-0000-4000-8000-0000000003{i:02}"),
                "person",
                &format!(r#"{{"name":"Person {i:02}"}}"#),
            )
            .await;
        }

        // No `limit` → DEFAULT_LIMIT (20), not all 60.
        let out = execute(&pool, json!({ "type": "person", "query": "" }))
            .await
            .expect("search ok");
        assert_eq!(
            results(&out).len(),
            DEFAULT_LIMIT,
            "absent limit returns DEFAULT_LIMIT rows"
        );

        // An over-large `limit` is clamped to MAX_LIMIT (50), never 1000.
        let out = execute(
            &pool,
            json!({ "type": "person", "query": "", "limit": 1000 }),
        )
        .await
        .expect("search ok");
        assert_eq!(
            results(&out).len(),
            MAX_LIMIT,
            "an over-large limit is clamped to MAX_LIMIT"
        );
    }

    #[tokio::test]
    async fn invalid_type_is_invalid_params() {
        let pool = memory_pool().await;
        let err = execute(&pool, json!({ "type": "journal_entry", "query": "x" }))
            .await
            .expect_err("journal_entry is not a searchable type");
        assert_eq!(err.code, "invalid_params");
    }

    #[test]
    fn display_arg_returns_trimmed_query_or_none() {
        // A non-empty query is the display arg, trimmed (ADR-0043).
        assert_eq!(
            display_arg(&json!({ "type": "person", "query": "  Lev  " })),
            Some("Lev".to_string())
        );
        // An empty / whitespace-only query matches all, so it has no label.
        assert_eq!(display_arg(&json!({ "type": "person", "query": "" })), None);
        assert_eq!(
            display_arg(&json!({ "type": "person", "query": "   " })),
            None
        );
        // A malformed payload (missing required fields) yields None, not a panic.
        assert_eq!(display_arg(&json!({})), None);
        assert_eq!(display_arg(&json!({ "query": "x" })), None);
        assert_eq!(
            display_arg(&json!({ "type": "journal_entry", "query": "x" })),
            None
        );
        // media is a real Entity Type but not searchable (projection None), so it
        // also has no display label.
        assert_eq!(
            display_arg(&json!({ "type": "media", "query": "x" })),
            None
        );
    }

    #[test]
    fn descriptor_has_name_label_and_type_enum() {
        let d = descriptor();
        assert_eq!(d.name, "search_entities");
        assert_eq!(d.label, "Search entities");
        assert_eq!(d.json_schema["type"], json!("object"));
        assert!(
            d.json_schema["properties"]["type"].is_object(),
            "schema describes the type property, got {}",
            d.json_schema
        );
        // The `type` field enum is generated from EntityTypeSpec searchable rows.
        let enum_values = &d.json_schema["properties"]["type"]["enum"];
        assert_eq!(
            enum_values,
            &json!(["person", "project", "todo", "habit"]),
            "type is a closed searchable Entity Type enum, got {}",
            d.json_schema
        );
    }
}
