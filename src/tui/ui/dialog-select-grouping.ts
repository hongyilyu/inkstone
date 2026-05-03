import type { DialogSelectOption } from "./dialog-select";

/**
 * Group options by `category ?? ""` while preserving insertion order.
 *
 * A `Map` preserves insertion order, so options whose category key first
 * appears earlier in the input lead their group — which matches how
 * callers (e.g. DialogModel) already order contiguous runs of
 * same-category rows, so grouping never reorders the visible list.
 * Options without a `category` land in the empty-string bucket; the
 * caller's `<Show when={category}>` gate hides the header for that
 * bucket, so callers without categories render unchanged.
 */
export function groupByCategory<T>(
	options: DialogSelectOption<T>[],
): [string, DialogSelectOption<T>[]][] {
	const buckets = new Map<string, DialogSelectOption<T>[]>();
	for (const opt of options) {
		const key = opt.category ?? "";
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = [];
			buckets.set(key, bucket);
		}
		bucket.push(opt);
	}
	return [...buckets];
}

/**
 * Count the total rendered rows for a `grouped()` result: the flat
 * option count plus one line per non-empty header, plus one spacer
 * line between consecutive non-empty groups (`paddingTop={1}` after
 * index 0). Matches OpenCode's `rows()` so `height()` sizes the
 * scrollbox to include headers.
 *
 * Dormant caveat: the accumulator keys off the raw group index. If a
 * caller mixes uncategorized and categorized options (empty-string
 * bucket at index 0, a non-empty header at index 1), the non-empty
 * header gets `paddingTop={1}` even though it's visually the first
 * header. No current caller mixes; fix alongside the first one that
 * does. The JSX in `DialogSelect` mirrors this same offset so the
 * height math stays aligned with the rendered output.
 */
export function countRows<T>(
	grouped: [string, DialogSelectOption<T>[]][],
): number {
	const flatLength = grouped.reduce(
		(acc, [, options]) => acc + options.length,
		0,
	);
	const headers = grouped.reduce((acc, [category], i) => {
		if (!category) return acc;
		return acc + (i > 0 ? 2 : 1);
	}, 0);
	return flatLength + headers;
}
