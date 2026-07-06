//! `thread/*` wire types (create, list, get, rename, archive) and the
//! `thread/get` Segment timeline shapes (ADR-0009 hand-mirror).

use serde::{Deserialize, Serialize};

/// `thread/titled` Notification (ADR-0047): the one-shot titler (ADR-0046) pushes
/// the generated `title` to the connection that created `thread_id`, so its
/// sidebar updates live without a `thread/list` poll. Rides the connection's
/// `out_tx`, keyed by `method` — not a Run subscription.
#[derive(Debug, Serialize)]
pub struct ThreadTitledNotification {
    pub thread_id: String,
    pub title: String,
}

/// `thread/create` params: the first user message (ADR-0022, message-first
/// creation). An empty/whitespace `prompt` is rejected with `invalid_params`;
/// the trim-empty guard lives in [`crate::runs::handle_thread_create`].
#[derive(Debug, Deserialize)]
pub struct ThreadCreateParams {
    pub prompt: String,
}

/// `thread/create` result: the freshly-minted Thread and its first Run
/// (ADR-0022). The Client follows with `run/subscribe(run_id)` to receive
/// events.
#[derive(Debug, Serialize)]
pub struct ThreadCreateResult {
    pub thread_id: String,
    pub run_id: String,
}

/// A Thread row in `thread/list` (ADR-0017 `threads` columns).
/// `last_activity_at` is the ms-epoch the Thread was last touched (bumped per
/// Run); the list orders by it, newest-first.
#[derive(Debug, Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub last_activity_at: i64,
}

/// `thread/list` result: every Thread, most-recent-activity-first. Object-wrapper
/// shape (`{threads: [...]}`) keeps the result forward-extensible.
/// `thread/list_archived` (ADR-0052) reuses this same result type for the
/// archived list (newest-archived-first).
#[derive(Debug, Serialize)]
pub struct ThreadListResult {
    pub threads: Vec<ThreadSummary>,
}

/// `thread/rename` params (ADR-0052): the Thread to rename + its new `title`.
/// Malformed `thread_id` → `invalid_params` (-32602), unknown → `unknown_thread`
/// (-32001); an empty/whitespace `title` is also `invalid_params`.
#[derive(Debug, Deserialize)]
pub struct ThreadRenameParams {
    pub thread_id: uuid::Uuid,
    pub title: String,
}

/// `thread/archive` params (ADR-0052): the Thread to archive (hide from the
/// default sidebar list). Malformed `thread_id` → `invalid_params` (-32602),
/// unknown → `unknown_thread` (-32001).
#[derive(Debug, Deserialize)]
pub struct ThreadArchiveParams {
    pub thread_id: uuid::Uuid,
}

/// `thread/unarchive` params (ADR-0052): the Thread to restore to the default
/// list. Malformed `thread_id` → `invalid_params` (-32602), unknown →
/// `unknown_thread` (-32001).
#[derive(Debug, Deserialize)]
pub struct ThreadUnarchiveParams {
    pub thread_id: uuid::Uuid,
}

/// The shared ack for the three mutating Thread verbs (`thread/rename`,
/// `thread/archive`, `thread/unarchive`, ADR-0052): the affected `thread_id`.
/// Mirrors `EntityMutateResult` but `thread_id` is NON-optional — every mutating
/// verb has a target Thread (the Web reconciles by invalidating its `["threads"]`
/// query and re-reading, so a minimal ack suffices).
#[derive(Debug, Serialize)]
pub struct ThreadMutateResult {
    pub thread_id: String,
}

/// `thread/get` params: the Thread to rehydrate. Malformed `thread_id` →
/// `invalid_params` (-32602), unknown → `unknown_thread` (-32001), as in
/// `run/post_message`.
#[derive(Debug, Deserialize)]
pub struct ThreadGetParams {
    pub thread_id: uuid::Uuid,
}

