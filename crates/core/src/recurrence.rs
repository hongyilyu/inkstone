//! Recurrence occurrence date math (ADR-0039): the pure function that, given a
//! Todo's Recurrence Rule and its current anchor dates, computes the next
//! occurrence's dates — or reports that the series has ended.
//!
//! No DB, no ambient clock, no UTC offset: every repeat is anchored to the
//! stored date (`next = old + interval × unit`), so the math is a pure function
//! of `(rule, date strings)`. Dates are naive local wall-clock
//! `YYYY-MM-DDTHH:MM:SS` (ADR-0031/0037), advanced as civil arithmetic on the
//! shared `civil_from_days`/`days_from_civil` calendar.
//!
//! Both `defer_at` and `due_at` advance by the SAME rule (each present date moves
//! by `interval × unit`, clamped independently for month/year), so a Todo that
//! defers before it is due keeps that relationship every occurrence. The `anchor`
//! the rule names is the date the `until` end-bound is checked against.

use serde_json::Value;

use crate::entities::{
    civil_from_days, days_from_civil, days_in_month, format_local_datetime, parse_local_datetime,
};

/// The next occurrence's dates and rule. `defer_at`/`due_at` mirror the
/// original's presence — a date absent on the completed Todo stays absent on the
/// successor. `recurrence` is the rule to store on the successor: identical to
/// the input except an `after_count` end condition is decremented by one.
pub(crate) struct Occurrence {
    pub defer_at: Option<String>,
    pub due_at: Option<String>,
    pub recurrence: Value,
}

/// Compute the next occurrence of a recurring Todo, or `None` when the series has
/// ended (the rule's end condition is reached) — in which case completing the
/// Todo spawns no successor.
///
/// `defer_at`/`due_at` are the completed Todo's current dates; the rule's
/// `anchor` names which one the `until` bound is measured against (validation
/// guarantees that date is present). Returns `None` on a malformed rule too — a
/// fail-safe: the caller validates the merged Todo first, so this is unreachable
/// in practice, but a bad rule must not panic the apply transaction.
pub(crate) fn next_occurrence(
    rule: &Value,
    defer_at: Option<&str>,
    due_at: Option<&str>,
) -> Option<Occurrence> {
    let obj = rule.as_object()?;
    let interval = obj.get("interval")?.as_u64()?;
    if interval < 1 {
        return None;
    }
    let unit = obj.get("unit")?.as_str()?;
    let anchor = obj.get("anchor")?.as_str()?;

    // End condition: after_count counts DOWN per occurrence. The Todo being
    // completed is one occurrence; if its rule says "1 left" (or, defensively, 0),
    // it was the last — no successor. The `<= 1` gate (not `== 1`) also keeps the
    // `count - 1` below from underflowing on a validation-bypassing 0. (until is
    // checked below, once the next anchor is known.)
    let end = obj.get("end").and_then(Value::as_object);
    let after_count = end.and_then(|e| e.get("after_count")).and_then(Value::as_u64);
    if after_count.is_some_and(|c| c <= 1) {
        return None;
    }

    // Advance every present date by the same rule. For minute/hour/day/week this
    // is a fixed duration (so the defer→due gap is preserved exactly); for
    // month/year each date keeps its day-of-month, clamped to the target month's
    // last valid day.
    let next_defer = match defer_at {
        Some(d) => Some(advance(d, interval, unit)?),
        None => None,
    };
    let next_due = match due_at {
        Some(d) => Some(advance(d, interval, unit)?),
        None => None,
    };

    // until is an INCLUSIVE upper bound on the anchor date: an occurrence landing
    // exactly on `until` is still generated; one strictly after ends the series.
    // Wall-clock strings sort chronologically, so a string compare is correct.
    let next_anchor = match anchor {
        "defer_at" => next_defer.as_deref(),
        "due_at" => next_due.as_deref(),
        _ => return None,
    }?;
    if let Some(until) = end.and_then(|e| e.get("until")).and_then(Value::as_str)
        && next_anchor > until
    {
        return None;
    }

    // The successor's rule: the same rule, with after_count decremented by one.
    let mut next_rule = obj.clone();
    if let Some(count) = after_count {
        let mut end_obj = next_rule
            .get("end")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        end_obj.insert("after_count".to_string(), Value::from(count - 1));
        next_rule.insert("end".to_string(), Value::Object(end_obj));
    }

    Some(Occurrence {
        defer_at: next_defer,
        due_at: next_due,
        recurrence: Value::Object(next_rule),
    })
}

