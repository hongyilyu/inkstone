/**
 * Reader's `/article` slash command — TUI happy paths + canExecute fall-through.
 *
 * Existing coverage: `permissions.test.ts:476` validates the path/symlink
 * guards at unit level, `agent-cycle.test.tsx:93` proves `/article` falls
 * through as a plain prompt on a non-reader agent. Neither exercises the
 * full TUI dispatch chain (textarea → submit-prompt → triggerSlash →
 * `articleCommand.execute` → `helpers.prompt` → reducer → user bubble).
 *
 * What this file pins:
 *   - Argful happy path: `/article foo.md` reads the seeded fixture and
 *     calls `actions.prompt` with both the LLM-facing text (workflow
 *     prelude + `Path:` + body) and the bubble-facing displayParts (a
 *     short prose line + a file chip showing the vault-relative path).
 *   - Bare picker: `/article` with no args opens the recommendations
 *     dialog; selecting a row dispatches the same argful flow.
 *   - canExecute fall-through (PR #112): `/article missing.md` and
 *     `/article sneak.md` are rejected at the dispatch gate so the
 *     prompt path takes over with the literal text intact — no toast,
 *     no error. Pinned at the TUI seam because the unit-level
 *     `permissions.test.ts:476` only sees `articleCommand.execute`
 *     directly; only this file proves the seam between
 *     `canRunSlashEntry` rule 3 and the plain-prompt fallthrough.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type generateSessionTitle,
	MAX_TITLE_CHARS,
} from "../../src/backend/agent";
import { ARTICLES_DIR } from "../preload";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

describe("/article command", () => {
	test("argful `/article foo.md` dispatches with workflow prelude + body", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Type `/article foo.md` and submit. The dropdown opens on `/`
		// and stays open until the first space; once `space` arrives
		// the dropdown closes and Enter falls through to `submit-prompt`.
		await setup.mockInput.typeText("/article foo.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		// `articleCommand.execute` is async (readFileSync wrapped in async
		// fn). The bridge fires it via `Promise.resolve(...).catch(...)`
		// without awaiting, so we have to give the microtask queue a
		// couple of ticks before checking calls.prompt.
		await Bun.sleep(40);

		// One prompt call landed.
		expect(fake.calls.prompt.length).toBe(1);
		const sent = fake.calls.prompt[0];
		expect(sent).toBeDefined();
		if (!sent) return;

		// LLM-facing text carries the workflow prelude (the prelude is a
		// long block — anchor on the static "Read this article and begin
		// the reading workflow." marker reader emits between prelude and
		// content), the absolute path, and the file body.
		expect(sent).toContain("Read this article and begin the reading workflow.");
		expect(sent).toContain("Path: ");
		expect(sent).toContain("foo.md");
		expect(sent).toContain("Body paragraph.");

		// Bubble-facing file chip: vault-relative path lands in the
		// rendered frame next to the `md` MIME badge. The preload seeds
		// `foo.md` under `010 RAW/013 Articles/` so the relative path
		// is `010 RAW/013 Articles/foo.md`.
		const f = await waitForFrame(setup, "013 Articles/foo.md");
		expect(f).toContain("md"); // the MIME badge
		expect(f).toContain("Read this article."); // bubble prose line
	});

	test("argful `/article missing.md` falls through as a plain prompt (no toast)", async () => {
		// PR #112 added `canExecute` (rule 3 in `canRunSlashEntry`) so
		// `articleCommand` only dispatches when the arg resolves to a
		// regular file inside ARTICLES_DIR. A typo / missing filename is
		// rejected at the gate, so `submit-prompt` falls through to the
		// plain-prompt path with the literal `/article …` text intact.
		// Matches the Discord/Slack convention.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("/article missing.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// Plain prompt landed with the original literal text intact.
		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("/article missing.md");

		// No "Command error" toast. Pinning the negative case so a
		// regression that re-routes resolver failures into the toast
		// pipeline (e.g. removing canExecute, or an `execute()`
		// throw bypass of the gate) would surface here.
		const f = setup.captureCharFrame();
		expect(f).not.toContain("Command error");
		expect(f).not.toContain("Article not found");
	});

	test("argful `/article sneak.md` (symlink) falls through as a plain prompt", async () => {
		// Same canExecute gate. Preload seeds `sneak.md` as a symlink
		// pointing at `/etc/hosts` (`test/preload.ts:107`).
		// `resolveArticlePath` returns `{ ok: false, reason: "symlink" }`
		// → rule 3 rejects → fallthrough to plain prompt.
		// Symlink-rejection MESSAGE is still pinned at the unit level by
		// `permissions.test.ts:593` ("sneak.md (symlink) — throws") since
		// the resolver preserves the discriminated reason.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("/article sneak.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("/article sneak.md");

		const f = setup.captureCharFrame();
		expect(f).not.toContain("Command error");
		expect(f).not.toContain("Symlinks are not supported");
	});

	test("title is set from frontmatter; LLM title generator is bypassed", async () => {
		// `/article` knows the article identity at dispatch time
		// (frontmatter `title:` or filename stem) and passes it through
		// `helpers.prompt`'s `opts.title`. The LLM title task short-
		// circuits — better than any model paraphrase for finding the
		// session in the list later. Pin: the LLM generator is NOT
		// called, and `store.sessionTitle` reflects the frontmatter
		// title (`foo` for the seeded `foo.md` fixture). Companion to
		// the bigger regression note: `/article`'s LLM-facing text
		// begins with a ~6.5KB workflow prelude; feeding that to the
		// LLM title generator (which truncates input to 4KB) emits
		// titles like "Title generator" — summarizing the prelude.
		// Skipping the LLM avoids both the prelude bug and the
		// paraphrase drift.
		let titleGeneratorCalls = 0;
		const titleGenerator: typeof generateSessionTitle = async () => {
			titleGeneratorCalls += 1;
			return null;
		};

		const fake = makeFakeSession();
		setup = await renderApp({
			session: fake.factory,
			sessionTitleGenerator: titleGenerator,
		});
		await setup.renderOnce();

		await setup.mockInput.typeText("/article foo.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		expect(titleGeneratorCalls).toBe(0);
		expect(setup.getAgent().store.sessionTitle).toBe("foo");
	});

	test("frontmatter title longer than MAX_TITLE_CHARS is truncated", async () => {
		// `applyExplicitSessionTitle` shares the persisted-title length
		// cap with the LLM-cleaned path (`MAX_TITLE_CHARS` in
		// `backend/agent/session-title.ts`). A future contributor who
		// bumps the LLM-side cap must also widen the explicit-title
		// path or the two paths will silently drift — long article
		// titles would clip while LLM paraphrases render at the new
		// width. Pin the cap here with a fixture whose frontmatter
		// title is comfortably over the bound.
		const longTitle = "A".repeat(MAX_TITLE_CHARS + 25); // 75 chars
		const fixturePath = resolve(ARTICLES_DIR, "long-title.md");
		writeFileSync(fixturePath, `---\ntitle: ${longTitle}\n---\n\nBody.\n`);

		try {
			const fake = makeFakeSession();
			setup = await renderApp({
				session: fake.factory,
				sessionTitleGenerator: async () => null,
			});
			await setup.renderOnce();

			await setup.mockInput.typeText("/article long-title.md");
			setup.mockInput.pressEnter();
			await setup.renderOnce();
			await Bun.sleep(40);

			const stored = setup.getAgent().store.sessionTitle;
			expect(stored.length).toBe(MAX_TITLE_CHARS);
			expect(stored).toBe(longTitle.slice(0, MAX_TITLE_CHARS));
		} finally {
			unlinkSync(fixturePath);
		}
	});

	test("explicit title whitespace runs collapse to single spaces before persist", async () => {
		// `applyExplicitSessionTitle` normalizes any run of whitespace
		// (spaces, tabs, newlines) to a single space and trims the ends
		// before persisting. Today's callers all hand it single-line
		// strings by construction; this is defense for future callers
		// (a freeform user-typed title, an unusual frontmatter scalar)
		// so the sidebar / session-list rows render cleanly. Pin with
		// a fixture whose frontmatter title contains an unrealistic-
		// but-permissible run of internal whitespace (the YAML-lite
		// parser preserves spaces and tabs verbatim within a scalar).
		const messyTitle = "Lots\t  of   weird   whitespace";
		const expected = "Lots of weird whitespace";
		const fixturePath = resolve(ARTICLES_DIR, "messy-title.md");
		writeFileSync(fixturePath, `---\ntitle: "${messyTitle}"\n---\n\nBody.\n`);

		try {
			const fake = makeFakeSession();
			setup = await renderApp({
				session: fake.factory,
				sessionTitleGenerator: async () => null,
			});
			await setup.renderOnce();

			await setup.mockInput.typeText("/article messy-title.md");
			setup.mockInput.pressEnter();
			await setup.renderOnce();
			await Bun.sleep(40);

			expect(setup.getAgent().store.sessionTitle).toBe(expected);
		} finally {
			unlinkSync(fixturePath);
		}
	});

	test("bare `/article ` opens picker; selecting first row dispatches", async () => {
		const fake = makeFakeSession();
		// Wider terminal so the picker title + row text don't wrap.
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Trailing space is load-bearing: with no whitespace the
		// autocomplete dropdown is in slash mode and Enter selects the
		// dropdown row (which inserts "/article " back into the textarea
		// because `argHint` is set — see `buildSlashOptions` argful
		// branch). Adding the space dismisses slash mode (per
		// `deriveNextMode`'s `\s` rule), so Enter falls through to
		// `submit-prompt` which calls `triggerSlash("article", "")` →
		// `articleCommand.execute("", helpers)` → picker opens.
		await setup.mockInput.typeText("/article ");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// Picker dialog title comes from articleCommand.execute
		// ("Recommended articles"). The dialog opens via dialog.replace
		// inside pickFromList — synchronous after Enter.
		const f = await waitForFrame(setup, "Recommended articles");
		expect(f).toContain("Recommended articles");

		// Both seeded articles should be reachable as rows. Anchor on
		// `bar.md` — it has no `reading_intent` frontmatter so it ranks
		// neutrally and shouldn't be filtered out as already-read.
		expect(f).toMatch(/bar|foo/);

		// Pick the first row (DialogSelect highlights the first option
		// by default; Enter commits). `pickFromList` resolves the
		// selected option's `value` which articleCommand passes to
		// `runArticle` → same code path as the argful test.
		// `DialogSelect` focuses its filter input via setTimeout(1), so
		// give it a tick before pressing Enter to avoid landing on the
		// prompt textarea behind the dialog.
		await Bun.sleep(30);
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// One prompt landed — same workflow shape as the argful test.
		expect(fake.calls.prompt.length).toBe(1);
		const sent = fake.calls.prompt[0];
		expect(sent).toBeDefined();
		if (!sent) return;
		expect(sent).toContain("Read this article and begin the reading workflow.");
		expect(sent).toContain("Path: ");
	});
});
