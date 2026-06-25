import type { ConnectionStatus } from "@inkstone/ui-sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetConnectionStore, setConnectionStatus } from "@/store/connection";
import {
	ConnectionStatusIndicator,
	present,
} from "./ConnectionStatusIndicator.js";

afterEach(() => {
	cleanup();
	resetConnectionStore();
});

describe("present()", () => {
	it("maps connected to a quiet, label-less calm state", () => {
		const p = present("connected");
		// Quiet when connected (PRODUCT.md local-first calm): no visible word, no spinner.
		expect(p.label).toBe("");
		expect(p.showSpinner).toBe(false);
		expect(p.tone).toBe("text-muted-foreground");
		// A calm dot, not an icon — pins the "no glyph when connected" half of quiet.
		expect(p.Icon).toBeNull();
		// Silent at rest (matches CopyOutcome): nothing to announce when healthy, so
		// the live region stays empty; recovery is the degraded srLabel clearing to "".
		expect(p.srLabel).toBe("");
	});

	it("maps reconnecting to a muted spinner + 'Reconnecting…'", () => {
		const p = present("reconnecting");
		expect(p.label).toBe("Reconnecting…");
		expect(p.showSpinner).toBe(true);
		expect(p.tone).toBe("text-muted-foreground");
		expect(p.srLabel).toMatch(/reconnecting to inkstone/i);
	});

	it("maps disconnected to a destructive icon + 'Lost connection'", () => {
		const p = present("disconnected");
		expect(p.label).toBe("Lost connection");
		expect(p.showSpinner).toBe(false);
		expect(p.tone).toBe("text-destructive");
		// A non-spinner icon carries the degraded visual (color is never the only signal).
		expect(p.Icon).not.toBeNull();
		expect(p.srLabel).toMatch(/lost connection to inkstone\. retrying/i);
	});
});

describe("ConnectionStatusIndicator", () => {
	function renderAt(status: ConnectionStatus) {
		// The vanilla store is set OUTSIDE React render (the bridge writes it).
		setConnectionStatus(status);
		return render(<ConnectionStatusIndicator />);
	}

	it("is calm and silent at rest when connected: no degraded text, empty live region", () => {
		renderAt("connected");
		expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/lost connection/i)).not.toBeInTheDocument();
		// The live region still EXISTS (so degraded transitions can fill it) but is
		// empty at rest — nothing announced on mount/navigation (matches CopyOutcome).
		const live = screen.getByRole("status");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveTextContent("");
	});

	it("shows a spinner + 'Reconnecting…' and announces it when reconnecting", () => {
		renderAt("reconnecting");
		expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
		const live = screen.getByRole("status");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveTextContent(/reconnecting to inkstone/i);
	});

	it("shows 'Lost connection' + a destructive icon and announces it when disconnected", () => {
		const { container } = renderAt("disconnected");
		expect(screen.getByText("Lost connection")).toBeInTheDocument();
		expect(
			container.querySelector('[class*="text-destructive"]'),
		).not.toBeNull();
		const live = screen.getByRole("status");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveTextContent(/lost connection to inkstone\. retrying/i);
	});
});
