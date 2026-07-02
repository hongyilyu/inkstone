//! Wall-clock / civil-calendar date math (proleptic Gregorian, Howard Hinnant's
//! `civil_from_days`/`days_from_civil` algorithms). A self-contained leaf with no
//! dependency on any entity concept: it parses and formats the `YYYY-MM-DDTHH:MM:SS`
//! wall-clock string (ADR-0031/0034), decomposes epoch-ms instants into a local
//! review-anchor clock, and computes the Sunday-20:00 review anchors. Shared by
//! entity validation ([`crate::entities`]), the recurrence date math (ADR-0039,
//! [`crate::recurrence`]), observation time-range reads ([`crate::observations`]),
//! the field-spec datetime check ([`crate::field_spec`]), and the mark-reviewed
//! apply path ([`crate::db::apply`]).

pub(crate) fn parse_local_datetime(
    value: &str,
    field: &str,
) -> Result<(u32, u32, u32, u32, u32, u32), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err(format!("{field} must use YYYY-MM-DDTHH:MM:SS"));
    }

    let year = parse_digits(value, 0, 4, field)?;
    let month = parse_digits(value, 5, 7, field)?;
    let day = parse_digits(value, 8, 10, field)?;
    let hour = parse_digits(value, 11, 13, field)?;
    let minute = parse_digits(value, 14, 16, field)?;
    let second = parse_digits(value, 17, 19, field)?;

    if month == 0 || month > 12 {
        return Err(format!("{field} month must be between 01 and 12"));
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return Err(format!("{field} day must be valid for its month"));
    }
    if hour > 23 {
        return Err(format!("{field} hour must be between 00 and 23"));
    }
    if minute > 59 {
        return Err(format!("{field} minute must be between 00 and 59"));
    }
    if second > 59 {
        return Err(format!("{field} second must be between 00 and 59"));
    }

    Ok((year, month, day, hour, minute, second))
}

fn parse_digits(value: &str, start: usize, end: usize, field: &str) -> Result<u32, String> {
    let part = &value[start..end];
    if !part.as_bytes().iter().all(u8::is_ascii_digit) {
        return Err(format!("{field} must use YYYY-MM-DDTHH:MM:SS"));
    }
    part.parse::<u32>()
        .map_err(|_| format!("{field} must use YYYY-MM-DDTHH:MM:SS"))
}

/// The number of days in a civil month (proleptic Gregorian), `0` for an
/// out-of-range month. `pub(crate)` so the recurrence date math (ADR-0039) can
/// clamp a month/year advance to the target month's last valid day.
pub(crate) fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// Decompose an epoch-ms instant into a local (review-anchor) wall clock as
/// `(days_since_1970, secs_of_day)`. `offset_minutes` shifts UTC to the anchor
/// local clock. `div_euclid`/`rem_euclid` floor toward negative infinity, so
/// `secs_of_day` stays in `[0, 86399]` even for pre-1970 instants. Shared by the
/// review-date helpers and [`now_local`] so they decompose time identically.
fn local_day_and_secs(now_ms: i64, offset_minutes: i64) -> (i64, i64) {
    let local_secs = (now_ms + offset_minutes * 60_000).div_euclid(1000);
    (local_secs.div_euclid(86_400), local_secs.rem_euclid(86_400))
}

/// The Sunday-20:00 review anchor at or after the given local day, formatted
/// `YYYY-MM-DDTHH:MM:SS` (ADR-0031), used to SEED a new active Project's first
/// review. A Sunday strictly before 20:00 resolves to the SAME day (a new
/// Project should not wait up to a week for its first review); at or after 20:00
/// it rolls to the following Sunday. NOT for advancing after a review — that
/// must always move strictly forward (see [`advance_review_at_local`], ADR-0034).
pub(crate) fn next_review_at_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, secs_of_day) = local_day_and_secs(now_ms, offset_minutes);
    // 1970-01-01 is a Thursday; with Sunday=0 that is weekday 4.
    let weekday = (days.rem_euclid(7) + 4).rem_euclid(7);
    let delta = if weekday == 0 && secs_of_day < 20 * 3_600 {
        0
    } else if weekday == 0 {
        7
    } else {
        7 - weekday
    };
    sunday_anchor(days + delta)
}

