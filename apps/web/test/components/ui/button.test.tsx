import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EntityEditorFrame } from "@/components/library/EntityEditor.js";
import { Button } from "@/components/ui/button.js";

afterEach(cleanup);

describe("Button primary variant", () => {
	it("renders the magenta text-primary fill at rounded-lg", () => {
		render(
			<Button variant="primary" size="row">
				Save
			</Button>,
		);
		const cls = screen.getByRole("button", { name: "Save" }).className;
		expect(cls).toContain("bg-primary");
		expect(cls).toContain("text-primary-foreground");
		expect(cls).toContain("shadow-sm");
		expect(cls).toContain("font-medium");
		expect(cls).toContain("rounded-lg");
		expect(cls).not.toContain("rounded-full");
	});
});

describe("EntityEditorFrame Save shape", () => {
	it("uses the primary variant at rounded-lg, not the rounded-full pill", () => {
		render(
			<EntityEditorFrame
				title="Edit"
				onSubmit={() => {}}
				onCancel={() => {}}
				saving={false}
				error={null}
			>
				<div />
			</EntityEditorFrame>,
		);
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toHaveAttribute("type", "submit");
		const cls = save.className;
		expect(cls).toContain("bg-primary");
		expect(cls).toContain("text-primary-foreground");
		expect(cls).toContain("rounded-lg");
		expect(cls).not.toContain("rounded-full");
	});
});
