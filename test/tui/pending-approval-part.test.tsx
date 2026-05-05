/**
 * Inline diff preview on the pending tool part + archive toggle.
 *
 * The real end-to-end flow (backend `beforeToolCall` → `confirmFn` →
 * `AgentProvider` closure → `previews` registry → `ToolPart` render)
 * is more machinery than we need to assert the render contract. We
 * cover it by installing a `confirmFn` from inside the test, firing
 * it once with a synthetic `ConfirmRequest`, and then scripting the
 * matching `toolcall_end` event through the reducer. That exercises
 * the full integration: `AgentProvider` installs the closure on
 * mount, the test calls it to populate `previews`, the reducer
 * pushes a tool part with the same callId, and `ToolPart` looks the
 * preview up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type ConfirmRequest,
	getConfirmFn,
} from "../../src/backend/agent/permissions";
import {
	assistantMessage,
	ev_agentStart,
	ev_messageStart,
	ev_toolcallEnd,
	ev_toolExecEnd,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

function makeRequest(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
	return {
		callId: "call-1",
		title: "Write confirmation",
		message: "Allow write to /tmp/x.md?",
		preview: {
			filepath: "/tmp/x.md",
			oldText: "old line\n",
			newText: "new line\n",
			unifiedDiff: [
				"Index: /tmp/x.md",
				"===================================================================",
				"--- /tmp/x.md",
				"+++ /tmp/x.md",
				"@@ -1,1 +1,1 @@",
				"-old line",
				"+new line",
				"",
			].join("\n"),
		},
		...overrides,
	};
}

describe("inline diff preview on pending tool part", () => {
	test("ToolPart renders the unified diff while confirmFn is pending", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });

		const req = makeRequest();
		// Fire confirmFn inline — AgentProvider installed the closure
		// on mount; this populates the previews registry for `call-1`
		// before we script the matching toolcall_end.
		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");

		// Don't await yet — we want the modal open (preview live) while
		// the reducer pushes the tool part below it.
		const pending = confirm(req);

		// Script the assistant turn: agent_start → message_start →
		// message_end (tool-use stop) → toolcall_end. The reducer
		// pushes a tool part into the last assistant bubble with
		// this callId.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "toolUse" }),
		});
		fake.emit(
			ev_toolcallEnd("call-1", "write", {
				path: "/tmp/x.md",
				content: "new line\n",
			}),
		);

		// Wait for the diff line to appear. `<diff>` renders
		// `new line` as part of the added-line content.
		const frame = await waitForFrame(setup, "new line");
		expect(frame).toContain("new line");
		expect(frame).toContain("old line");

		// Resolve the pending confirmFn via the panel's Esc keybind
		// (rejects and resolves the Promise).
		setup.mockInput.pressEscape();
		await pending;
	});

	test("preview clears when confirmFn resolves, archive retains, chevron re-expands it", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });

		const req = makeRequest({ callId: "call-2" });
		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(req);

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "toolUse" }),
		});
		fake.emit(ev_toolcallEnd("call-2", "write", { path: "/tmp/x.md" }));

		// Diff visible while pending.
		await waitForFrame(setup, "new line");

		// Reject via the panel's Esc keybind.
		setup.mockInput.pressEscape();
		await pending;

		// Script tool_execution_end so the pending part promotes to
		// error (since the backend rejected it) or completed.
		fake.emit(ev_toolExecEnd("call-2", "write"));

		// Diff auto-collapsed on resolve — pending entry wiped, but
		// the archive retains. The header now shows a `▸` chevron
		// next to the tool name.
		await setup.renderOnce();
		await Bun.sleep(50);
		await setup.renderOnce();
		const collapsed = setup.captureCharFrame();
		expect(collapsed).not.toContain("new line");
		expect(collapsed).not.toContain("old line");
		expect(collapsed).toContain("▸");

		// Click anywhere on the header row (chevron cell is small but
		// the whole header is the target). Locate the row containing
		// `~ write` — we know it's in the frame — and click roughly
		// at the chevron column (paddingLeft={3} → column 3 in terms
		// of renderable offset; the chevron sits at column 3 of the
		// header row).
		const rows = collapsed.split("\n");
		const headerRow = rows.findIndex((row) => row.includes("~ write"));
		expect(headerRow).toBeGreaterThanOrEqual(0);
		await setup.mockMouse.click(5, headerRow);

		await setup.renderOnce();
		await Bun.sleep(50);
		await setup.renderOnce();
		const expanded = setup.captureCharFrame();
		expect(expanded).toContain("new line");
		expect(expanded).toContain("old line");
		expect(expanded).toContain("▾");

		// Click again to collapse.
		const expandedRows = expanded.split("\n");
		const reHeaderRow = expandedRows.findIndex((row) =>
			row.includes("~ write"),
		);
		await setup.mockMouse.click(5, reHeaderRow);

		await setup.renderOnce();
		await Bun.sleep(50);
		await setup.renderOnce();
		const recollapsed = setup.captureCharFrame();
		expect(recollapsed).not.toContain("new line");
		expect(recollapsed).toContain("▸");
	});

	test("ConfirmRequest without preview does not render a diff or chevron", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });

		// No preview → registry.set is skipped in the provider
		// closure → no diff rendering even though the tool part
		// exists.
		const req: ConfirmRequest = {
			callId: "call-3",
			title: "Write confirmation",
			message: "Allow write?",
		};
		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(req);

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "toolUse" }),
		});
		fake.emit(ev_toolcallEnd("call-3", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "~ write");
		const frame = setup.captureCharFrame();
		// Strongest signal the `<diff>` element didn't mount is the
		// absence of the old/new line content that appears in every
		// `makeRequest()` preview. `@@` hunk headers don't survive
		// the renderable's parser (it reflows into numbered panes),
		// so a hunk-header absence would be tautological.
		expect(frame).not.toContain("new line");
		expect(frame).not.toContain("old line");
		// No preview → no archive → no chevron.
		expect(frame).not.toContain("▸");
		expect(frame).not.toContain("▾");

		setup.mockInput.pressEscape();
		await pending;
	});
});
