import type { Locator, Page } from "@playwright/test";

/** Page object over the derived GTD read surfaces — Inbox / Waiting / Review and the Todo detail projection (ADR-0019): selectors live here so specs read as user flows. */
export class GtdPage {
	constructor(
		readonly page: Page,
		private readonly baseUrl: string,
	) {}

	/** Navigate to a GTD view (`/library/gtd?filt=inbox|waiting|review`). */
	async gotoView(view: "inbox" | "waiting" | "review"): Promise<void> {
		await this.page.goto(
			new URL(`/library/gtd?filt=${view}`, this.baseUrl).href,
		);
	}

	/** Navigate to a Todo's detail projection (`/library/todos?id=<id>`). */
	async gotoTodo(id: string): Promise<void> {
		await this.page.goto(new URL(`/library/todos?id=${id}`, this.baseUrl).href);
	}

	/** The GTD view region landmark by its accessible name (e.g. `/inbox/i`). */
	region(name: string | RegExp) {
		return this.page.getByRole("region", { name });
	}

	/** The Todo detail rail landmark by its accessible name (e.g. `/Buy stamps details/i`). */
	detailRail(name: string | RegExp) {
		return this.page.getByRole("complementary", { name });
	}

	/** The linked-person row inside `rail`: a button labelled by the person's
	 * name + its role chip (e.g. `/Alice Waiting on/`) — the person_refs that
	 * ride on the Todo row (ADR-0031/0032 slice-3 wire). */
	linkedPerson(rail: Locator, name: string | RegExp) {
		return rail.getByRole("button", { name });
	}

	/** The owning-Project link inside `rail`: a button labelled with the project name (derived from `project_id`). */
	owningProject(rail: Locator, name: string | RegExp) {
		return rail.getByRole("button", { name });
	}
}
