//! Thread-title support: the shared length cap plus a sanitizer that turns a
//! model's raw title reply into a single clean line.

/// Max Thread-title length, in Unicode scalars (not bytes, so the cut never
/// splits a multi-byte character).
pub(crate) const TITLE_MAX_CHARS: usize = 80;

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

/// Remove every `<think>...</think>` block (case-insensitive tags, possibly
/// multiline/repeated). A lone opening `<think>` with no close is a cut-off
/// reasoning stream: drop from that tag to end-of-input. A lone closing
/// `</think>` with no open is dropped as a bare tag.
fn strip_think(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;

    while let Some(open) = find_ci(rest, "<think>") {
        let after_open = &rest[open + "<think>".len()..];
        match find_ci(after_open, "</think>") {
            // Paired block: emit text before the open tag, skip the block.
            Some(close_rel) => {
                out.push_str(&rest[..open]);
                let close_abs = open + "<think>".len() + close_rel + "</think>".len();
                rest = &rest[close_abs..];
            }
            // Open with no close: a cut-off reasoning stream. Emit text up to
            // the open tag and drop everything from the tag to end-of-input.
            None => {
                out.push_str(&rest[..open]);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);

    // Drop any orphan `</think>` (close with no open) left over.
    remove_all_ci(&out, "</think>")
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

/// Remove every case-insensitive occurrence of `needle` from `text`.
fn remove_all_ci(text: &str, needle: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = find_ci(rest, needle) {
        out.push_str(&rest[..at]);
        rest = &rest[at + needle.len()..];
    }
    out.push_str(rest);
    out
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
