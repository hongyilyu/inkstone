import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/ChatMarkdown.js";

afterEach(() => {
	cleanup();
});

describe("ChatMarkdown", () => {
	it("renders headings, lists, and links from markdown", () => {
		render(
			<ChatMarkdown text={"# Title\n\n- a\n- b\n\n[link](https://x.test)"} />,
		);

		expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);

		const anchor = screen.getByRole("link");
		expect(anchor).toHaveAttribute("target", "_blank");
		expect(anchor.getAttribute("rel")).toContain("noreferrer");
	});
});
