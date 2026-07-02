//! Pure serde_json document-mutation over a Journal Entry `body` array, factored
//! out of the intent-graph DB apply path ([`super::intent_graph`]). No pool, no
//! transaction, no graph types — just the placeholder-rewrite, chip-splice, and
//! clause-join primitives the apply orchestration composes. The one non-`std`
//! dependency is [`super::ApplyError`] for the loud not-found failure.

use super::ApplyError;

/// Rewrite a JE body's `entity_ref` placeholders in place (ADR-0042 slice 6): a
/// `{type:entity_ref, target:@handle}` node whose handle has a minted ref id
/// becomes `{type:entity_ref, ref_id:<id>}` (the STORED shape — entity_ref body
/// nodes carry `ref_id`, never `target`); a node whose target was rejected/dropped
/// (no ref id) collapses to a `{type:text, text:<label>}` node carrying the
/// target's recognized NAME (ADR-0042 "the name stays plain text"), falling back
/// to `"Referenced entity"` when the node declared no usable label — NEVER an empty
/// text node, which would violate the body's own `minLength:1` and make the stored
/// JE unreadable by the client codec. This mirrors the delete-cascade collapse
/// (`textualize_journal_refs_targeting_deleted_entity`), which COALESCEs to the
/// same non-empty fallback. A non-`entity_ref` node (text) is left untouched.
/// Body-target handles were validated at extraction (`validate_links`), so a
/// surviving placeholder names a declared handle (present in `handle_to_label`
/// unless that node carried no label).
pub(super) fn weave_journal_body(
    payload: &mut serde_json::Value,
    target_ref_id: &std::collections::HashMap<String, String>,
    handle_to_label: &std::collections::HashMap<String, String>,
) -> Result<(), ApplyError> {
    let Some(body) = payload
        .as_object_mut()
        .and_then(|o| o.get_mut("body"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        // No body array — the JE carries no weavable placeholders (the
        // create_journal_entry validator at mint enforces the body shape).
        return Ok(());
    };
    for node in body.iter_mut() {
        if node.get("type").and_then(serde_json::Value::as_str) != Some("entity_ref") {
            continue;
        }
        let target = node
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim);
        *node = match target.and_then(|t| target_ref_id.get(t)) {
            Some(ref_id) => serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
            // A placeholder whose target was rejected/dropped collapses to its
            // recognized name as plain text (ADR-0042 "the name stays plain text").
            None => {
                let label = target
                    .and_then(|t| handle_to_label.get(t))
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Referenced entity");
                serde_json::json!({ "type": "text", "text": label })
            }
        };
    }
    Ok(())
}

