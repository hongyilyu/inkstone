//! TickTick OpenAPI transport decode + normalization (external-task-views A2).
//! Private `Raw*` types decode TickTick's JSON; [`normalize`] turns a
//! `/project` list + a `/task/filter` page into `TickTickTaskRow`s and the
//! truncation flag. Pure over its inputs — the unit tests drive it straight
//! from small hand-authored wire values, no HTTP.

use serde::Deserialize;

use crate::protocol::{TickTickChecklistItem, TickTickDue, TickTickTaskRow};

/// TickTick's `/open/v1/task/filter` hard ceiling (S1: the fixed
/// `{"status":[0]}` read returns at most 200 open entries, no cursor). A
/// response AT the cap may be truncated, so the flag is computed on the RAW
/// count before kind filtering (a 200-row page can normalize to fewer visible
/// rows — the signal must survive NOTE removal).
const SOURCE_LIMIT: usize = 200;

/// The synthetic list name for the Inbox (S1a outcome 1): TickTick's Inbox
/// `projectId` is `inbox`-prefixed and never appears in `/project`.
const INBOX_PREFIX: &str = "inbox";

/// `/open/v1/project` row — only `id`/`name` are consumed.
#[derive(Debug, Deserialize)]
pub(super) struct RawProject {
    pub id: String,
    pub name: String,
}

/// One checklist sub-item of a raw task.
#[derive(Debug, Deserialize)]
pub(super) struct RawChecklistItem {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: i64,
}

/// `/open/v1/task/filter` row. Per-kind-absent fields are `#[serde(default)]`
/// (S1 nullability). The due tuple is `due_date`/`is_all_day`/`time_zone`;
/// `start_date` is intentionally NOT decoded (S1a: it always equals due).
/// `rename_all` maps every snake_case field to TickTick's camelCase key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawTask {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_task_kind")]
    pub kind: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub is_all_day: bool,
    #[serde(default)]
    pub time_zone: String,
    #[serde(default)]
    pub repeat_flag: Option<String>,
    #[serde(default)]
    pub items: Vec<RawChecklistItem>,
}

/// TickTick omits `kind` on plain tasks in some responses (the field is
/// optional in its schema): an absent kind IS a plain task, so default `TEXT`
/// rather than `""` (which `normalize`'s TEXT/CHECKLIST filter would drop).
fn default_task_kind() -> String {
    "TEXT".to_string()
}

/// Resolve a task's `project_id` to a display list name (A2): the `^inbox`
/// sentinel → synthetic `"Inbox"` (S1a outcome 1); a `/project` row's name;
/// else `None` (rendered "unnamed list"). The sentinel check comes FIRST
/// because Inbox is never in `/project`.
fn list_name(project_id: &str, projects: &[RawProject]) -> Option<String> {
    if project_id.starts_with(INBOX_PREFIX) {
        return Some("Inbox".to_string());
    }
    projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.name.clone())
}

