import { expect, test } from "@playwright/test";
import { ChatPage } from "./page-objects/ChatPage.js";

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
		"waitForAssistantText",
		"newChat",
		"openThread",
		"reload",
	] as const) {
		expect(typeof chat[method]).toBe("function");
	}
});