/// The NEXT Sunday-20:00 review anchor strictly after the given instant (ADR-0034),
/// used to ADVANCE `next_review_at` when a Project is marked reviewed. Unlike
/// [`next_review_at_local`] (which seeds to the *same* Sunday before 20:00), this
/// always rolls forward: reviewing on a Sunday — at any time — schedules the
/// FOLLOWING Sunday, so a just-reviewed Project never re-enters the Review view
/// the same day. Every non-Sunday day lands on the coming Sunday.
pub(crate) fn advance_review_at_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, _) = local_day_and_secs(now_ms, offset_minutes);
    let weekday = (days.rem_euclid(7) + 4).rem_euclid(7);
    // Today-if-Sunday counts as a full week out (delta 7), so the next review is
    // always a strictly-future Sunday regardless of the review time of day.
    let delta = if weekday == 0 { 7 } else { 7 - weekday };
    sunday_anchor(days + delta)
}

/// Format a day-count (days since 1970-01-01) as the `…T20:00:00` Sunday review
/// anchor. The caller guarantees `day` lands on a Sunday.
fn sunday_anchor(day: i64) -> String {
    let (year, month, day) = civil_from_days(day);
    format!("{year:04}-{month:02}-{day:02}T20:00:00")
}

/// The current instant as a local wall-clock `YYYY-MM-DDTHH:MM:SS` (ADR-0034),
/// used to stamp `last_reviewed_at` when a Project is marked reviewed. `now_ms`
/// is epoch milliseconds (UTC); `offset_minutes` shifts it to the review-anchor
/// local wall clock, the same anchor the review-date helpers use, so the stamped
/// "last reviewed" and computed "next review" share one clock.
pub(crate) fn now_local(now_ms: i64, offset_minutes: i64) -> String {
    let (days, secs_of_day) = local_day_and_secs(now_ms, offset_minutes);
    let (year, month, day) = civil_from_days(days);
    format_local_datetime(
        year,
        month,
        day,
        (secs_of_day / 3_600) as u32,
        ((secs_of_day % 3_600) / 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

/// Format a civil date + time as the `YYYY-MM-DDTHH:MM:SS` wall-clock string —
/// the one owner of the wall-clock format used by [`now_local`] and the
/// recurrence date math (ADR-0039). `pub(crate)` so the recurrence module shares
/// this string rather than re-deriving it.
pub(crate) fn format_local_datetime(
    year: i64,
    month: i64,
    day: i64,
    hour: u32,
    minute: u32,
    second: u32,
) -> String {
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
}

/// Civil (year, month, day) for a count of days since 1970-01-01, proleptic
/// Gregorian (Howard Hinnant's `civil_from_days`). `pub(crate)` so the recurrence
/// date math (ADR-0039) shares one civil calendar with the review-date helpers.
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// Days since 1970-01-01 for a civil (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `days_from_civil`); the inverse of [`civil_from_days`].
/// `pub(crate)` so the recurrence date math (ADR-0039) can convert a clamped
/// civil date back to a day count for the day/week advance.
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_local_formats_full_wall_clock() {
        // 1_749_470_400_000 ms = 2025-06-09T12:00:00Z (a Monday); offset 0 ⇒ UTC.
        assert_eq!(now_local(1_749_470_400_000, 0), "2025-06-09T12:00:00");
        // A +60-minute anchor shifts the wall clock forward one hour.
        assert_eq!(now_local(1_749_470_400_000, 60), "2025-06-09T13:00:00");
        // Non-zero minute AND second, so the minute/second arithmetic is actually
        // exercised (a hardcoded :00:00 or swapped /60 and %60 would fail here).
        // 1_749_458_231_000 ms = 2025-06-09T08:37:11Z.
        assert_eq!(now_local(1_749_458_231_000, 0), "2025-06-09T08:37:11");
        // A +90-minute anchor rolls the hour (and only the hour) forward by 1:30.
        assert_eq!(now_local(1_749_458_231_000, 90), "2025-06-09T10:07:11");
    }

    #[test]
    fn advance_review_at_local_always_rolls_strictly_forward() {
        // A non-Sunday lands on the coming Sunday (2025-06-09 Mon → 06-15 Sun).
        assert_eq!(
            advance_review_at_local(1_749_470_400_000, 0),
            "2025-06-15T20:00:00"
        );
        // Reviewing ON a Sunday (2025-06-15) advances to the FOLLOWING Sunday,
        // regardless of time of day — both before AND after the 20:00 anchor.
        // 1_749_988_800_000 = 2025-06-15T12:00:00Z (before 20:00).
        assert_eq!(
            advance_review_at_local(1_749_988_800_000, 0),
            "2025-06-22T20:00:00"
        );
        // 1_750_021_200_000 = 2025-06-15T21:00:00Z (after 20:00) — still next week,
        // matching next_review_at_local's after-20:00 roll for the same instant.
        assert_eq!(
            advance_review_at_local(1_750_021_200_000, 0),
            "2025-06-22T20:00:00"
        );
        assert_eq!(
            next_review_at_local(1_750_021_200_000, 0),
            "2025-06-22T20:00:00"
        );
    }

    #[test]
    fn next_review_at_local_seeds_same_sunday_before_anchor() {
        // The SEED variant keeps the same-day shortcut: a Sunday before 20:00 seeds
        // to that same evening (a new Project shouldn't wait a week for review 1).
        // This is the behavior advance_review_at_local deliberately does NOT share.
        // 1_749_988_800_000 = 2025-06-15T12:00:00Z (Sunday, before 20:00).
        assert_eq!(
            next_review_at_local(1_749_988_800_000, 0),
            "2025-06-15T20:00:00"
        );
    }

    // Anchors below are hand-derived from concrete UTC instants. 2026-06-14 is a
    // Sunday (epoch-days 20618; weekday formula ((20618 % 7) + 4) % 7 == 0).

    #[test]
    fn next_review_mid_week_targets_upcoming_sunday() {
        // 2026-06-10T09:30:00 UTC = Wednesday (weekday 3), offset 0.
        // Upcoming Sunday is 2026-06-14.
        assert_eq!(
            next_review_at_local(1_781_083_800_000, 0),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn next_review_sunday_before_2000_targets_same_day() {
        // 2026-06-14T09:00:00 UTC = Sunday before 20:00 local, offset 0.
        // Target is the same Sunday at 20:00.
        assert_eq!(
            next_review_at_local(1_781_427_600_000, 0),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn next_review_sunday_at_2000_targets_following_sunday() {
        // 2026-06-14T20:00:00 UTC = Sunday at exactly 20:00 local, offset 0.
        // At-or-after 20:00 ⇒ the following Sunday 2026-06-21.
        assert_eq!(
            next_review_at_local(1_781_467_200_000, 0),
            "2026-06-21T20:00:00"
        );
    }

    #[test]
    fn next_review_offset_crosses_day_boundary() {
        // 2026-06-13T23:30:00 UTC = Saturday in UTC, but with +60 min offset the
        // local wall clock is 2026-06-14T00:30:00 (Sunday before 20:00).
        // Target is the local Sunday 2026-06-14 at 20:00.
        assert_eq!(
            next_review_at_local(1_781_393_400_000, 60),
            "2026-06-14T20:00:00"
        );
    }

    #[test]
    fn civil_days_round_trip() {
        for (y, m, d) in [(1970, 1, 1), (2026, 6, 14), (2026, 6, 21), (2000, 2, 29)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "round-trips {y}-{m}-{d}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0, "epoch is day 0");
    }
}
