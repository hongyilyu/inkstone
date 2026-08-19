//! `ticktick/*` Web-lane wire types (external-task-views A2): the connection
//! state the Web keys its task query on, and the normalized task rows. Core
//! holds NO task state — these are computed per read from TickTick's OpenAPI
//! (`crate::ticktick::client`). Mirrored in TS (`packages/protocol`). The
//! private OpenAPI transport-decode shapes live in `crate::ticktick::wire`,
//! not here — this module is only the TS-mirrored contract.

use serde::{Deserialize, Serialize};

/// `ticktick/status` result (A5): a `state`-tagged union, so `Connected` ALWAYS
/// carries the opaque, boot-scoped connection ID and `NotConnected` never does
/// — the illegal shapes (connected-without-id, disconnected-with-id) are
/// unrepresentable. The id is the SOLE task-query key; the Web calls this FIRST
/// on every (re)connection and gates task reads on it (A2 reconnect protocol).
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TickTickStatusResult {
    Connected { connection_id: String },
    NotConnected,
}

/// The durable execution state of a TickTick write (ticktick-writes W-A4): the
/// ONE outcome shape carried everywhere the Client can look — the
/// `proposal/decide` response, `proposal/changed`, `proposal/get` (pending),
/// and `Segment::Proposal` — so live and reload render identically for every
/// state. `Proposed` carries the READ-DERIVED staleness (row fingerprint vs
/// the current boot connection's); `Executing` carries the CORE-COMPUTED
/// absolute deadline (`requested_at` + the A7 timeout + grace) because the
/// client has neither `requested_at` nor the timeout knob's value.
/// `Deserialize`/`Clone`: rides `Segment`, which round-trips through
/// `RunEvent::Snapshot`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TickTickWriteState {
    Proposed {
        stale_connection: bool,
    },
    Executing {
        /// Absolute epoch-ms deadline for the bounded client observe-poll.
        deadline_at: i64,
    },
    Created {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
    },
    Failed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        http_status: Option<i64>,
    },
    Unknown,
}

/// A task's single due tuple (external-task-views S1a: start/due COLLAPSE, so
/// there is no separate start). `date` is TickTick's UTC instant string;
/// `is_all_day` + `time_zone` carry the local meaning (never the instant
/// alone). Absent on an undated task.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct TickTickDue {
    pub date: String,
    pub is_all_day: bool,
    pub time_zone: String,
}

/// One checklist sub-item of a `CHECKLIST` task: its title and done flag
/// (TickTick `status` 0 = open, 1 = done).
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct TickTickChecklistItem {
    pub title: String,
    pub done: bool,
}

/// A normalized TickTick task row for the Web Tasks surface (A2). TickTick ids
/// are verbatim; TickTick's "project" is exposed as `list` (Project is an
/// inkstone outcome Entity). `list_name` is the resolved list: a `/project`
/// row's name, the synthetic `"Inbox"` for the `^inbox` sentinel (S1a outcome
/// 1), or `None` for an unmatched id (rendered "unnamed list"). Only `TEXT`
/// and `CHECKLIST` kinds reach here (NOTE is discarded upstream).
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct TickTickTaskRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_name: Option<String>,
    pub title: String,
    pub kind: String,
    pub priority: i64,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<TickTickDue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_flag: Option<String>,
    pub checklist_items: Vec<TickTickChecklistItem>,
}

/// `ticktick/tasks/list` result (A2): the normalized rows plus the truncation
/// signal. `source_limit_reached` is computed on the RAW row count BEFORE kind
/// filtering (a 200-row response can normalize to fewer visible tasks — the
/// signal must survive NOTE filtering), so the Tasks UI can warn that the view
/// may be incomplete.
#[derive(Debug, Serialize)]
pub struct TickTickTasksListResult {
    pub tasks: Vec<TickTickTaskRow>,
    pub source_limit_reached: bool,
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_connected_and_not_connected_shapes() {
        // Connected ALWAYS carries the id (the union makes id-less connected
        // unrepresentable); not_connected is just the tag.
        assert_eq!(
            serde_json::to_value(TickTickStatusResult::Connected {
                connection_id: "conn-1".to_string(),
            })
            .unwrap(),
            json!({ "state": "connected", "connection_id": "conn-1" })
        );
        assert_eq!(
            serde_json::to_value(TickTickStatusResult::NotConnected).unwrap(),
            json!({ "state": "not_connected" })
        );
    }