/// Normalize a `/project` list + a `/task/filter` page into the Web-lane
/// envelope (A2): keep only `TEXT`/`CHECKLIST` (NOTE discarded), map each row's
/// list name, collapse the due tuple, and flag truncation on the RAW count.
pub(super) fn normalize(
    projects: &[RawProject],
    raw_tasks: &[RawTask],
) -> (Vec<TickTickTaskRow>, bool) {
    let source_limit_reached = raw_tasks.len() >= SOURCE_LIMIT;
    let tasks = raw_tasks
        .iter()
        .filter(|t| t.kind == "TEXT" || t.kind == "CHECKLIST")
        .map(|t| TickTickTaskRow {
            id: t.id.clone(),
            list_name: list_name(&t.project_id, projects),
            title: t.title.clone(),
            kind: t.kind.clone(),
            priority: t.priority,
            tags: t.tags.clone(),
            due: t.due_date.as_ref().map(|date| TickTickDue {
                date: date.clone(),
                is_all_day: t.is_all_day,
                time_zone: t.time_zone.clone(),
            }),
            // An empty repeatFlag ("") means "not recurring" — normalize to None.
            repeat_flag: t.repeat_flag.as_ref().filter(|r| !r.is_empty()).cloned(),
            checklist_items: t
                .items
                .iter()
                .map(|i| TickTickChecklistItem {
                    title: i.title.clone(),
                    done: i.status == 1,
                })
                .collect(),
        })
        .collect();
    (tasks, source_limit_reached)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_projects(body: &serde_json::Value) -> Vec<RawProject> {
        serde_json::from_value(body.clone()).expect("projects decode")
    }

    fn decode_tasks(body: &serde_json::Value) -> Vec<RawTask> {
        serde_json::from_value(body.clone()).expect("tasks decode")
    }

    fn raw_task(id: &str, title: &str, kind: &str) -> RawTask {
        RawTask {
            id: id.to_string(),
            project_id: "list-1".to_string(),
            title: title.to_string(),
            kind: kind.to_string(),
            priority: 0,
            tags: vec![],
            due_date: None,
            is_all_day: false,
            time_zone: String::new(),
            repeat_flag: None,
            items: vec![],
        }
    }

    #[test]
    fn full_page_filters_note_and_flags_truncation() {
        let mut raw = (0..199)
            .map(|i| raw_task(&format!("task-{i}"), &format!("Task {i}"), "TEXT"))
            .collect::<Vec<_>>();
        raw.push(raw_task("note-1", "Hidden note", "NOTE"));

        let (tasks, source_limit_reached) = normalize(&[], &raw);
        assert!(source_limit_reached, "a 200-row page flags truncation");
        assert_eq!(tasks.len(), 199, "the one NOTE row is discarded");
        assert!(
            tasks
                .iter()
                .all(|t| t.kind == "TEXT" || t.kind == "CHECKLIST"),
            "only TEXT/CHECKLIST survive"
        );
    }

    /// TickTick's `kind` is optional: a row WITHOUT the field is a plain task
    /// — it must decode as `TEXT` and survive normalization, not default to
    /// `""` and vanish (CodeRabbit #336).
    #[test]
    fn absent_kind_defaults_to_text_and_survives() {
        let raw = decode_tasks(&serde_json::json!([
            { "id": "task-1", "projectId": "list-1", "title": "Plain task" }
        ]));
        assert_eq!(raw[0].kind, "TEXT", "absent kind decodes as TEXT");
        let (tasks, _) = normalize(&[], &raw);
        assert_eq!(tasks.len(), 1, "the kindless row is kept");
        assert_eq!(tasks[0].kind, "TEXT");
    }

    /// A short page (below the cap) does NOT flag truncation.
    #[test]
    fn short_page_does_not_flag_truncation() {
        let mut task = raw_task("t1", "one", "TEXT");
        task.project_id = "missing-list".to_string();
        task.repeat_flag = Some(String::new());

        let (tasks, source_limit_reached) = normalize(&[], &[task]);
        assert!(!source_limit_reached);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].repeat_flag, None, "empty repeatFlag → None");
        assert_eq!(tasks[0].list_name, None, "unmatched id → unnamed list");
    }

    #[test]
    fn contract_cases_normalize_to_expected_rows() {
        let projects = decode_projects(&serde_json::json!([
            { "id": "list-1", "name": "Work" }
        ]));
        let raw = decode_tasks(&serde_json::json!([
            {
                "id": "all-day",
                "projectId": "list-1",
                "title": "All-day task",
                "kind": "TEXT",
                "dueDate": "2026-08-20T07:00:00.000+0000",
                "isAllDay": true,
                "timeZone": "America/Los_Angeles"
            },
            {
                "id": "timed",
                "projectId": "list-1",
                "title": "Timed task",
                "kind": "TEXT",
                "tags": ["advanced"],
                "dueDate": "2026-08-20T17:30:00.000+0000",
                "isAllDay": false,
                "timeZone": "America/Los_Angeles"
            },
            {
                "id": "recurring",
                "projectId": "list-1",
                "title": "Recurring task",
                "kind": "TEXT",
                "repeatFlag": "RRULE:FREQ=DAILY;INTERVAL=1"
            },
            {
                "id": "checklist",
                "projectId": "list-1",
                "title": "Checklist task",
                "kind": "CHECKLIST",
                "items": [
                    { "title": "Open item", "status": 0 },
                    { "title": "Done item", "status": 1 }
                ]
            }
        ]));
        let (tasks, _) = normalize(&projects, &raw);
        let by_title = |title: &str| {
            tasks
                .iter()
                .find(|t| t.title == title)
                .unwrap_or_else(|| panic!("missing {title}"))
                .clone()
        };

        let all_day = by_title("All-day task");
        assert_eq!(
            all_day.due,
            Some(TickTickDue {
                date: "2026-08-20T07:00:00.000+0000".to_string(),
                is_all_day: true,
                time_zone: "America/Los_Angeles".to_string(),
            })
        );
        let timed = by_title("Timed task");
        assert_eq!(
            timed.due,
            Some(TickTickDue {
                date: "2026-08-20T17:30:00.000+0000".to_string(),
                is_all_day: false,
                time_zone: "America/Los_Angeles".to_string(),
            })
        );
        assert_eq!(timed.list_name.as_deref(), Some("Work"));
        assert_eq!(timed.tags, vec!["advanced".to_string()]);
        assert_eq!(
            by_title("Recurring task").repeat_flag.as_deref(),
            Some("RRULE:FREQ=DAILY;INTERVAL=1")
        );
        let checklist = by_title("Checklist task");
        assert_eq!(checklist.kind, "CHECKLIST");
        assert_eq!(
            checklist.checklist_items,
            vec![
                TickTickChecklistItem {
                    title: "Open item".to_string(),
                    done: false
                },
                TickTickChecklistItem {
                    title: "Done item".to_string(),
                    done: true
                },
            ]
        );
    }

    #[test]
    fn inbox_sentinel_maps_to_inbox_list() {
        let raw = decode_tasks(&serde_json::json!([{
            "id": "inbox-task",
            "projectId": "inbox-account-suffix",
            "title": "Inbox task",
            "kind": "TEXT"
        }]));
        let (tasks, _) = normalize(&[], &raw);

        let inbox_task = tasks
            .iter()
            .find(|t| t.title == "Inbox task")
            .expect("the inbox task");
        assert_eq!(
            inbox_task.list_name.as_deref(),
            Some("Inbox"),
            "the ^inbox sentinel maps to the synthetic Inbox list"
        );
    }
}