/// Advance one wall-clock date by `interval` units of `unit`, returning the new
/// `YYYY-MM-DDTHH:MM:SS` string. minute/hour/day/week add a fixed span of seconds
/// (rolling the calendar as needed); month/year shift the calendar month/year and
/// CLAMP the day to the target month's last valid day (Jan 31 + 1 month →
/// Feb 28/29), preserving the time-of-day. `None` on an unparseable input OR an
/// `interval` so large the civil arithmetic would overflow `i64` — checked
/// arithmetic throughout, so a runaway interval yields "no successor" rather than
/// a panic (debug) or a wrapped garbage date (release), honoring the
/// fail-safe contract `next_occurrence` advertises.
fn advance(value: &str, interval: u64, unit: &str) -> Option<String> {
    let (year, month, day, hour, minute, second) = parse_local_datetime(value, "recurrence").ok()?;
    let interval = i64::try_from(interval).ok()?;

    match unit {
        "minute" | "hour" | "day" | "week" => {
            let per_unit_secs: i64 = match unit {
                "minute" => 60,
                "hour" => 3_600,
                "day" => 86_400,
                "week" => 7 * 86_400,
                _ => unreachable!("outer match restricts the unit"),
            };
            let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
            let secs_of_day = i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
            let total = days
                .checked_mul(86_400)?
                .checked_add(secs_of_day)?
                .checked_add(interval.checked_mul(per_unit_secs)?)?;
            let (new_days, new_secs) = (total.div_euclid(86_400), total.rem_euclid(86_400));
            let (y, m, d) = civil_from_days(new_days);
            Some(format_local_datetime(
                y,
                m,
                d,
                (new_secs / 3_600) as u32,
                ((new_secs % 3_600) / 60) as u32,
                (new_secs % 60) as u32,
            ))
        }
        "month" | "year" => {
            let added_months = if unit == "year" {
                interval.checked_mul(12)?
            } else {
                interval
            };
            // Months since year 0, advanced, then split back to (year, month).
            let total_months = i64::from(year)
                .checked_mul(12)?
                .checked_add(i64::from(month - 1))?
                .checked_add(added_months)?;
            let target_year = total_months.div_euclid(12);
            let target_month = total_months.rem_euclid(12) + 1;
            let max_day = i64::from(days_in_month(target_year as u32, target_month as u32));
            let target_day = i64::from(day).min(max_day);
            Some(format_local_datetime(
                target_year,
                target_month,
                target_day,
                hour,
                minute,
                second,
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(interval: u64, unit: &str, anchor: &str) -> Value {
        json!({ "interval": interval, "unit": unit, "anchor": anchor })
    }

    /// The advanced anchor date for a single-date Todo, unwrapping the successor.
    fn next_due(rule: &Value, due: &str) -> String {
        next_occurrence(rule, None, Some(due))
            .expect("a successor exists")
            .due_at
            .expect("the due date advanced")
    }

    #[test]
    fn advances_each_unit() {
        // minute / hour roll the time; day / week add whole days.
        assert_eq!(
            next_due(&rule(30, "minute", "due_at"), "2026-06-14T09:00:00"),
            "2026-06-14T09:30:00"
        );
        assert_eq!(
            next_due(&rule(2, "hour", "due_at"), "2026-06-14T23:30:00"),
            "2026-06-15T01:30:00",
            "adding hours rolls past midnight"
        );
        assert_eq!(
            next_due(&rule(3, "day", "due_at"), "2026-06-14T09:00:00"),
            "2026-06-17T09:00:00"
        );
        assert_eq!(
            next_due(&rule(1, "week", "due_at"), "2026-06-14T09:00:00"),
            "2026-06-21T09:00:00"
        );
        assert_eq!(
            next_due(&rule(6, "month", "due_at"), "2026-06-30T09:00:00"),
            "2026-12-30T09:00:00"
        );
        assert_eq!(
            next_due(&rule(1, "year", "due_at"), "2026-06-14T09:00:00"),
            "2027-06-14T09:00:00"
        );
    }

    #[test]
    fn clamps_month_overflow_to_month_end() {
        // Jan 31 + 1 month → Feb 28 (2027 is not a leap year).
        assert_eq!(
            next_due(&rule(1, "month", "due_at"), "2027-01-31T09:00:00"),
            "2027-02-28T09:00:00"
        );
        // Jan 31 + 1 month in a LEAP year → Feb 29.
        assert_eq!(
            next_due(&rule(1, "month", "due_at"), "2028-01-31T09:00:00"),
            "2028-02-29T09:00:00"
        );
        // Mar 31 + 1 month → Apr 30 (30-day month).
        assert_eq!(
            next_due(&rule(1, "month", "due_at"), "2026-03-31T09:00:00"),
            "2026-04-30T09:00:00"
        );
        // The clamp does not "stick": May (31 days) is reached intact via +2 from
        // March, not dragged down to the April clamp.
        assert_eq!(
            next_due(&rule(2, "month", "due_at"), "2026-03-31T09:00:00"),
            "2026-05-31T09:00:00"
        );
    }

    #[test]
    fn clamps_leap_day_on_year_advance() {
        // Feb 29 + 1 year → Feb 28 (the next year is not a leap year).
        assert_eq!(
            next_due(&rule(1, "year", "due_at"), "2028-02-29T09:00:00"),
            "2029-02-28T09:00:00"
        );
        // Feb 29 + 4 years → Feb 29 (the next leap year keeps the day).
        assert_eq!(
            next_due(&rule(4, "year", "due_at"), "2028-02-29T09:00:00"),
            "2032-02-29T09:00:00"
        );
    }

    #[test]
    fn advances_month_across_year_boundary() {
        assert_eq!(
            next_due(&rule(2, "month", "due_at"), "2026-12-15T09:00:00"),
            "2027-02-15T09:00:00"
        );
    }

    #[test]
    fn both_dates_advance_in_lockstep() {
        // anchor is due_at; defer_at rides along by the same rule. A 6-day
        // defer→due gap survives a weekly advance exactly.
        let occ = next_occurrence(
            &rule(1, "week", "due_at"),
            Some("2026-06-14T09:00:00"),
            Some("2026-06-20T17:00:00"),
        )
        .expect("successor exists");
        assert_eq!(occ.defer_at.as_deref(), Some("2026-06-21T09:00:00"));
        assert_eq!(occ.due_at.as_deref(), Some("2026-06-27T17:00:00"));
    }

    #[test]
    fn month_advance_keeps_each_date_day_of_month() {
        // defer on the 15th, due on the 31st, monthly: each keeps its own
        // day-of-month, the due date clamping to Feb-end independently.
        let occ = next_occurrence(
            &rule(1, "month", "due_at"),
            Some("2027-01-15T09:00:00"),
            Some("2027-01-31T17:00:00"),
        )
        .expect("successor exists");
        assert_eq!(occ.defer_at.as_deref(), Some("2027-02-15T09:00:00"));
        assert_eq!(occ.due_at.as_deref(), Some("2027-02-28T17:00:00"));
    }

    #[test]
    fn defer_anchor_advances_defer_date() {
        // anchor is defer_at and only defer_at is present.
        let occ = next_occurrence(
            &rule(2, "day", "defer_at"),
            Some("2026-06-14T09:00:00"),
            None,
        )
        .expect("successor exists");
        assert_eq!(occ.defer_at.as_deref(), Some("2026-06-16T09:00:00"));
        assert_eq!(occ.due_at, None);
    }

    #[test]
    fn until_inclusive_bound() {
        // An occurrence landing exactly on `until` is generated…
        let on_bound = json!({
            "interval": 1, "unit": "day", "anchor": "due_at",
            "end": { "until": "2026-06-15T09:00:00" }
        });
        assert!(
            next_occurrence(&on_bound, None, Some("2026-06-14T09:00:00")).is_some(),
            "next anchor == until is still generated (inclusive)"
        );
        // …but one strictly after ends the series.
        let past_bound = json!({
            "interval": 1, "unit": "day", "anchor": "due_at",
            "end": { "until": "2026-06-14T23:59:59" }
        });
        assert!(
            next_occurrence(&past_bound, None, Some("2026-06-14T09:00:00")).is_none(),
            "next anchor > until ends the series"
        );
    }

    #[test]
    fn after_count_counts_down_to_the_last() {
        // after_count: 3 → successor carries 2 …
        let three = json!({
            "interval": 1, "unit": "week", "anchor": "due_at",
            "end": { "after_count": 3 }
        });
        let occ = next_occurrence(&three, None, Some("2026-06-14T09:00:00"))
            .expect("successor exists");
        assert_eq!(occ.recurrence["end"]["after_count"].as_u64(), Some(2));

        // … after_count: 1 → this was the last occurrence, no successor.
        let one = json!({
            "interval": 1, "unit": "week", "anchor": "due_at",
            "end": { "after_count": 1 }
        });
        assert!(
            next_occurrence(&one, None, Some("2026-06-14T09:00:00")).is_none(),
            "after_count == 1 means the completed Todo was the last occurrence"
        );
    }

    #[test]
    fn no_end_repeats_indefinitely_and_preserves_rule() {
        let occ = next_occurrence(&rule(1, "week", "due_at"), None, Some("2026-06-14T09:00:00"))
            .expect("successor exists");
        assert_eq!(occ.recurrence, rule(1, "week", "due_at"), "rule round-trips");
    }

    #[test]
    fn until_is_measured_against_the_defer_anchor() {
        // anchor is defer_at: the `until` bound is checked against the advanced
        // DEFER date, not the due date. Next defer = 2026-06-21; an until one day
        // earlier ends the series…
        let past = json!({
            "interval": 1, "unit": "week", "anchor": "defer_at",
            "end": { "until": "2026-06-20T09:00:00" }
        });
        assert!(
            next_occurrence(&past, Some("2026-06-14T09:00:00"), Some("2026-06-30T17:00:00")).is_none(),
            "until measured against the defer anchor (next defer > until) ends the series"
        );
        // …while an until at-or-after the next defer still generates — even though
        // the (later) due date would be past a naive due-based check.
        let on = json!({
            "interval": 1, "unit": "week", "anchor": "defer_at",
            "end": { "until": "2026-06-21T09:00:00" }
        });
        assert!(
            next_occurrence(&on, Some("2026-06-14T09:00:00"), Some("2026-06-30T17:00:00")).is_some(),
            "until == next defer (inclusive) still generates, regardless of the due date"
        );
    }

    #[test]
    fn defensive_after_count_zero_ends_series() {
        // after_count: 0 can't reach here through the validated path (validation
        // requires >= 1), but the fail-safe must not underflow `count - 1` — it
        // ends the series cleanly.
        let zero = json!({
            "interval": 1, "unit": "week", "anchor": "due_at",
            "end": { "after_count": 0 }
        });
        assert!(
            next_occurrence(&zero, None, Some("2026-06-14T09:00:00")).is_none(),
            "after_count == 0 ends the series with no underflow"
        );
    }

    #[test]
    fn runaway_interval_yields_no_successor_not_a_panic() {
        // An interval large enough to overflow the civil-seconds arithmetic must
        // return None (no successor), not panic — the fail-safe the doc promises.
        let huge = json!({ "interval": u64::MAX, "unit": "week", "anchor": "due_at" });
        assert!(
            next_occurrence(&huge, None, Some("2026-06-14T09:00:00")).is_none(),
            "a runaway interval is a safe no-op, not a panic"
        );
        let huge_year = json!({ "interval": u64::MAX, "unit": "year", "anchor": "due_at" });
        assert!(
            next_occurrence(&huge_year, None, Some("2026-06-14T09:00:00")).is_none(),
            "a runaway year interval is a safe no-op, not a panic"
        );
    }
}
