/**
 * Today's local date as `YYYY-MM-DD`.
 *
 * Single source for the agent module's `YYYY-MM-DD` formatting. Local
 * time so the value matches the wall clock the user reads; ISO shape so
 * it sorts lexically and aligns with frontmatter date conventions in
 * the vault.
 *
 * Callers:
 *   - `composeEnvBlock` in `compose.ts` — `<env>` block fixing today's
 *     date for the LLM (see ADR D9 for the cache-prefix invariant).
 *   - `recommendArticles` in `agents/reader/recommendations.ts` —
 *     compares against `reading_completed` frontmatter to filter out
 *     already-read articles.
 *   - KB workflow command titles (`/ingest`, `/lint`) — disambiguates
 *     same-verb sessions in the session list.
 *
 * No timezone arg, no `Date` arg: every caller wants "today, local". A
 * future caller that needs to format an arbitrary `Date` should hoist
 * a `formatLocalDate(d: Date)` peer here, not parameterize this one.
 */
export function todayLocalDate(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
