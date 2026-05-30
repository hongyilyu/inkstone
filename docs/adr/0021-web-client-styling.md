# Web Client styling: Tailwind v4 + base-ui primitives

The Web Client (`apps/web`) styles its UI with **Tailwind v4** for utilities and **`@base-ui-components/react`** for unstyled accessible primitives (dialogs, disclosures, popovers, etc.). Component variants compose via `class-variance-authority` + `clsx` + `tailwind-merge`. No design-system framework (MUI, Chakra, etc.) is used.

## What's in scope

- All styling under `apps/web/src/**` uses Tailwind utility classes.
- Reusable primitives that need accessible behavior (focus-trap, ARIA, keyboard nav) come from `@base-ui-components/react`, styled with Tailwind.
- Design tokens (colors, surfaces, accent, spacing) are CSS variables defined once in `apps/web/src/index.css` and consumed by Tailwind via `@theme inline`. See [Theming](#theming).
- Animations: `tw-animate-css` for keyframe utilities.
- Icons: `lucide-react`. One source for proposal-kind icons, theme toggle, send button, filter pills, and any future glyph. Tree-shaken; matches the shadcn / `my-clone` convention so patterns lift without translation.
- Typography: **Inter Variable, self-hosted**. The WOFF2 file lives at `apps/web/public/fonts/Inter-Variable.woff2`; one `@font-face` block in `index.css` declares it. Body fallback chain: `"Inter", ui-sans-serif, system-ui, sans-serif`. Mono stays `ui-monospace, "SF Mono", Menlo, Consolas, monospace` (system mono is fine; no self-host). Self-hosting (vs. Google Fonts CDN) keeps the app offline-capable and consistent with local-first; embedded into Core through Vite's `dist/` like the rest of the static bundle.

## What's out of scope

- Tailwind in any other workspace package (Worker, Core, ui-sdk).
- Styling primitives in `packages/ui-sdk`. The SDK stays a non-visual contract layer.

## Theming

Light/dark uses **semantic tokens that flip values under `[data-theme]`**, not Tailwind's `dark:` variant.

- All tokens live in `apps/web/src/index.css` (single source of truth) and are exposed via `@theme inline`. `@theme inline` (not plain `@theme`) is required so the underlying CSS variables can swap at runtime — plain `@theme` would inline values at build time and break the toggle.
- Token vocabulary follows the **shadcn-style semantic set** in **OKLCH**: `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`. Reason: matches the conventional v4 + base-ui idiom the LLM slice loop already knows and the visual reference uses, so patterns can be lifted without renaming.
- Markup references token-named utilities (`bg-background`, `text-foreground`, `border-border`); both light and dark provide values for the same set of tokens. Components do not double-up classes with `dark:` variants for color choices.
- The theme toggle (slice 8) sets `document.documentElement.dataset.theme`. The cascade does the rest; no JS recomputes class strings.
- **Initial theme** follows `prefers-color-scheme` on first visit. **User overrides persist** to `localStorage` (key: `inkstone-theme`, values `"light" | "dark"`). Subsequent loads read localStorage first, fall back to OS pref if absent.
- **FOUC avoidance**: an inline blocking `<script>` in `apps/web/index.html` runs before the stylesheet links and sets `data-theme` from localStorage / OS pref. Without it, the page paints with the OS-pref-derived default and visibly snaps to the persisted choice when React mounts. The script is small enough to inline; it never imports.
- This contradicts the original FEATURE-PLAN line "Persisting theme … is out of scope." The plan needs updating to bring slice 8 in line with this ADR (toggle persists; `index.html` carries the inline script).
- Tailwind's `dark:` variant is reserved for the rare override that doesn't fit the token system; not the default theming mechanism.

## Primitives layout

Reusable styled primitives — `Button`, `Card`, `Badge`, `Input`, `Textarea`, `Disclosure`, etc. — live under `apps/web/src/components/ui/` (shadcn convention). Each is a thin wrapper that composes a base-ui primitive (where one exists) with `cva` variants and `cn` (clsx + tailwind-merge). Slice-level components (`Sidebar`, `ChatColumn`, `ActivityRail`, `ProposalCard`, etc.) live one level up at `apps/web/src/components/` and import from `components/ui/`.

The primitive kit is established up-front rather than grown ad-hoc per slice, so each later slice imports a ready primitive instead of inlining cva and risking divergent variants across slices. Variant lists stay minimal (only what the slice loop has actually needed); a primitive is only added when at least one slice consumes it.

The `cn` helper lives at `apps/web/src/lib/utils.ts` (shadcn convention) and pipes `clsx` → `tailwind-merge`. Slice 1 also configures `extendTailwindMerge` so the merge function understands our semantic token names (`background`, `card`, `accent`, etc.) and groups them correctly with their `-foreground` pairs. Without this, `cn("bg-background", className)` where the caller passes `bg-card` may keep both classes and fall back to source-order resolution — fragile and surprising in cva variant overrides.

## Spacing & typography scale

Tailwind v4's default spacing scale (`0.25rem` increments) and default text scale (`text-xs`, `text-sm`, `text-base`, ...) are used as-is. The `@theme` block does not redefine them.

The `ui-mock` `Demo.tsx` reference uses ad-hoc half-pixel values (`13.5px`, `14.5px`, `10.5px`); these are eyeballed rather than systematic, so the slice loop **rounds to Tailwind's nearest scale step** rather than encoding the halves. Half-pixel rendering is device- and hint-dependent; the visual cost is negligible. The escape hatch when a specific element looks visibly wrong vs. the reference is an arbitrary value (`text-[14.5px]`) at the call site — used sparingly, not as a default.

## Markdown rendering

Real assistant message bubbles will render markdown (lists, links, tables, fenced code). The stack is locked in here so the future re-wiring feature does not re-debate it:

- **`react-markdown`** — Parses markdown → React tree.
- **`remark-gfm`** — GitHub-flavored extensions: tables, task lists, strikethrough.
- **`shiki`** — Code-block syntax highlighting via TextMate grammars (the VS Code engine). Highest-fidelity available in JS. Local-first compatible: WASM (oniguruma) ships in `dist/` and is embedded via `rust-embed`; no runtime network. Shiki's dual-theme rendering emits light + dark token classes in one render and lets CSS pick — composes naturally with `[data-theme]` from [Theming](#theming) (no re-render on toggle).
- **`@tailwindcss/typography`** — `prose` classes for default markdown styling (paragraphs, headings, lists, blockquotes).

None of the current revamp slices import these — slice 3 renders mock-array bubble text plain; slice 5's proposal cards parse structured strings into custom JSX (regex-based, not markdown), matching `ui-mock`'s `TodoBody` / `NoteBody` / `ProjectBody`. The first import site is the re-wiring feature that plumbs real assistant content.

To keep bundle in check, Shiki languages are lazy-loaded via `getHighlighter` per-language; the base highlighter ships only a small core grammar set.

## Testing

Vitest (jsdom) does **not** process Tailwind. Tests are behavior-level — `getByRole`, text matches, event handlers, `aria-*` / `data-*` attributes — none of which need a real CSS cascade. Pulling `@tailwindcss/vite` into the Vitest config would slow every test for no assertion that requires it.

Practical consequence: assertions that depend on visual state (e.g., "is this element hidden?") MUST use semantic attributes (`aria-hidden`, `data-state="closed"` from base-ui, etc.) rather than `getComputedStyle`. base-ui sets these idiomatically; the `dark:` variant is unused per [Theming](#theming), so theme-driven visibility doesn't come up either.

## Why Tailwind v4 + base-ui

- **Utility-first lets the LLM-driven slice loop iterate without a separate stylesheet step.** Demo.tsx in `ui-mock` proved the cost of vanilla CSS at this scale: ~3000 lines of `<style>` block in a single component, hard to extract piecemeal. Tailwind keeps style colocated with markup.
- **Tailwind v4 has zero JS-config; one `@import "tailwindcss"` line + the Vite plugin.** No `tailwind.config.js` to drift from the source of truth. Design tokens live in CSS, not a JS file.
- **`@base-ui-components/react` is unstyled by design.** It provides correctness (focus management, keyboard nav, ARIA wiring) and lets us style every primitive with Tailwind. The alternative — Radix Primitives — works the same way; base-ui was chosen because the `my-clone` reference template uses it and the API surface is sufficient for our needs.
- **`my-clone` (the visual reference) is built with this stack.** Adopting it means we can lift styling patterns directly during the slice loop without translation.
- **The choice composes with [ADR-0015](./0015-web-client-packaging.md).** Tailwind v4 outputs a single CSS file in `dist/`; nothing about the embed-in-Core packaging changes. The inline FOUC script (see [Theming](#theming)) is plain HTML in `apps/web/index.html`, ships verbatim through Vite into `dist/index.html`, and is embedded and served by `rust-embed` exactly like any other byte. It only writes `documentElement.dataset.theme`, so it has no coupling to Vite's hashed asset filenames.

## Considered and rejected

- **Vanilla CSS (status quo on master).** Works for the trivial App + Sidebar + Composer surface that exists today, but the `/8` design is much larger; vanilla CSS at that scale either drifts toward BEM-by-convention (high cognitive overhead, easy to break) or toward CSS Modules (extra build step, file proliferation). Tailwind solves both without adopting a framework.
- **CSS Modules.** One `.module.css` per component is fine; the friction is naming + cross-component shared tokens. Tailwind handles tokens via theme variables and avoids the per-component file pair.
- **Material UI / Chakra / Mantine.** Each ships a complete design system that conflicts with the `/8` aesthetic. Theming a design-system framework into a custom look is more work than building from primitives. Also imposes runtime CSS-in-JS, which slows down the LCP we'd otherwise get from a static Tailwind build.
- **Radix Primitives instead of base-ui.** Functionally equivalent; base-ui chosen only to match the `my-clone` reference. Switching is a future two-day swap if needed.
- **Stitches / Vanilla Extract / Panda CSS.** All defensible; all add a build-time CSS-in-JS layer Tailwind doesn't need. The simplicity-first principle in `CLAUDE.md` argues against the extra moving piece.

## Related

- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — Web Client is the only Client surface in MVP; styling decision matters because the Web Client carries the entire UX surface.
- [ADR-0015](./0015-web-client-packaging.md) — Vite-in-dev / embed-in-prod packaging is unchanged by this choice; Tailwind v4 produces a single `dist/` CSS asset that `rust-embed` ships verbatim.