    /// Every `TickTickWriteState` variant's wire shape, pinned (W-A4): the
    /// tag is `state`, per-variant fields ride flat, and absent optionals are
    /// OMITTED (never null).
    #[test]
    fn write_state_shapes() {
        for (value, expected) in [
            (
                TickTickWriteState::Proposed {
                    stale_connection: true,
                },
                json!({ "state": "proposed", "stale_connection": true }),
            ),
            (
                TickTickWriteState::Executing {
                    deadline_at: 1_755_600_000_000,
                },
                json!({ "state": "executing", "deadline_at": 1_755_600_000_000_i64 }),
            ),
            (
                TickTickWriteState::Created {
                    task_id: Some("tt-task-1".to_string()),
                },
                json!({ "state": "created", "task_id": "tt-task-1" }),
            ),
            (
                TickTickWriteState::Created { task_id: None },
                json!({ "state": "created" }),
            ),
            (
                TickTickWriteState::Failed {
                    http_status: Some(401),
                },
                json!({ "state": "failed", "http_status": 401 }),
            ),
            (
                TickTickWriteState::Failed { http_status: None },
                json!({ "state": "failed" }),
            ),
            (TickTickWriteState::Unknown, json!({ "state": "unknown" })),
        ] {
            assert_eq!(serde_json::to_value(&value).unwrap(), expected);
            // Round-trips (the state rides Segment through RunEvent::Snapshot).
            let back: TickTickWriteState = serde_json::from_value(expected).unwrap();
            assert_eq!(back, value);
        }
    }

    #[test]
    fn task_row_full_and_minimal_shapes() {
        // A maximal CHECKLIST-ish row.
        let full = TickTickTaskRow {
            id: "t1".to_string(),
            list_name: Some("Inbox".to_string()),
            title: "buy milk".to_string(),
            kind: "CHECKLIST".to_string(),
            priority: 3,
            tags: vec!["errand".to_string()],
            due: Some(TickTickDue {
                date: "2026-08-20T17:30:00.000+0000".to_string(),
                is_all_day: false,
                time_zone: "America/Los_Angeles".to_string(),
            }),
            repeat_flag: Some("RRULE:FREQ=DAILY;INTERVAL=1".to_string()),
            checklist_items: vec![TickTickChecklistItem {
                title: "2%".to_string(),
                done: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            json!({
                "id": "t1",
                "list_name": "Inbox",
                "title": "buy milk",
                "kind": "CHECKLIST",
                "priority": 3,
                "tags": ["errand"],
                "due": {
                    "date": "2026-08-20T17:30:00.000+0000",
                    "is_all_day": false,
                    "time_zone": "America/Los_Angeles"
                },
                "repeat_flag": "RRULE:FREQ=DAILY;INTERVAL=1",
                "checklist_items": [{ "title": "2%", "done": true }]
            })
        );
        // A minimal undated TEXT row with an unmatched list: optionals omitted.
        let minimal = TickTickTaskRow {
            id: "t2".to_string(),
            list_name: None,
            title: "think".to_string(),
            kind: "TEXT".to_string(),
            priority: 0,
            tags: vec![],
            due: None,
            repeat_flag: None,
            checklist_items: vec![],
        };
        assert_eq!(
            serde_json::to_value(&minimal).unwrap(),
            json!({
                "id": "t2",
                "title": "think",
                "kind": "TEXT",
                "priority": 0,
                "tags": [],
                "checklist_items": []
            })
        );
    }

    #[test]
    fn tasks_list_result_shape() {
        assert_eq!(
            serde_json::to_value(TickTickTasksListResult {
                tasks: vec![],
                source_limit_reached: true,
            })
            .unwrap(),
            json!({ "tasks": [], "source_limit_reached": true })
        );
    }
}
