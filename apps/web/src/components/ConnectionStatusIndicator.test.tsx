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
	it("maps connected to a quiet, label-less calm state — discoverable but not announced", () => {
		const p = present("connected");
		// Quiet when connected (PRODUCT.md local-first calm): no visible word, no spinner.
		expect(p.label).toBe("");
		expect(p.showSpinner).toBe(false);
		expect(p.tone).toBe("text-muted-foreground");
		// A calm dot, not an icon — pins the "no glyph when connected" half of quiet.
		expect(p.Icon).toBeNull();
		// Two independent a11y knobs: srLabel is non-empty so SR users can DISCOVER the
		// healthy state on navigation, but live="off" so it's never auto-announced (no
		// unsolicited "Connected" on mount/recovery) — only the degraded states speak.
		expect(p.srLabel).toMatch(/connected to inkstone/i);
		expect(p.live).toBe("off");
	});

	it("maps reconnecting to a muted spinner + 'Reconnecting…' that announces", () => {
		const p = present("reconnecting");
		expect(p.label).toBe("Reconnecting…");
		expect(p.showSpinner).toBe(true);
		expect(p.tone).toBe("text-muted-foreground");
		expect(p.srLabel).toMatch(/reconnecting to inkstone/i);
		expect(p.live).toBe("polite");
	});

	it("maps disconnected to a destructive icon + 'Lost connection' that announces", () => {
		const p = present("disconnected");
		expect(p.label).toBe("Lost connection");
		expect(p.showSpinner).toBe(false);
		expect(p.tone).toBe("text-destructive");
		// A non-spinner icon carries the degraded visual (color is never the only signal).
		expect(p.Icon).not.toBeNull();
		expect(p.srLabel).toMatch(/lost connection to inkstone\. retrying/i);
		expect(p.live).toBe("polite");
	});
});

describe("ConnectionStatusIndicator", () => {
	function renderAt(status: ConnectionStatus) {
		// The vanilla store is set OUTSIDE React render (the bridge writes it).
		setConnectionStatus(status);
		return render(<ConnectionStatusIndicator />);
	}

	it("is calm at rest when connected: discoverable label, but aria-live off (not announced)", () => {
		renderAt("connected");
		// No visible degraded word — the healthy state is just the quiet dot visually.
		expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/lost connection/i)).not.toBeInTheDocument();
		// The role="status" region carries the healthy state in TEXT (so a SR user can
		// DISCOVER it on navigation) but is aria-live="off" — it is NOT auto-announced
		// on mount or on recovery back to connected (PRODUCT.md local-first calm).
		const live = screen.getByRole("status");
		expect(live).toHaveAttribute("aria-live", "off");
		expect(live).toHaveTextContent(/connected to inkstone/i);
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
