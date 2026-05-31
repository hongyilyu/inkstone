import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { conversation } from "@/data/mock/conversation";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ChatColumn } from "./ChatColumn.js";

describe("ChatColumn", () => {
	it("renders user and agent bubbles with action chips on the streaming turn", () => {
		renderWithQuery(<ChatColumn />);

		for (const turn of conversation) {
			const node = screen.getByText(turn.text);
			expect(node).toBeInTheDocument();
			expect(node.closest(`[data-role="${turn.role}"]`)).toBeInTheDocument();
		}

		const last = conversation[conversation.length - 1];
		if (last.role === "agent" && last.actions) {
			for (const action of last.actions) {
				expect(screen.getByText(action.label)).toBeInTheDocument();
			}
		} else {
			throw new Error(
				"test setup expects last turn to be an agent with actions",
			);
		}
	});
});