/// One item in an assistant turn's ordered `segments[]` timeline (ADR-0045): a
/// contiguous run of text, a tool-activity row, or the decided Proposal — replayed
/// in `run_steps` `seq` order so the reload renders the turn's pieces in the order
/// they happened. A `#[serde(tag = "kind")]` snake_case union, modeled on
/// [`RunEvent`]. The variant field shapes are exactly what each row renders — the
/// former `ToolCallView` (`name`/`status`/optional `arg`) and `MessageProposalView`
/// (`proposal_id`/`mutation_kind`/`status`) — inlined here, not wrapped, because the
/// `kind` tag IS the discriminant. The union is left OPEN for a future `reasoning`
/// kind (#202) without reshaping `MessageView`. This SUPERSEDES the read-path shapes
/// of ADR-0043 (`tool_calls`) and ADR-0044 (`proposal`): both fold into `segments`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Segment {
    /// A contiguous run of assistant text (one `message_parts` row).
    Text { text: String },
    /// A settled tool-activity row (ADR-0043): `name`, `status` (`completed`/`error`
    /// — the read filters `pending`), and an optional display `arg`, omitted (not
    /// `null`) for argless tools. Proposal tool calls are NOT emitted here — they
    /// become a `proposal` segment.
    ToolCall {
        name: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arg: Option<String>,
    },
    /// The decided Proposal an assistant turn parked on (ADR-0044). Only
    /// `accepted`/`rejected` appear — a still-`pending` Proposal renders its
    /// interactive card (deferred), a `cancelled` one is cleared live. The Client
    /// looks the live interactive payload up by `proposal_id`; `mutation_kind` drives
    /// the decided card's copy + routing, `status` the accepted-vs-rejected branch,
    /// and `entity_id` (ADR-0044 amendment) the durable Entity the accepted change
    /// created/updated — the anchor for `apply_intent_graph` — so the card can name +
    /// deep-link it. `entity_id` is omitted (not `null`, matching the TS `S.optional`)
    /// for a `rejected` Proposal (nothing created) or when no Entity resolves.
    Proposal {
        proposal_id: String,
        mutation_kind: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        entity_id: Option<String>,
    },
    /// The model's thinking trace (ADR-0045 reasoning amendment, #202): `text` is
    /// the streamed reasoning (one `message_parts.type='reasoning'` row), and
    /// `duration_ms` how long the model thought — Core-computed at read from the
    /// reasoning step's span, omitted (not `null`, matching the TS `S.optional`) when
    /// unknown. Renders default-collapsed; never replayed into the worker transcript.
    Reasoning {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<i64>,
    },
}

/// A Message in a `thread/get` result. `run_id` lets a refreshed Client resubscribe
/// to a `streaming` Message's Run. `terminal_reason` carries how the owning Run
/// settled, so a reload can tell a stopped turn from an errored one. `segments` is
/// the assistant turn's ordered timeline (ADR-0045) — `text | tool_call | proposal`
/// items in `run_steps` order — replacing the prior three independent buckets
/// (`text`, `tool_calls`, `proposal`). A user Message carries a single `text`
/// segment. There is no denormalized flat `text`: the Client derives it via one
/// `concatText(segments)` helper, a single source of truth (ADR-0045).
#[derive(Debug, Serialize)]
pub struct MessageView {
    pub id: String,
    pub role: String,
    pub status: String,
    pub run_id: String,
    /// The owning Run's `terminal_reason` — `'cancelled'` lets the Client
    /// rehydrate a stopped turn calmly (ADR-0014: cancel is not an error);
    /// omitted (not `null`, matching the TS `S.optional`) while the Run is live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    pub segments: Vec<Segment>,
}

/// `thread/get` result: the Thread header plus its Messages in chronological
/// order. A mid-stream Run yields a `streaming` assistant Message with partial
/// text and a `run_id`.
#[derive(Debug, Serialize)]
pub struct ThreadGetResult {
    pub thread_id: String,
    pub title: String,
    pub messages: Vec<MessageView>,
}

/// Mirror tests: lock the Rust serde shapes to the canonical snake_case wire
/// JSON the TS `Schema` definitions in `packages/protocol` produce (ADR-0009).
/// Each test asserts agreement in the type's available direction; a renamed
/// field or changed type fails the matching test. This is the reconciliation
/// point that guards against TS/Rust divergence.
#[cfg(test)]
mod mirror_tests {
    use super::*;
    use serde_json::json;

    // A fixed UUID-shaped string; the wire carries ids as plain strings.
    const UUID_A: &str = "0190d3c1-0000-7000-8000-000000000001";

    #[test]
    fn thread_titled_notification_encodes_full_shape() {
        let n = ThreadTitledNotification {
            thread_id: UUID_A.to_string(),
            title: "Budget planning for Q3".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "thread_id": UUID_A, "title": "Budget planning for Q3" }),
        );
    }

    #[test]
    fn thread_get_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadGetParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        // A non-UUID thread_id is rejected at decode → invalid_params (ADR-0029).
        assert!(serde_json::from_value::<ThreadGetParams>(json!({ "thread_id": "nope" })).is_err());
    }

    #[test]
    fn thread_rename_params_decodes_thread_id_and_title() {
        let wire = json!({ "thread_id": UUID_A, "title": "Renamed thread" });
        let p: ThreadRenameParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert_eq!(p.title, "Renamed thread");
        // A non-UUID thread_id is rejected at decode → invalid_params (ADR-0029).
        assert!(
            serde_json::from_value::<ThreadRenameParams>(
                json!({ "thread_id": "nope", "title": "x" })
            )
            .is_err()
        );
    }

    #[test]
    fn thread_archive_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadArchiveParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert!(
            serde_json::from_value::<ThreadArchiveParams>(json!({ "thread_id": "nope" })).is_err()
        );
    }

    #[test]
    fn thread_unarchive_params_decodes_thread_id() {
        let wire = json!({ "thread_id": UUID_A });
        let p: ThreadUnarchiveParams = serde_json::from_value(wire).unwrap();
        assert_eq!(p.thread_id.to_string(), UUID_A);
        assert!(
            serde_json::from_value::<ThreadUnarchiveParams>(json!({ "thread_id": "nope" }))
                .is_err()
        );
    }
}
