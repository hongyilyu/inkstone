import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge.js";

afterEach(cleanup);

describe("Badge", () => {
	it("xs size carries the node-row footprint classes", () => {
		render(<Badge size="xs">x</Badge>);
		const el = screen.getByText("x");
		expect(el.className).toContain("px-1.5");
		expect(el.className).toContain("py-0.5");
		expect(el.className).toContain("text-[0.6875rem]");
	});
});
