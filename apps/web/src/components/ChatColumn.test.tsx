import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { conversation } from "@/data/mock/conversation";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ChatColumn } from "./ChatColumn.js";

describe("ChatColumn", () => {
	it("renders user and assistant bubbles with action chips on the streaming message", () => {
		renderWithQuery(<ChatColumn />);

		for (const message of conversation) {
			const node = screen.getByText(message.text);
			expect(node).toBeInTheDocument();
			expect(
				node.closest(`[data-role="${message.role}"]`),
			).toBeInTheDocument();
		}

		const last = conversation[conversation.length - 1];
		if (last.role === "assistant" && last.actions) {
			for (const action of last.actions) {
				expect(screen.getByText(action.label)).toBeInTheDocument();
			}
		} else {
			throw new Error(
				"test setup expects last message to be an assistant with actions",
			);
		}
	});
});
