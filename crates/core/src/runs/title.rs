//! Thread-title support: the shared length cap plus a sanitizer that turns a
//! model's raw title reply into a single clean line.

/// Max *generated*-title length, in Unicode scalars (not bytes, so the cut never
/// splits a multi-byte character). Applied by [`sanitize_title`] to the LLM
/// reply.
pub(crate) const TITLE_MAX_CHARS: usize = 80;

/// Max *fallback*-title (slug) length, in Unicode scalars. Governs
/// [`placeholder_title`] — the create-time name a Thread carries until (and
/// unless) the titler generates a better one (ADR-0048). Deliberately smaller
/// than [`TITLE_MAX_CHARS`]: the fallback is a terse identifier, the generated
/// title a fuller phrase.
pub(crate) const PLACEHOLDER_MAX_CHARS: usize = 32;

/// Sanitize a model's raw title reply into a single clean line.
///
/// Returns `None` when nothing usable remains (the caller keeps its
/// placeholder); `Some(title)` otherwise. The pipeline, in order:
///   a. strip `<think>...</think>` reasoning blocks (and orphan think tags),
///   b. take the first non-empty line,
///   c. collapse internal whitespace runs to a single space and trim,
///   d. strip one layer of wrapping quotes/backticks (straight, smart),
///   e. truncate to [`TITLE_MAX_CHARS`] Unicode scalars.
///
/// Non-empty output is never heuristically rejected (no length floor, no
/// refusal detection).
pub(crate) fn sanitize_title(raw: &str) -> Option<String> {
    let without_think = strip_think(raw);

    let first_line = without_think
        .split('\n')
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");

    let collapsed = collapse_whitespace(first_line);
    let unwrapped = strip_wrapping_quotes(&collapsed);
    let truncated: String = unwrapped.chars().take(TITLE_MAX_CHARS).collect();

    if truncated.is_empty() {
        None
    } else {
        Some(truncated)
    }
}

/// Derive a Thread's create-time fallback title (the slug) from the user's first
/// prompt (ADR-0048).
///
/// The slug is the name a Thread carries until the titler (ADR-0046) generates a
/// better one. It is a terse, legible identifier — not the prompt dumped and cut
/// mid-word. The pipeline:
///   a. collapse internal whitespace runs to a single space and trim (one clean
///      line),
///   b. if it already fits [`PLACEHOLDER_MAX_CHARS`] scalars, return it verbatim,
///   c. otherwise back off to the last WHOLE word within the cap (no ellipsis),
///   d. if the first word alone exceeds the cap, hard-cut at the cap on a scalar
///      boundary so the slug can never collapse to empty.
///
/// `thread/create` rejects an empty/whitespace prompt upstream, so the input here
/// is always non-empty after the trim; the hard-cut in (d) keeps that invariant
/// even for a single very long token.
pub(crate) fn placeholder_title(prompt: &str) -> String {
    let collapsed = collapse_whitespace(prompt);

    // Already within the cap (counted in scalars, not bytes): use as-is.
    if collapsed.chars().count() <= PLACEHOLDER_MAX_CHARS {
        return collapsed;
    }

    // The scalar-bounded prefix is the budget we get to fill. Back off to the
    // last whole word inside it; `split_whitespace` already dropped interior
    // runs, but the prefix can end mid-word, so trim the trailing partial word.
    let prefix: String = collapsed.chars().take(PLACEHOLDER_MAX_CHARS).collect();
    match prefix.rsplit_once(' ') {
        // A space exists in the budget: keep through the last whole word.
        Some((head, _partial)) => head.trim_end().to_string(),
        // No space — the first word alone overflows the cap. Hard-cut the prefix
        // on its scalar boundary (already done above) so the slug is non-empty.
        None => prefix,
    }
}

/// Remove every `<think>...</think>` block (case-insensitive tags, possibly
/// multiline/repeated/**nested**). Walks tag by tag tracking nesting `depth`,
/// emitting text only at `depth == 0` so a nested block (`<think>a<think>b</think>c</think>`)
/// is removed as one unit rather than leaking the inner fragment. A lone opening
/// `<think>` with no close is a cut-off reasoning stream: everything from it to
/// end-of-input is dropped. A lone closing `</think>` with no open keeps the text
/// before it (depth saturates at 0) and drops the bare tag.
fn strip_think(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    let mut depth: usize = 0;

    loop {
        // Advance to whichever tag comes first; an open we haven't closed keeps
        // `depth > 0` so its contents (and any nested tags) are skipped.
        let (idx, is_open, tag_len) = match (find_ci(rest, "<think>"), find_ci(rest, "</think>")) {
            (Some(o), Some(c)) if o < c => (o, true, "<think>".len()),
            (Some(_), Some(c)) => (c, false, "</think>".len()),
            (Some(o), None) => (o, true, "<think>".len()),
            (None, Some(c)) => (c, false, "</think>".len()),
            // No more tags: emit the tail only if we're outside every block.
            (None, None) => {
                if depth == 0 {
                    out.push_str(rest);
                }
                break;
            }
        };

        // Text before this tag is real output only when not inside a block.
        if depth == 0 {
            out.push_str(&rest[..idx]);
        }
        if is_open {
            depth += 1;
        } else {
            depth = depth.saturating_sub(1);
        }
        rest = &rest[idx + tag_len..];
    }

    out
}