/// Where an anchor-reuse `journal_ref` chip lands (ADR-0042 amendment, #221). Exactly
/// one variant per link; the XOR is validated once, at parse-of-the-loop, so the body
/// dispatch never has to re-decode "both/neither".
pub(super) enum Placement<'a> {
    /// `match_text`: splice the chip at this substring already in the stored prose.
    Splice(&'a str),
    /// `append_text`: append this model-proposed clause, chip spliced inside it.
    Append(&'a str),
}

/// Fold a single separating space onto a real text node at the boundary between the
/// existing `body` and an appended `clause`, so the clause does not weld onto the
/// prior prose ("…Lead Ads." + "Followed…" → "…Lead Ads. Followed…"). The space MUST
/// land inside an existing text node — a standalone `{text:" "}` node is rejected by
/// `validate_woven_journal_body`. Preference order, covering every boundary shape:
///   1. clause opens with text (the common "Followed up with …" case) → prepend " "
///      to the clause's first node. This is correct even when the body's trailing node
///      is a chip (an end-of-prose mention).
///   2. else (clause opens with the chip — a label-leading clause) the space can only
///      ride on the body side → append " " to the body's trailing text node.
///   3. else both sides meet at a chip (label-leading clause after a chip-trailing
///      body): no text node to carry the space, so leave it — inter-chip spacing is the
///      renderer's concern, and a `{text:" "}` node would fail validation.
/// No-op on an empty body (nothing to separate from), and on a boundary that ALREADY
/// carries whitespace (an already-spaced clause/prose) — so the join never double-spaces.
pub(super) fn join_with_separator(
    body: &mut [serde_json::Value],
    clause: &mut [serde_json::Value],
) {
    if body.is_empty() {
        return;
    }
    // Whether the prose already ends in whitespace: the boundary is then ALREADY
    // separated, so neither side should add a space (a clause-side prepend would
    // double it). Read before the clause-side branch, which cannot see the body.
    let body_ends_with_whitespace = body
        .last()
        .and_then(|node| node.get("text").and_then(serde_json::Value::as_str))
        .is_some_and(|text| text.ends_with(char::is_whitespace));
    if let Some(first) = clause.first_mut() {
        if let Some(text) = first.get("text").and_then(serde_json::Value::as_str) {
            // Add the separating space on the clause side, UNLESS the clause already
            // opens with whitespace or the body already ends with it (no double space).
            if !body_ends_with_whitespace && !text.starts_with(char::is_whitespace) {
                first["text"] = serde_json::Value::String(format!(" {text}"));
            }
            return;
        }
    }
    if let Some(last) = body.last_mut() {
        if let Some(text) = last.get("text").and_then(serde_json::Value::as_str) {
            // Skip if the prose already ends in whitespace (no double space).
            if !text.ends_with(char::is_whitespace) {
                last["text"] = serde_json::Value::String(format!("{text} "));
            }
        }
    }
}

/// Splice a NEW `entity_ref` chip into a STORED JE body at the FIRST un-chipped
/// plain-text occurrence of `match_text` (the ADR-0042 anchor-reuse re-scan: the
/// user accepted a missed entity whose name already sits as plain prose in an
/// existing JE). The matched substring is split out of its `{type:text}` node into a
/// `{type:entity_ref, ref_id}` node, leaving the surrounding prose BYTE-IDENTICAL
/// (no rewording, no trimming, leading/trailing spaces preserved) and every existing
/// `entity_ref` node untouched. An `entity_ref` node has no `text`, so it is never
/// scanned — an already-chipped occurrence of the same name is skipped and a later
/// plain-text occurrence is the one chipped.
///
/// Returns `Err(InvalidMutation)` naming `match_text` when it occurs in NO un-chipped
/// text node — the prose-faithfulness guard: Core never invents prose, so a re-scan
/// whose anchor has vanished from the stored body fails loud rather than appending or
/// rewording. The split never emits an empty `{text:""}` node (which would violate
/// the body's own `minLength:1`): an empty side from a match at the start/end of a
/// node, or a match spanning the whole node, is dropped — mirroring how
/// `weave_journal_body` never collapses to an empty text node. The result satisfies
/// `crate::entities::validate_woven_journal_body`.
pub(super) fn splice_entity_ref_into_body(
    body: &[serde_json::Value],
    match_text: &str,
    ref_id: &str,
) -> Result<Vec<serde_json::Value>, ApplyError> {
    let mut out = Vec::with_capacity(body.len() + 2);
    let mut spliced = false;

    for node in body {
        // Only un-chipped text nodes are candidates; an entity_ref node (no `text`)
        // is copied through verbatim. Once we've spliced, every later node — text or
        // chip — is copied verbatim too (first occurrence wins).
        let text = (!spliced)
            .then(|| node.get("text").and_then(serde_json::Value::as_str))
            .flatten();
        let Some((before, after)) = text.and_then(|t| t.split_once(match_text)) else {
            out.push(node.clone());
            continue;
        };

        // Drop an empty side rather than emit a `{text:""}` node (minLength:1).
        if !before.is_empty() {
            out.push(serde_json::json!({ "type": "text", "text": before }));
        }
        out.push(serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }));
        if !after.is_empty() {
            out.push(serde_json::json!({ "type": "text", "text": after }));
        }
        spliced = true;
    }

    if !spliced {
        return Err(ApplyError::InvalidMutation(format!(
            "re-scan match text {match_text:?} not found in any un-chipped journal body text node"
        )));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // join_with_separator folds exactly ONE space onto the body↔clause boundary,
    // never zero and never two, across every boundary shape (ADR-0042 #221).
    fn boundary(
        body: &[serde_json::Value],
        clause: &[serde_json::Value],
    ) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
        let mut b = body.to_vec();
        let mut c = clause.to_vec();
        join_with_separator(&mut b, &mut c);
        (b, c)
    }

    #[test]
    fn separator_prepends_one_space_when_neither_side_has_it() {
        // Common case: prose ends without a space, clause opens with text → the
        // separating space rides on the clause side.
        let (_b, c) = boundary(
            &[serde_json::json!({ "type": "text", "text": "…Lead Ads." })],
            &[serde_json::json!({ "type": "text", "text": "Followed up." })],
        );
        assert_eq!(c[0]["text"], serde_json::json!(" Followed up."));
    }

    #[test]
    fn separator_no_double_space_when_body_already_ends_in_whitespace() {
        // Regression guard: a stored body ending in a space must NOT get a second
        // space prepended onto the clause (the boundary is already separated).
        let (_b, c) = boundary(
            &[serde_json::json!({ "type": "text", "text": "…Lead Ads. " })],
            &[serde_json::json!({ "type": "text", "text": "Followed up." })],
        );
        assert_eq!(
            c[0]["text"],
            serde_json::json!("Followed up."),
            "body already ends in whitespace → clause is left untouched"
        );
    }

    #[test]
    fn separator_no_double_space_when_clause_already_opens_with_whitespace() {
        let (_b, c) = boundary(
            &[serde_json::json!({ "type": "text", "text": "…Lead Ads." })],
            &[serde_json::json!({ "type": "text", "text": " Followed up." })],
        );
        assert_eq!(c[0]["text"], serde_json::json!(" Followed up."));
    }

    #[test]
    fn separator_falls_to_body_side_when_clause_opens_with_a_chip() {
        // A label-leading clause (opens with an entity_ref, no text) can't carry the
        // space, so it appends onto the body's trailing text node instead.
        let ref_id = Uuid::now_v7().to_string();
        let (b, _c) = boundary(
            &[serde_json::json!({ "type": "text", "text": "…Lead Ads." })],
            &[serde_json::json!({ "type": "entity_ref", "ref_id": ref_id })],
        );
        assert_eq!(b[0]["text"], serde_json::json!("…Lead Ads. "));
    }

    // weave_journal_body pins all three placeholder outcomes in isolation, including
    // the two collapse arms a decide-level test can't easily distinguish: a
    // dropped ref WITH a known label collapses to that label, and a dropped ref with
    // NO label collapses to the "Referenced entity" fallback. NEITHER is ever an
    // empty text node (the regression this slice fixes — empty text crashes the
    // client codec).
    #[test]
    fn weave_collapses_dropped_refs_to_label_or_fallback_never_empty() {
        let ref_id = Uuid::now_v7().to_string();
        let mut payload = serde_json::json!({
            "body": [
                { "type": "text", "text": "saw " },
                { "type": "entity_ref", "target": "@kept" },     // resolved → ref_id
                { "type": "text", "text": " and " },
                { "type": "entity_ref", "target": "@dropped" },  // rejected, HAS label
                { "type": "text", "text": " and " },
                { "type": "entity_ref", "target": "@bare" }      // dropped, NO label
            ]
        });
        let target_ref_id =
            std::collections::HashMap::from([("@kept".to_string(), ref_id.clone())]);
        // @dropped declared a label; @bare did not (it is absent from the map).
        let handle_to_label =
            std::collections::HashMap::from([("@dropped".to_string(), "Morris".to_string())]);

        weave_journal_body(&mut payload, &target_ref_id, &handle_to_label).expect("weave ok");

        let body = payload["body"].as_array().expect("body array");
        // The surviving placeholder wove to the minted ref_id.
        assert_eq!(body[1], serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }));
        // The labeled drop collapsed to its name; the bare drop to the fallback.
        assert_eq!(body[3], serde_json::json!({ "type": "text", "text": "Morris" }));
        assert_eq!(
            body[5],
            serde_json::json!({ "type": "text", "text": "Referenced entity" })
        );
        // No node carries a dangling `target`, and no text node is empty.
        assert!(body.iter().all(|n| n.get("target").is_none()));
        assert!(body.iter().all(|n| n.get("type").and_then(serde_json::Value::as_str)
            != Some("text")
            || n.get("text").and_then(serde_json::Value::as_str).is_some_and(|t| !t.is_empty())));
    }

    // splice_entity_ref_into_body: the re-scan splice (slice 2). All cases are pure
    // — no pool, no tx. A fresh UUID stands in for the minted ref id so the spliced
    // body satisfies `validate_woven_journal_body` (entity_ref ref_id must be a UUID).

    // Case 1: splice into a single text node. The matched substring is split out into
    // a `{entity_ref, ref_id}` node; the prose on either side is BYTE-IDENTICAL to the
    // original minus the match (leading/trailing spaces preserved exactly, no trim).
    #[test]
    fn splice_splits_one_text_node_byte_faithfully() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![serde_json::json!({
            "type": "text", "text": "synced with Wenqian and Priya today"
        })];
        let out = splice_entity_ref_into_body(&body, "Priya", &ref_id).expect("splice ok");
        assert_eq!(
            out,
            vec![
                serde_json::json!({ "type": "text", "text": "synced with Wenqian and " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
                serde_json::json!({ "type": "text", "text": " today" }),
            ]
        );
        // The spliced body is a valid stored JE body.
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 2: an existing entity_ref node is left IDENTICAL (same ref_id) when a
    // DIFFERENT entity is spliced elsewhere in the body.
    #[test]
    fn splice_leaves_existing_chip_untouched() {
        let old = Uuid::now_v7().to_string();
        let new = Uuid::now_v7().to_string();
        let body = vec![
            serde_json::json!({ "type": "text", "text": "met " }),
            serde_json::json!({ "type": "entity_ref", "ref_id": old }),
            serde_json::json!({ "type": "text", "text": " and Priya" }),
        ];
        let out = splice_entity_ref_into_body(&body, "Priya", &new).expect("splice ok");
        // The pre-existing chip is byte-identical (same ref_id, same node).
        assert_eq!(out[1], serde_json::json!({ "type": "entity_ref", "ref_id": old }));
        // The plain-text "Priya" became the new chip; the prose around it is exact.
        assert_eq!(out[2], serde_json::json!({ "type": "text", "text": " and " }));
        assert_eq!(out[3], serde_json::json!({ "type": "entity_ref", "ref_id": new }));
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 3: match_text absent from every text node → loud Err(InvalidMutation),
    // NOT a silent no-op. The message names the missing match_text.
    #[test]
    fn splice_not_found_errors_loud() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![serde_json::json!({ "type": "text", "text": "synced with the team" })];
        let err = splice_entity_ref_into_body(&body, "Priya", &ref_id)
            .expect_err("absent match_text must fail loud");
        match err {
            ApplyError::InvalidMutation(msg) => assert!(
                msg.contains("Priya"),
                "the error names the missing match_text: {msg}"
            ),
            other => panic!("expected InvalidMutation, got {other:?}"),
        }
    }

    // Case 4a: the FIRST un-chipped occurrence wins. "Priya" appears twice in plain
    // text; only the first is chipped — the second stays plain text.
    #[test]
    fn splice_chips_first_occurrence_only() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![serde_json::json!({
            "type": "text", "text": "Priya then later Priya again"
        })];
        let out = splice_entity_ref_into_body(&body, "Priya", &ref_id).expect("splice ok");
        // Match at the very start drops the empty left side: chip, then the remainder
        // (which still contains the second, plain-text "Priya").
        assert_eq!(
            out,
            vec![
                serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
                serde_json::json!({ "type": "text", "text": " then later Priya again" }),
            ]
        );
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 4b: a name that is ALREADY chipped earlier (an entity_ref node has no
    // `text` so it is never scanned) and ALSO appears later as plain text → the
    // plain-text occurrence is the one chipped; the existing chip is untouched.
    #[test]
    fn splice_skips_existing_chip_and_takes_plain_text() {
        let old = Uuid::now_v7().to_string();
        let new = Uuid::now_v7().to_string();
        let body = vec![
            serde_json::json!({ "type": "entity_ref", "ref_id": old }),
            serde_json::json!({ "type": "text", "text": " saw Priya later" }),
        ];
        let out = splice_entity_ref_into_body(&body, "Priya", &new).expect("splice ok");
        assert_eq!(out[0], serde_json::json!({ "type": "entity_ref", "ref_id": old }));
        assert_eq!(out[1], serde_json::json!({ "type": "text", "text": " saw " }));
        assert_eq!(out[2], serde_json::json!({ "type": "entity_ref", "ref_id": new }));
        assert_eq!(out[3], serde_json::json!({ "type": "text", "text": " later" }));
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 5a: match at the START of a node — the empty LEFT side is dropped (no
    // `{text:""}` node, which would violate minLength:1).
    #[test]
    fn splice_match_at_start_drops_empty_left() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![serde_json::json!({ "type": "text", "text": "Priya said hi" })];
        let out = splice_entity_ref_into_body(&body, "Priya", &ref_id).expect("splice ok");
        assert_eq!(
            out,
            vec![
                serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
                serde_json::json!({ "type": "text", "text": " said hi" }),
            ]
        );
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 5b: match at the END of a node — the empty RIGHT side is dropped.
    #[test]
    fn splice_match_at_end_drops_empty_right() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![serde_json::json!({ "type": "text", "text": "today I met Priya" })];
        let out = splice_entity_ref_into_body(&body, "Priya", &ref_id).expect("splice ok");
        assert_eq!(
            out,
            vec![
                serde_json::json!({ "type": "text", "text": "today I met " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
            ]
        );
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }

    // Case 5c: match == the WHOLE text node — both sides empty, so ONLY the chip
    // remains (no empty text siblings on either side).
    #[test]
    fn splice_match_whole_node_leaves_only_chip() {
        let ref_id = Uuid::now_v7().to_string();
        let body = vec![
            serde_json::json!({ "type": "text", "text": "saw " }),
            serde_json::json!({ "type": "text", "text": "Priya" }),
            serde_json::json!({ "type": "text", "text": " today" }),
        ];
        let out = splice_entity_ref_into_body(&body, "Priya", &ref_id).expect("splice ok");
        assert_eq!(
            out,
            vec![
                serde_json::json!({ "type": "text", "text": "saw " }),
                serde_json::json!({ "type": "entity_ref", "ref_id": ref_id }),
                serde_json::json!({ "type": "text", "text": " today" }),
            ]
        );
        crate::entities::validate_woven_journal_body(&serde_json::Value::Array(out))
            .expect("spliced body is schema-valid");
    }
}
