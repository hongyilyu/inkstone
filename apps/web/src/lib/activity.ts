export type Bucket = "today" | "yesterday" | "earlier";

export function classify(at: string): Bucket {
	const lower = at.toLowerCase();
	if (lower.startsWith("today")) return "today";
	if (lower.startsWith("yesterday")) return "yesterday";
	if (/^\d{1,2}:\d{2}/.test(at)) return "today";
	return "earlier";
}