/// Byte offset of the first case-insensitive (ASCII) match of `needle` in
/// `haystack`, or `None`.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let nee = needle.as_bytes();
    if nee.is_empty() || hay.len() < nee.len() {
        return None;
    }
    (0..=hay.len() - nee.len()).find(|&start| {
        hay[start..start + nee.len()]
            .iter()
            .zip(nee)
            .all(|(h, n)| h.eq_ignore_ascii_case(n))
    })
}

/// Collapse runs of whitespace to a single space and trim both ends.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Strip ONE layer of wrapping quotes/backticks if the whole string is wrapped
/// in a matched pair, then re-trim. Recognised pairs: `"..."`, `'...'`,
/// `` `...` ``, smart `“...”`, smart `‘...’`. A lone delimiter (len 1) and
/// inner quotes are left untouched.
fn strip_wrapping_quotes(s: &str) -> String {
    const PAIRS: [(char, char); 5] =
        [('"', '"'), ('\'', '\''), ('`', '`'), ('“', '”'), ('‘', '’')];

    // A single character can't be a wrapping pair.
    if s.chars().count() < 2 {
        return s.to_string();
    }

    let mut chars = s.chars();
    let first = chars.next();
    let last = chars.next_back();

    if let (Some(f), Some(l)) = (first, last) {
        for (open, close) in PAIRS {
            if f == open && l == close {
                let inner_start = open.len_utf8();
                let inner_end = s.len() - close.len_utf8();
                return s[inner_start..inner_end].trim().to_string();
            }
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_short_prompt_passes_through() {
        // Under the cap → stored verbatim (after the trim).
        assert_eq!(placeholder_title("draft the offsite agenda"), "draft the offsite agenda");
        assert_eq!(placeholder_title("reconcile the vendor invoices"), "reconcile the vendor invoices");
        assert_eq!(placeholder_title("summarize the launch retro"), "summarize the launch retro");
        // Leading/trailing whitespace is trimmed.
        assert_eq!(placeholder_title("  hello world  "), "hello world");
    }

    #[test]
    fn placeholder_pins_the_cap_boundary() {
        // The function's one numeric decision is `count() <= PLACEHOLDER_MAX_CHARS`.
        // Pin BOTH sides so an off-by-one (`<` for `<=`, or `take(CAP - 1)`) can't
        // pass silently. `at_cap` is exactly PLACEHOLDER_MAX_CHARS (32) scalars and
        // ends on a word boundary, so the correct `<=` returns it verbatim; a `<`
        // regression would instead drop its trailing word.
        let at_cap = "plan the quarterly budget review";
        assert_eq!(at_cap.chars().count(), PLACEHOLDER_MAX_CHARS);
        assert_eq!(placeholder_title(at_cap), at_cap);

        // One scalar over the cap (33): the first input that must trip the
        // word-boundary back-off, pinning the crossover.
        let over_cap = "plan the quarterly budget reviews";
        assert_eq!(over_cap.chars().count(), PLACEHOLDER_MAX_CHARS + 1);
        assert_eq!(placeholder_title(over_cap), "plan the quarterly budget");
    }

    #[test]
    fn placeholder_long_prompt_backs_off_to_word_boundary() {
        // The canonical case: a long multi-word prompt becomes a clean slug cut
        // on a WORD boundary within 32 scalars — never mid-word, no ellipsis.
        assert_eq!(
            placeholder_title(
                "i need to plan the q3 budget across all teams and figure out headcount"
            ),
            "i need to plan the q3 budget"
        );
        let out = placeholder_title(
            "i need to plan the q3 budget across all teams and figure out headcount",
        );
        assert!(out.chars().count() <= PLACEHOLDER_MAX_CHARS);
        assert!(!out.ends_with(' '));
    }

    #[test]
    fn placeholder_collapses_whitespace_and_newlines() {
        // Internal whitespace runs (incl. newlines/tabs) collapse to one space,
        // so a multi-line prompt yields a single clean line.
        assert_eq!(
            placeholder_title("plan\n\tthe   trip"),
            "plan the trip"
        );
    }

    #[test]
    fn placeholder_overlong_first_word_hard_cuts_without_panic() {
        // A single token longer than the cap has no word boundary to back off to,
        // so it is hard-cut at the cap on a scalar boundary — never empty.
        let long_word = "a".repeat(50);
        let out = placeholder_title(&long_word);
        assert_eq!(out.chars().count(), PLACEHOLDER_MAX_CHARS);
        assert_eq!(out, "a".repeat(PLACEHOLDER_MAX_CHARS));

        // Multi-byte scalars straddling the boundary must not panic or split a
        // character: 40 emoji (one token, no spaces) → exactly 32 emoji kept.
        let emoji = "🎉".repeat(40);
        let out = placeholder_title(&emoji);
        assert_eq!(out.chars().count(), PLACEHOLDER_MAX_CHARS);
        assert!(out.chars().all(|c| c == '🎉'));
    }

    #[test]
    fn placeholder_word_boundary_with_multibyte_words() {
        // Multi-byte words must still cut on a word boundary, not a byte offset.
        // Each "café" is 4 scalars (5 bytes); the slug keeps whole words ≤ 32
        // scalars and never splits the é.
        let out = placeholder_title("café café café café café café café café café");
        assert!(out.chars().count() <= PLACEHOLDER_MAX_CHARS);
        assert!(out.ends_with("café"));
        assert!(!out.ends_with(' '));
    }

    #[test]
    fn sanitize_strips_think_block() {
        assert_eq!(
            sanitize_title("<think>reasoning here</think>\nMilk run"),
            Some("Milk run".to_string())
        );
        // Internal newlines inside the block.
        assert_eq!(
            sanitize_title("<think>line one\nline two\nstill reasoning</think>\nBudget"),
            Some("Budget".to_string())
        );
        // Orphan close tag with no open.
        assert_eq!(
            sanitize_title("Grocery list</think>"),
            Some("Grocery list".to_string())
        );
        // Nested blocks are removed as one unit — the inner fragment `c` must
        // not leak (the depth-aware strip; CodeRabbit #208).
        assert_eq!(
            sanitize_title("<think>a<think>b</think>c</think>Real title"),
            Some("Real title".to_string())
        );
    }

    #[test]
    fn sanitize_takes_first_nonempty_line() {
        assert_eq!(
            sanitize_title("\n\nBudget planning\nignored second line"),
            Some("Budget planning".to_string())
        );
    }

    #[test]
    fn sanitize_collapses_whitespace() {
        assert_eq!(
            sanitize_title("Trip    to\t\tLisbon"),
            Some("Trip to Lisbon".to_string())
        );
    }

    #[test]
    fn sanitize_strips_wrapping_quotes() {
        assert_eq!(
            sanitize_title("\"Quarterly review\""),
            Some("Quarterly review".to_string())
        );
        // Smart double quotes.
        assert_eq!(sanitize_title("“Foo”"), Some("Foo".to_string()));
        // Backticks.
        assert_eq!(sanitize_title("`bar`"), Some("bar".to_string()));
        // Inner apostrophe is preserved — only a matched wrapping pair strips.
        assert_eq!(
            sanitize_title("Bob's plan"),
            Some("Bob's plan".to_string())
        );
    }

    #[test]
    fn sanitize_truncates_to_80_scalars() {
        // 100 ASCII chars → exactly 80.
        let long = "a".repeat(100);
        let out = sanitize_title(&long).unwrap();
        assert_eq!(out.chars().count(), 80);

        // A multi-byte char straddling the boundary must not panic / split.
        // 79 ASCII chars then an emoji = the emoji is the 80th scalar (kept);
        // everything after it is dropped.
        let mut near = "a".repeat(79);
        near.push('🎉');
        near.push_str("trailing");
        let out = sanitize_title(&near).unwrap();
        assert_eq!(out.chars().count(), 80);
        assert!(out.ends_with('🎉'));
    }

    #[test]
    fn sanitize_empty_returns_none() {
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("   "), None);
        assert_eq!(sanitize_title("<think>only reasoning</think>"), None);
        assert_eq!(sanitize_title("\n\n"), None);
    }

    #[test]
    fn sanitize_plain_title_passthrough() {
        assert_eq!(
            sanitize_title("Plan the Lisbon trip"),
            Some("Plan the Lisbon trip".to_string())
        );
    }

    #[test]
    fn sanitize_orphan_open_think_drops_to_end() {
        // A lone opening `<think>` with no close means a cut-off reasoning
        // stream: everything from the tag to end-of-input is reasoning and is
        // dropped. Text BEFORE the tag is a real title and is kept.
        assert_eq!(
            sanitize_title("Real title<think>dangling reasoning"),
            Some("Real title".to_string())
        );
        // Multiline trailing reasoning must not leak its first line either.
        assert_eq!(
            sanitize_title("<think>never closes\nMilk run"),
            None
        );
        // Only a dangling open → everything stripped → None.
        assert_eq!(sanitize_title("<think>only dangling"), None);
    }

    #[test]
    fn sanitize_think_tags_are_case_insensitive() {
        // Upper-case paired tags.
        assert_eq!(
            sanitize_title("<THINK>reasoning</THINK>\nBudget review"),
            Some("Budget review".to_string())
        );
        // Mixed-case paired tags.
        assert_eq!(
            sanitize_title("<Think>reasoning here</Think>\nMilk run"),
            Some("Milk run".to_string())
        );
        // Case-insensitive orphan open also drops to end.
        assert_eq!(
            sanitize_title("Quarterly plan<THINK>cut off"),
            Some("Quarterly plan".to_string())
        );
    }
}
