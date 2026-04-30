import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARTICLES_DIR } from "../../constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleRecommendation {
	/** Bare filename (e.g. `"Agent Design Is Still Hard.md"`). */
	filename: string;
	/** Frontmatter `title:` or filename sans extension. */
	title: string;
	/** Frontmatter `description:` (first ~120 chars), if present. */
	description: string | undefined;
	/** Reading bucket emoji + label derived from saved/published bands. */
	bucket: string;
	/** Composite score (higher = more recommended). */
	score: number;
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parser.
//
// Reads `key: value` lines between the first pair of `---` delimiters.
// Handles optional surrounding single/double quotes on values. Does NOT
// handle multi-line values, arrays, or nested YAML — sufficient for the
// four fields we need (title, published, description, reading_completed).
// ---------------------------------------------------------------------------

interface ArticleFrontmatter {
	title?: string;
	published?: string;
	description?: string;
	reading_completed?: string;
}

const FRONTMATTER_KEYS = new Set([
	"title",
	"published",
	"description",
	"reading_completed",
]);

/**
 * Parse the frontmatter block from a markdown file's content.
 * Returns only the keys we care about. Stops at the closing `---`.
 */
export function parseFrontmatter(content: string): ArticleFrontmatter {
	const result: ArticleFrontmatter = {};
	const lines = content.split("\n");
	if (lines.length === 0 || lines[0]?.trim() !== "---") return result;

	for (let i = 1; i < lines.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bound guarantees index is valid
		const line = lines[i]!;
		if (line.trim() === "---") break;

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		if (!FRONTMATTER_KEYS.has(key)) continue;

		let value = line.slice(colonIdx + 1).trim();
		// Strip surrounding quotes (single or double).
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value) {
			(result as Record<string, string>)[key] = value;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Scoring — faithful port of index.base formulas.
// ---------------------------------------------------------------------------

type SavedBand = "new" | "recent" | "old";
type PublishedBand = "fresh" | "recent" | "old" | "unknown";

function daysBetween(a: Date, b: Date): number {
	return Math.max(
		0,
		Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24)),
	);
}

export function computeSavedBand(mtimeMs: number, now: Date): SavedBand {
	const days = daysBetween(now, new Date(mtimeMs));
	if (days <= 7) return "new";
	if (days <= 21) return "recent";
	return "old";
}

export function computePublishedBand(
	published: string | undefined,
	now: Date,
): PublishedBand {
	if (!published) return "unknown";
	const pubDate = new Date(published);
	if (Number.isNaN(pubDate.getTime())) return "unknown";
	const days = daysBetween(now, pubDate);
	if (days <= 14) return "fresh";
	if (days <= 45) return "recent";
	return "old";
}

export function computeReadingBucket(
	savedBand: SavedBand,
	publishedBand: PublishedBand,
): string {
	if (publishedBand === "unknown") return "❓ Missing published";
	if (savedBand === "new" && publishedBand === "fresh") return "🔥 Fresh catch";
	if (savedBand === "old" && publishedBand !== "old")
		return "✅ Still worth reading";
	if (savedBand === "old" && publishedBand === "old")
		return "🧊 Probably stale";
	return "📚 Active backlog";
}

function savedScore(band: SavedBand): number {
	if (band === "new") return 30;
	if (band === "recent") return 20;
	return 10;
}

function publishedScore(band: PublishedBand): number {
	if (band === "fresh") return 30;
	if (band === "recent") return 20;
	if (band === "old") return 10;
	return 0; // unknown
}

export function computeReadingScore(
	isRead: boolean,
	savedBand: SavedBand,
	publishedBand: PublishedBand,
): number {
	const base = isRead ? -100 : 0;
	return base + savedScore(savedBand) + publishedScore(publishedBand);
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

/**
 * Scan `ARTICLES_DIR`, score each article using the `index.base` ranking
 * logic, and return the top `limit` unread articles sorted by
 * `reading_score DESC`, `published DESC`, `filename ASC`.
 */
export function recommendArticles(limit = 10): ArticleRecommendation[] {
	let entries: string[];
	try {
		entries = readdirSync(ARTICLES_DIR);
	} catch {
		return [];
	}

	const now = new Date();
	const candidates: (ArticleRecommendation & {
		published: string | undefined;
	})[] = [];

	for (const entry of entries) {
		// Only .md files; skip the Obsidian Bases index file.
		if (!entry.endsWith(".md")) continue;
		if (entry === "index.base") continue;

		const fullPath = resolve(ARTICLES_DIR, entry);

		// Skip symlinks (defense-in-depth, same as articleCommand).
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(fullPath);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) continue;

		let content: string;
		try {
			content = readFileSync(fullPath, "utf-8");
		} catch {
			continue;
		}

		const fm = parseFrontmatter(content);

		// Status: "Read" if reading_completed exists and <= today.
		const isRead =
			!!fm.reading_completed && fm.reading_completed <= formatDate(now);
		if (isRead) continue; // Only recommend unread articles.

		const savedBand = computeSavedBand(stat.mtimeMs, now);
		const publishedBand = computePublishedBand(fm.published, now);
		const score = computeReadingScore(false, savedBand, publishedBand);
		const bucket = computeReadingBucket(savedBand, publishedBand);

		const title = fm.title || entry.replace(/\.md$/, "");
		const description = fm.description
			? fm.description.length > 120
				? `${fm.description.slice(0, 119)}…`
				: fm.description
			: undefined;

		candidates.push({
			filename: entry,
			title,
			description,
			bucket,
			score,
			published: fm.published,
		});
	}

	// Sort: score DESC, published DESC (lexical — safe for YYYY-MM-DD),
	// filename ASC (alphabetical tie-break for stability).
	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const pubA = a.published ?? "";
		const pubB = b.published ?? "";
		if (pubB !== pubA) return pubB < pubA ? -1 : 1;
		return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
	});

	return candidates.slice(0, limit).map(({ published: _, ...rest }) => rest);
}

/**
 * Format the recommendation list as a numbered text block for display
 * in a user bubble.
 */
export function formatRecommendationList(
	recs: ArticleRecommendation[],
): string {
	const lines = [`📚 Recommended articles (${recs.length} unread)\n`];
	for (let i = 0; i < recs.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bound guarantees index is valid
		const r = recs[i]!;
		const num = `${i + 1}.`.padStart(3);
		lines.push(`${num} ${r.title}  ${r.bucket}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
