import { expect, test } from "@playwright/test";
import { ChatPage } from "./page-objects/ChatPage.js";
import { GtdPage } from "./page-objects/GtdPage.js";
import { LibraryPage } from "./page-objects/LibraryPage.js";
import { SettingsPage } from "./page-objects/SettingsPage.js";

/**
 * Slice 9: a lightweight guard that the page-object scaffold is exported with
 * its behavior-level surface intact — cheaper than a full browser run for the
 * documentation/scaffold contract the README points at. (The real browser
 * exercise of ChatPage is smoke.spec + the acceptance specs.)
 */
test("ChatPage exposes its behavior-level methods", () => {
	// A dummy page stand-in: the constructor must not touch it, so methods are
	// inspectable without a browser.
	const chat = new ChatPage({} as never, "http://127.0.0.1:0");

	for (const method of [
		"goto",
		"send",
		"stop",
		"waitForAssistantText",
		"newChat",
		"openThread",
		"reload",
	] as const) {
		expect(typeof chat[method]).toBe("function");
	}
});

test("LibraryPage exposes its behavior-level methods", () => {
	const library = new LibraryPage({} as never, "http://127.0.0.1:0");

	for (const method of [
		"gotoTopic",
		"newEntity",
		"rail",
		"field",
		"fillField",
		"selectField",
		"save",
		"enterEdit",
		"deleteButton",
		"deleteConfirmPrompt",
		"deleteEntity",
		"cancelDelete",
		"collection",
		"successCue",
	] as const) {
		expect(typeof library[method]).toBe("function");
	}
});

test("GtdPage exposes its behavior-level methods", () => {
	const gtd = new GtdPage({} as never, "http://127.0.0.1:0");

	for (const method of [
		"gotoView",
		"gotoTodo",
		"region",
		"detailRail",
		"linkedPerson",
		"owningProject",
	] as const) {
		expect(typeof gtd[method]).toBe("function");
	}
});

test("SettingsPage exposes its behavior-level methods", () => {
	const settings = new SettingsPage({} as never);

	for (const method of [
		"open",
		"modelsHeading",
		"effortRadio",
		"openProvider",
		"modelRow",
		"enabledCheckbox",
		"providerRow",
	] as const) {
		expect(typeof settings[method]).toBe("function");
	}
});
